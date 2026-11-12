/**
 * Bounded retention for the host's complete-output spill files.
 *
 * The host `subprocess-local` provider writes each complete stream that
 * overflows the in-memory tail to a 0600 `.log` file inside a private
 * `<tmpdir>/dsh-subprocess-<6 random characters>/` directory, keeps it "until
 * external cleanup" and never unlinks it. That cleanup does not exist in DSH
 * 0.2.2-rc.1, so without this module every successful, failed, cancelled or
 * timed-out long command leaks its full output until the OS temp cleaner
 * intervenes.
 *
 * This module performs the missing cleanup with an ownership rule that errs on
 * the side of leaving files alone:
 *
 * - only a path recorded in `spill-ledger.ts` at a settlement is a candidate;
 * - the path must resolve to `<realpath(tmpdir)>/dsh-subprocess-<6>/` with the
 *   provider's exact file-name shape and the recording pid;
 * - the file must be a regular file (no symlink), and on POSIX its directory
 *   must be owned by this user with mode 0700;
 * - the file's mtime must be older than the retention window, or the total
 *   retained bytes must exceed the budget (oldest files first);
 * - only individual files are unlinked. The provider creates its directory
 *   once per process and never recreates it, and its random suffix does not
 *   name a pid, so deleting a directory could permanently disable spilling for
 *   a live host. This module never removes a directory.
 *
 * A failed unlink (EPERM/EACCES/E BUSY) keeps the ledger entry with
 * `lastError` so the next pass retries it; it is never forgotten.
 *
 * @module dsh-ops/shells/spill-retention
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeSpillError, getSpillLedger, isCode, type SpillLedger, type SpillLedgerEntry } from './spill-ledger.js'

/** Default retention window; aligned with the upstream spill-local `cleanupPeriodDays`. */
export const DEFAULT_SPILL_RETENTION_DAYS = 30

/** Default total byte budget for retained spill files, in MiB. */
export const DEFAULT_SPILL_TOTAL_BUDGET_MIB = 256

/** Automatic bounded passes are on by default. */
export const DEFAULT_SPILL_SWEEP_ENABLED = true

/** How often an active component runs one bounded pass. */
export const SPILL_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Settlements between two bounded passes; each pass is capped independently. */
export const SPILL_SETTLEMENTS_PER_SWEEP = 256

/** Hard cap on files one pass may unlink, so activation never stalls on I/O. */
export const MAX_SPILL_FILES_PER_PASS = 64

/** The host's private spill directory name: prefix plus `mkdtemp`'s six characters. */
export const SPILL_DIRECTORY_PATTERN = /^dsh-subprocess-[A-Za-z0-9]{6}$/

/** The host's exact per-stream file name. */
export const SPILL_FILE_PATTERN = /^dsh-subprocess-(\d+)-\d+-[0-9a-f]{12}-(?:stdout|stderr)\.log$/

const DAY_MS = 24 * 60 * 60 * 1000
const MIB = 1024 * 1024

/** The three operator-facing retention keys, resolved. */
export interface SpillRetentionConfig {
  /** Files whose mtime is older than this many days are evicted; 0 reports only. */
  retentionDays: number
  /** Retained spill bytes allowed; 0 means no budget. */
  totalBudgetMiB: number
  /** Whether an active component runs automatic passes. */
  sweepEnabled: boolean
}

/** Defaults applied when a caller has no resolved configuration. */
export const DEFAULT_SPILL_RETENTION: SpillRetentionConfig = Object.freeze({
  retentionDays: DEFAULT_SPILL_RETENTION_DAYS,
  totalBudgetMiB: DEFAULT_SPILL_TOTAL_BUDGET_MIB,
  sweepEnabled: DEFAULT_SPILL_SWEEP_ENABLED,
})

/** One eligible file observed at a pass. */
export interface SpillObservation {
  path: string
  size: number
  mtimeMs: number
}

/** One ledger entry this pass declined to touch, with the reason a report can show. */
export interface SpillSkip {
  path: string
  reason: string
}

/** Inputs of the pure eviction plan. */
export interface SpillEvictionOptions {
  now: number
  /** Retention window in milliseconds; null means report-only (never evict). */
  retentionMs: number | null
  /** Total byte budget; Infinity disables the budget. */
  maxTotalBytes: number
  /** Cap on evictions this pass. */
  maxFilesPerPass: number
}

