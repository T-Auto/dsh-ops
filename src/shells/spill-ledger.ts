/**
 * The ownership ledger for host-created spill files.
 *
 * The host's `subprocess-local` provider keeps its complete-output spill files
 * "until external cleanup" and never unlinks them itself (the only unlink is
 * the provider discarding its own stream above the 64 MiB cap). It also has no
 * configuration surface that would let this plugin choose the directory, so the
 * only proof of ownership this plugin can ever have is the `spillPath` it
 * reads back at the settlement of a call it made.
 *
 * This module stores exactly those paths. It appends one JSON line per settled
 * stream to `$DSH_HOME/ops-spill-ledger.jsonl` (mode 0600), removes duplicate
 * paths on load and keeps only the most recent {@link MAX_SPILL_LEDGER_ENTRIES}
 * entries. A write failure never fails the command that produced the spill: the
 * entry stays in memory and the degradation is reported once, so a read-only or
 * revoked `DSH_HOME` degrades retention to a per-process report instead of
 * changing command results.
 *
 * The ledger is not a deletion list on its own. `spill-retention.ts` re-checks
 * every entry against the host's directory and file shape before it deletes
 * anything, and never touches a file that is not listed here.
 *
 * @module dsh-ops/shells/spill-ledger
 */

import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from '../paths.js'

/** File name of the ledger inside `DSH_HOME`. */
export const SPILL_LEDGER_FILE = 'ops-spill-ledger.jsonl'

/** Maximum entries kept after load and after every append. */
export const MAX_SPILL_LEDGER_ENTRIES = 4096

/** POSIX mode of the ledger file: it only ever names paths, but stays private. */
const LEDGER_MODE = 0o600

/** One spill file this plugin's own settlement produced. */
export interface SpillLedgerEntry {
  /** Absent identifies the existing host provider; native files never borrow its naming rule. */
  origin?: 'ops-native-v1'
  /** Absolute path the host reported as `spillPath`. */
  path: string
  /** Stream length in bytes at settlement; what the retained file is expected to hold. */
  bytes: number
  /** Recording process id, matching the pid embedded in the host's file name. */
  pid: number
  /** Session whose call produced the stream, when the caller had one. */
  sessionId?: string
  /** Epoch milliseconds of the settlement that recorded the entry. */
  recordedAt: number
  /** Last deletion failure, retained so the next pass retries instead of forgetting. */
  lastError?: string
}

/** Construction seams; the defaults are the production ones. */
export interface SpillLedgerOptions {
  /** Entry cap; tests use a small one instead of writing 4096 lines. */
  maxEntries?: number
  /** Clock seam. */
  now?: () => number
  /** Called at most once when the ledger can no longer write to disk. */
  report?: (message: string) => void
}

/** What {@link SpillLedger.record} accepts from a settlement. */
export interface SpillLedgerRecord {
  origin?: 'ops-native-v1'
  path: string
  bytes: number
  pid?: number
  sessionId?: string
}

/** Exact native output origin. The recording PID is the kernel, not this Node process. */
export function nativeSpillPathMatches(file: string, pid: number): boolean {
  const directory = /^dsh-ops-native-([1-9]\d*)-[0-9a-f]{32}$/.exec(path.basename(path.dirname(file)))
  return directory !== null && Number(directory[1]) === pid
    && /^(?:stdout|stderr)-[0-9a-f]{32}\.log$/.test(path.basename(file))
}

/**
 * The ledger path for one environment.
 * @param env - the environment to resolve `DSH_HOME` from.
 * @returns the absolute ledger file path.
 */
export function spillLedgerFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dshHome(env), SPILL_LEDGER_FILE)
}

/**
 * Read one ledger line, rejecting anything a compromised or truncated file
 * could put there. A malformed line is skipped, never trusted.
 * @param line - one JSONL line.
 * @returns the validated entry, or undefined.
 */
function parseLedgerLine(line: string): SpillLedgerEntry | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.path !== 'string' || raw.path === '' || !path.isAbsolute(raw.path)) return undefined
  if (typeof raw.bytes !== 'number' || !Number.isFinite(raw.bytes) || raw.bytes < 0) return undefined
  if (typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid <= 0) return undefined
  if (typeof raw.recordedAt !== 'number' || !Number.isFinite(raw.recordedAt)) return undefined
  if (raw.sessionId !== undefined && typeof raw.sessionId !== 'string') return undefined
  if (raw.lastError !== undefined && typeof raw.lastError !== 'string') return undefined
  if (raw.origin !== undefined && raw.origin !== 'ops-native-v1') return undefined
  if (raw.origin === 'ops-native-v1' && (!nativeSpillPathMatches(raw.path, raw.pid)
    || !Number.isSafeInteger(raw.bytes) || raw.bytes > 64 * 1024 * 1024)) return undefined
  return {
    ...(raw.origin === undefined ? {} : { origin: raw.origin }),
    path: raw.path,
    bytes: raw.bytes,
    pid: raw.pid,
    recordedAt: raw.recordedAt,
    ...(raw.sessionId === undefined ? {} : { sessionId: raw.sessionId }),
    ...(raw.lastError === undefined ? {} : { lastError: raw.lastError }),
  }
}

