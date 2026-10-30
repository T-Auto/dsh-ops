/**
 * Shared vocabulary for the in-process `read_files` executor.
 *
 * The native worker used to answer `read_files`; every call paid one 3.8 MB process spawn
 * (~19 ms floor) before a byte was read. The replacement runs the same gates in this process:
 * a bounded pool, a per-file deadline, a size gate on the open descriptor, a binary gate inside
 * the decode window, a per-file character cap and a batch-wide output budget. Only the code that
 * sits after `open`/`fstat` is shared state; identity always comes from the descriptor.
 */

/** Per-file outcome, in the shape the compat renderer consumes. */
export interface ReadResult {
  path: string
  status: 'success' | 'error'
  content: string | null
  error: { code: string; message: string } | null
  truncated: boolean
  size: number | null
  bytes: number | null
  mtimeMs: number | null
  lineCount: number | null
  revision: string | null
  elapsedMs: number
  rows: string[] | null
  rowsClipped: boolean
  scannedBytes: number
}

/** Line window used by the compat renderer so a 1 MB file never lands in memory whole. */
export interface LineWindow { from: number; to: number; maxBytes: number }

export interface ReadOptions {
  concurrency: number
  maxFileSize: number
  timeoutMs: number
  maxChars: number
  maxTotalChars: number
  chunkBytes: number
  closeMs: number
  encoding: string
  root: string | null
  signal: AbortSignal | null
  full: boolean
  hash: boolean
  maxOpenRetries: number
  strictUtf8: boolean
  allowLinks: boolean
  stripBom: boolean
  normalize: boolean
  /** Refuse a file whose first bytes contain NUL. The compat arm turns this off: the native
   *  worker returned such bytes as text, so refusing them here would be a replacement regression. */
  nulGate: boolean
  lineWindow?: LineWindow | null
  /** Batch-level cache of in-flight directory `lstat` promises. */
  linkCache?: Map<string, Promise<void>>
  /** Memoised `realpath` of the fence root, computed once per batch. */
  rootReal?: Promise<string>
}

export interface ReadOverrides extends Partial<ReadOptions> {}

/** Defaults for a direct (non-compat) read: the AI reads a whole file, so the byte cap is real. */
export const DEFAULTS: Readonly<ReadOptions> = Object.freeze({
  concurrency: 10,
  maxFileSize: 2 * 1024 * 1024,
  timeoutMs: 3000,
  maxChars: 50000,
  maxTotalChars: 120000,
  chunkBytes: 64 * 1024,
  closeMs: 100,
  encoding: 'utf8',
  root: null,
  signal: null,
  full: false,
  hash: false,
  maxOpenRetries: 2,
  strictUtf8: false,
  allowLinks: true,
  stripBom: true,
  normalize: true,
  nulGate: true,
})

export const TRUNCATED_MARK = '\n...[Warning: Content truncated]...'

/** Error carrying a stable code, so the compat layer can map it without string matching. */
export class OpsError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'OpsError'
    this.code = code
  }
}

export function errorOf(value: unknown): { code: string; message: string } {
  if (value !== null && typeof value === 'object') {
    const record = value as { code?: unknown; name?: unknown; message?: unknown }
    const code = typeof record.code === 'string' ? record.code : typeof record.name === 'string' ? record.name : 'UNKNOWN'
    const message = typeof record.message === 'string' ? record.message : String(value)
    return { code, message }
  }
  return { code: 'UNKNOWN', message: String(value) }
}

/** Stable skeleton: built in one place so the hidden class never changes shape. */
export function emptyResult(filePath: string): ReadResult {
  return {
    path: filePath, status: 'error', content: null, error: null, truncated: false,
    size: null, bytes: null, mtimeMs: null, lineCount: null, revision: null, elapsedMs: 0,
    rows: null, rowsClipped: false, scannedBytes: 0,
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  if (typeof timer.unref === 'function') timer.unref()
})

/**
 * Hand-written pool. Worker coroutines share one cursor, so in-flight work never exceeds `limit`;
 * the synchronous increment needs no lock.
 */
export async function runPool<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const total = items.length
  if (total === 0) return []
  const results = new Array<R>(total)
  const slots = Math.max(1, Math.min(Math.floor(limit) || 1, total))
  let cursor = 0
  const runners = Array.from({ length: slots }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= total) return
      try {
        results[index] = await worker(items[index] as T, index)
      } catch (error) {
        results[index] = {
          ...emptyResult(String(items[index])),
          error: errorOf(error),
        } as unknown as R
      }
    }
  })
  await Promise.all(runners)
  return results
}

/** Count newlines without retaining the text (full mode needs a line count, not the bytes). */
export function countNewlines(text: string): number {
  let count = 0
  let index = -1
  while ((index = text.indexOf('\n', index + 1)) !== -1) count++
  return count
}

/** Cut by characters without splitting a surrogate pair. */
export function cutChars(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

/** Truncate and append the marker; the marker is not counted against `maxChars`. */
export function truncate(text: string, maxChars: number): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false }
  return { content: cutChars(text, maxChars) + TRUNCATED_MARK, truncated: true }
}

/**
 * Cross-call read cache (LRU, process-local).
 *
 * `open` and `fstat` must run every time — they are the only evidence of what the file is now.
 * What can be skipped is everything after them: decode, SHA-256, line splitting. The key carries
 * `dev:ino:size:mtime` plus every switch that changes the body, so a hit is byte-equivalent.
 * An inode of 0 (some network shares) disables the cache: no identity, no hit.
 */
const READ_CACHE_MAX_ENTRIES = 64
const READ_CACHE_MAX_CHARS = 8 << 20
interface CacheEntry { value: Omit<ReadResult, 'elapsedMs'>; chars: number }
const readCache = new Map<string, CacheEntry>()
let readCacheChars = 0
let readCacheHits = 0
let readCacheMisses = 0

export function readCacheGet(key: string): Omit<ReadResult, 'elapsedMs'> | undefined {
  const hit = readCache.get(key)
  if (hit === undefined) { readCacheMisses++; return undefined }
  readCache.delete(key)
  readCache.set(key, hit)
  readCacheHits++
  return hit.value
}

export function readCacheSet(key: string, value: Omit<ReadResult, 'elapsedMs'>): void {
  const chars = (value.content ? value.content.length : 0)
    + (value.rows ? value.rows.reduce((sum, row) => sum + row.length, 0) : 0)
  if (chars > READ_CACHE_MAX_CHARS) return
  readCache.set(key, { value, chars })
  readCacheChars += chars
  while (readCache.size > READ_CACHE_MAX_ENTRIES || readCacheChars > READ_CACHE_MAX_CHARS) {
    const oldest = readCache.keys().next()
    if (oldest.done) break
    readCacheChars -= readCache.get(oldest.value)?.chars ?? 0
    readCache.delete(oldest.value)
  }
}

export function readCacheStats(): { entries: number; chars: number; hits: number; misses: number } {
  return { entries: readCache.size, chars: readCacheChars, hits: readCacheHits, misses: readCacheMisses }
}

export function clearReadCache(): void {
  readCache.clear()
  readCacheChars = 0
  readCacheHits = 0
  readCacheMisses = 0
}
