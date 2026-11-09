/** Operator-owned Bash installation inventory, selection and receipt-scoped removal. */
import fs from 'node:fs'
import path from 'node:path'
import { NIUBASH_HOME_PATH, NIUBASH_PIN, NIUBASH_RECEIPT } from '../cli/niubash-payload.js'
import { unsealDirectorySync } from '../niubash/seal.js'
import { isNiubashExecutable, niubashCandidates, verifiedNiubash } from '../niubash/runtime.js'
import { PACKAGE_ROOT, dshHome } from '../paths.js'
import { provisionedShellStore } from './pins.js'
import { executableNames, isSpawnableFile, isWslBashLauncher, wellKnownCandidates } from './paths.js'
import { restrictedCompatibility } from '../bash-ipc.js'

export interface BashRuntimeOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string }
export interface ManagedBashVersion { directory: string; version: string; owned: boolean; sha256?: string; backend?: 'niubash' }
export interface BashRemovalOptions { env?: NodeJS.ProcessEnv; yes?: boolean; dryRun?: boolean }
const missing = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function assertPhysicalDirectory(directory: string, anchor: string): void {
  const relative = path.relative(anchor, directory)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Bash removal target must be inside DSH_HOME')
  let current = anchor
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    let stat
    try { stat = fs.lstatSync(current) } catch (error) { if (missing(error)) return; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed Bash directories must not traverse links: ' + current)
  }
}

export function managedBashInventory({ env = process.env }: BashRuntimeOptions = {}): ManagedBashVersion[] {
  const home = dshHome(env), store = path.join(provisionedShellStore({ env }), 'bash')
  assertPhysicalDirectory(store, home)
  const native = path.join(home, NIUBASH_HOME_PATH)
  assertPhysicalDirectory(native, home)
  const inventory: ManagedBashVersion[] = []
  if (fs.existsSync(native)) {
    let owned = false
    try {
      const receiptFile = path.join(native, NIUBASH_RECEIPT), stat = fs.lstatSync(receiptFile)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
        const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
        owned = receipt.version === 1 && receipt.backend === 'niubash'
          && receipt.archiveSha256 === NIUBASH_PIN.archiveSha256 && receipt.upstreamVersion === NIUBASH_PIN.upstreamVersion
      }
    } catch { /* An absent or invalid receipt cannot authorize removal. */ }
    inventory.push({ directory: native, version: NIUBASH_PIN.upstreamVersion, backend: 'niubash', owned,
      ...(owned ? { sha256: NIUBASH_PIN.archiveSha256 } : {}) })
  }
  let entries
  try { entries = fs.readdirSync(store, { withFileTypes: true }) } catch (error) { if (missing(error)) return inventory; throw error }
  return [...inventory, ...entries.map(entry => {
    const directory = path.join(store, entry.name)
    assertPhysicalDirectory(directory, home)
    const receiptFile = path.join(directory, '.provisioned.json')
    let receipt: unknown
    try {
      if (!fs.lstatSync(receiptFile).isFile() || fs.lstatSync(receiptFile).isSymbolicLink()) throw new Error('not a regular receipt')
      receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
    } catch { return { directory, version: entry.name, owned: false } }
    if (!record(receipt)) return { directory, version: entry.name, owned: false }
    return { directory, version: entry.name, owned: receipt.schemaVersion === 1 && receipt.name === 'bash'
      && receipt.version === entry.name && typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(receipt.sha256),
      ...(typeof receipt.sha256 === 'string' ? { sha256: receipt.sha256 } : {}) }
  })]
}

/** Reports first; deletes only receipt-marked version directories after explicit operator confirmation. */
export function removeManagedBash({ env = process.env, yes = false, dryRun = false }: BashRemovalOptions = {}): { action: 'removed' | 'preview'; versions: ManagedBashVersion[]; kept: ManagedBashVersion[] } {
  const inventory = managedBashInventory({ env })
  const selected = inventory.filter(entry => entry.owned)
  if (yes && !dryRun) {
    // Validate the complete plan before the first deletion. Never touch an unmarked or system copy.
    for (const entry of selected) assertPhysicalDirectory(entry.directory, dshHome(env))
    // A previous execution seals the shared payload inodes read-only; clear that
    // before deleting an owned copy or Windows refuses with EPERM.
    for (const entry of selected) if (entry.backend === 'niubash') unsealDirectorySync(entry.directory)
    for (const entry of selected) fs.rmSync(entry.directory, { recursive: true, force: false })
  }
  return { action: yes && !dryRun ? 'removed' : 'preview', versions: selected, kept: inventory.filter(entry => !entry.owned) }
}

