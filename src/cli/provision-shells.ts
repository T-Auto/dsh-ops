/**
 * `dsh-ops provision-shells`: turn the pinned upstream shell releases into the
 * local copies the shell rungs prefer — download, digest verification, unpacking,
 * and the receipt that records which pin produced each copy.
 *
 * Split out of `bin/dsh-ops.mjs`; the command's argv surface, output and exit
 * codes are unchanged.
 *
 * @module dsh-ops/cli/provision-shells
 */

import { NIUBASH_PIN, NIUBASH_HOME_PATH, reclaimNiubashSiblings, stageNiubashArchive, verifyNiubashTree } from './niubash-payload.js'
import type { NiubashSiblingDecision } from './niubash-payload.js'
import { discardPendingRecord, pendingRoot, recordPendingScratch, sweepPendingScratch } from './pending-scratch.js'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { errorMessage } from '../shells/types.js'
import os from 'node:os'
import path from 'node:path'
import { dshHome } from '../paths.js'
import {
  PLATFORM_PACKAGES,
  SHELL_UPSTREAM_PINS,
  provisionedShellStore,
  provisionedShellVersionDir,
  shellExecutable,
} from '../shells.js'
import { formatBytes } from './uninstall.js'

type ShellKind = 'bash' | 'pwsh'
export interface ShellPin extends Record<string, unknown> {
  name: ShellKind; platform: string; arch: string; version: string; assetFile: string; url: string
  sha256: string; bytes: number; extractor: string; extractTo: string; executableRelativePath: string
}
type HelperResult = { ok: true } | { error: string; stderr: string[] }

// ---------------------------------------------------------------------------
// provision-shells: the pinned upstream shells become local copies
// ---------------------------------------------------------------------------

/** Receipt schema written inside one provisioned shell's version directory. */
export const SHELL_RECEIPT_VERSION = 1

/** The marker file a provisioned version directory carries. */
export const SHELL_RECEIPT_FILE = '.provisioned.json'

/** The archive shapes a pin may name, and how each is opened. */
export const PIN_EXTRACTORS = Object.freeze(['zip', 'sfx-7z', 'tar.gz'])

/** The fields every pin must carry; `executableSha256` and the labels are optional. */
export const PIN_REQUIRED_FIELDS = Object.freeze([
  'name',
  'platform',
  'arch',
  'version',
  'assetFile',
  'url',
  'sha256',
  'bytes',
  'extractor',
  'extractTo',
  'executableRelativePath',
])

/**
 * The SHA-256 of one file, streamed so a 100 MB archive is never held in memory
 * twice.
 * @param {string} file - the file to hash.
 * @returns {string} the lowercase hex digest.
 */
export function sha256File(file: string) {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  const handle = fs.openSync(file, 'r')
  try {
    for (;;) {
      const read = fs.readSync(handle, chunk, 0, chunk.length, null)
      if (read === 0) break
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    fs.closeSync(handle)
  }
  return hash.digest('hex')
}

/**
 * The last few non-empty lines of one stream, for a failure report.
 * @param {string|undefined} text - the stream.
 * @param {number} [count] - how many lines to keep.
 * @returns {string[]} the lines.
 */
export function tailLines(text: string | undefined | null, count = 8) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-count)
}

/**
 * Run one helper program, and report the tail of its stderr when it fails.
 * @param {string} file - the program.
 * @param {string[]} args - its arguments.
 * @param {object} [options] - run inputs.
 * @param {string} [options.cwd] - working directory for the child.
 * @returns {{ok: true}|{error: string, stderr: string[]}} the outcome.
 */
export function runTool(file: string, args: string[], { cwd }: { cwd?: string } = {}): HelperResult {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error !== undefined && result.error !== null) {
    return { error: `could not run ${file}: ${String(result.error.message ?? result.error)}`, stderr: [] }
  }
  if (result.status !== 0) {
    return { error: `${file} exited with code ${result.status}`, stderr: tailLines(result.stderr) }
  }
  return { ok: true }
}