/**
 * Describe a filesystem error without leaking a stack into a report.
 * @param error - the thrown value.
 * @returns a compact code-and-message description.
 */
export function describeSpillError(error: unknown): string {
  if (error === null || typeof error !== 'object') return String(error)
  const code = 'code' in error && typeof error.code === 'string' ? error.code + ': ' : ''
  const message = 'message' in error ? String(error.message ?? '') : String(error)
  return code + message
}

/** Order entries oldest first; ties keep path order so a pass is deterministic. */
function oldestFirst(a: SpillLedgerEntry, b: SpillLedgerEntry): number {
  return a.recordedAt - b.recordedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/**
 * The settled-spill ledger.
 *
 * Construction is side-effect free; the file is read on first use and written
 * with an append plus an atomic rewrite when the entry cap or a state change
 * requires compaction.
 */
export class SpillLedger {
  /** Absolute path of the JSONL file. */
  readonly file: string
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly report: ((message: string) => void) | undefined
  private readonly entriesByPath = new Map<string, SpillLedgerEntry>()
  private loaded = false
  private degradedReason: string | null = null
  private reported = false
  private directoryReady = false
  private modeChecked = false

  constructor(file: string, options: SpillLedgerOptions = {}) {
    this.file = file
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_SPILL_LEDGER_ENTRIES)
    this.now = options.now ?? (() => Date.now())
    this.report = options.report
  }

  /**
   * Load and normalise the file once: malformed lines are dropped, the last
   * record for one path wins and only the newest entries survive the cap.
   * @returns nothing; entries are available through {@link entries}.
   */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    let text: string
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      // A missing ledger is the normal first run. Anything else (a directory in
      // its place, revoked permissions) is a degradation worth reporting once.
      if (!isCode(error, 'ENOENT')) this.degrade(`read failed: ${describeSpillError(error)}`)
      return
    }
    const seen = new Map<string, SpillLedgerEntry>()
    let malformed = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const entry = parseLedgerLine(line)
      if (entry === undefined) {
        malformed++
        continue
      }
      // Re-insert so the most recent occurrence keeps the newest position.
      seen.delete(entry.path)
      seen.set(entry.path, entry)
    }
    const all = [...seen.values()].sort(oldestFirst)
    const kept = all.length > this.maxEntries ? all.slice(all.length - this.maxEntries) : all
    for (const entry of kept) this.entriesByPath.set(entry.path, entry)
    // Compact a file that carried duplicates, malformed lines or excess entries.
    if (malformed > 0 || kept.length !== all.length || this.rawEntryCount(text) !== kept.length) this.rewrite()
  }

  /**
   * Every retained entry, oldest first.
   * @returns a fresh snapshot; mutating it does not change the ledger.
   */
  entries(): SpillLedgerEntry[] {
    this.load()
    return [...this.entriesByPath.values()].sort(oldestFirst)
  }

  /** The one degradation reason, or null while the ledger can still write. */
  degraded(): string | null {
    return this.degradedReason
  }

  /**
   * Record one settled spill. Duplicate paths replace the previous entry.
   * A write failure degrades to memory without throwing.
   * @param input - the settled path and its facts.
   * @returns nothing.
   */
  record(input: SpillLedgerRecord): void {
    if (input === null || typeof input !== 'object') return
    if (typeof input.path !== 'string' || input.path === '' || !path.isAbsolute(input.path)) return
    if (input.origin !== undefined && input.origin !== 'ops-native-v1') return
    if (input.origin === 'ops-native-v1' && (!Number.isSafeInteger(input.pid) || !nativeSpillPathMatches(input.path, input.pid!)
      || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > 64 * 1024 * 1024)) return
    this.load()
    const bytes = typeof input.bytes === 'number' && Number.isFinite(input.bytes) && input.bytes >= 0 ? input.bytes : 0
    const pid = typeof input.pid === 'number' && Number.isSafeInteger(input.pid) && input.pid > 0 ? input.pid : process.pid
    const entry: SpillLedgerEntry = {
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      path: input.path,
      bytes,
      pid,
      recordedAt: Math.round(this.now()),
      ...(typeof input.sessionId === 'string' && input.sessionId !== '' ? { sessionId: input.sessionId } : {}),
    }
    this.entriesByPath.set(entry.path, entry)
    if (this.entriesByPath.size > this.maxEntries) {
      const all = this.entries()
      for (const stale of all.slice(0, all.length - this.maxEntries)) this.entriesByPath.delete(stale.path)
      this.rewrite()
      return
    }
    this.appendLine(entry)
  }

  /**
   * Drop entries whose files are gone or were just deleted.
   * @param paths - the paths to forget.
   * @returns nothing.
   */
  forget(paths: readonly string[]): void {
    if (paths.length === 0) return
    this.load()
    let changed = false
    for (const file of paths) if (this.entriesByPath.delete(file)) changed = true
    if (changed) this.rewrite()
  }

  /**
   * Keep entries whose deletion failed, with the failure attached.
   * @param failures - the paths and their errors.
   * @returns nothing.
   */
  noteFailures(failures: readonly { path: string; error: string }[]): void {
    if (failures.length === 0) return
    this.load()
    let changed = false
    for (const failure of failures) {
      const entry = this.entriesByPath.get(failure.path)
      if (entry === undefined) continue
      this.entriesByPath.set(failure.path, { ...entry, lastError: failure.error })
      changed = true
    }
    if (changed) this.rewrite()
  }

  /** Force the in-memory state to disk (used after a pass changed entries). */
  flush(): void {
    this.load()
    this.rewrite()
  }

  /** Append one record; on failure keep the memory entry and report once. */
  private appendLine(entry: SpillLedgerEntry): void {
    try {
      this.ensureDirectory()
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: LEDGER_MODE })
      this.ensureMode()
    } catch (error) {
      this.degrade(`append failed: ${describeSpillError(error)}`)
    }
  }

  /** Write the whole in-memory state atomically. */
  private rewrite(): void {
    const lines = [...this.entriesByPath.values()].sort(oldestFirst).map(entry => JSON.stringify(entry))
    const body = lines.length === 0 ? '' : lines.join('\n') + '\n'
    const temporary = `${this.file}.${process.pid}.tmp`
    try {
      this.ensureDirectory()
      fs.writeFileSync(temporary, body, { encoding: 'utf8', mode: LEDGER_MODE })
      fs.renameSync(temporary, this.file)
      this.modeChecked = false
      this.ensureMode()
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }) } catch { /* best effort */ }
      this.degrade(`write failed: ${describeSpillError(error)}`)
    }
  }

  /** Create `$DSH_HOME` when the first write happens before the host did. */
  private ensureDirectory(): void {
    if (this.directoryReady) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    this.directoryReady = true
  }

  /** Keep the file at 0600 even when it predates this code path. */
  private ensureMode(): void {
    if (this.modeChecked || process.platform === 'win32') return
    try { fs.chmodSync(this.file, LEDGER_MODE) } catch { /* a filesystem without POSIX modes */ }
    this.modeChecked = true
  }

  /** Record once, and never throw out of a command's settlement path. */
  private degrade(reason: string): void {
    if (this.degradedReason === null) this.degradedReason = reason
    if (this.reported) return
    this.reported = true
    try {
      this.report?.(`dsh-ops: spill ledger cannot be written (${reason}); retaining entries in memory for this process only`)
    } catch { /* a hostile reporter must not fail the command */ }
  }

  /** Count non-empty lines to detect a file that needs compaction. */
  private rawEntryCount(text: string): number {
    let count = 0
    for (const line of text.split('\n')) if (line.trim() !== '') count++
    return count
  }
}

/**
 * A code comparison for a thrown filesystem error.
 * @param error - the thrown value.
 * @param code - the code to test.
 * @returns whether the error carries that code.
 */
export function isCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}

const ledgers = new Map<string, SpillLedger>()

/**
 * The process-wide ledger for the current `DSH_HOME`.
 * @param env - the environment to resolve the file from.
 * @returns the shared ledger instance.
 */
export function getSpillLedger(env: NodeJS.ProcessEnv = process.env): SpillLedger {
  const file = spillLedgerFile(env)
  let ledger = ledgers.get(file)
  if (ledger === undefined) {
    ledger = new SpillLedger(file)
    ledgers.set(file, ledger)
  }
  return ledger
}

/**
 * Record one settled stream when the host actually produced a spill file.
 * Never throws: settlement belongs to the command, not to retention.
 * @param input - the settled path and its facts.
 * @returns whether the entry reached the in-memory ledger.
 */
export function recordSettledSpill(input: SpillLedgerRecord): boolean {
  try {
    getSpillLedger().record(input)
    return true
  } catch {
    return false
  }
}
