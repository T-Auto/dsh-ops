/** Frozen complete Niubash distribution. Receipts describe bytes; only this manifest authorizes them. */
import { NIUBASH_FACES } from '../niubash/faces.js'
import { unsealDirectorySync } from '../niubash/seal.js'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import manifest from './niubash-payload-manifest.json' with { type: 'json' }

Object.freeze(manifest.files)
Object.freeze(manifest.sizes)
Object.freeze(manifest.directories)
export const NIUBASH_PIN = Object.freeze(manifest)
export const NIUBASH_RECEIPT = 'provenance.json'
export const NIUBASH_PACKAGE_PATH = 'runtime/win32-x64/niubash'
export const NIUBASH_HOME_PATH = 'dsh-ops/shells/niubash'
/** One message from an unknown throwable; this module stays inside the release module closure, so it
 * borrows no host-side helper. */
const errorText = (error: unknown): string => (error instanceof Error && typeof error.message === 'string' ? error.message : String(error))
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const niubashFileHash = (file: string) => digest(fs.readFileSync(file))
const files: Readonly<Record<string, string>> = manifest.files
const sizes: Readonly<Record<string, number>> = manifest.sizes

/** Digest of the compiled inventory, also the version key of the prepared runtime. */
export const NIUBASH_MANIFEST_SHA256 = createHash('sha256')
  .update(JSON.stringify({ directories: manifest.directories, files, sizes })).digest('hex')

type TarEntry = { name: string; type: string; bytes: Buffer; link: string }
const text = (bytes: Buffer) => bytes.toString('utf8').replace(/\0.*$/su, '')

/** Reject Windows aliases, traversal, ADS, and absolute paths before any filesystem write. */
export function safeNiubashMember(name: string) {
  if (!name || /[\\:\x00-\x1f]/u.test(name) || name.startsWith('/')
    || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw Error(`Unsafe Niubash archive member: ${name}`)
  }
  return name
}

/** Minimal strict ustar reader: no external extractor, symlinks, devices, PAX, or path rewriting. */
export function readNiubashTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  const names = new Set<string>()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset).some(byte => byte !== 0)) throw Error('Trailing data in Niubash tar')
      return entries
    }
    const octal = (start: number, end: number) => {
      const value = text(header.subarray(start, end)).trim()
      if (!/^[0-7]+$/u.test(value)) throw Error('Invalid Niubash tar numeric field')
      return Number.parseInt(value, 8)
    }
    const checksum = octal(148, 156)
    let actual = 0
    for (let index = 0; index < 512; index++) actual += index >= 148 && index < 156 ? 32 : header[index]
    if (checksum !== actual) throw Error('Niubash tar header checksum mismatch')
    const prefix = text(header.subarray(345, 500))
    const raw = `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`
    const name = safeNiubashMember(raw.replace(/\/$/u, ''))
    const key = name.toLowerCase()
    if (names.has(key)) throw Error(`Duplicate Niubash tar member: ${name}`)
    names.add(key)
    const type = text(header.subarray(156, 157)) || '0'
    if (!['0', '1', '5'].includes(type)) throw Error(`Unsupported Niubash tar member type: ${type}`)
    const size = octal(124, 136)
    if (!Number.isSafeInteger(size) || size < 0 || (type !== '0' && size !== 0)
      || offset + 512 + size > tar.length) throw Error('Truncated or invalid Niubash tar member')
    const link = text(header.subarray(157, 257))
    if (type === '1') safeNiubashMember(link)
    entries.push({ name, type, link, bytes: tar.subarray(offset + 512, offset + 512 + size) })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw Error('Missing Niubash tar terminator')
}

