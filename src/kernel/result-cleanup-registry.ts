/**
 * Persistent ledger of result-cache roots that still owe physical cleanup.
 *
 * A result cache root is named after a one-way digest of session, workspace and nonce, so once
 * its in-memory location is gone nothing can name it again. This module is the durable answer to
 * that: one bounded JSON record per root, written before the first caller receives the storage
 * handle, so a cleanup that fails (read-only authority, changed authority, timeout, EPERM) is
 * deferred instead of forgotten. Records live under the real temp directory, are written with a
 * temporary file plus atomic rename, and are removed only after a cleanup actually completed.
 *
 * The module also owns the process-local view of the ledger: which roots are live in this process
 * right now, and which ones this process created. The garbage collector must never touch the
 * live set, and a shutdown sweep only needs the owned set.
 *
 * @module dsh-ops/kernel/result-cleanup-registry
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

/** On-disk record shape version; a record with another version is ignored, never migrated. */
export const CLEANUP_REGISTRY_VERSION = 1
/** Hard bound on the number of pending records read or written per pass. */
export const MAX_CLEANUP_RECORDS = 4096
/** Hard bound on the process-local owned-root set. */
const MAX_OWNED_ROOTS = 4096
const MAX_PATH_LENGTH = 4096
const MAX_REASON_LENGTH = 64

/** Why the last cleanup attempt did not complete. */
export type CleanupReason = 'read-only' | 'authority-changed' | 'cache-grant-changed' | 'timeout' | 'eperm' | 'other'

/** One root that still owes cleanup, as persisted under the temp directory. */
export interface CleanupRecord {
  version: number
  root: string
  /** sha256 of the session id; the ledger never stores the session id itself. */
  sessionHeading: string
  workspaceRoot: string
  createdAt: number
  lastAttemptAt: number
  attempts: number
  lastReason: CleanupReason
  /** Random id of the process that first registered the root. */
  hostBoot: string
  state: 'pending'
}

/** What {@link registerCleanupRoot} needs from the caller. */
export interface CleanupRootInfo {
  sessionHeading: string
  workspaceRoot: string
}

let registryOverride: string | undefined
let bootId = randomUUID()
const live = new Set<string>()
const owned = new Set<string>()

/** Point the ledger at an explicit directory; production never calls this. */
export function setCleanupRegistryDir(dir: string | undefined): void {
  registryOverride = dir === undefined ? undefined : path.resolve(dir)
}

/** The directory holding one record per pending root. */
export function cleanupRegistryDir(): string {
  if (registryOverride !== undefined) return registryOverride
  return path.join(fs.realpathSync(tmpdir()), 'dsh-ops-cleanup-registry')
}

/** Replace the boot id; only a test that simulates a restart needs this. */
export function resetCleanupHostBoot(): void {
  bootId = randomUUID()
}

/** Record that this process currently owns the root (GC must exclude it). */
export function markCleanupRootLive(root: string): void {
  live.add(root); owned.add(root)
  while (owned.size > MAX_OWNED_ROOTS) {
    const oldest = owned.values().next().value
    if (oldest === undefined) break
    owned.delete(oldest)
  }
}

/** Record that this process no longer owns the root; a pending record may still exist. */
export function releaseCleanupRootLive(root: string): void {
  live.delete(root)
}

/** Roots this process is using right now. */
export function liveCleanupRoots(): ReadonlySet<string> {
  return live
}

/** Roots this process created and has not yet reclaimed. */
export function ownedCleanupRoots(): ReadonlySet<string> {
  return owned
}

/** Forget every process-local fact about the root, including its owned flag. */
export function forgetCleanupRoot(root: string): void {
  live.delete(root); owned.delete(root)
}

/** Bound a persisted string field so a record can never grow without limit. */
function bounded(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function reasonOf(value: unknown): CleanupReason {
  return value === 'read-only' || value === 'authority-changed' || value === 'cache-grant-changed'
    || value === 'timeout' || value === 'eperm' ? value : 'other'
}

/** The ledger directory must be private and ours before anything is written into it. */
function ensureDir(): string | undefined {
  const dir = cleanupRegistryDir()
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const info = fs.lstatSync(dir)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return undefined
    return dir
  } catch {
    return undefined
  }
}

function recordPath(dir: string, root: string): string {
  return path.join(dir, `${createHash('sha256').update(root).digest('hex')}.json`)
}

/** Write one record with a temporary file plus atomic rename; a failure is reported, never thrown. */
function writeRecord(dir: string, record: CleanupRecord): boolean {
  const target = recordPath(dir, record.root), temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    const descriptor = fs.openSync(temporary, 'w', 0o600)
    try {
      fs.writeFileSync(descriptor, JSON.stringify(record))
      fs.fsyncSync(descriptor)
    } finally { fs.closeSync(descriptor) }
    fs.renameSync(temporary, target)
    return true
  } catch {
    try { fs.rmSync(temporary, { force: true }) } catch { /* the temporary never carries data */ }
    return false
  }
}

