/**
 * Bounded garbage collection for result-cache roots under the system temp directory.
 *
 * A session cache root is created eagerly on the first non-read-only call and named after a
 * one-way digest, so nothing can address it later. The native purge deliberately keeps the root,
 * its `s-<hash>/` directory and the stable lock inode, so even a successful session disposal
 * leaves directory entries behind. This module is the host-side sweep that reclaims them.
 *
 * It never takes the native cache lock and never runs a worker: it validates the directory
 * structure itself (name, no symlink, owner, private mode, whitelisted contents) and only then
 * removes whitelisted names, bottom-up with `rmdir` so a concurrent writer makes the removal
 * fail instead of losing data. Four protections bound what it may touch:
 *
 * 1. the live set of this process is excluded, and an owned-scope sweep only considers roots this
 *    process created;
 * 2. a root must be idle for `maxAgeMs` (owned roots skip the grace during shutdown);
 * 3. every entry must be a whitelisted name — one unknown name skips the whole root;
 * 4. one pass is bounded by a root count and a wall-clock budget, and a failed removal stops it.
 *
 * Two budgets exist. The default only reclaims roots that hold no snapshot data at all (empty, or
 * a shard with just its lock); `maxRoots`/`maxTotalBytes` are aggregate budgets over every
 * `dsh-ops-results-*` root and stay at 0 ("report only") until an operator opts in. The native
 * 100 MiB session quota is a per-nonce quota and is never used as a global budget here.
 *
 * @module dsh-ops/kernel/result-cache-gc
 */
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  completeCleanupRoot, forgetCleanupRoot, listPendingCleanup, liveCleanupRoots, ownedCleanupRoots,
} from './result-cleanup-registry.js'

/** The only directory name the collector may remove. */
export const RESULT_CACHE_ROOT_NAME = /^dsh-ops-results-[0-9a-f]{64}$/
/** One session scope directory inside a root: `s-<sha256(scope)>`. */
const SHARD_NAME = /^s-[0-9a-f]{64}$/
/** Snapshot or staging name written by the native cache: `<uuid>.json` / `<uuid>.tmp`. */
const SNAPSHOT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:json|tmp)$/
const LOCK_NAME = 'lock'
const DEFAULT_MAX_ROOTS_PER_TICK = 512
const DEFAULT_MAX_DURATION_MS = 2000
const MAX_REPORTED_ROOTS = 512

/** Operator-visible retention budget; the config resolver owns the shipped defaults. */
export interface ResultCacheBudget {
  /** Aggregate root count over every `dsh-ops-results-*` root; 0 reports without evicting data. */
  maxRoots: number
  /** Aggregate byte count over every `dsh-ops-results-*` root; 0 reports without evicting data. */
  maxTotalBytes: number
  /** Minimum idle time before a root is touched; 0 disables the grace period. */
  maxAgeMs: number
  /** When false the collector reports only and removes nothing. */
  sweepEnabled: boolean
}

/** How a root looks from the outside. */
export type ResultCacheRootState = 'empty' | 'lock-only' | 'data' | 'live' | 'unknown'

/** One scanned root, bounded to plain facts. */
export interface ResultCacheRootReport {
  name: string
  state: ResultCacheRootState
  bytes: number
  files: number
  ageMs: number
  pending: boolean
  reclaimable: boolean
  reason?: string
}

/** What one collector pass found and did. */
export interface ResultCacheGcReport {
  dir: string
  scanned: number
  roots: number
  totalBytes: number
  pending: number
  reclaimable: number
  reclaimableBytes: number
  planned: number
  /** True when an explicitly configured aggregate budget is exceeded; data roots are reported, never removed. */
  overBudget: boolean
  applied: boolean
  removed: number
  removedBytes: number
  retained: number
  durationMs: number
  /** How many scanned roots are in each state; unknown and live roots are not counted as roots. */
  states: Record<ResultCacheRootState, number>
  errors: string[]
  details: ResultCacheRootReport[]
}

