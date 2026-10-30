/**
 * `read_files` renderer: folds in-process reads into the receipt shape the native worker used to
 * emit, so nothing above this module has to change.
 *
 * The contract, measured against 0.4.1 rather than read off the docs:
 *
 *   files: [{ path, offset >= 1, limit 1..10000, default whole file }] (1..32)
 *   -> { status, complete, total, matched, failed, pending, nextIndex, truncated, effectState, items }
 *   items[]: { path, status, bytes, revision, lineCount, complete, truncated, skipped, omitted,
 *              matched, total, failed, changed, phase, nextOffset, items: [{ line, path, text }] }
 *
 * Differences from the direct reader, all deliberate:
 *   - CRLF loses its `\r` per line, matching what the native worker returned;
 *   - `lineCount` does not count a trailing empty line;
 *   - `nextOffset` is `offset + returned lines`, not `offset + limit`;
 *   - `complete` means "the whole file fit on this page", not "no error";
 *   - the output budget is 128 KiB of JSON and is settled by dropping whole lines.
 */
import { normalizeOptions, readOne } from './parallel-read.js'
import { cutChars } from './read-types.js'
import type { ReadOverrides, ReadResult } from './read-types.js'

const COMPAT_MAX_FILES = 32
const COMPAT_MAX_LIMIT = 10000
// The native default was 200 lines, which silently cut a 270-line file while still reporting
// `complete`. The only real gate now is the output budget.
const COMPAT_DEFAULT_LIMIT = COMPAT_MAX_LIMIT
const COMPAT_OUTPUT_BUDGET = 128 * 1024

interface CompatFile { path: string; offset?: number; limit?: number }
interface CompatError {
  code: string; message: string; phase: string; effectState: string; retryable: boolean; nextAction: string
}
interface CompatLine { line: number; path: string; text: string; truncatedInLine?: true; bytesOmitted?: number; bytesTotal?: number | null }
interface CompatItem {
  path: string; status: 'completed' | 'error'; complete: boolean
  items: CompatLine[]; error?: CompatError
  bytes?: number | null; revision?: string | null; lineCount?: number | null
  truncated?: boolean; skipped?: number; omitted?: number; matched?: number; total?: number
  failed?: number; changed?: number; phase?: string; nextOffset?: number; nextAction?: string
}
interface CompatReceipt {
  status: 'completed' | 'partial' | 'error'
  complete?: boolean; total?: number; matched?: number; failed?: number; changed?: number
  pending?: number; nextIndex?: number; truncated?: boolean; effectState?: string; phase?: string
  items?: CompatItem[]; nextAction?: string; error?: CompatError
}