/**
 * The proxy one environment names, in curl's own precedence.
 * @param {NodeJS.ProcessEnv} env - the environment to read.
 * @returns {string|undefined} the proxy URL, when one is named.
 */
export function proxyFor(env: NodeJS.ProcessEnv) {
  const value = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Download one pinned asset with the platform's own `curl`.
 *
 * The child inherits this process's environment — curl reads the proxy
 * variables itself — and a named proxy is ALSO passed as `--proxy`, so the
 * answer does not depend on which of curl's own variables wins. `process.env` is
 * read, never written.
 * @param {object} options - download inputs.
 * @param {{url: string, assetFile: string}} options.pin - what to fetch.
 * @param {string} options.into - the directory to write the asset into.
 * @param {NodeJS.ProcessEnv} options.env - the environment to read.
 * @returns {{file: string}|{error: string, detail: string, stderr: string[]}} the asset, or why not.
 */
export function curlAsset({ pin, into, env }: { pin: Pick<ShellPin, 'url' | 'assetFile'>; into: string; env: NodeJS.ProcessEnv }): { file: string } | { error: string; detail: string; stderr: string[] } {
  const file = path.join(into, pin.assetFile)
  const proxy = proxyFor(env)
  const args = ['--location', '--fail', '--silent', '--show-error', '--output', file]
  if (proxy !== undefined) args.push('--proxy', proxy)
  args.push(pin.url)
  const result = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
    encoding: 'utf8',
    windowsHide: true,
    env,
  })
  if (result.error !== undefined && result.error !== null) {
    return {
      error: `could not run curl: ${String(result.error.message ?? result.error)}`,
      detail: 'Windows 10 and newer ship curl.exe; install curl on this machine, or provision where one exists',
      stderr: [],
    }
  }
  if (result.status !== 0) {
    return {
      error: `curl exited with code ${result.status}`,
      detail: `could not download ${pin.url}`
        + (proxy === undefined ? '' : ` through the proxy ${proxy}`)
        + ' — check the network, the proxy configuration, and whether the upstream release still carries that asset',
      stderr: tailLines(result.stderr),
    }
  }
  return { file }
}

/**
 * A `tar` that can open a zip: Windows' own bsdtar, never the GNU tar a Git
 * installation puts on PATH.
 *
 * The distinction is not cosmetic. GNU tar cannot read a zip container, so
 * pointing it at the PowerShell archive fails with a message about a corrupt
 * archive rather than about the wrong program. `%SystemRoot%\System32\tar.exe`
 * is the bsdtar Windows 10 and newer ship, and its `--version` says so.
 * @param {NodeJS.ProcessEnv} env - the environment to locate it with.
 * @returns {string|undefined} the program, or undefined when there is none.
 */
export function findZipCapableTar(env: NodeJS.ProcessEnv) {
  const candidates = process.platform === 'win32'
    ? [path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe')]
    : []
  candidates.push('tar')
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true })
    if (probe.status === 0 && /bsdtar|libarchive/u.test(`${probe.stdout ?? ''}${probe.stderr ?? ''}`)) {
      return candidate
    }
  }
  return undefined
}

/**
 * Unpack one verified asset into a version directory.
 * @param {object} options - unpack inputs.
 * @param {{extractor: string, extractTo: string}} options.pin - the pin.
 * @param {string} options.asset - the verified archive.
 * @param {string} options.target - the version directory.
 * @returns {{ok: true}|{error: string, stderr: string[]}} the outcome.
 */