/** Collector inputs; production supplies the validated budget. */
export interface ResultCacheGcOptions {
  budget: ResultCacheBudget
  /** Directory that holds `dsh-ops-results-*` roots; defaults to the canonical temp directory. */
  dir?: string
  /** false plans without deleting; true performs the planned removals. */
  apply?: boolean
  /** `all` scans every root; `owned` considers only roots this process created. */
  scope?: 'all' | 'owned'
  now?: number
  /** Bound on removed roots in one pass. */
  maxRootsPerTick?: number
  /** Bound on the wall-clock time spent removing in one pass. */
  maxDurationMs?: number
}

interface Shard { name: string; files: string[] }
interface Inspection {
  name: string
  root: string
  state: ResultCacheRootState
  bytes: number
  files: number
  ageMs: number
  mtimeMs: number
  shards: Shard[]
  reason?: string
}

let configured: ResultCacheBudget | undefined
let configuredDir: string | undefined
let startupDelayMs = 3000
let startupTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Install the validated budget the result lifecycle should sweep with. An undefined budget
 * disables sweeping, which is what a row without the section, or a test, wants.
 * @param budget - the validated retention budget.
 * @param options - startup delay override, used by tests.
 */
export function configureResultCacheGc(budget: ResultCacheBudget | undefined,
  options: { startupDelayMs?: number; dir?: string } = {}): void {
  configured = budget === undefined ? undefined : { ...budget }
  configuredDir = options.dir
  startupDelayMs = options.startupDelayMs ?? 3000
}

/** Whether a sweep is configured for this process. */
export function resultCacheGcConfigured(): boolean {
  return configured !== undefined
}

/**
 * Schedule the start-up sweep. It is deferred and unref'd so plugin start is never delayed by
 * scanning the temp directory, and one schedule per process is enough.
 * @param delayMs - override the configured delay.
 * @returns nothing; failures are the collector's own report, never a startup error.
 */
export function scheduleStartupResultCacheGc(delayMs = startupDelayMs): void {
  if (configured === undefined || configured.sweepEnabled !== true || startupTimer !== undefined) return
  const budget = { ...configured }, dir = configuredDir
  startupTimer = setTimeout(() => {
    startupTimer = undefined
    try { runResultCacheGc({ budget, dir, scope: 'all', apply: true }) } catch { /* best effort by design */ }
  }, Math.max(0, delayMs))
  startupTimer.unref?.()
}

/** Run the configured sweep now; undefined when no budget is configured. */
export function runConfiguredResultCacheGc(scope: 'all' | 'owned'): ResultCacheGcReport | undefined {
  if (configured === undefined) return undefined
  return runResultCacheGc({ budget: configured, dir: configuredDir, scope, apply: true })
}

function errorText(error: unknown): string {
  return String(error !== null && typeof error === 'object' && 'message' in error ? error.message ?? error : error)
}

function unknownInspection(name: string, root: string, reason: string, mtimeMs = 0, now = Date.now()): Inspection {
  return { name, root, state: 'unknown', bytes: 0, files: 0, ageMs: Math.max(0, now - mtimeMs), mtimeMs, shards: [], reason }
}

/** Private, current-user-owned directory or file — the same rule the native cache enforces. */
function privateOwner(info: fs.Stats): boolean {
  if (info.isSymbolicLink()) return false
  if ((info.mode & 0o077) !== 0) return false
  return typeof process.getuid !== 'function' || info.uid === process.getuid()
}

function inspectFile(parent: string, name: string): { bytes: number } | undefined {
  try {
    const info = fs.lstatSync(path.join(parent, name))
    if (!info.isFile() || !privateOwner(info) || info.nlink !== 1) return undefined
    return { bytes: info.size }
  } catch { return undefined }
}

