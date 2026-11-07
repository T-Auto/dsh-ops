/**
 * Offline inspection and reclamation of the temporary resources OPS itself can
 * reproduce: kept provision downloads, Niubash staging siblings, quarantined
 * Bash IPC generations, an interrupted audit-store writer, and per-call Niubash
 * execution trees.
 *
 * Every item carries an ownership evidence string, and nothing is deleted on the
 * strength of its name alone. Being under the right root with the right name only
 * makes an entry a candidate; the decision also needs its record, receipt or
 * provenance, and a deletion outside an explicit offline confirmation never
 * touches a mutable execution root.
 *
 * @module dsh-ops/cli/cache-reclaim
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bashIpcInventory, currentBashIpcIdentity, reclaimBashGenerations } from '../bash-ipc.js'
import { QUARANTINE_RETAIN } from '../bash-ipc.js'
import { hasLiveLease, plainTree } from '../bash-ipc-lifecycle.js'
import { dshHome } from '../paths.js'
import { provisionedShellStore } from '../shells.js'
import { errorMessage } from '../shells/types.js'
import { reclaimNiubashSiblings, verifyNiubashTree, NIUBASH_EXECUTION_DIRECTORIES, NIUBASH_HOME_PATH, NIUBASH_MANIFEST_SHA256, NIUBASH_PIN, NIUBASH_RECEIPT } from './niubash-payload.js'
import { NIUBASH_FACE_RULE, NIUBASH_FACES } from '../niubash/faces.js'
import { pendingRoot, planPendingSweep, sweepPendingScratch } from './pending-scratch.js'

/** The resource classes this command knows, and the only ones it may print or touch. */
export type CacheKind = 'pending-scratch' | 'niubash-sibling' | 'ipc-quarantine' | 'audit-tmp' | 'exec-tree'

/** Every kind, in report order. */
export const CACHE_KINDS: readonly CacheKind[] = Object.freeze([
  'pending-scratch', 'niubash-sibling', 'ipc-quarantine', 'audit-tmp', 'exec-tree',
])

/** One inventory row: what is there, who owns it, and what a reclaim may do. */
export interface CacheItem {
  kind: CacheKind
  path: string
  bytes: number
  files: number
  /** The ownership evidence that makes this row actionable. */
  evidence: string
  /** Reclaimable only after the offline confirmation; everything else is kept or unverified. */
  decision: 'reclaimable' | 'kept' | 'unverified'
  /** Why the item is not reclaimable; absent for a reclaimable item. */
  detail?: string
  /** What a reclaim actually did to this row; absent on a status preview. */
  action?: 'deleted' | 'reused' | 'restored' | 'kept' | 'unverified'
}

/** The whole inventory plus byte totals. */
export interface CacheInventory {
  root: { home: string, temp: string }
  items: CacheItem[]
  totals: { reclaimableBytes: number, keptBytes: number, unverifiedBytes: number, files: number }
  /** Record files that could not be read; they authorize nothing. */
  unreadable: string[]
}

/** The audit-store writer temporary this command may reclaim: "<id>.<uuid>.tmp". */
export const AUDIT_TMP_NAME = /^(?:j|r)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u

/** Inputs shared by status and reclaim. */
export interface CacheOptions {
  /** The DSH home; defaults to the process environment's. */
  home?: string
  /** Additional audit-store roots ("<root>/.dsh-ops") the operator names explicitly. */
  roots?: string[]
  /** The temporary root; defaults to the platform's. */
  tmpRoot?: string
  now?: number
  log?: (message: string) => void
}

/** A refusal that must end the command with exit code 2, not a partial deletion. */
export class CacheSafetyError extends Error {}

/** The canonical form of one path, or the input when it cannot be resolved. */
function canonical(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return target
  }
}

