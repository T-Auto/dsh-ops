/**
 * Kept provision scratch directories: a failed download keeps its bytes for
 * diagnosis, a durable record under "<DSH_HOME>/dsh-ops/pending" says where they
 * are, and the next provision reclaims the **registered** ones under an explicit
 * byte / count / age budget.
 *
 * Nothing here ever scans the temporary directory for a name pattern. A
 * directory is only eligible when its own record names it, the record is
 * well-formed, the path is a canonical directory one level below the temporary
 * root, and the name carries this module's own prefix. A failed or unreadable
 * record leaves its directory alone and reports it as unverified.
 *
 * @module dsh-ops/cli/pending-scratch
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dshHome } from '../paths.js'
import { errorMessage } from '../shells/types.js'

/** The receipt directory below DSH_HOME. */
export const PENDING_DIR_PATH = 'dsh-ops/pending'

/** The record schema this build writes and reads. */
export const PENDING_VERSION = 1

/** The kinds "provision-shells" may keep. */
export type PendingKind = 'bash' | 'pwsh'

/** Every record kind this module accepts. */
export const PENDING_KINDS: readonly PendingKind[] = Object.freeze(['bash', 'pwsh'])

/** Default byte budget for kept scratch directories. */
export const PENDING_KEEP_BYTES = 256 * 1024 * 1024

/** Default count budget for kept scratch directories. */
export const PENDING_KEEP_COUNT = 4

/** Default age budget; an older record is reclaimed even inside the other budgets. */
export const PENDING_KEEP_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** The names this module is allowed to reclaim: its own prefix, or a renamed aside of one. */
export const PENDING_SCRATCH_NAME = /^dsh-ops-(?:bash|pwsh)-[A-Za-z0-9]+(?:\.reclaim-[a-z0-9]+)?$/u

/** One stored record. */
export interface PendingRecord {
  version: 1
  kind: PendingKind
  pinSha256: string
  scratch: string
  bytes: number
  reason: string
  at: string
}

/** One record as it is now, with a decision attached. */
export interface PendingItem extends PendingRecord {
  /** Measured bytes of the registered directory. */
  measuredBytes: number
  /** Measured file count. */
  files: number
  /** What a sweep at this budget would do. */
  decision: 'reclaimable' | 'kept' | 'unverified'
  /** Why the item is kept or unverified; absent for a reclaimable item. */
  detail?: string
}

/** The records and what a sweep would do, without changing anything. */
export interface PendingPlan {
  items: PendingItem[]
  invalid: string[]
}

/** What one sweep did. */
export interface PendingSweepResult {
  removed: string[]
  kept: string[]
  unverified: string[]
  bytes: number
}

/** Inputs shared by the plan and the sweep. */
export interface PendingOptions {
  /** The DSH home holding the records; defaults to the process environment's. */
  home?: string
  /** The temporary root the records must point into. */
  tmpRoot?: string
  keepBytes?: number
  keepCount?: number
  keepAgeMs?: number
  now?: () => number
}

/** The receipt directory for one home. */
export function pendingRoot(home: string): string {
  return path.join(home, PENDING_DIR_PATH)
}

/** The canonical form of one path, or the input when it cannot be resolved. */
function canonical(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return target
  }
}

/**
 * Measure a tree without following links out of it.
 * @param directory - the directory to measure.
 * @returns the byte and file totals.
 */
export function directoryBytes(directory: string): { bytes: number, files: number } {
  let bytes = 0
  let files = 0
  const walk = (directoryPath: string): void => {
    let entries
    try {
      entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(directoryPath, entry.name)
      let stat
      try {
        stat = fs.lstatSync(file)
      } catch {
        continue
      }
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(file)
      else {
        bytes += stat.size
        files += 1
      }
    }
  }
  walk(directory)
  return { bytes, files }
}

/** One record's file path, refusing anything but a known kind and a hex digest. */
function recordFile(root: string, kind: PendingKind, pinSha256: string): string {
  if (!PENDING_KINDS.includes(kind)) throw new Error('unknown pending kind ' + JSON.stringify(kind))
  if (!/^[0-9a-f]{64}$/u.test(pinSha256)) throw new Error('a pending record needs the pin sha256')
  return path.join(root, kind + '-' + pinSha256.slice(0, 12) + '.json')
}