/** The archive hash is checked before decompression; every file is checked against the frozen inventory. */
export function verifiedNiubashArchive(archive: string) {
  const bytes = fs.readFileSync(archive)
  if (bytes.length !== manifest.archiveBytes || digest(bytes) !== manifest.archiveSha256) {
    throw Error('Niubash archive checksum/size mismatch; refusing unpinned bytes')
  }
  const entries = readNiubashTar(gunzipSync(bytes, { maxOutputLength: 80 * 1024 * 1024 }))
  const contents = new Map<string, Buffer>()
  const directories = new Set<string>()
  for (const entry of entries) {
    if (entry.name === manifest.prefix.slice(0, -1) && entry.type === '5') continue
    if (!entry.name.startsWith(manifest.prefix)) throw Error(`Wrong Niubash archive root: ${entry.name}`)
    const relative = entry.name.slice(manifest.prefix.length)
    if (entry.type === '5') { directories.add(relative); continue }
    const data = entry.type === '1' ? contents.get(entry.link) : entry.bytes
    if (!data) throw Error(`Invalid Niubash hardlink: ${entry.name}`)
    if (!Object.hasOwn(files, relative) || data.length !== sizes[relative] || digest(data) !== files[relative]) throw Error(`Niubash member checksum mismatch: ${relative}`)
    contents.set(entry.name, data)
  }
  if (contents.size !== Object.keys(files).length || directories.size !== manifest.directories.length
    || manifest.directories.some(name => !directories.has(name))) throw Error('Incomplete Niubash archive tree')
  return contents
}

function noLinks(directory: string) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error(`Niubash path is a link: ${current}`)
    if (path.dirname(current) === current) break
  }
}

export const NIUBASH_EXECUTION_DIRECTORIES = ['winuxcmd/usr/local', 'winuxcmd/usr/local/bin', 'winuxcmd/etc', 'winuxcmd/var', 'winuxcmd/dev', 'winuxcmd/dev/shm']

/** Rehash a tree against the compiled inventory, not the untrusted local receipt. */
function assertProvenanceReceipt(value: unknown) {
  const receipt = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (receipt.version !== 1 || receipt.archiveSha256 !== manifest.archiveSha256
    || receipt.executableSha256 !== manifest.executableSha256 || receipt.upstreamVersion !== manifest.upstreamVersion
    || JSON.stringify(receipt.files) !== JSON.stringify(files)
    || JSON.stringify(receipt.sizes) !== JSON.stringify(sizes)) throw Error('Invalid Niubash provenance receipt')
}

/**
 * Installation/selection verification: rehash every source byte against the
 * compiled inventory, including generated argv0 faces when present.
 */
function verifyTree(directory: string, prepared: boolean) {
  noLinks(directory)
  const seenFiles = new Set<string>()
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      const file = path.join(directory, name)
      if (entry.isDirectory()) {
        if (!manifest.directories.includes(name) && !NIUBASH_EXECUTION_DIRECTORIES.includes(name)) throw Error(`Unknown Niubash directory: ${name}`)
        walk(name)
      }
      // pnpm may hardlink package members into its store; byte hashes remain the trust anchor.
      else if (!entry.isFile() || fs.lstatSync(file).isSymbolicLink()) throw Error(`Unsafe Niubash tree member: ${name}`)
      else if (name === NIUBASH_RECEIPT) continue
      else {
        const original = Object.hasOwn(files, name) ? name : NIUBASH_FACES.some(face => name === `winuxcmd/usr/bin/${face}.exe`) ? 'winuxcmd/usr/bin/winuxcmd.exe' : undefined
        if (original === undefined || fs.statSync(file).size !== sizes[original] || niubashFileHash(file) !== files[original]) throw Error(`Niubash tree checksum mismatch: ${name}`)
        if (Object.hasOwn(files, name)) seenFiles.add(name)
      }
    }
  }
  walk('')
  if (prepared) {
    for (const name of NIUBASH_EXECUTION_DIRECTORIES) {
      if (!fs.statSync(path.join(directory, name)).isDirectory()) throw Error(`Incomplete Niubash state directories: ${name}`)
    }
    for (const face of NIUBASH_FACES) {
      if (!fs.existsSync(path.join(directory, `winuxcmd/usr/bin/${face}.exe`))) throw Error(`Incomplete Niubash argv0 faces: ${face}`)
    }
  }
  // npm omits empty directories; required parents are enforced by the complete file inventory.
  if (seenFiles.size !== Object.keys(files).length) throw Error('Incomplete Niubash payload tree')
  assertProvenanceReceipt(JSON.parse(fs.readFileSync(path.join(directory, NIUBASH_RECEIPT), 'utf8')))
  return path.join(directory, manifest.executable)
}