/** Validate one root's complete structure; any unknown entry turns the whole root into 'unknown'. */
function inspectRoot(dir: string, name: string, now: number): Inspection {
  const root = path.join(dir, name)
  let rootInfo: fs.Stats
  try { rootInfo = fs.lstatSync(root) } catch (error) { return unknownInspection(name, root, 'unreadable', 0, now) }
  const mtimeMs = rootInfo.mtimeMs
  if (!rootInfo.isDirectory()) return unknownInspection(name, root, 'not-a-directory', mtimeMs, now)
  if (!privateOwner(rootInfo)) return unknownInspection(name, root, 'foreign-owner', mtimeMs, now)
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return unknownInspection(name, root, 'unreadable', mtimeMs, now) }
  const shards: Shard[] = []
  let bytes = 0, files = 0
  for (const entry of entries) {
    if (!SHARD_NAME.test(entry.name)) return unknownInspection(name, root, 'unknown-entry', mtimeMs, now)
    const shardRoot = path.join(root, entry.name)
    let shardInfo: fs.Stats
    try { shardInfo = fs.lstatSync(shardRoot) } catch { return unknownInspection(name, root, 'unreadable', mtimeMs, now) }
    if (!shardInfo.isDirectory() || !privateOwner(shardInfo)) return unknownInspection(name, root, 'foreign-shard', mtimeMs, now)
    let children: fs.Dirent[]
    try { children = fs.readdirSync(shardRoot, { withFileTypes: true }) } catch { return unknownInspection(name, root, 'unreadable', mtimeMs, now) }
    const snapshotNames: string[] = []
    for (const child of children) {
      if (child.name !== LOCK_NAME && !SNAPSHOT_NAME.test(child.name)) return unknownInspection(name, root, 'unknown-entry', mtimeMs, now)
      const checked = inspectFile(shardRoot, child.name)
      if (checked === undefined) return unknownInspection(name, root, 'unknown-entry', mtimeMs, now)
      files += 1; bytes += checked.bytes
      if (child.name !== LOCK_NAME) snapshotNames.push(child.name)
    }
    shards.push({ name: entry.name, files: snapshotNames })
  }
  const state: ResultCacheRootState = shards.length === 0 ? 'empty'
    : shards.every(shard => shard.files.length === 0) ? 'lock-only' : 'data'
  return { name, root, state, bytes, files, ageMs: Math.max(0, now - mtimeMs), mtimeMs, shards }
}