const MAPPED: Record<string, { code: string; message?: string; nextAction: string; retryable: boolean }> = {
  ENOENT: { code: 'NOT_FOUND', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  ENOTDIR: { code: 'NOT_FOUND', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  EACCES: { code: 'PERMISSION_DENIED', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  EPERM: { code: 'PERMISSION_DENIED', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  NOT_A_FILE: { code: 'INVALID_ARGUMENT', message: 'path is a directory; use ops_glob or ops_grep', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  BINARY_FILE: {
    code: 'ERR_INVALID_ENCODING',
    message: 'File is not valid UTF-8',
    nextAction: 'Use a dedicated document/binary reader, or inspect with view=hex; do not replace invalid bytes with lossy text.',
    retryable: false,
  },
  UNSUPPORTED_ENCODING: { code: 'ERR_INVALID_ENCODING', nextAction: 'Use a dedicated document/binary reader; convert to UTF-8 first.', retryable: false },
  FILE_TOO_LARGE: { code: 'INVALID_ARGUMENT', nextAction: 'Read a line range instead of the whole file.', retryable: false },
  TIMEOUT: { code: 'TIMEOUT', nextAction: 'Retry, or read fewer files at once.', retryable: true },
  EMFILE: { code: 'RESOURCE_EXHAUSTED', nextAction: 'Retry with a smaller batch.', retryable: true },
  ENFILE: { code: 'RESOURCE_EXHAUSTED', nextAction: 'Retry with a smaller batch.', retryable: true },
  ABORTED: { code: 'ABORTED', nextAction: 'Retry if the work is still needed.', retryable: false },
  ESCAPE_ROOT: { code: 'ACCESS_DENIED', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  INVALID_PATH: { code: 'INVALID_ARGUMENT', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  INVALID_UTF8: {
    code: 'ERR_INVALID_ENCODING',
    message: 'File is not valid UTF-8',
    nextAction: 'Use a dedicated document/binary reader, or inspect with view=hex; do not replace invalid bytes with lossy text.',
    retryable: false,
  },
  PATH_RESTRICTED: { code: 'PATH_RESTRICTED', nextAction: 'Inspect the target path for the offending entry.', retryable: false },
}

function toCompatError(error: { code?: string; message?: string } | null | undefined, fallbackMessage?: string): CompatError {
  const mapped = MAPPED[error?.code ?? ''] ?? ({} as Partial<(typeof MAPPED)[string]>)
  return {
    code: mapped.code ?? error?.code ?? 'UNKNOWN',
    message: mapped.message ?? error?.message ?? fallbackMessage ?? 'unknown error',
    phase: 'preflight',
    effectState: 'none',
    retryable: mapped.retryable === true,
    nextAction: mapped.nextAction ?? 'Correct the request or inspect the manifest.',
  }
}

/**
 * Argument validation mirrors the native schema: 1..32 entries, `offset >= 1`, `limit` 1..10000.
 * The native worker rejected the whole batch, so this must not silently repair the request.
 */
function validateCompatInput(files: readonly (CompatFile | string)[]): string | null {
  if (!Array.isArray(files) || files.length === 0 || files.length > COMPAT_MAX_FILES) {
    return 'read_files: files must contain 1-32 items'
  }
  for (const file of files) {
    if (typeof file === 'string') { if (file === '') return 'read_files: each item needs a non-empty path string'; continue }
    if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || file.path === '') {
      return 'read_files: each item needs a non-empty path string'
    }
    if (file.offset !== undefined && (!Number.isInteger(file.offset) || file.offset < 1)) {
      return 'read_files: read_files offset starts at 1 and limit is 1-10000'
    }
    if (file.limit !== undefined && (!Number.isInteger(file.limit) || file.limit < 1 || file.limit > COMPAT_MAX_LIMIT)) {
      return 'read_files: read_files offset starts at 1 and limit is 1-10000'
    }
  }
  return null
}

/** JSON byte size without building the string twice. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * Turn one read into one native item, clipped to `room` bytes of JSON.
 * Returns `null` only when not even one truncated line fits.
 */
function compatItem(file: CompatFile & { offset: number }, result: ReadResult, room: number): [CompatItem, number] | null {
  // Receipt paths are POSIX: the native worker returned backslashes, which cost two bytes per
  // separator and disagreed with symbol_map / ptc receipts. I/O still uses the original path.
  const shown = result.path.replace(/\\/g, '/')
  if (result.status !== 'success') {
    const errorItem: CompatItem = {
      path: shown, status: 'error', complete: false, items: [],
      error: toCompatError(result.error, 'missing result'),
    }
    let bytes = jsonBytes(errorItem)
    if (bytes > room && errorItem.error) {
      const base = errorItem.error.message
      let keep = base.length
      while (bytes > room && keep > 8) {
        keep >>= 1
        errorItem.error.message = base.slice(0, keep) + '…'
        bytes = jsonBytes(errorItem)
      }
    }
    return [errorItem, bytes]
  }

  const page = result.rows ?? []
  const total = result.lineCount == null ? page.length : result.lineCount
  const skeleton = (count: number): CompatItem => ({
    path: shown,
    status: 'completed',
    bytes: result.bytes,
    revision: result.revision,
    lineCount: total,
    complete: !result.truncated && file.offset + count > total,
    truncated: result.truncated || result.rowsClipped || count < page.length,
    skipped: file.offset - 1,
    omitted: Math.max(0, total - (file.offset - 1) - count),
    matched: total,
    total,
    failed: 0,
    changed: 0,
    phase: 'verify',
    nextOffset: file.offset + count,
    items: [],
  })
  const make = (count: number): CompatItem => ({
    ...skeleton(count),
    items: page.slice(0, count).map((text, index) => ({ line: file.offset + index, path: shown, text })),
  })

  // Prefix sums of per-line JSON size. Estimating per line undercounts escaped or CJK text; the
  // old corrective loop re-serialised the whole page for every dropped line.
  const prefix = new Float64Array(page.length + 1)
  for (let index = 0; index < page.length; index++) {
    prefix[index + 1] = (prefix[index] as number) + Buffer.byteLength(
      JSON.stringify({ line: file.offset + index, path: shown, text: page[index] }), 'utf8')
  }
  const sizeOf = (count: number): number => Buffer.byteLength(JSON.stringify(skeleton(count)), 'utf8') - 1 + 9
    + (count === 0 ? 2 : (prefix[count] as number) + count + 1)

  const full = make(page.length)
  if (sizeOf(page.length) <= room) return [full, jsonBytes(full)]

  let low = 0
  let high = page.length
  let best = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (sizeOf(mid) <= room) { best = mid; low = mid + 1 } else high = mid - 1
  }
  // `omitted`/`nextOffset` change digit counts, so the size function is not strictly monotonic.
  while (best > 0 && sizeOf(best) > room) best--
  while (best < page.length && sizeOf(best + 1) <= room) best++
  const entry = make(best)
  if (best > 0) {
    const bytes = jsonBytes(entry)
    return bytes > room ? null : [entry, bytes]
  }

  // A single line larger than the page: deliver a prefix and keep `nextOffset` on that line,
  // matching the native `truncatedInLine` + `bytesOmitted` guidance. Returning zero lines would
  // leave the cursor spinning forever.
  if (page.length === 0) {
    const bytes = jsonBytes(entry)
    return bytes > room ? null : [entry, bytes]
  }
  const lineText = page[0] as string
  const totalBytes = result.size
  const build = (count: number): CompatItem => {
    const text = cutChars(lineText, count)
    const item: CompatItem = {
      ...make(0),
      complete: false,
      truncated: true,
      omitted: 1,
      nextOffset: file.offset,
      nextAction: 'A line was cut by the output budget. Inspect this file with view=hex and page its 16-byte rows; nextOffset retains the incomplete line, so text paging alone cannot recover its suffix.',
      items: [{
        line: file.offset, path: shown, text, truncatedInLine: true,
        bytesOmitted: totalBytes == null ? 0 : Math.max(0, totalBytes - Buffer.byteLength(text)),
        bytesTotal: totalBytes,
      }],
    }
    return item
  }
  let lowText = 0
  let highText = lineText.length
  let bestText = 0
  while (lowText <= highText) {
    const mid = (lowText + highText) >> 1
    if (jsonBytes(build(mid)) <= room) { bestText = mid; lowText = mid + 1 } else highText = mid - 1
  }
  if (bestText === 0) return null
  const cut = build(bestText)
  return [cut, jsonBytes(cut)]
}

/** Compat entry point used by `worker.ts`. */
export async function readFilesCompat(
  files: readonly (CompatFile | string)[],
  options: ReadOverrides & { maxOutputBytes?: number } = {},
): Promise<CompatReceipt> {
  const invalid = validateCompatInput(files)
  if (invalid) {
    return {
      status: 'error',
      error: {
        code: 'INVALID_ARGUMENT', message: invalid, phase: 'preflight',
        effectState: 'none', retryable: false, nextAction: 'Correct the request or inspect the manifest.',
      },
    }
  }

  const list = files.map((file) => {
    const input = typeof file === 'string' ? { path: file } : file
    return {
      path: input.path,
      offset: Math.max(1, Math.floor(input.offset || 1)),
      limit: Math.min(COMPAT_MAX_LIMIT, Math.max(1, Math.floor(input.limit || COMPAT_DEFAULT_LIMIT))),
    }
  })

  // The compat path is deliberately stricter than the direct reader, matching the native arm:
  // fatal UTF-8, no link traversal, and no 2 MB cap (the native worker read a 30 MB file with a
  // range). BOM and normalisation stay off so the write path receives the bytes on disk.
  const opts = normalizeOptions({
    strictUtf8: true,
    allowLinks: false,
    ...options,
    stripBom: options.stripBom === true,
    normalize: options.normalize === true,
    // The native arm returned NUL bytes as text (a 3-byte `A B` file came back completed);
    // refusing them here would turn readable files into errors.
    nulGate: false,
    maxFileSize: options.maxFileSize !== undefined && options.maxFileSize > 0 ? options.maxFileSize : Number.MAX_SAFE_INTEGER,
    full: true,
    hash: true,
  })
  const linkCache = new Map<string, Promise<void>>()
  const budget = Math.max(2048, (options.maxOutputBytes !== undefined && options.maxOutputBytes > 0 ? options.maxOutputBytes : COMPAT_OUTPUT_BUDGET) - 1024)

  const items: CompatItem[] = []
  let used = 0
  let batch = Math.min(Number.isFinite(opts.concurrency) && opts.concurrency > 0
    ? Math.max(1, Math.min(COMPAT_MAX_FILES, opts.concurrency))
    : COMPAT_MAX_FILES, 4)
  let cursor = 0

  outer:
  while (cursor < list.length) {
    if (used >= budget) break
    const slice = list.slice(cursor, cursor + batch)
    const raw = await Promise.all(slice.map((file) => readOne(file.path, {
      ...opts,
      lineWindow: { from: file.offset, to: file.offset + file.limit - 1, maxBytes: budget },
      linkCache,
    }, Date.now())))

    for (let index = 0; index < slice.length; index++) {
      if (used >= budget) break outer
      const packed = compatItem(slice[index] as CompatFile & { offset: number }, raw[index] as ReadResult, budget - used)
      if (!packed) break outer
      items.push(packed[0])
      used += packed[1]
      if (packed[0].truncated) break outer
    }
    cursor += slice.length

    if (items.length > 0 && used < budget) {
      const average = used / items.length
      batch = Math.max(1, Math.min(opts.concurrency, Math.ceil((budget - used) / average)))
    }
  }

  const failed = items.filter((item) => item.status !== 'completed').length
  const truncated = items.some((item) => item.truncated)
  const complete = items.length === list.length && failed === 0 && !truncated && items.every((item) => item.complete)
  const out: CompatReceipt = {
    status: complete ? 'completed' : 'partial',
    complete,
    total: list.length,
    matched: items.length - failed,
    failed,
    changed: 0,
    pending: list.length - items.length,
    nextIndex: items.length,
    truncated,
    effectState: 'none',
    phase: 'verify',
    items,
  }
  if (!complete) {
    out.nextAction = "Resume remaining files from nextIndex. Follow each file's nextOffset for more lines; for truncatedInLine use that file's hex inspection guidance."
  }
  return out
}