/** Reject a record that cannot authorize a deletion. */
function validRecord(value: unknown): value is PendingRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.version === PENDING_VERSION
    && typeof record.kind === 'string'
    && PENDING_KINDS.includes(record.kind as PendingKind)
    && typeof record.pinSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(record.pinSha256)
    && typeof record.scratch === 'string'
    && path.isAbsolute(record.scratch)
    && typeof record.bytes === 'number'
    && Number.isSafeInteger(record.bytes)
    && record.bytes >= 0
    && typeof record.reason === 'string'
    && typeof record.at === 'string'
    && Number.isFinite(Date.parse(record.at))
}

/** Write one record atomically: a crash leaves the old record or none, never half a JSON. */
function writeRecord(root: string, record: PendingRecord): string {
  fs.mkdirSync(root, { recursive: true })
  const file = recordFile(root, record.kind, record.pinSha256)
  const temporary = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n')
  fs.renameSync(temporary, file)
  return file
}

/**
 * Register one kept scratch directory.
 *
 * The path is canonicalized first, so what a later sweep validates is the path it
 * will rename and delete, not a caller's spelling of it.
 * @param options - the record to write.
 * @param options.root - the pending directory.
 * @param options.kind - which shell's download failed.
 * @param options.pinSha256 - the pin the bytes were expected to match.
 * @param options.scratch - the directory this process is keeping.
 * @param options.reason - one line an operator can act on.
 * @param options.now - clock override.
 * @returns the record as written.
 */
export function recordPendingScratch({ root, kind, pinSha256, scratch, reason, now = Date.now }: {
  root: string, kind: PendingKind, pinSha256: string, scratch: string, reason: string, now?: () => number
}): PendingRecord {
  const canonicalScratch = canonical(scratch)
  const usage = directoryBytes(canonicalScratch)
  const record: PendingRecord = {
    version: PENDING_VERSION, kind, pinSha256, scratch: canonicalScratch,
    bytes: usage.bytes, reason, at: new Date(now()).toISOString(),
  }
  writeRecord(root, record)
  return record
}

/** Read every record; a malformed one is named, never interpreted. */
export function readPendingRecords(root: string): { records: PendingRecord[], invalid: string[] } {
  const records: PendingRecord[] = []
  const invalid: string[] = []
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { records, invalid }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.isSymbolicLink()) continue
    const file = path.join(root, entry.name)
    let value: unknown
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      invalid.push(file)
      continue
    }
    if (!validRecord(value)) {
      invalid.push(file)
      continue
    }
    records.push(value)
  }
  return { records, invalid }
}

/** Drop one record file; absent is success. */
export function discardPendingRecord(root: string, kind: PendingKind, pinSha256: string): void {
  try {
    fs.rmSync(recordFile(root, kind, pinSha256), { force: true })
  } catch {
    /* a later sweep retries */
  }
}

/**
 * Plan a sweep without touching the filesystem.
 *
 * Eligibility is decided by the record and the directory it names: the path must
 * already be canonical, its parent must be the canonical temporary root (one
 * segment, no traversal), the basename must be this module's prefix, and the
 * entry must be a real directory. Anything else is "unverified" and stays.
 * @param options - the budget and clock.
 * @returns every item with its decision, plus unreadable record files.
 */
