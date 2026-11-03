/** One-shot worker transport. Only trusted bridge code supplies envelope metadata and budgets. */
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { indexCachePath } from '../paths.js'

export const WORKER_TIMEOUT_MS = 30000
export const WORKER_OUTPUT_BYTES = 128 * 1024

export const INDEX_CACHE_MODE = 0o700

/** The file-system calls index-cache preparation needs; injectable for tests. */
export interface IndexCacheFs {
  mkdir(path: string, options: { recursive: true; mode: number }): void
  chmod(path: string, mode: number): void
}

const hostIndexCacheFs: IndexCacheFs = {
  mkdir: (path, options) => { mkdirSync(path, options) },
  chmod: (path, mode) => { chmodSync(path, mode) },
}

/**
 * Resolves and prepares the optional index cache directory.
 *
 * Disabled unless the operator turned `indexCache` on. Every failure (no home,
 * EACCES, ENOSPC, a path that is not a directory) returns `null`: indexing is an
 * optimisation, never a reason for a search to fail, and the worker keeps
 * walking whenever the field is absent. The mode is forced after `mkdir` so an
 * existing directory with a wider mode is narrowed, not trusted.
 * @param {object} [options] - enable switch, home override and test fs.
 * @returns {string | null} the cache directory, or `null` to omit the field.
 */
export function indexCacheDir(options: { enabled: boolean; home?: string; fs?: IndexCacheFs } = { enabled: false }): string | null {
  if (!options.enabled) return null
  const fileSystem = options.fs ?? hostIndexCacheFs
  try {
    const dir = indexCachePath(options.home)
    fileSystem.mkdir(dir, { recursive: true, mode: INDEX_CACHE_MODE })
    fileSystem.chmod(dir, INDEX_CACHE_MODE)
    return dir
  } catch {
    return null
  }
}

/** The request field a worker envelope carries when the cache is usable. */
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
