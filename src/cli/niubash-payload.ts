/** Frozen complete Niubash distribution. Receipts describe bytes; only this manifest authorizes them. */
import { NIUBASH_FACES, NIUBASH_FACE_RULE } from '../niubash/faces.js'
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
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const niubashFileHash = (file: string) => digest(fs.readFileSync(file))
const files: Readonly<Record<string, string>> = manifest.files
const sizes: Readonly<Record<string, number>> = manifest.sizes

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
function verifyTree(directory: string, allowExecutionState: boolean) {
  noLinks(directory)
  const expected = { ...files }
  if (allowExecutionState) for (const face of NIUBASH_FACES) {
    if (!/^(?:[a-z0-9][a-z0-9-]*|\[)$/u.test(face)) throw Error('Unsafe compiled Niubash face')
    const name = `winuxcmd/usr/bin/${face}.exe`
    if (!Object.hasOwn(expected, name)) expected[name] = files['winuxcmd/usr/bin/winuxcmd.exe']
  }
  const seenFiles = new Set<string>()
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      const file = path.join(directory, name)
      if (entry.isDirectory()) {
        if (!manifest.directories.includes(name)
          && !(allowExecutionState && NIUBASH_EXECUTION_DIRECTORIES.some(allowed => allowed === name || allowed.startsWith(`${name}/`)))) {
          throw Error(`Unknown Niubash directory: ${name}`)
        }
        walk(name)
      }
      // pnpm may hardlink immutable package members into its store. Rehash every
      // source byte; only disposable execution trees must have exclusive file links.
      else if (!entry.isFile() || fs.lstatSync(file).isSymbolicLink() || (allowExecutionState && fs.lstatSync(file).nlink !== 1)) throw Error(`Unsafe Niubash tree member: ${name}`)
      else if (name === NIUBASH_RECEIPT || (allowExecutionState && name === 'execution-provenance.json')) continue
      else {
        if (!Object.hasOwn(expected, name) || fs.statSync(file).size !== (sizes[name] ?? sizes['winuxcmd/usr/bin/winuxcmd.exe']) || niubashFileHash(file) !== expected[name]) throw Error(`Niubash tree checksum mismatch: ${name}`)
        seenFiles.add(name)
      }
    }
  }
  walk('')
  // npm omits empty directories; required parents are enforced by the complete file inventory.
  if (seenFiles.size !== Object.keys(expected).length) throw Error('Incomplete Niubash payload tree')
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, NIUBASH_RECEIPT), 'utf8')) as Record<string, unknown>
  if (receipt.version !== 1 || receipt.archiveSha256 !== manifest.archiveSha256
    || receipt.executableSha256 !== manifest.executableSha256 || receipt.upstreamVersion !== manifest.upstreamVersion
    || JSON.stringify(receipt.files) !== JSON.stringify(files)
    || JSON.stringify(receipt.sizes) !== JSON.stringify(sizes)) throw Error('Invalid Niubash provenance receipt')
  if (allowExecutionState) {
    const derived = JSON.parse(fs.readFileSync(path.join(directory, 'execution-provenance.json'), 'utf8'))
    if (JSON.stringify(derived) !== JSON.stringify(niubashExecutionReceipt())) throw Error('Invalid Niubash execution receipt')
  }
  return path.join(directory, manifest.executable)
}

/** Cancellable per-invocation validation; selection retains the synchronous fail-closed check. */
export async function verifyNiubashTreeAsync(directory: string, allowExecutionState: boolean, signal: AbortSignal) {
  signal.throwIfAborted()
  noLinks(directory)
  const expected = { ...files }
  if (allowExecutionState) for (const face of NIUBASH_FACES) {
    if (!/^(?:[a-z0-9][a-z0-9-]*|\[)$/u.test(face)) throw Error('Unsafe compiled Niubash face')
    const name = `winuxcmd/usr/bin/${face}.exe`
    if (!Object.hasOwn(expected, name)) expected[name] = files['winuxcmd/usr/bin/winuxcmd.exe']
  }
  const seenFiles = new Set<string>()
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      signal.throwIfAborted()
      const file = path.join(directory, name)
      if (entry.isDirectory()) {
        if (!manifest.directories.includes(name)
          && !(allowExecutionState && NIUBASH_EXECUTION_DIRECTORIES.some(allowed => allowed === name || allowed.startsWith(`${name}/`)))) {
          throw Error(`Unknown Niubash directory: ${name}`)
        }
        await walk(name)
      }
      else if (!entry.isFile() || fs.lstatSync(file).isSymbolicLink() || (allowExecutionState && fs.lstatSync(file).nlink !== 1)) throw Error(`Unsafe Niubash tree member: ${name}`)
      else if (name === NIUBASH_RECEIPT || (allowExecutionState && name === 'execution-provenance.json')) continue
      else {
        if (!Object.hasOwn(expected, name) || fs.statSync(file).size !== (sizes[name] ?? sizes['winuxcmd/usr/bin/winuxcmd.exe']) || digest(await fs.promises.readFile(file, { signal })) !== expected[name]) throw Error(`Niubash tree checksum mismatch: ${name}`)
        seenFiles.add(name)
      }
    }
  }
  await walk('')
  // npm omits empty directories; required parents are enforced by the complete file inventory.
  if (seenFiles.size !== Object.keys(expected).length) throw Error('Incomplete Niubash payload tree')
  const receipt = JSON.parse(await fs.promises.readFile(path.join(directory, NIUBASH_RECEIPT), { encoding: 'utf8', signal })) as Record<string, unknown>
  if (receipt.version !== 1 || receipt.archiveSha256 !== manifest.archiveSha256
    || receipt.executableSha256 !== manifest.executableSha256 || receipt.upstreamVersion !== manifest.upstreamVersion
    || JSON.stringify(receipt.files) !== JSON.stringify(files)
    || JSON.stringify(receipt.sizes) !== JSON.stringify(sizes)) throw Error('Invalid Niubash provenance receipt')
  if (allowExecutionState) {
    const derived = JSON.parse(await fs.promises.readFile(path.join(directory, 'execution-provenance.json'), { encoding: 'utf8', signal }))
    if (JSON.stringify(derived) !== JSON.stringify(niubashExecutionReceipt())) throw Error('Invalid Niubash execution receipt')
  }
  return path.join(directory, manifest.executable)
}

export function niubashExecutionReceipt() {
  return { rule: NIUBASH_FACE_RULE, sourceArchiveSha256: manifest.archiveSha256,
    sourceExecutableSha256: files['winuxcmd/usr/bin/winuxcmd.exe'], faces: NIUBASH_FACES }
}

export function verifyNiubashTree(directory: string) { return verifyTree(directory, false) }

/** Validate a mutable execution copy while allowing only directories created by Niubash itself. */
export function verifyNiubashExecutionTree(directory: string) { return verifyTree(directory, true) }

/** Build in a fresh sibling, verify before rename, and preserve the previous payload on failure. */
export function stageNiubashArchive(archive: string, target: string) {
  const contents = verifiedNiubashArchive(archive)
  noLinks(target)
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
  if (moved) fs.rmSync(previous, { recursive: true, force: true })
  return path.join(target, manifest.executable)
}