export function verifyNiubashTree(directory: string, prepared = false) { return verifyTree(directory, prepared) }

/** Build in a fresh sibling, verify before rename, and preserve the previous payload on failure. */
export function stageNiubashArchive(archive: string, target: string) {
  const contents = verifiedNiubashArchive(archive)
  noLinks(target)
  // A previous execution sealed the shared inodes read-only; clear that before the
  // target is replaced or its previous tree is removed.
  unsealDirectorySync(target)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const scratch = fs.mkdtempSync(`${target}.stage-`)
  const previous = `${target}.previous-${randomUUID()}`
  let moved = false
  try {
    for (const directory of manifest.directories) fs.mkdirSync(path.join(scratch, directory), { recursive: true })
    for (const [name, bytes] of contents) fs.writeFileSync(path.join(scratch, name.slice(manifest.prefix.length)), bytes)
    fs.writeFileSync(path.join(scratch, NIUBASH_RECEIPT), `${JSON.stringify({
      version: 1, backend: 'niubash', upstreamVersion: manifest.upstreamVersion,
      archive: manifest.archive, url: manifest.url, archiveSha256: manifest.archiveSha256,
      archiveBytes: manifest.archiveBytes, executable: manifest.executable,
      executableSha256: manifest.executableSha256, files, sizes,
    }, null, 2)}\n`)
    verifyNiubashTree(scratch)
    if (fs.existsSync(target)) { fs.renameSync(target, previous); moved = true }
    try { fs.renameSync(scratch, target) } catch (error) {
      if (moved) { fs.renameSync(previous, target); moved = false }
      throw error
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  // Cleanup is diagnostic only: a refused removal must never turn a completed
  // install into a reported failure, and the sibling it leaves behind is
  // reclaimed by the next provision after the tree verifies.
  if (moved) {
    try {
      unsealDirectorySync(previous)
      fs.rmSync(previous, { recursive: true, force: true })
    } catch (error) {
      console.error('dsh-ops: could not remove the previous Niubash tree ' + previous + ': ' + errorText(error))
    }
  }
  return path.join(target, manifest.executable)
}

/** What one staged sibling of the fixed Niubash target is, and what a reclaim did with it. */
export interface NiubashSiblingDecision {
  /** The decision, in the order a reclaim applies it. */
  action: 'reused' | 'restored' | 'removed' | 'kept'
  /** The sibling this decision is about. */
  path: string
  /** Bytes the sibling occupies. */
  bytes: number
  /** Why it was kept; absent for a decision that changed the filesystem. */
  detail?: string
}

/** Bytes and files below one tree, without following links out of it. */
function treeSize(directory: string): { bytes: number, files: number } {
  let bytes = 0, files = 0
  const walk = (current: string): void => {
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = path.join(current, entry.name)
      let stat
      try { stat = fs.lstatSync(file) } catch { continue }
      if (stat.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(file)
      else { bytes += stat.size; files += 1 }
    }
  }
  walk(directory)
  return { bytes, files }
}

/**
 * Reclaim the siblings an interrupted or failed Niubash install left beside the
 * fixed target: "niubash.stage-*" and "niubash.previous-*".
 *
 * The target is the only authority on what may be reused, restored or removed:
 *  - a complete staged tree is renamed into place when the target is missing
 *    (reuse, which also saves another 108 MiB copy) and removed when it is not;
 *  - a complete previous tree is renamed back when the target is missing
 *    (restore after a failed replacement) and removed when it is not;
 *  - anything that does not verify stays where it is and is reported as kept.
 *
 * Only direct children of the target's own directory are considered, links are
 * never followed, and every deletion is a rename to an aside name first so a
 * refused remove can be retried. A dry run reports the same decisions without
 * changing the filesystem.
 * @param target - the fixed Niubash tree path the sibling names extend.
 * @param options - verification, filesystem and clock injection for tests.
 * @returns one decision per sibling, newest first.
 */
export function reclaimNiubashSiblings(target: string, {
  dryRun = false,
  verify = verifyNiubashTree,
  rename = (from: string, to: string): void => { fs.renameSync(from, to) },
  remove = (aside: string): void => { fs.rmSync(aside, { recursive: true, force: true }) },
  now = Date.now(),
  log = (message: string): void => { console.error(message) },
}: {
  dryRun?: boolean
  verify?: (directory: string) => string
  rename?: (from: string, to: string) => void
  remove?: (aside: string) => void
  now?: number
  log?: (message: string) => void
} = {}): NiubashSiblingDecision[] {
  const parent = path.dirname(target)
  const base = path.basename(target)
  let entries
  try { entries = fs.readdirSync(parent, { withFileTypes: true }) } catch { return [] }
  const stages: { path: string, bytes: number }[] = []
  const previous: { path: string, bytes: number }[] = []
  const decisions: NiubashSiblingDecision[] = []
  for (const entry of entries) {
    if (entry.name === base) continue
    const full = path.join(parent, entry.name)
    if (entry.name.startsWith(base + '.stage-') || entry.name.startsWith(base + '.previous-')) {
      let stat
      try { stat = fs.lstatSync(full) } catch { continue }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        decisions.push({ action: 'kept', path: full, bytes: 0, detail: 'the sibling is not a plain directory' })
        continue
      }
      const size = treeSize(full)
      if (entry.name.startsWith(base + '.stage-')) stages.push({ path: full, bytes: size.bytes })
      else previous.push({ path: full, bytes: size.bytes })
    }
  }
  const verifyQuietly = (directory: string): boolean => {
    try { verify(directory); return true } catch { return false }
  }
  const moveAsideAndRemove = (full: string, bytes: number): NiubashSiblingDecision => {
    if (dryRun) return { action: 'removed', path: full, bytes }
    const aside = full + '.reclaim-' + now.toString(36)
    try { rename(full, aside) } catch (error) {
      return { action: 'kept', path: full, bytes, detail: 'could not move it aside: ' + errorText(error) }
    }
    try { remove(aside) } catch (error) {
      return { action: 'kept', path: aside, bytes, detail: 'could not remove it: ' + errorText(error) }
    }
    return { action: 'removed', path: full, bytes }
  }
  for (const staged of stages) {
    if (!verifyQuietly(staged.path)) {
      decisions.push({ action: 'kept', path: staged.path, bytes: staged.bytes, detail: 'the staged tree does not verify' })
      continue
    }
    if (!fs.existsSync(target)) {
      if (!dryRun) {
        try { rename(staged.path, target) } catch (error) {
          decisions.push({ action: 'kept', path: staged.path, bytes: staged.bytes, detail: 'could not reuse it: ' + errorText(error) })
          continue
        }
      }
      decisions.push({ action: 'reused', path: staged.path, bytes: staged.bytes })
      log('dsh-ops: reused a complete staged Niubash tree as ' + target)
      continue
    }
    decisions.push(moveAsideAndRemove(staged.path, staged.bytes))
  }
  for (const kept of previous) {
    if (!verifyQuietly(kept.path)) {
      decisions.push({ action: 'kept', path: kept.path, bytes: kept.bytes, detail: 'the previous tree does not verify' })
      continue
    }
    if (!fs.existsSync(target)) {
      if (!dryRun) {
        try { rename(kept.path, target) } catch (error) {
          decisions.push({ action: 'kept', path: kept.path, bytes: kept.bytes, detail: 'could not restore it: ' + errorText(error) })
          continue
        }
      }
      decisions.push({ action: 'restored', path: kept.path, bytes: kept.bytes })
      log('dsh-ops: restored the previous Niubash tree to ' + target)
      continue
    }
    decisions.push(moveAsideAndRemove(kept.path, kept.bytes))
  }
  return decisions
}