/** The pure eviction decision, before any filesystem mutation. */
export interface SpillEvictionPlan {
  /** Every file older than the window, oldest first (may exceed the pass cap). */
  expired: SpillObservation[]
  /** The files this pass should unlink, oldest first, at most `maxFilesPerPass`. */
  evict: SpillObservation[]
  /** The files a pass leaves alone. */
  kept: SpillObservation[]
  /** Total bytes of every observation, before eviction. */
  totalBytes: number
  /** Total bytes of {@link expired}. */
  expiredBytes: number
}

/** The structural subset of `fs.Stats` a pass reads. */
export interface SpillStats {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  size: number
  mtimeMs: number
  mode: number
  uid: number
}

/** Filesystem seam; tests inject failures and fake entries through it. */
export interface SpillFilesystem {
  realpath(file: string): string
  lstat(file: string): SpillStats
  stat(file: string): SpillStats
  unlink(file: string): void
}

/** The production seam. */
export const NODE_SPILL_FILESYSTEM: SpillFilesystem = {
  realpath: file => fs.realpathSync.native(file),
  lstat: file => fs.lstatSync(file),
  stat: file => fs.statSync(file),
  unlink: file => fs.unlinkSync(file),
}

/** One read-only or mutating pass. */
export interface SpillPassOptions {
  config?: SpillRetentionConfig
  ledger?: SpillLedger
  now?: number
  tmpdir?: string
  fs?: SpillFilesystem
  platform?: NodeJS.Platform
  uid?: number
  maxFilesPerPass?: number
}

/** What one pass observed and did. */
export interface SpillReport {
  checkedAt: number
  ledger: { file: string; entries: number; degraded: string | null }
  retention: SpillRetentionConfig
  /** Ledger files that exist and pass every shape check. */
  existingFiles: number
  existingBytes: number
  /** How many of those are already older than the window. */
  expiredFiles: number
  expiredBytes: number
  /** Ledger entries left alone, with the reason (other providers, foreign files). */
  unknown: SpillSkip[]
  /** Entries a previous or this pass could not delete; retained for a retry. */
  failures: { path: string; error: string }[]
  /** Entries whose file is already gone. */
  missing: number
  /** Files this pass chose to delete (0 in a report-only pass). */
  planned: number
  plannedBytes: number
  /** Files actually unlinked by this pass. */
  deleted: string[]
  deletedBytes: number
  remainingFiles: number
  remainingBytes: number
  /** Set when the pass could not even resolve the temporary directory. */
  fatal?: string
}

/**
 * Sort oldest first, then by path, so a pass is deterministic.
 * @param a - first observation.
 * @param b - second observation.
 * @returns the comparison result.
 */
