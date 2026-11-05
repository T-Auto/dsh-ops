/** Operator-owned Bash installation inventory, selection and receipt-scoped removal. */
import fs from 'node:fs'
import path from 'node:path'
import { NIUBASH_HOME_PATH, NIUBASH_PIN, NIUBASH_RECEIPT, verifyNiubashTree } from '../cli/niubash-payload.js'
import { dshHome } from '../paths.js'
import { provisionedShellStore, shellUpstreamPin, shellExecutable } from './pins.js'
import { isSpawnableFile, wellKnownCandidates } from './paths.js'
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
    for (const entry of selected) fs.rmSync(entry.directory, { recursive: true, force: false })
  }
  return { action: yes && !dryRun ? 'removed' : 'preview', versions: selected, kept: inventory.filter(entry => !entry.owned) }
}

/** Only actual Git install layouts; no PATH launcher, WSL, shim or implicit shell switch. */
export function gitBashCandidates({ env = process.env, platform = process.platform }: BashRuntimeOptions = {}): string[] {
  if (platform !== 'win32') return []
  return [...new Set(wellKnownCandidates({ kind: 'bash', env, platform })
    .filter(file => /[\\/]git[\\/]/i.test(file) && isSpawnableFile(file)).map(file => path.resolve(file)))]
}

/** The row config is a reviewable selection; the host config editor owns persisting and remounting it. */
export function selectBashRuntime(source: 'managed' | 'git', options: BashRuntimeOptions = {}) {
  const platform = options.platform ?? process.platform
  const pin = shellUpstreamPin({ kind: 'bash', platform, arch: options.arch ?? process.arch })
  const relative = pin && 'executableRelativePath' in pin && typeof pin.executableRelativePath === 'string'
    ? pin.executableRelativePath : path.join('bin', shellExecutable('bash', platform))
  const inventory = source === 'managed' ? managedBashInventory(options).filter(entry => entry.owned) : []
  const native = inventory.find(entry => entry.backend === 'niubash')
  // A corrupt selected native installation is actionable, not a reason to switch engines.
  const managed = native ? verifyNiubashTree(native.directory) : inventory
    .sort((a, b) => a.version < b.version ? 1 : a.version > b.version ? -1 : 0)
    .map(entry => path.join(entry.directory, relative)).find(isSpawnableFile)
  const file = source === 'managed' ? managed : source === 'git' ? gitBashCandidates(options)[0] : undefined
  if (!file) throw new Error(source === 'managed' ? 'No managed Bash is installed; run dsh-ops bash-runtime install.' : 'No Git Bash installation found; set bashPath to an existing absolute executable.')
  const absolute = path.resolve(file)
  return { source, file: absolute, config: { bashPath: absolute }, restricted: restrictedCompatibility(absolute, options) }
}