/** Only actual Git install layouts; no PATH launcher, WSL, shim or implicit shell switch. */
export function gitBashCandidates({ env = process.env, platform = process.platform }: BashRuntimeOptions = {}): string[] {
  if (platform !== 'win32') return []
  return [...new Set([
    // PATH is a real installation the resolution ladder already honours, so the
    // operator must be able to pick it here too. The WSL launcher is not bash.
    ...(env.PATH ?? env.Path ?? '').split(path.delimiter)
      .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
      .filter(directory => directory !== '' && path.isAbsolute(directory))
      .flatMap(directory => executableNames('bash', platform).map(name => path.join(directory, name)))
      .filter(file => isSpawnableFile(file) && !isWslBashLauncher(file, env, platform)),
    ...wellKnownCandidates({ kind: 'bash', env, platform })
      .filter(file => /[\\/]git[\\/]/i.test(file) && isSpawnableFile(file)),
    // A PortableGit copy an older provisioner wrote stays selectable; it is a
    // normal MSYS install, not a hidden second rung.
    ...legacyProvisionedBash({ env, platform }),
  ].map(file => path.resolve(file)))]
}

/** Receipt-owned legacy Git Bash copies from the pre-Niubash provisioner. */
function legacyProvisionedBash(options: BashRuntimeOptions): string[] {
  try {
    return managedBashInventory(options)
      .filter(entry => entry.backend !== 'niubash')
      .map(entry => path.join(entry.directory, 'bin', 'bash.exe'))
      .filter(isSpawnableFile)
  } catch { return [] }
}

/** One explicit executor choice: the default Niubash rung, or a concrete Git Bash/MSYS executable. */
export type BashSelectionSource = 'niubash' | 'git'
/** What a selection resolves to, before the operator saves it to the row config. */
export interface BashSelection {
  source: BashSelectionSource
  /** The executable the choice resolves to, when one is installed. */
  file?: string
  /** Whether saving means removing the explicit `bashPath` (the default rung). */
  clear: boolean
  engine: 'niubash' | 'msys'
  detail: string
  restriction: string
}
export interface BashSelectionOptions extends BashRuntimeOptions { path?: string }

/**
 * Validate one operator choice against the payloads this deployment actually has.
 * Nothing is written: the row config editor owns persisting and remounting it.
 * @param source - the default Niubash rung or an explicit executable.
 * @param options - environment, platform and the explicit path for `git`.
 * @returns the resolved selection, or throws with an actionable reason.
 */
export function selectBashRuntime(source: BashSelectionSource, options: BashSelectionOptions = {}): BashSelection {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (source === 'niubash') {
    // Clearing `bashPath` is the choice: the ladder then prefers the provisioned
    // copy and falls back to the payload shipped inside the package.
    const resolved = niubashCandidates(PACKAGE_ROOT, env).map(candidate => {
      try { return verifiedNiubash(candidate.file, env.PATH ?? env.Path, env) } catch { return undefined }
    }).find(runtime => runtime !== undefined)
    return { source, clear: true, engine: 'niubash',
      ...(resolved === undefined ? {} : { file: resolved.file }),
      detail: resolved === undefined
        ? `No verified Niubash ${NIUBASH_PIN.upstreamVersion} payload is installed; saving clears bashPath and the row reports the missing payload. Run dsh-ops bash-runtime install first.`
        : `Niubash ${NIUBASH_PIN.upstreamVersion} resolved from the deployment's own payload.`,
      restriction: resolved === undefined ? '' : restrictedCompatibility(resolved.file, options).reason ?? '' }
  }
  const requested = options.path?.trim()
  const candidate = requested === undefined || requested === '' ? gitBashCandidates(options)[0] : requested
  if (candidate === undefined) throw new Error('No Git Bash installation found; set bashPath to an existing absolute executable.')
  if (!path.isAbsolute(candidate)) throw new Error('The Bash executable path must be absolute.')
  const absolute = path.resolve(candidate)
  if (!isSpawnableFile(absolute)) throw new Error('The Bash executable does not exist: ' + absolute)
  const engine = isNiubashExecutable(absolute) ? 'niubash' : 'msys'
  if (engine === 'niubash') verifiedNiubash(absolute, env.PATH ?? env.Path, env)
  const check = restrictedCompatibility(absolute, options)
  return { source, file: absolute, clear: false, engine,
    detail: engine === 'niubash' ? 'Explicit Niubash payload selected.' : 'Explicit Git Bash (MSYS) executable selected.',
    restriction: check.compatible
      ? 'This Bash has verified restricted-mode IPC compatibility.'
      : String(check.reason ?? 'Restricted modes cannot use this Bash. A supported sandbox/executor remains required.') }
}

/** The engine behind one resolved executable, for the operator pages and reports. */
export function bashEngine(file: string | undefined): 'niubash' | 'msys' | 'none' {
  if (file === undefined) return 'none'
  return isNiubashExecutable(file) ? 'niubash' : 'msys'
}
