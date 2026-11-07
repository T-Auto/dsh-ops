/** One-shot worker transport. Only trusted bridge code supplies envelope metadata and budgets. */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dshHome, indexCachePath } from '../paths.js'

export const WORKER_TIMEOUT_MS = 30000
export const WORKER_OUTPUT_BYTES = 128 * 1024

export const INDEX_CACHE_MODE = 0o700

/** The file-system calls index-cache preparation needs; injectable for tests. */
export interface IndexCacheFs {
  mkdir(path: string, options: { recursive: true; mode: number }): void
  chmod(path: string, mode: number): void
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean }
  realpath(path: string): string
}

const hostIndexCacheFs: IndexCacheFs = {
  mkdir: (path, options) => { mkdirSync(path, options) },
  chmod: (path, mode) => { chmodSync(path, mode) },
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync(path),
}

/**
 * Resolves and prepares the optional index cache directory.
 *
 * Disabled unless the operator turned `indexCache` on. The path is inspected
 * before anything is created or chmod'ed: an existing symlinked `dsh-ops` or
 * `index-cache` (or a path that resolves outside the home) is refused without
 * touching its target, because `chmod` follows a symlink. Every failure (no
 * home, EACCES, ENOSPC, a path that is not a directory) returns `null`: indexing
 * is an optimisation, never a reason for a search to fail, and the worker keeps
 * walking whenever the field is absent. On POSIX the mode is forced after
 * `mkdir` so an existing directory with a wider mode is narrowed, not trusted;
 * on Windows Node cannot set an ACL, so the directory inherits the
 * `%USERPROFILE%` ACL and only the read-only attribute is controlled. A
 * same-user swap of the path between the inspection and the chmod is outside
 * this best-effort check; the final `realpath` assertion still rejects a cache
 * that does not resolve to the home.
 * @param {object} [options] - enable switch, home override and test fs.
 * @returns {string | null} the cache directory, or `null` to omit the field.
 */
export function indexCacheDir(options: { enabled: boolean; home?: string; fs?: IndexCacheFs } = { enabled: false }): string | null {
  if (!options.enabled) return null
  const fileSystem = options.fs ?? hostIndexCacheFs
  const home = options.home ?? dshHome()
  try {
    const dir = indexCachePath(home)
    // 1. Inspect before mutating. `chmod` follows a symlink, so an existing
    //    symlinked `dsh-ops` or `index-cache` must be refused before `mkdir` or
    //    `chmod` can touch its target.
    for (const candidate of [path.dirname(dir), dir]) {
      const info = existing(fileSystem, candidate)
      if (info === null) continue
      if (!info.isDirectory() || info.isSymbolicLink()) return null
    }
    // 2. Create only the missing layers, then re-check that the leaf is still a
    //    real directory before changing its mode.
    fileSystem.mkdir(dir, { recursive: true, mode: INDEX_CACHE_MODE })
    const leaf = fileSystem.lstat(dir)
    if (!leaf.isDirectory() || leaf.isSymbolicLink()) return null
    fileSystem.chmod(dir, INDEX_CACHE_MODE)
    // 3. Whatever happened above, the cache must still resolve to exactly
    //    `<resolved home>/dsh-ops/index-cache`.
    const expected = path.join(fileSystem.realpath(home), 'dsh-ops', 'index-cache')
    if (fileSystem.realpath(dir) !== expected) return null
    return dir
  } catch {
    return null
  }
}

/** One `lstat` where a missing path is a normal answer, not a failure. */
function existing(fileSystem: IndexCacheFs, candidate: string): { isDirectory(): boolean; isSymbolicLink(): boolean } | null {
  try { return fileSystem.lstat(candidate) } catch { return null }
}

export function indexCacheRequest(options?: { enabled: boolean; home?: string; fs?: IndexCacheFs }): { cache_dir?: string } {
  const dir = indexCacheDir(options)
  return dir ? { cache_dir: dir } : {}
}

export interface WorkerStorage {
  root: string
  authorityId: string
  allowedTools: string[]
  windowsWriteSid?: string
}
export function workerEnvelope(component: 'file' | 'ptc', request: Record<string, unknown>, timeoutMs: number | null = WORKER_TIMEOUT_MS, storage?: WorkerStorage) {
  timeoutMs ??= WORKER_TIMEOUT_MS
  const timeout = Math.max(1, Math.trunc(timeoutMs))
  if (!['file', 'ptc'].includes(component) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeout > 2147483647) {
    throw new TypeError('Invalid internal worker component or timeout')
  }
  return { version: 1, requestId: randomUUID(), component,
    budget: { timeoutMs: Math.min(timeout, WORKER_TIMEOUT_MS), maxBytes: WORKER_OUTPUT_BYTES }, request, ...(storage ? { storage } : {}) }
}