/** Read one root's record directly; a missing or corrupt file is simply no record. */
function readRecord(dir: string, root: string): CleanupRecord | undefined {
  try { return parseRecord(JSON.parse(fs.readFileSync(recordPath(dir, root), 'utf8'))) } catch { return undefined }
}

/** Narrow one parsed record; anything else is a foreign or corrupt file and is ignored. */
function parseRecord(value: unknown): CleanupRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.version !== CLEANUP_REGISTRY_VERSION || record.state !== 'pending') return undefined
  const root = bounded(record.root, MAX_PATH_LENGTH)
  if (!path.isAbsolute(root)) return undefined
  const attempts = record.attempts
  return {
    version: CLEANUP_REGISTRY_VERSION,
    root,
    sessionHeading: bounded(record.sessionHeading, 64),
    workspaceRoot: bounded(record.workspaceRoot, MAX_PATH_LENGTH),
    createdAt: Number.isFinite(record.createdAt) ? Number(record.createdAt) : 0,
    lastAttemptAt: Number.isFinite(record.lastAttemptAt) ? Number(record.lastAttemptAt) : 0,
    attempts: Number.isSafeInteger(attempts) && Number(attempts) >= 0 ? Number(attempts) : 0,
    lastReason: reasonOf(record.lastReason),
    hostBoot: bounded(record.hostBoot, MAX_REASON_LENGTH),
    state: 'pending',
  }
}

/**
 * Register a root before its storage handle is returned. An existing record keeps its original
 * creation facts and attempt history; a rewrite only refreshes the ownership facts.
 * @param root - the absolute result-cache root.
 * @param info - bounded ownership facts.
 * @param now - current time, for tests.
 * @returns the persisted record, or undefined when the ledger cannot be written.
 */
export function registerCleanupRoot(root: string, info: CleanupRootInfo, now = Date.now()): CleanupRecord | undefined {
  const dir = ensureDir()
  if (!dir) return undefined
  const existing = readRecord(dir, root)
  const record: CleanupRecord = existing === undefined ? {
    version: CLEANUP_REGISTRY_VERSION,
    root: bounded(root, MAX_PATH_LENGTH),
    sessionHeading: bounded(info.sessionHeading, 64),
    workspaceRoot: bounded(info.workspaceRoot, MAX_PATH_LENGTH),
    createdAt: now,
    lastAttemptAt: 0,
    attempts: 0,
    lastReason: 'other',
    hostBoot: bootId,
    state: 'pending',
  } : { ...existing, sessionHeading: bounded(info.sessionHeading, 64), workspaceRoot: bounded(info.workspaceRoot, MAX_PATH_LENGTH) }
  return writeRecord(dir, record) ? record : undefined
}

/**
 * Record a failed cleanup attempt, keeping the root pending for a later authorized retry.
 * @param root - the absolute result-cache root.
 * @param reason - classified failure, bounded to a known value.
 * @param now - current time, for tests.
 * @returns the updated record, or undefined when the root was never registered.
 */
export function recordCleanupFailure(root: string, reason: CleanupReason, now = Date.now()): CleanupRecord | undefined {
  const dir = ensureDir()
  if (!dir) return undefined
  const existing = readRecord(dir, root)
  if (existing === undefined) return undefined
  const record: CleanupRecord = { ...existing, attempts: existing.attempts + 1, lastAttemptAt: now, lastReason: reasonOf(reason) }
  return writeRecord(dir, record) ? record : undefined
}

/** Remove a record whose cleanup completed (or whose root no longer exists). */
export function completeCleanupRoot(root: string): void {
  forgetCleanupRoot(root)
  try { fs.rmSync(recordPath(ensureDir() ?? cleanupRegistryDir(), root), { force: true }) } catch { /* the record is advisory */ }
}

/** Every pending record, in directory order, bounded to {@link MAX_CLEANUP_RECORDS}. */
export function listPendingCleanup(dir = cleanupRegistryDir()): CleanupRecord[] {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  const records: CleanupRecord[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    if (records.length >= MAX_CLEANUP_RECORDS) break
    try {
      const record = parseRecord(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
      if (record !== undefined) records.push(record)
    } catch { /* an unreadable or corrupt record is not evidence about a root */ }
  }
  return records
}

/** Number of pending records, without parsing their bodies. */
export function pendingCleanupCount(dir = cleanupRegistryDir()): number {
  try { return fs.readdirSync(dir).filter(name => name.endsWith('.json') && !name.startsWith('.')).length } catch { return 0 }
}