/** Remove only the names the inspection validated: snapshots/lock first, then the directories. */
function removeInspectedRoot(inspection: Inspection): void {
  for (const shard of inspection.shards) {
    const shardRoot = path.join(inspection.root, shard.name)
    if (shard.files.length > 0) for (const name of shard.files) fs.unlinkSync(path.join(shardRoot, name))
    try { fs.unlinkSync(path.join(shardRoot, LOCK_NAME)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    fs.rmdirSync(shardRoot)
  }
  fs.rmdirSync(inspection.root)
}

function defaultDir(): string {
  try { return fs.realpathSync(tmpdir()) } catch { return tmpdir() }
}

/**
 * Scan, plan and (optionally) apply one bounded collection pass.
 * @param options - budget, scope and bounds.
 * @returns the bounded report; never throws for a root it cannot inspect.
 */
export function runResultCacheGc(options: ResultCacheGcOptions): ResultCacheGcReport {
  const now = options.now ?? Date.now()
  const dir = path.resolve(options.dir ?? defaultDir())
  const scope = options.scope ?? 'all'
  const apply = options.apply === true
  const sweepEnabled = options.budget.sweepEnabled === true
  const started = Date.now()
  const live = liveCleanupRoots(), owned = ownedCleanupRoots()
  const pending = listPendingCleanup()
  const pendingRoots = new Set(pending.map(record => record.root))
  const report: ResultCacheGcReport = {
    dir, scanned: 0, roots: 0, totalBytes: 0, pending: pending.length, reclaimable: 0, reclaimableBytes: 0,
    planned: 0, overBudget: false, applied: apply && sweepEnabled, removed: 0, removedBytes: 0, retained: 0, durationMs: 0,
    states: { empty: 0, 'lock-only': 0, data: 0, live: 0, unknown: 0 }, errors: [], details: [],
  }
  let names: string[]
  try { names = fs.readdirSync(dir) } catch (error) {
    report.errors.push(`${dir}: ${errorText(error)}`)
    return report
  }
  const inspected: Inspection[] = []
  for (const name of names) {
    if (!RESULT_CACHE_ROOT_NAME.test(name)) continue
    if (scope === 'owned' && !owned.has(path.join(dir, name))) continue
    report.scanned += 1
    const inspection = inspectRoot(dir, name, now)
    if (live.has(inspection.root)) inspection.state = 'live'
    inspected.push(inspection)
    report.states[inspection.state] += 1
    if (inspection.state !== 'unknown' && inspection.state !== 'live') {
      report.roots += 1
      report.totalBytes += inspection.bytes
    }
  }
  // A pending record whose root is gone owes nothing any more.
  for (const record of pending) {
    if (!fs.existsSync(record.root)) completeCleanupRoot(record.root)
  }
  const budget = options.budget, grace = Math.max(0, budget.maxAgeMs)
  const eligible = (inspection: Inspection): boolean => {
    if (inspection.state === 'unknown' || inspection.state === 'live') return false
    if (scope === 'owned' && owned.has(inspection.root)) return true
    return inspection.ageMs >= grace
  }
  // Only structural leftovers are ever candidates: a root that still holds a snapshot is reclaimed
  // by the authorized session purge (or its deferred retry), never by this host-side sweep. The
  // aggregate budgets therefore classify such roots as blocked and report them; they never turn
  // another session's data into a deletion candidate.
  const selected = inspected.filter(inspection => eligible(inspection)
    && (inspection.state === 'empty' || inspection.state === 'lock-only')
  )
  const overBudget = (budget.maxRoots > 0 && report.roots > budget.maxRoots)
    || (budget.maxTotalBytes > 0 && report.totalBytes > budget.maxTotalBytes)
  report.overBudget = overBudget
  report.reclaimable = selected.length
  report.reclaimableBytes = selected.reduce((sum, inspection) => sum + inspection.bytes, 0)
  report.planned = selected.length
  const selectedNames = new Set(selected.map(inspection => inspection.name))
  for (const inspection of inspected) {
    const entry: ResultCacheRootReport = {
      name: inspection.name, state: inspection.state, bytes: inspection.bytes, files: inspection.files,
      ageMs: inspection.ageMs, pending: pendingRoots.has(inspection.root), reclaimable: selectedNames.has(inspection.name),
    }
    if (inspection.reason !== undefined) entry.reason = inspection.reason
    else if (inspection.state === 'live') entry.reason = 'live-in-this-process'
    else if (inspection.state === 'data' && overBudget) entry.reason = 'blocked-over-budget'
    else if (!entry.reclaimable) entry.reason = inspection.ageMs < grace ? 'within-age-grace' : 'blocked-awaiting-authorized-purge'
    if (report.details.length < MAX_REPORTED_ROOTS) report.details.push(entry)
  }
  const maxRoots = Math.max(1, options.maxRootsPerTick ?? DEFAULT_MAX_ROOTS_PER_TICK)
  const maxDuration = Math.max(1, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)
  if (apply && sweepEnabled) for (const inspection of selected) {
    if (report.removed >= maxRoots) break
    if (Date.now() - started > maxDuration) break
    try {
      removeInspectedRoot(inspection)
      completeCleanupRoot(inspection.root)
      report.removed += 1
      report.removedBytes += inspection.bytes
    } catch (error) {
      report.errors.push(`${inspection.name}: ${errorText(error)}`)
      break
    }
  }
  report.retained = inspected.length - report.removed
  report.durationMs = Date.now() - started
  return report
}