export function planPendingSweep(options: PendingOptions = {}): PendingPlan {
  const home = options.home ?? dshHome()
  const tmpRoot = canonical(options.tmpRoot ?? os.tmpdir())
  const keepBytes = options.keepBytes ?? PENDING_KEEP_BYTES
  const keepCount = options.keepCount ?? PENDING_KEEP_COUNT
  const keepAgeMs = options.keepAgeMs ?? PENDING_KEEP_AGE_MS
  const now = (options.now ?? Date.now)()
  const root = pendingRoot(home)
  const { records, invalid } = readPendingRecords(root)
  const items: PendingItem[] = []
  for (const record of records) {
    const measured = directoryBytes(record.scratch)
    const item: PendingItem = { ...record, measuredBytes: measured.bytes, files: measured.files, decision: 'unverified' }
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(record.scratch)
    } catch {
      item.detail = 'the registered directory is gone'
      items.push(item)
      continue
    }
    if (canonical(record.scratch) !== record.scratch) item.detail = 'the registered path is not canonical'
    else if (path.dirname(record.scratch) !== tmpRoot) item.detail = 'the registered path is not one segment below the temporary root'
    else if (!PENDING_SCRATCH_NAME.test(path.basename(record.scratch))) item.detail = 'the directory name is not this module own prefix'
    else if (!stat.isDirectory() || stat.isSymbolicLink()) item.detail = 'the registered path is not a plain directory'
    else {
      item.decision = 'kept'
      item.detail = 'inside the retention budget'
    }
    items.push(item)
  }
  const eligible = items.filter((item) => item.decision === 'kept')
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || (left.scratch < right.scratch ? -1 : 1))
  let keptBytes = 0
  for (const [index, item] of eligible.entries()) {
    const age = now - Date.parse(item.at)
    if (index < keepCount && keptBytes + item.measuredBytes <= keepBytes && age < keepAgeMs) {
      keptBytes += item.measuredBytes
      continue
    }
    item.decision = 'reclaimable'
    item.detail = age >= keepAgeMs ? 'older than the age budget' : 'outside the byte or count budget'
  }
  return { items, invalid }
}

/**
 * Reclaim the registered scratch directories a plan marked reclaimable.
 *
 * Every deletion is a rename to a sibling ".reclaim-<ts>" name first, then a
 * recursive remove: a remove that fails leaves the aside directory and its
 * rewritten record for the next sweep instead of a half-deleted tree under the
 * original name.
 * @param options - the budget, clock, and injectable filesystem for tests.
 * @returns what was removed, kept, left unverified, and the bytes freed.
 */
export function sweepPendingScratch(options: PendingOptions & {
  rename?: (from: string, to: string) => void
  remove?: (target: string) => void
  log?: (message: string) => void
} = {}): PendingSweepResult {
  const home = options.home ?? dshHome()
  const now = (options.now ?? Date.now)()
  const rename = options.rename ?? ((from: string, to: string): void => { fs.renameSync(from, to) })
  const remove = options.remove ?? ((target: string): void => { fs.rmSync(target, { recursive: true, force: true }) })
  const log = options.log ?? ((): void => {})
  const root = pendingRoot(home)
  const plan = planPendingSweep(options)
  const result: PendingSweepResult = { removed: [], kept: [], unverified: [...plan.invalid], bytes: 0 }
  for (const item of plan.items) {
    if (item.decision === 'unverified') {
      result.unverified.push(item.scratch)
      log('dsh-ops: kept an unverified provision scratch ' + item.scratch + ': ' + (item.detail ?? 'no ownership evidence'))
      continue
    }
    if (item.decision === 'kept') {
      result.kept.push(item.scratch)
      continue
    }
    const aside = item.scratch + '.reclaim-' + now.toString(36)
    try {
      rename(item.scratch, aside)
    } catch (error) {
      result.kept.push(item.scratch)
      log('dsh-ops: could not move aside the provision scratch ' + item.scratch + ': ' + errorMessage(error))
      continue
    }
    try {
      remove(aside)
      result.removed.push(item.scratch)
      result.bytes += item.measuredBytes
      discardPendingRecord(root, item.kind, item.pinSha256)
      log('dsh-ops: reclaimed a kept provision scratch ' + path.basename(item.scratch) + ' (' + item.measuredBytes + ' bytes)')
    } catch (error) {
      // The record now names the aside directory, so the next sweep retries it.
      try {
        writeRecord(root, {
          version: PENDING_VERSION, kind: item.kind, pinSha256: item.pinSha256, scratch: aside,
          bytes: item.measuredBytes, reason: item.reason, at: item.at,
        })
      } catch {
        result.kept.push(aside)
        continue
      }
      result.kept.push(aside)
      log('dsh-ops: removed nothing from the kept provision scratch ' + aside + ': ' + errorMessage(error))
    }
  }
  return result
}