export function unpackAsset({ pin, asset, target }: { pin: Pick<ShellPin, 'extractor' | 'extractTo'>; asset: string; target: string }): HelperResult {
  const into = path.resolve(target, pin.extractTo)
  if (pin.extractor === 'zip') {
    const tar = findZipCapableTar(process.env)
    if (tar === undefined) {
      return {
        error: 'no zip-capable tar found',
        stderr: [
          'reading a zip needs a libarchive-based tar: on Windows that is the bsdtar shipped at '
          + '%SystemRoot%\\System32\\tar.exe, because the tar a Git installation puts on PATH is GNU tar, '
          + 'which cannot read a zip. Prefer a `tar.gz` pin on platforms that have one.',
        ],
      }
    }
    return runTool(tar, ['-xf', asset, '-C', into])
  }
  if (pin.extractor === 'sfx-7z') {
    // PortableGit's archive IS a 7-Zip self-extractor: `-o<dir>` names where it
    // unpacks and `-y` answers its own prompts.
    return runTool(asset, [`-o${into}`, '-y'], { cwd: path.dirname(asset) })
  }
  if (pin.extractor === 'tar.gz') {
    // What every POSIX upstream publishes. `tar` here is libarchive's bsdtar on
    // macOS and GNU tar on Linux; both read a gzipped tar, and both keep the
    // mode bits that make the payload spawnable.
    return runTool('tar', ['-xzf', asset, '-C', into])
  }
  return { error: `unknown extractor ${JSON.stringify(pin.extractor)}`, stderr: [] }
}

/**
 * Validate one pin object from a `--pin` file.
 *
 * The fields become path segments (`name`, `version`), a file name
 * (`assetFile`), and an extraction directory (`extractTo`), so they are checked
 * rather than trusted: this table is the one operator-supplied input that
 * reaches the filesystem and the network.
 * @param {unknown} value - the candidate pin.
 * @param {number} index - its position, for the error message.
 * @returns {object} the validated pin.
 * @throws {Error} when a field is missing or malformed.
 */
export function validatePin(value: unknown, index: number): ShellPin {
  const at = `pins[${index}]`
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${at} must be an object`)
  }
  const pin = value as Record<string, unknown>
  for (const field of PIN_REQUIRED_FIELDS) {
    if (pin[field] === undefined) throw new Error(`${at}.${field} is required`)
  }

  /**
   * One field as a non-empty string.
   * @param {string} key - the field.
   * @returns {string} its value.
   */
  const text = (key: string) => {
    const entry = pin[key]
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${at}.${key} must be a non-empty string, got ${JSON.stringify(entry)}`)
    }
    return entry
  }

  /**
   * One field as a value safe to use as a single path segment.
   * @param {string} key - the field.
   * @returns {string} its value.
   */
  const segment = (key: string) => {
    const entry = text(key)
    if (entry.includes('/') || entry.includes('\\') || entry.includes('..') || path.isAbsolute(entry)) {
      throw new Error(`${at}.${key} must be a plain name, got ${JSON.stringify(entry)}`)
    }
    return entry
  }

  /**
   * One field as a relative path that stays inside the version directory.
   * @param {string} key - the field.
   * @returns {string} its value.
   */
  const relative = (key: string) => {
    const entry = text(key)
    if (path.isAbsolute(entry) || entry.split(/[\\/]/u).includes('..')) {
      throw new Error(`${at}.${key} must be a relative path inside the version directory, got ${JSON.stringify(entry)}`)
    }
    return entry
  }

  const name = text('name')
  if (!Object.hasOwn(PLATFORM_PACKAGES, name)) {
    throw new Error(`${at}.name must be one of ${Object.keys(PLATFORM_PACKAGES).join(', ')}, got ${JSON.stringify(name)}`)
  }
  if (!PIN_EXTRACTORS.includes(text('extractor'))) {
    throw new Error(`${at}.extractor must be one of ${PIN_EXTRACTORS.join(', ')}, got ${JSON.stringify(pin.extractor)}`)
  }
  if (!/^[0-9a-f]{64}$/u.test(text('sha256'))) {
    throw new Error(`${at}.sha256 must be 64 lowercase hex characters, got ${JSON.stringify(pin.sha256)}`)
  }
  if (typeof pin.bytes !== 'number' || !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0) {
    throw new Error(`${at}.bytes must be a positive whole number, got ${JSON.stringify(pin.bytes)}`)
  }
  const executableRelativePath = relative('executableRelativePath')
  // The expected file name follows the pin's own platform, not the host's: a pin
  // table is validated on whatever machine runs the provisioner, and a `darwin`
  // pin's payload has no `.exe`.
  const expectedExecutable = shellExecutable(name as ShellKind, text('platform'))
  if (path.basename(executableRelativePath) !== expectedExecutable) {
    throw new Error(`${at}.executableRelativePath must end in ${expectedExecutable}, `
      + `got ${JSON.stringify(executableRelativePath)}`)
  }
  if (pin.executableSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(String(pin.executableSha256))) {
    throw new Error(`${at}.executableSha256 must be 64 lowercase hex characters, got ${JSON.stringify(pin.executableSha256)}`)
  }

  return {
    ...pin,
    name: name as ShellKind,
    sha256: text('sha256'),
    bytes: pin.bytes,
    version: segment('version'),
    platform: text('platform'),
    arch: text('arch'),
    assetFile: segment('assetFile'),
    url: text('url'),
    extractor: text('extractor'),
    extractTo: relative('extractTo'),
    executableRelativePath,
  }
}