/** Whether a target stays inside a root, by relative segments rather than string prefix. */
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** A plain directory, never a link. */
function plainDirectory(target: string): boolean {
  try {
    const stat = fs.lstatSync(target)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** Bytes and files below one tree, without following links. */
function treeUsage(directory: string): { bytes: number, files: number } {
  let bytes = 0
  let files = 0
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

/** The fixed Niubash target under one home. */
function niubashTarget(home: string): string {
  return path.join(home, NIUBASH_HOME_PATH)
}

/** Every staged or previous Niubash sibling beside the fixed target. */
function niubashSiblings(home: string): string[] {
  const target = niubashTarget(home)
  const parent = path.dirname(target)
  const base = path.basename(target)
  let entries
  try { entries = fs.readdirSync(parent, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter((entry) => entry.name.startsWith(base + '.stage-') || entry.name.startsWith(base + '.previous-'))
    .map((entry) => path.join(parent, entry.name))
}

/** Whether one Niubash sibling is a complete tree this command may reuse or delete. */
function niubashSiblingComplete(sibling: string): boolean {
  try {
    verifyNiubashTree(sibling)
    return true
  } catch {
    return false
  }
}

/** The quarantine rows of one Bash IPC root, with the offline rule applied. */
function quarantineItems(home: string, inventory: ReturnType<typeof bashIpcInventory>): CacheItem[] {
  const items: CacheItem[] = []
  const quarantines = inventory.entries.filter((entry) => entry.kind === 'quarantine')
  for (const [index, entry] of quarantines.entries()) {
    const target = path.join(inventory.root, entry.name)
    const item: CacheItem = {
      kind: 'ipc-quarantine', path: target, bytes: entry.bytes, files: entry.files,
      evidence: 'ipc-quarantine', decision: 'kept', detail: 'retained beside the current generation',
    }
    if (!plainTree(target)) item.decision = 'unverified'
    else if (hasLiveLease(target)) item.detail = 'a live lease still names this copy'
    else if (index >= QUARANTINE_RETAIN) {
      item.decision = 'reclaimable'
      item.detail = 'offline confirmation reclaimed all but the newest quarantines'
      delete item.detail
    }
    items.push(item)
  }
  return items
}

/** Audit-store writer temporaries below one explicitly named root. */
function auditItems(root: string): CacheItem[] {
  const store = path.join(root, '.dsh-ops')
  let entries
  try { entries = fs.readdirSync(store, { withFileTypes: true }) } catch { return [] }
  const items: CacheItem[] = []
  for (const entry of entries) {
    if (!AUDIT_TMP_NAME.test(entry.name)) continue
    const target = path.join(store, entry.name)
    let stat
    try { stat = fs.lstatSync(target) } catch { continue }
    if (!stat.isFile() || stat.isSymbolicLink()) continue
    items.push({ kind: 'audit-tmp', path: target, bytes: stat.size, files: 1, evidence: 'audit-namespace', decision: 'reclaimable' })
  }
  return items
}

/** Offline stat-only verification of one per-call execution tree: path set, sizes and receipt, no payload byte. */
function verifyExecutionTreeForReclaim(target: string): void {
  const executable = 'winuxcmd/usr/bin/winuxcmd.exe'
  const sizes: Readonly<Record<string, number>> = NIUBASH_PIN.sizes
  const allowedDirectories = new Set([...NIUBASH_PIN.directories, ...NIUBASH_EXECUTION_DIRECTORIES])
  const derived = new Set(NIUBASH_FACES.map(face => `winuxcmd/usr/bin/${face}.exe`))
  const walk = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(target, relative), { withFileTypes: true })) {
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`
      const file = path.join(target, name)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error(`Unsafe execution tree member: ${name}`)
      if (stat.isDirectory()) {
        if (!allowedDirectories.has(name)) throw new Error(`Unknown execution tree directory: ${name}`)
        walk(name)
        continue
      }
      if (!stat.isFile()) throw new Error(`Unsafe execution tree member: ${name}`)
      if (name === 'execution-provenance.json' || name === NIUBASH_RECEIPT) continue
      if (Object.hasOwn(NIUBASH_PIN.files, name)) {
        if (stat.size !== sizes[name]) throw new Error(`Execution tree size mismatch: ${name}`)
      } else if (derived.has(name)) {
        if (stat.size !== sizes[executable]) throw new Error(`Execution tree size mismatch: ${name}`)
      } else throw new Error(`Unknown execution tree member: ${name}`)
    }
  }
  walk('')
  const receipt: unknown = JSON.parse(fs.readFileSync(path.join(target, 'execution-provenance.json'), 'utf8'))
  if (typeof receipt !== 'object' || receipt === null) throw new Error('Invalid execution provenance receipt')
  const value = receipt as Record<string, unknown>
  if (value.version !== 1 || value.rule !== NIUBASH_FACE_RULE
    || value.sourceManifestSha256 !== NIUBASH_MANIFEST_SHA256
    || (value.mode !== 'hardlink' && value.mode !== 'copy')
    || (value.seal !== 'readonly+acl' && value.seal !== 'readonly')) throw new Error('Invalid execution provenance receipt')
}

/** Per-call Niubash execution trees: verified against their own execution provenance. */
function execItems(tmpRoot: string): CacheItem[] {
  let entries
  try { entries = fs.readdirSync(tmpRoot, { withFileTypes: true }) } catch { return [] }
  const items: CacheItem[] = []
  for (const entry of entries) {
    if (!entry.name.startsWith('dsh-ops-niu-exec-')) continue
    const target = path.join(tmpRoot, entry.name)
    if (!plainDirectory(target)) {
      items.push({ kind: 'exec-tree', path: target, bytes: 0, files: 0, evidence: 'execution-provenance', decision: 'unverified', detail: 'not a plain directory' })
      continue
    }
    const usage = treeUsage(target)
    const item: CacheItem = { kind: 'exec-tree', path: target, bytes: usage.bytes, files: usage.files, evidence: 'execution-provenance', decision: 'unverified' }
    try {
      verifyExecutionTreeForReclaim(target)
      item.decision = 'reclaimable'
      item.detail = 'offline confirmation required; the tree carries a complete execution provenance'
    } catch (error) {
      item.detail = 'the execution provenance does not verify: ' + errorMessage(error)
    }
    items.push(item)
  }
  return items
}

/**
 * Build the inventory without changing anything.
 * @param options - the home, named audit roots and clock.
 * @returns every candidate row, its evidence, and byte totals.
 */
export function cacheInventory({ home = dshHome(), roots = [], tmpRoot = os.tmpdir(), now = Date.now() }: CacheOptions = {}): CacheInventory {
  const canonicalTmp = canonical(tmpRoot)
  const items: CacheItem[] = []
  const unreadable: string[] = []
  const pending = planPendingSweep({ home, tmpRoot: canonicalTmp, now: () => now })
  unreadable.push(...pending.invalid)
  for (const item of pending.items) {
    items.push({
      kind: 'pending-scratch', path: item.scratch, bytes: item.measuredBytes, files: item.files,
      evidence: 'pending-record', decision: item.decision === 'reclaimable' ? 'reclaimable' : item.decision,
      ...(item.decision === 'reclaimable' ? {} : { detail: item.detail ?? 'unverified record' }),
    })
  }
  for (const sibling of niubashSiblings(home)) {
    if (!plainDirectory(sibling)) {
      items.push({ kind: 'niubash-sibling', path: sibling, bytes: 0, files: 0, evidence: 'niubash-provenance', decision: 'unverified', detail: 'not a plain directory' })
      continue
    }
    const usage = treeUsage(sibling)
    const complete = niubashSiblingComplete(sibling)
    items.push({
      kind: 'niubash-sibling', path: sibling, bytes: usage.bytes, files: usage.files,
      evidence: 'niubash-provenance', decision: complete ? 'reclaimable' : 'unverified',
      ...(complete ? {} : { detail: 'the sibling does not verify against the compiled inventory' }),
    })
  }
  const ipc = bashIpcInventory({ home, confirmedStopped: true })
  items.push(...quarantineItems(home, ipc))
  for (const root of roots) items.push(...auditItems(root))
  items.push(...execItems(canonicalTmp))
  const totals = { reclaimableBytes: 0, keptBytes: 0, unverifiedBytes: 0, files: 0 }
  for (const item of items) {
    totals.files += item.files
    if (item.decision === 'reclaimable') totals.reclaimableBytes += item.bytes
    else if (item.decision === 'kept') totals.keptBytes += item.bytes
    else totals.unverifiedBytes += item.bytes
  }
  return { root: { home, temp: canonicalTmp }, items, totals, unreadable }
}

/** What one apply run did, with the same rows as the inventory. */
export interface CacheReclaimResult extends CacheInventory {
  deletedBytes: number
  errors: number
}

/** Rename one entry aside, then remove it; a failed removal leaves the aside for the next run. */
function removeAsAside(target: string, now: number): { ok: boolean, detail?: string } {
  const aside = target + '.reclaim-' + now.toString(36)
  try {
    fs.renameSync(target, aside)
  } catch (error) {
    return { ok: false, detail: 'could not move it aside: ' + errorMessage(error) }
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: 'could not remove it: ' + errorMessage(error) }
  }
}

/**
 * Apply the inventory, or return it unchanged when apply is false.
 *
 * An apply run refuses outright without the offline confirmation: several of
 * these roots belong to processes that may still be running, and a partial
 * deletion is worse than a refusal.
 * @param options - the run inputs.
 * @returns the rows with their action and the bytes actually freed.
 */
export function cacheReclaim({
  apply = false, allHostsStopped = false, kinds = CACHE_KINDS, ...options
}: CacheOptions & { apply?: boolean, allHostsStopped?: boolean, kinds?: readonly CacheKind[] } = {}): CacheReclaimResult {
  const home = options.home ?? dshHome()
  const now = options.now ?? Date.now()
  const log = options.log ?? ((): void => {})
  if (apply && !allHostsStopped) throw new CacheSafetyError('Stop every OPS host and Bash job, then confirm with --yes --all-hosts-stopped. No cache was changed.')
  const inventory = cacheInventory({ ...options, home, now, roots: options.roots ?? [] })
  const wanted = new Set(kinds)
  const result: CacheReclaimResult = { ...inventory, deletedBytes: 0, errors: 0 }
  for (const item of result.items) {
    if (!wanted.has(item.kind)) continue
    item.action = item.decision === 'unverified' ? 'unverified' : 'kept'
    if (!apply || item.decision !== 'reclaimable') continue
    try {
      if (item.kind === 'pending-scratch') {
        const sweep = sweepPendingScratch({ home, tmpRoot: inventory.root.temp, now: () => now, log })
        const removed = sweep.removed.includes(item.path)
        item.action = removed ? 'deleted' : (sweep.unverified.includes(item.path) ? 'unverified' : 'kept')
        if (removed) result.deletedBytes += item.bytes
      } else if (item.kind === 'niubash-sibling') {
        const decisions = reclaimNiubashSiblings(niubashTarget(home), { log })
        const decision = decisions.find((candidate) => candidate.path === item.path)
        item.action = decision === undefined ? 'kept'
          : decision.action === 'reused' ? 'reused'
            : decision.action === 'restored' ? 'restored'
              : decision.action === 'removed' ? 'deleted' : 'kept'
        if (item.action === 'deleted' || item.action === 'reused' || item.action === 'restored') result.deletedBytes += item.bytes
      } else {
        const outcome = removeAsAside(item.path, now)
        item.action = outcome.ok ? 'deleted' : 'kept'
        if (outcome.ok) result.deletedBytes += item.bytes
        if (!outcome.ok) {
          item.detail = outcome.detail
          result.errors += 1
        }
      }
    } catch (error) {
      item.action = 'kept'
      item.detail = errorMessage(error)
      result.errors += 1
    }
  }
  if (apply) {
    // Quarantined copies live in the IPC root and are reclaimed by its own sweep, under its own
    // lock and retain rule, rather than by this loop.
    const ipcKinds = result.items.some((item) => item.kind === 'ipc-quarantine' && wanted.has(item.kind))
    if (ipcKinds) {
      try {
        const reclaimed = reclaimBashGenerations(path.join(home, 'dsh-ops', 'bash-ipc'),
          currentBashIpcIdentity(undefined) ?? '', { confirmedStopped: true, retainQuarantine: QUARANTINE_RETAIN, log })
        const names = new Set(reclaimed.removed)
        for (const item of result.items) {
          if (item.kind !== 'ipc-quarantine') continue
          if (names.has(path.basename(item.path))) {
            item.action = 'deleted'
            result.deletedBytes += item.bytes
          } else if (item.action === undefined) item.action = 'kept'
        }
      } catch (error) {
        result.errors += 1
        log('dsh-ops: the Bash IPC cleanup failed: ' + errorMessage(error))
      }
    }
  }
  return result
}

/** The inventory for one row, as one printable line. */
export function formatCacheItem(item: CacheItem): string {
  const bytes = item.bytes >= 1024 * 1024 ? (item.bytes / (1024 * 1024)).toFixed(1) + ' MiB' : (item.bytes / 1024).toFixed(1) + ' KiB'
  const state = item.action ?? item.decision
  const detail = item.detail === undefined ? '' : ' — ' + item.detail
  return state.padEnd(11) + ' ' + item.kind.padEnd(16) + ' ' + bytes.padStart(10) + '  ' + item.path + '  [' + item.evidence + ']' + detail
}

/**
 * "dsh-ops cache": report what OPS can reproduce on disk, and with --yes reclaim it.
 * @param action - "status" or "reclaim".
 * @param options - the CLI flags.
 * @returns the exit code: 0 success or preview, 1 a deletion failed, 2 a safety refusal.
 */
export function commandCache(action: string, {
  yes = false, dryRun = false, allHostsStopped = false, kinds, roots, json = false, home, now,
}: {
  yes?: boolean, dryRun?: boolean, allHostsStopped?: boolean, kinds?: readonly CacheKind[], roots?: string[], json?: boolean, home?: string, now?: number
} = {}): number {
  if (action !== 'status' && action !== 'reclaim') throw new Error('Expected cache status or cache reclaim.')
  for (const kind of kinds ?? []) {
    if (!CACHE_KINDS.includes(kind)) throw new Error('--kind must be one of ' + CACHE_KINDS.join(', ') + ', got ' + JSON.stringify(kind))
  }
  const apply = action === 'reclaim' && yes && !dryRun
  if (apply && !allHostsStopped) {
    console.error('dsh-ops: stop every OPS host and Bash job, then confirm with --yes --all-hosts-stopped. No cache was changed.')
    return 2
  }
  if (action === 'status' && yes) throw new Error('--yes applies to cache reclaim only.')
  const options = { ...(home === undefined ? {} : { home }), ...(now === undefined ? {} : { now }), roots: roots ?? [] }
  const report: CacheInventory | CacheReclaimResult = apply
    ? cacheReclaim({ ...options, apply: true, allHostsStopped, ...(kinds === undefined ? {} : { kinds }) })
    : cacheInventory(options)
  const deletedBytes = apply ? (report as CacheReclaimResult).deletedBytes : 0
  const errors = apply ? (report as CacheReclaimResult).errors : 0
  const items = kinds === undefined ? report.items : report.items.filter((item) => kinds.includes(item.kind))
  if (json) {
    console.log(JSON.stringify({
      action: apply ? 'reclaimed' : 'preview', root: report.root, items, totals: report.totals,
      deletedBytes, errors, unreadable: report.unreadable,
    }, null, 2))
    return errors > 0 ? 1 : 0
  }
  if (items.length === 0) console.log('dsh-ops cache: nothing to report')
  for (const item of items) console.log(formatCacheItem(item))
  console.log('')
  console.log('reclaimable: ' + (report.totals.reclaimableBytes / (1024 * 1024)).toFixed(1) + ' MiB; kept: '
    + (report.totals.keptBytes / (1024 * 1024)).toFixed(1) + ' MiB; unverified: '
    + (report.totals.unverifiedBytes / (1024 * 1024)).toFixed(1) + ' MiB')
  if (!apply) console.log('Preview only. Reclaim after stopping all OPS hosts: dsh-ops cache reclaim --yes --all-hosts-stopped')
  else console.log('reclaimed: ' + (deletedBytes / (1024 * 1024)).toFixed(1) + ' MiB; failed entries: ' + errors)
  return errors > 0 ? 1 : 0
}