function byAge(a: SpillObservation, b: SpillObservation): number {
  return a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/**
 * The pure eviction decision.
 *
 * Expired files go first, then the oldest remaining files until the byte
 * budget is met; both are capped by `maxFilesPerPass`. A file whose mtime is
 * exactly `now - retentionMs` is kept: the window is strictly older-than.
 * @param observed - every eligible file the pass could see.
 * @param options - clock, window, budget and cap.
 * @returns the plan; it never mutates the input.
 */
export function planSpillEviction(observed: readonly SpillObservation[], options: SpillEvictionOptions): SpillEvictionPlan {
  const sorted = [...observed].sort(byAge)
  const totalBytes = sorted.reduce((sum, item) => sum + item.size, 0)
  const cutoff = options.retentionMs === null ? Number.NEGATIVE_INFINITY : options.now - options.retentionMs
  const expired = options.retentionMs === null ? [] : sorted.filter(item => item.mtimeMs < cutoff)
  const maxFiles = Math.max(0, Math.min(options.maxFilesPerPass, MAX_SPILL_FILES_PER_PASS))
  const remaining = new Set(sorted)
  const evict: SpillObservation[] = []
  let liveBytes = totalBytes
  for (const item of expired) {
    if (evict.length >= maxFiles) break
    evict.push(item)
    remaining.delete(item)
    liveBytes -= item.size
  }
  if (options.retentionMs !== null && Number.isFinite(options.maxTotalBytes)) {
    for (const item of sorted) {
      if (evict.length >= maxFiles || liveBytes <= options.maxTotalBytes) break
      if (!remaining.delete(item)) continue
      evict.push(item)
      liveBytes -= item.size
    }
  }
  return {
    expired,
    evict,
    kept: sorted.filter(item => remaining.has(item)),
    totalBytes,
    expiredBytes: expired.reduce((sum, item) => sum + item.size, 0),
  }
}

/** The outcome of validating one ledger entry against the filesystem. */
type Observation = { kind: 'file'; observation: SpillObservation } | { kind: 'missing' } | { kind: 'skip'; reason: string }

/**
 * Compare two absolute paths with the host's case rules.
 * @param left - first path.
 * @param right - second path.
 * @param platform - the platform whose comparison applies.
 * @returns whether they name the same path.
 */
function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Validate one ledger entry and observe its file.
 *
 * Every rejection reason is a string a report can print. The function never
 * deletes anything; it only decides whether the file is provably this plugin's
 * own settled spill.
 * @param entry - the ledger entry.
 * @param context - resolved filesystem, temporary root and identity.
 * @returns the observation, or why the entry is skipped.
 */
function observeEntry(entry: SpillLedgerEntry, context: { fs: SpillFilesystem; realTmp: string; platform: NodeJS.Platform; uid: number | undefined }): Observation {
  const file = entry.path
  if (!path.isAbsolute(file)) return { kind: 'skip', reason: 'not-absolute' }
  const directory = path.dirname(file)
  const name = path.basename(file)
  const directoryName = path.basename(directory)
  if (!SPILL_DIRECTORY_PATTERN.test(directoryName)) return { kind: 'skip', reason: 'unexpected-directory' }
  const match = SPILL_FILE_PATTERN.exec(name)
  if (match === null) return { kind: 'skip', reason: 'unexpected-file-name' }
  if (Number(match[1]) !== entry.pid) return { kind: 'skip', reason: 'pid-mismatch' }
  let realDirectory: string
  try {
    realDirectory = context.fs.realpath(directory)
  } catch (error) {
    return isCode(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'skip', reason: 'unreadable-directory' }
  }
  // The provider always creates its directory directly under the real temporary
  // root. A directory reached through any other parent is not the host's shape.
  if (!samePath(realDirectory, path.join(context.realTmp, directoryName), context.platform)) return { kind: 'skip', reason: 'outside-temporary-root' }
  let directoryStat: SpillStats
  try {
    directoryStat = context.fs.stat(directory)
  } catch (error) {
    return isCode(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'skip', reason: 'unreadable-directory' }
  }
  if (!directoryStat.isDirectory()) return { kind: 'skip', reason: 'not-a-directory' }
  if (context.platform !== 'win32') {
    // The provider's 0700 directory is the ownership proof an external file can
    // carry; a wider or non-owned directory may belong to another user/process.
    if ((directoryStat.mode & 0o777) !== 0o700) return { kind: 'skip', reason: 'directory-mode' }
    if (context.uid !== undefined && directoryStat.uid !== context.uid) return { kind: 'skip', reason: 'directory-owner' }
  }
  let fileStat: SpillStats
  try {
    fileStat = context.fs.lstat(file)
  } catch (error) {
    return isCode(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'skip', reason: 'unreadable-file' }
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) return { kind: 'skip', reason: 'not-a-regular-file' }
  let realFile: string
  try {
    realFile = context.fs.realpath(file)
  } catch {
    return { kind: 'skip', reason: 'unreadable-file' }
  }
  if (!samePath(realFile, path.join(realDirectory, name), context.platform)) return { kind: 'skip', reason: 'symlinked-file' }
  return { kind: 'file', observation: { path: file, size: fileStat.size, mtimeMs: fileStat.mtimeMs } }
}

/**
 * Run one pass.
 * @param options - configuration and seams.
 * @param apply - whether eligible files are unlinked (false observes only).
 * @returns the report.
 */
function runPass(options: SpillPassOptions, apply: boolean): SpillReport {
  const config = options.config ?? DEFAULT_SPILL_RETENTION
  const ledger = options.ledger ?? getSpillLedger()
  const now = options.now ?? Date.now()
  const platform = options.platform ?? process.platform
  const filesystem = options.fs ?? NODE_SPILL_FILESYSTEM
  const entries = ledger.entries()
  const report: SpillReport = {
    checkedAt: now,
    ledger: { file: ledger.file, entries: entries.length, degraded: ledger.degraded() },
    retention: { retentionDays: config.retentionDays, totalBudgetMiB: config.totalBudgetMiB, sweepEnabled: config.sweepEnabled },
    existingFiles: 0,
    existingBytes: 0,
    expiredFiles: 0,
    expiredBytes: 0,
    unknown: [],
    failures: [],
    missing: 0,
    planned: 0,
    plannedBytes: 0,
    deleted: [],
    deletedBytes: 0,
    remainingFiles: 0,
    remainingBytes: 0,
  }
  let realTmp: string
  try {
    realTmp = filesystem.realpath(options.tmpdir ?? os.tmpdir())
  } catch (error) {
    report.fatal = 'temporary directory cannot be resolved: ' + describeSpillError(error)
    return report
  }
  const uid = options.uid ?? (typeof process.geteuid === 'function' ? process.geteuid() : undefined)
  const context = { fs: filesystem, realTmp, platform, uid }
  const observed: SpillObservation[] = []
  const forget: string[] = []
  for (const entry of entries) {
    const outcome = observeEntry(entry, context)
    if (outcome.kind === 'missing') {
      report.missing++
      if (apply) forget.push(entry.path)
      continue
    }
    if (outcome.kind === 'skip') {
      report.unknown.push({ path: entry.path, reason: outcome.reason })
      continue
    }
    observed.push(outcome.observation)
  }
  report.existingFiles = observed.length
  report.existingBytes = observed.reduce((sum, item) => sum + item.size, 0)
  const retentionMs = config.retentionDays > 0 ? config.retentionDays * DAY_MS : null
  const maxTotalBytes = config.totalBudgetMiB > 0 ? config.totalBudgetMiB * MIB : Number.POSITIVE_INFINITY
  const plan = planSpillEviction(observed, {
    now,
    retentionMs,
    maxTotalBytes,
    maxFilesPerPass: options.maxFilesPerPass ?? MAX_SPILL_FILES_PER_PASS,
  })
  report.expiredFiles = plan.expired.length
  report.expiredBytes = plan.expiredBytes
  const candidates = retentionMs === null ? [] : plan.evict
  report.planned = candidates.length
  report.plannedBytes = candidates.reduce((sum, item) => sum + item.size, 0)
  if (apply) {
    const failures: { path: string; error: string }[] = []
    for (const candidate of candidates) {
      try {
        filesystem.unlink(candidate.path)
        report.deleted.push(candidate.path)
        report.deletedBytes += candidate.size
        forget.push(candidate.path)
      } catch (error) {
        if (isCode(error, 'ENOENT')) {
          report.missing++
          forget.push(candidate.path)
          continue
        }
        // Keep the entry and the reason: the next pass retries instead of
        // forgetting a file it still owns (the mechanism-3 mistake).
        const message = describeSpillError(error)
        failures.push({ path: candidate.path, error: message })
      }
    }
    if (forget.length > 0) ledger.forget(forget)
    if (failures.length > 0) ledger.noteFailures(failures)
  }
  report.failures = ledger.entries()
    .filter(entry => typeof entry.lastError === 'string')
    .map(entry => ({ path: entry.path, error: entry.lastError as string }))
  report.ledger.degraded = ledger.degraded()
  // A pass counts before/after from what it observed; deleted files cannot still
  // be reported as remaining.
  report.remainingFiles = Math.max(0, report.existingFiles - report.deleted.length)
  report.remainingBytes = Math.max(0, report.existingBytes - report.deletedBytes)
  return report
}

/**
 * Observe the ledger and its files without changing anything.
 * @param options - configuration and seams.
 * @returns the report.
 */
export function inspectSpills(options: SpillPassOptions = {}): SpillReport {
  return runPass(options, false)
}

/**
 * Run one bounded pass that may unlink eligible files.
 * The caller decides whether the automatic trigger is enabled; an explicit
 * sweep still obeys `retentionDays: 0` (report only).
 * @param options - configuration and seams.
 * @returns the report, including what was deleted this pass.
 */
export function sweepSpills(options: SpillPassOptions = {}): SpillReport {
  return runPass(options, true)
}

/**
 * Project the resolved plugin config onto the retention keys.
 * @param config - the resolved row configuration.
 * @returns the retention configuration.
 */
export function spillRetentionConfig(config: Pick<{ spillRetentionDays: number; spillTotalBudgetMiB: number; spillSweepEnabled: boolean }, 'spillRetentionDays' | 'spillTotalBudgetMiB' | 'spillSweepEnabled'>): SpillRetentionConfig {
  return { retentionDays: config.spillRetentionDays, totalBudgetMiB: config.spillTotalBudgetMiB, sweepEnabled: config.spillSweepEnabled }
}