/**
 * The pins `provision-shells` works from.
 *
 * The shipped table is the default; `--pin` replaces it with one JSON file — a
 * mirror, an offline pin set, or a test fixture. Every pin that arrives that way
 * is validated, because these values become paths and a download.
 * @param {string|undefined} file - the `--pin` path, when one was given.
 * @returns {object[]} the pins.
 * @throws {Error} when the file is unreadable or a pin is malformed.
 */
export function pinTable(file: string | undefined): ShellPin[] {
  if (file === undefined) return SHELL_UPSTREAM_PINS.filter(pin => pin.name !== 'bash').map((pin, index) => validatePin(pin, index))
  const resolved = path.resolve(file)
  let text
  try {
    text = fs.readFileSync(resolved, 'utf8')
  } catch (error) {
    throw new Error(`--pin does not name a readable file: ${resolved} (${errorMessage(error)})`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`--pin must hold one JSON document of pins: ${errorMessage(error)}`)
  }
  const list = Array.isArray(value) ? value : value !== null && typeof value === 'object' && 'pins' in value ? value.pins : undefined
  if (!Array.isArray(list)) {
    throw new Error('--pin must hold one JSON array of pins (or an object with a "pins" array)')
  }
  return list.map((pin, index) => validatePin(pin, index))
}

/**
 * Read one provision marker, or undefined when it is absent or unreadable.
 * @param {string} file - the marker file.
 * @returns {object|undefined} the parsed marker.
 */
