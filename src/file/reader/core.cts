/**
 * Shared primitives for the parallel reader: defaults, the result skeleton, the error type and the pool.
 *
 * Everything here is deliberately dependency-free — the reader has to run on a bare Node install with no
 * packages at all — so the pool is hand-written rather than pulled from `p-limit`.
 *
 * @module dsh-ops/file/reader/core
 */

/** One file's outcome. Success and failure share one shape so a caller never has to branch first. */
export interface ReadEntry {
  /** The path as it was given (not resolved). */
  path: string
  status: 'success' | 'error'
  /** The text, already cut to `maxChars` and carrying `TRUNCATED_MARK`. */
  content: string | null
  error: { code: string, message: string } | null
  /** Truncated during read, or cut again by the batch budget at render time. */
  truncated: boolean
  /** Size from `fstat`; null when the file could not be opened. */
  size: number | null
  /** Bytes actually read; below `size` when the read stopped early. */
  bytes: number | null
  /** mtime in milliseconds; null when the file could not be opened. */
  mtimeMs: number | null
  /** Only in full mode or line-window mode; null rather than a guess in the early-stop mode. */
  lineCount: number | null
  /** SHA-256 hex, only with `full` + `hash`; always null when the read stopped early. */
  revision: string | null
  elapsedMs: number
  /** Lines matched by a line window; null in the plain mode. */
  rows: string[] | null
  /** The line window was clipped by the byte budget, as opposed to the file being truncated. */
  rowsClipped: boolean
  /**
   * Bytes the binary gate and the decode gate actually covered.
   *
   * Below `size` when the read stopped early — that means "this is a prefix, and the part after it was
   * never checked for NULs", so `truncated` must not be read as "the whole file was validated".
   */
  scannedBytes: number
}

/** Every knob the reader accepts. The two entry points fill in different defaults; see their docs. */
export interface ReadOptions {
  /** Concurrency, which is also the file-descriptor peak. */
  concurrency?: number
  /** Per-file byte ceiling; a larger file is refused without reading a byte. */
  maxFileSize?: number
  /** Per-file budget covering open/fstat/read/close. */
  timeoutMs?: number
  /** Per-file character ceiling. */
  maxChars?: number
  /** Batch character ceiling, settled deterministically in input order. */
  maxTotalChars?: number
  /** Read granularity in bytes. */
  chunkBytes?: number
  /** How long to wait for `close` before giving up on it. */
  closeMs?: number
  /** Decoding used when a BOM does not decide it. */
  encoding?: BufferEncoding
  /** When set, IO is fenced inside this directory. */
  root?: string | null
  /** Cancels the whole batch. */
  signal?: AbortSignal | null
  /** Read to EOF, producing `lineCount` and `revision`. */
  full?: boolean
  /** Hash while reading; only meaningful with `full`. */
  hash?: boolean
  /** Retries on EMFILE/ENFILE/EBUSY. */
  maxOpenRetries?: number
  /** Refuse invalid UTF-8 with `INVALID_UTF8` instead of substituting U+FFFD. */
  strictUtf8?: boolean
  /** `false` refuses symlinks and junctions, checked with a per-component lstat. */
  allowLinks?: boolean
  /** Strip a leading UTF-8 BOM. */
  stripBom?: boolean
  /** CRLF to LF, and path keys from `\` to `/`. */
  normalize?: boolean
}

/** The resolved form: every field present. */
export type ResolvedOptions = ReadOptions & {
  concurrency: number
  maxFileSize: number
  timeoutMs: number
  maxChars: number
  maxTotalChars: number
  chunkBytes: number
  closeMs: number
  encoding: BufferEncoding
  root: string | null
  signal: AbortSignal | null
  full: boolean
  hash: boolean
  maxOpenRetries: number
  strictUtf8: boolean
  allowLinks: boolean
  stripBom: boolean
  normalize: boolean
}

/**
 * Defaults.
 *
 * `stripBom` and `normalize` exist as switches because the two entry points disagree: the native reader
 * strips and normalizes (a model reading prose does not want a stray U+FEFF or CRLF), while the compat
 * entry point must not — the original host returns the bytes on disk, and its callers edit, CAS and diff
 * the returned text, so cleaning it would silently lose three bytes.
 */
export const DEFAULTS: ResolvedOptions = Object.freeze({
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
} as ResolvedOptions)

/** The cut marker, emitted verbatim so a caller can match on it. */
export const TRUNCATED_MARK = '\n...[Warning: Content truncated]...'

/** An error carrying a `code` the caller branches on. */
export class OpsError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'OpsError'
    this.code = code
  }
}

/**
 * The one result constructor.
 *
 * Both the success and the failure path build through it so the field set cannot drift: same keys in the
 * same order keeps the hidden class stable and stops V8 from falling back to dictionary mode on the hot
 * path.
 */
export function emptyResult(filePath: string): ReadEntry {
  return {
    path: filePath,
    status: 'error',
    content: null,
    error: null,
    truncated: false,
    size: null,
    bytes: null,
    mtimeMs: null,
    lineCount: null,
    revision: null,
    elapsedMs: 0,
    rows: null,
    rowsClipped: false,
    scannedBytes: 0,
  }
}

/** Sleep that never keeps the process alive: this timer is a fallback, not work. */
export const sleep = (ms: number): Promise<void> => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

/**
 * A minimal concurrency pool.
 *
 * `limit` workers share a cursor and each one loops "take a number, do the work, take the next". The
 * worker count is the concurrency, so the number of in-flight tasks is bounded by construction and the
 * cursor needs no lock.
 *
 * `limit` may arrive as NaN or Infinity from a caller: NaN would make `Array.from({ length: NaN })` empty
 * and silently drop the whole batch, so it is normalized to "at least one worker".
 */
export async function runPool<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<Array<R | ReadEntry>> {
  const total = items.length
  if (total === 0) return []
  const results = new Array<R | ReadEntry>(total)
  const slots = Math.max(1, Math.min(Math.floor(limit) || 1, total))
  let cursor = 0
  const runners = Array.from({ length: slots }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= total) return
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        // Last line of defence: the fallback entry carries the path too, or that file vanishes from the
        // result set entirely and the caller never learns it existed.
        const problem = error as { code?: string, message?: string }
        results[index] = {
          ...emptyResult(String(items[index])),
          error: { code: problem.code ?? 'UNKNOWN', message: problem.message ?? String(error) },
        }
      }
    }
  })
  await Promise.all(runners)
  return results
}