export function readShellReceipt(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * Provision one pinned shell: download, verify, unpack, and record.
 *
 * Nothing outside the deployment is written: the asset lands in a fresh
 * temporary directory that is removed once the copy is in place, and the copy
 * lands in `<DSH_HOME>/dsh-ops/shells/<name>/<version>`. A failure keeps the
 * downloaded bytes and says where they are, because "the digest did not match"
 * is only actionable with the file in hand.
 * @param {object} pin - the validated pin.
 * @param {object} options - run inputs.
 * @param {boolean} options.force - reinstall even when a matching copy is present.
 * @param {boolean} options.dryRun - report what would happen, and download nothing.
 * @returns {boolean} whether this shell is provisioned (or already was).
 */
/**
 * The receipt one provisioned version carries: what pin produced these bytes.
 * @param {object} pin - the validated pin.
 * @returns {string} the JSON document, with a trailing newline.
 */
export function shellReceiptText(pin: ShellPin) {
  return `${JSON.stringify({
    schemaVersion: SHELL_RECEIPT_VERSION,
    name: pin.name,
    version: pin.version,
    releaseTag: pin.releaseTag ?? null,
    upstreamRepo: pin.upstreamRepo ?? null,
    url: pin.url,
    assetFile: pin.assetFile,
    bytes: pin.bytes,
    sha256: pin.sha256,
    extractor: pin.extractor,
    extractTo: pin.extractTo,
    executable: pin.executableRelativePath,
    executableSha256: pin.executableSha256 ?? null,
    provisionedBy: 'dsh-ops provision-shells',
    provisionedAt: new Date().toISOString(),
    dshHome: dshHome(),
  }, null, 2)}\\n`
}

export function provisionShell(pin: ShellPin, { force, dryRun }: { force: boolean; dryRun: boolean }) {
  const target = provisionedShellVersionDir({ kind: pin.name, version: pin.version })
  const executable = path.join(target, pin.executableRelativePath)
  const receiptFile = path.join(target, SHELL_RECEIPT_FILE)
  const receipt = readShellReceipt(receiptFile)
  if (!force && receipt?.sha256 === pin.sha256 && fs.existsSync(executable)) {
    console.log(`${pin.name}: already provisioned — ${executable}`)
    console.log(`  version:    ${pin.version}`)
    console.log(`  sha256:     ${pin.sha256}`)
    return true
  }

  if (dryRun) {
    console.log(`${pin.name}: would provision version ${pin.version} (dry run: no download, no writes)`)
    console.log(`  url:        ${pin.url}`)
    console.log(`  asset:      ${pin.assetFile} (${formatBytes(pin.bytes)})`)
    console.log(`  sha256:     ${pin.sha256}`)
    console.log(`  unpack:     ${pin.extractor} into ${path.resolve(target, pin.extractTo)}`)
    console.log(`  target:     ${target}`)
    console.log(`  executable: ${executable}`)
    return true
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ops-${pin.name}-`))
  const pending = pendingRoot(dshHome())
  /** Keep the bytes an operator needs to act on a failed install, and register them. */
  const keepForDiagnosis = (reason: string): false => {
    const record = recordPendingScratch({ root: pending, kind: pin.name, pinSha256: pin.sha256, scratch, reason })
    if (record.bytes === 0) {
      fs.rmSync(scratch, { recursive: true, force: true })
      console.error('  nothing kept: the download left no bytes in ' + scratch)
      return false
    }
    console.error(`  kept for diagnosis: ${scratch}`)
    console.error(`  registered for reclamation: ${formatBytes(record.bytes)} under ${pending}`)
    return false
  }
  console.log(`${pin.name}: downloading ${pin.url}`)
  const downloaded = curlAsset({ pin, into: scratch, env: process.env })
  if (!('file' in downloaded)) {
    console.error(`${pin.name}: ${downloaded.error} — ${downloaded.detail}`)
    for (const line of downloaded.stderr) console.error(`  curl: ${line}`)
    return keepForDiagnosis('the download did not complete: ' + downloaded.error)
  }

  const actual = sha256File(downloaded.file)
  if (actual !== pin.sha256) {
    console.error(`${pin.name}: ${pin.assetFile} hashed to ${actual}, not the pinned ${pin.sha256}`)
    console.error('  refusing to install bytes this distribution did not pin')
    return keepForDiagnosis('the downloaded archive did not match the pinned sha256')
  }
  console.log(`${pin.name}: verified sha256 ${actual}`)

  // Unpack and verify inside a staging sibling first: the version directory is
  // only ever replaced by a rename of a complete, receipt-carrying tree, so an
  // interrupted or failed install leaves the previous version usable.
  const staged = `${target}.stage-${randomUUID()}`
  let installed = false
  try {
    fs.mkdirSync(path.resolve(staged, pin.extractTo), { recursive: true })
    const unpacked = unpackAsset({ pin, asset: downloaded.file, target: staged })
    if (!('ok' in unpacked)) {
      console.error(`${pin.name}: ${unpacked.error}`)
      for (const line of unpacked.stderr) console.error(`  ${line}`)
      return keepForDiagnosis('the archive did not unpack: ' + unpacked.error)
    }
    const stagedExecutable = path.join(staged, pin.executableRelativePath)
    if (!fs.existsSync(stagedExecutable)) {
      console.error(`${pin.name}: the archive unpacked without ${pin.executableRelativePath}`)
      console.error(`  expected it at ${stagedExecutable}`)
      return keepForDiagnosis('the archive unpacked without the pinned executable')
    }
    if (pin.executableSha256 !== undefined) {
      const executableActual = sha256File(stagedExecutable)
      if (executableActual !== pin.executableSha256) {
        console.error(`${pin.name}: the provisioned ${pin.executableRelativePath} hashed to ${executableActual}, `
          + `not the pinned ${pin.executableSha256}`)
        return keepForDiagnosis('the provisioned executable did not match the pinned sha256')
      }
    }
    fs.writeFileSync(path.join(staged, SHELL_RECEIPT_FILE), shellReceiptText(pin))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const previous = `${target}.previous-${randomUUID()}`
    let displaced = false
    try {
      if (fs.existsSync(target)) {
        fs.renameSync(target, previous)
        displaced = true
      }
      fs.renameSync(staged, target)
      installed = true
    } catch (error) {
      if (displaced) {
        try {
          fs.renameSync(previous, target)
          displaced = false
        } catch (restoreError) {
          console.error(`${pin.name}: could not restore the previous version ${previous}: ${errorMessage(restoreError)}`)
        }
      }
      console.error(`${pin.name}: could not move the verified copy into place: ${errorMessage(error)}`)
      return keepForDiagnosis('the verified copy could not be moved into place')
    }
    if (displaced) {
      try {
        fs.rmSync(previous, { recursive: true, force: true })
      } catch (error) {
        console.error(`  warning:    could not remove the previous version ${previous}: ${errorMessage(error)}`)
      }
    }
  } finally {
    fs.rmSync(staged, { recursive: true, force: true })
  }
  fs.rmSync(scratch, { recursive: true, force: true })
  discardPendingRecord(pending, pin.name, pin.sha256)
  if (!installed) return false

  // The store holds the version the pins name. A previous version is a copy this
  // distribution no longer vouches for — and one the resolution would still
  // consider, because it takes the greatest version name — so it is removed
  // here, after a successful install and never before it. Staging and previous
  // siblings are handled by their own rename above; they are never swept here,
  // because a name pattern alone is not ownership evidence.
  const store = path.join(provisionedShellStore({ env: process.env }), pin.name)
  for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === pin.version) continue
    if (entry.name.includes('.stage-') || entry.name.includes('.previous-')) continue
    const stale = path.join(store, entry.name)
    try {
      fs.rmSync(stale, { recursive: true, force: true })
      console.log(`  removed:    ${stale} (a version this pin no longer names)`)
    } catch (error) {
      console.error(`  warning:    could not remove the previous version ${stale}: ${errorMessage}`)
    }
  }

  console.log(`${pin.name}: provisioned ${executable}`)
  console.log(`  receipt:    ${receiptFile}`)
  return true
}

/** Print one sibling decision; a kept tree names why it stayed. */
function reportNiubashSibling(decision: NiubashSiblingDecision) {
  const bytes = formatBytes(decision.bytes)
  if (decision.action === 'kept') console.log(`  kept:       ${decision.path} (${bytes}; ${decision.detail ?? 'unverified'})`)
  else console.log(`  ${decision.action.padEnd(9)} ${decision.path} (${bytes})`)
}

/** Default Windows Bash provisioner; a custom --pin remains an explicit legacy operation. */
export function provisionNiubash({ force, dryRun }: { force: boolean; dryRun: boolean }) {
  const target = path.join(dshHome(), NIUBASH_HOME_PATH)
  if (dryRun) {
    console.log(`bash: would provision complete Niubash ${NIUBASH_PIN.upstreamVersion} at ${target}`)
    console.log(`  sha256: ${NIUBASH_PIN.archiveSha256}`)
    return true
  }
  if (!force && fs.existsSync(target)) {
    try {
      console.log(`bash: already provisioned — ${verifyNiubashTree(target)}`)
      for (const decision of reclaimNiubashSiblings(target)) reportNiubashSibling(decision)
      return true
    } catch (error) {
      console.error(`bash: invalid Niubash payload: ${errorMessage(error)}; use --force to replace it`)
      console.error('  staging siblings are kept until the target verifies again')
      return false
    }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-niubash-'))
  try {
    let archive = process.env.DSH_OPS_NIUBASH_ARCHIVE
    if (!archive) {
      if (process.env.DSH_OPS_OFFLINE === '1') throw Error('Niubash archive missing in offline mode; no Git Bash fallback')
      const result = curlAsset({ pin: { url: NIUBASH_PIN.url, assetFile: NIUBASH_PIN.archive }, into: scratch, env: process.env })
      if (!('file' in result)) throw Error(`${result.error}: ${result.detail}`)
      archive = result.file
    }
    const executable = stageNiubashArchive(archive, target)
    for (const decision of reclaimNiubashSiblings(target)) reportNiubashSibling(decision)
    console.log(`bash: provisioned complete Niubash ${NIUBASH_PIN.upstreamVersion} — ${executable}`)
    return true
  } catch (error) {
    console.error(`bash: Niubash provisioning failed: ${errorMessage(error)}; no Git Bash fallback`)
    return false
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * `provision-shells`: turn the pinned upstream releases into the local copies
 * the shell rungs prefer.
 *
 * The pointer is the whole distribution story for these two binaries: this
 * command is what reads {@link SHELL_UPSTREAM_PINS}, downloads the exact
 * archive, checks the exact digest, and unpacks it under `DSH_HOME`. A shell
 * that is already there with the pinned digest is left alone (`--force` is the
 * way to reinstall), and `--dry-run` answers "what would this do" without
 * touching the network or the filesystem.
 * @param {object} options - command inputs.
 * @param {('bash'|'pwsh')[]} options.kinds - which shells to provision.
 * @param {boolean} options.force - reinstall even when current.
 * @param {boolean} options.dryRun - report only.
 * @param {string|undefined} options.pinFile - read the pins from this JSON file instead.
 * @returns {number} the exit code: 0 when every selected shell is in place, 1 otherwise.
 */
export function commandProvisionShells({ kinds, force, dryRun, pinFile }: { kinds: ShellKind[]; force: boolean; dryRun: boolean; pinFile?: string }) {
  // The pinned payload is the Windows one: a Windows host carries no POSIX shell, so this
  // distribution provisions and digest-checks one there. A POSIX host already has its
  // distribution's own bash, so there is nothing to install — say that instead of failing on an
  // empty pin table (report: the shell component's POSIX rung).
  if (process.platform !== 'win32') {
    console.error(`dsh-ops provisions shells on Windows only; this host (${process.platform}-${process.arch}) already has its own bash,`
      + " and the shell component resolves it (PATH, then /bin/bash, /usr/bin/bash, /usr/local/bin/bash). Use config.bashPath to pin an explicit executable instead.")
    return 1
  }
  // Reclaim what earlier failed provisions registered: the registry, not a name
  // pattern, decides what is eligible. A dry run changes nothing.
  if (!dryRun) {
    const swept = sweepPendingScratch({ log: (line: string) => { console.log(line) } })
    if (swept.removed.length > 0) console.log(`provision-shells: reclaimed ${swept.removed.length} kept download(s), ${formatBytes(swept.bytes)}`)
    const remaining = swept.kept.length + swept.unverified.length
    if (remaining > 0) console.log(`provision-shells: ${remaining} kept download(s) remain under ${pendingRoot(dshHome())}`)
  }
  let pins
  try {
    pins = pinTable(pinFile)
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  }

  let failed = 0
  if (pinFile === undefined && kinds.includes('bash')) {
    if (!provisionNiubash({ force, dryRun })) failed += 1
    kinds = kinds.filter(kind => kind !== 'bash')
  }
  const selected = []
  for (const kind of kinds) {
    const pin = pins.find((candidate) => (
      candidate.name === kind && candidate.platform === process.platform && candidate.arch === process.arch
    ))
    if (pin === undefined) {
      const covered = [...new Set(pins.map((candidate) => `${candidate.platform}-${candidate.arch}`))].join(', ')
      console.error(`no upstream pin for ${kind} on ${process.platform}-${process.arch}`
        + (covered === '' ? '' : `; the pin table covers ${covered}`)
        + (kind === 'bash'
          ? '. No upstream project publishes a portable bash for every platform: on macOS and Linux '
            + 'point the shell component at the copy the machine already has with `bashPath` '
            + '(for example /opt/homebrew/bin/bash).'
          : '.'))
      return 1
    }
    selected.push(pin)
  }

  for (const pin of selected) {
    if (!provisionShell(pin, { force, dryRun })) failed += 1
  }
  return failed === 0 ? 0 : 1
}
