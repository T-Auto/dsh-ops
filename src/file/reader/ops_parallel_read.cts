/**
 * The batch reader: many files, one controlled read, two entry points.
 *
 * `parallelRead` is the native entry point — a key/value map of path to result, no byte budget beyond a
 * character cap. `readFilesCompat` reproduces the original host's `read_files` contract exactly: the same
 * input schema, the same item shape, the same 96 KiB JSON budget, the same error codes. The second one
 * exists so this package can replace the built-in tool without any caller noticing.
 *
 * Seven gates, and a failure of any one of them fails a single file rather than the batch:
 *
 *   1. pool        in-flight files never exceed `concurrency`; the descriptor peak equals it
 *   2. size        the fstat lands on the descriptor that was opened, so a swapped path cannot lie
 *   3. timeout     one deadline and one timer span open/fstat/read/close
 *   4. binary      a NUL in the decoded window means binary; a UTF-16 BOM is still text
 *   5. decoding    BOM first, then the caller's encoding; the UTF-8 BOM is stripped when asked
 *   6. truncation  the read stops at the character quota — a 2 MiB file costs ~64 KiB of reading
 *   7. budget      the whole batch settles in input order, so which files are cut never depends on timing
 *
 * @module dsh-ops/file/reader
 */

import { cutChars, truncate } from './text.cjs'
import { DEFAULTS, OpsError, runPool, TRUNCATED_MARK, type ReadEntry, type ReadOptions, type ResolvedOptions } from './core.cjs'
import { readCacheReset, readCacheStats, readOne, type LineWindow } from './read-one.cjs'

/** Merge caller options over the defaults, normalizing every numeric gate. */
function normalizeOptions(options: ReadOptions = {}): ResolvedOptions {
  const opts = { ...DEFAULTS, ...options } as ResolvedOptions
  opts.concurrency = Math.max(1, Math.floor(opts.concurrency) || 1)
  // `!(x > 0)` rather than `x <= 0`: NaN compares false against everything, so a `<=` test would let NaN
  // through the gate. With maxFileSize=NaN the 2 MiB ceiling stops applying, and with maxChars=NaN the body
  // stays empty while the entry still reports success.
  if (!(opts.maxFileSize > 0)) opts.maxFileSize = DEFAULTS.maxFileSize
  if (!(opts.maxChars > 0)) opts.maxChars = DEFAULTS.maxChars
  if (!(opts.maxTotalChars > 0)) opts.maxTotalChars = DEFAULTS.maxTotalChars
  if (!(opts.timeoutMs > 0)) opts.timeoutMs = DEFAULTS.timeoutMs
  // Node silently turns a delay above 2^31-1 into 1 ms (plus a TimeoutOverflowWarning), so timeoutMs of
  // Infinity or 3e9 does not mean "never" — it means "always after 1 ms". Capping at 2^31-1 (~24.8 days)
  // keeps the "effectively never" meaning without the overflow.
  opts.timeoutMs = Math.min(opts.timeoutMs, 2147483647)
  if (!(opts.chunkBytes > 0)) opts.chunkBytes = DEFAULTS.chunkBytes
  if (!(opts.closeMs > 0)) opts.closeMs = DEFAULTS.closeMs
  opts.full = Boolean(opts.full)
  opts.hash = Boolean(opts.hash)
  opts.normalize = opts.normalize !== false
  // Unspecified stripBom follows normalize: normalize:false means "byte for byte", and turning off only the
  // CRLF conversion while still eating a BOM loses three bytes and breaks that promise. The compat entry
  // point passes both explicitly, so its behaviour is unchanged.
  opts.stripBom = options.stripBom === undefined ? opts.normalize : Boolean(options.stripBom)
  return opts
}

/**
 * Read many files concurrently and return a map keyed by path.
 *
 * Settling runs serially in input order after the pool finishes, which is what makes truncation and the
 * batch budget deterministic: the same request returns the same text regardless of which file finished
 * first.
 */
export async function parallelRead(filePaths: string[], options: ReadOptions = {}): Promise<Record<string, ReadEntry>> {
  if (!Array.isArray(filePaths)) throw new TypeError('filePaths must be a string[]')
  const opts = normalizeOptions(options)
  // Deduplicate: the same path twice should not take two descriptors or be read twice.
  const unique = [...new Set(filePaths.map(String))]
  const raw = await runPool(unique, opts.concurrency, filePath => readOne(filePath, opts, Date.now()))
  // Null prototype: a file legitimately named "__proto__" must not touch the prototype chain.
  const result: Record<string, ReadEntry> = Object.create(null)
  let used = 0
  for (const item of raw as ReadEntry[]) {
    if (item.status !== 'success') {
      result[item.path] = item
      continue
    }
    // An empty file costs no budget. Without this the last zero-byte file in a full batch would be reported
    // BUDGET_EXHAUSTED — a false error that sends the caller to retry something with no content.
    if (item.content !== null && item.content.length === 0 && !item.truncated) {
      result[item.path] = item
      continue
    }
    const room = opts.maxTotalChars - used
    // Less room than the marker itself cannot hold half a file either; report the budget instead of
    // returning a fragment and let the caller split the batch.
    if (room <= TRUNCATED_MARK.length) {
      result[item.path] = {
        ...item,
        status: 'error',
        content: null,
        truncated: false,
        error: {
          code: 'BUDGET_EXHAUSTED',
          message: `the batch budget of ${opts.maxTotalChars} characters is spent (${used} returned); read fewer files`,
        },
      }
      continue
    }
    // Two stages: cut to the per-file cap first, and re-cut only when the batch total overflows. Folding the
    // marker into maxChars up front would cost every file its last 35 characters.
    const cap = Math.min(opts.maxChars, room)
    const body = item.content as string
    let content: string
    let truncated: boolean
    if (item.truncated) {
      // The read already cut this file, so `content` is body + marker. Running truncate() over that string
      // again is wrong: when the surrogate guard made the body one character shorter than `keep` (the cut
      // landed inside an emoji), the second cut lands inside the marker itself and produces
      // "body + first marker character" plus a fresh marker — neither a prefix of the original nor
      // marker-once.
      const withoutMarker = body.slice(0, body.length - TRUNCATED_MARK.length)
      const maxBody = Math.min(opts.maxChars, room - TRUNCATED_MARK.length)
      content = (withoutMarker.length > maxBody ? cutChars(withoutMarker, maxBody) : withoutMarker) + TRUNCATED_MARK
      truncated = true
    } else {
      ({ content, truncated } = truncate(body, cap))
      if (content.length > room) ({ content, truncated } = truncate(body, room - TRUNCATED_MARK.length))
    }
    used += content.length
    result[item.path] = { ...item, content, truncated }
  }
  return result
}

// ---------------------------------------------------------------------------
// Compat layer: mirrors dsh-ops 0.4.1 `ops_read_files` on both sides
// ---------------------------------------------------------------------------

/** The original schema limits: 1-32 files, offset >= 1, limit 1-10000. */
const COMPAT_MAX_FILES = 32
const COMPAT_MAX_LIMIT = 10000

/**
 * Default of 200 lines, matching the original tool's schema.
 *
 * 4.1.5 raised this to 10000 on the grounds that "200 lines silently returns less". But truncation is no
 * longer silent — complete, truncatedBy and nextOffset are all in the receipt and the caller can resume. The
 * real cost of the higher default is tokens: the same 1 MB file returns 10.7 KiB at 200 lines and 46.5 KiB
 * at 10000, four times as much. A replacement's default has to match the original, or "swap out
 * ops_read_files" quietly changes every session's context cost.
 */
const COMPAT_DEFAULT_LIMIT = 200

/**
 * The original's output budget is **JSON bytes**, and its strategy is: accumulate in input order, cut the
 * current file line by line until it fits, then stop, with nextIndex naming the first file not returned.
 * Measured 20×16 KB: 3 items, the third at 169 of 186 lines, a 98293-byte body.
 *
 * The previous version reused the native character budget instead, which made every file from the ninth
 * report BUDGET_EXHAUSTED and left the eighth silently 129 lines short with nextIndex pinned at 20 — so the
 * caller could not resume. That was a real defect.
 *
 * The original treats 128 KiB as a ceiling yet empirically stopped at a quarter of it (8×800 lines: 4 files,
 * 34.1 KiB). Filling 128 KiB returned 5 files and 47.3 KiB — 39% more bytes for the same budget, i.e. more
 * tokens every call. 96 KiB keeps a comparable reserve without dropping a whole file.
 */
const COMPAT_OUTPUT_BUDGET = 96 * 1024

interface MappedError { code: string, message?: string, nextAction: string, retryable: boolean }

/** Error code mapping: every entry here comes from measuring the original worker, not from its docs. */
const ERROR_MAP: Readonly<Record<string, MappedError>> = Object.freeze({
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
  // These three follow the original Rust worker's measured codes: an illegal path component is
  // INVALID_ARGUMENT with the message passed through, invalid UTF-8 is ERR_INVALID_ENCODING, a link is
  // PATH_RESTRICTED.
  INVALID_PATH: { code: 'INVALID_ARGUMENT', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  INVALID_UTF8: { code: 'ERR_INVALID_ENCODING', message: 'File is not valid UTF-8', nextAction: 'Use a dedicated document/binary reader, or inspect with view=hex; do not replace invalid bytes with lossy text.', retryable: false },
  PATH_RESTRICTED: { code: 'PATH_RESTRICTED', nextAction: 'Inspect the target path for the offending entry.', retryable: false },
})

/** A file request as the compat entry point accepts it. */
export interface CompatFileInput {
  path: string
  offset?: number
  limit?: number
}

/** One line of a page. */
export interface CompatLine {
  line: number
  path: string
  text: string
  truncatedInLine?: true
  bytesOmitted?: number
  bytesTotal?: number | null
}

/** The error object the original returns. */
export interface CompatError {
  code: string
  message: string
  phase: string
  effectState: string
  retryable: boolean
  nextAction: string
}

/** One file's receipt. */
export interface CompatItem {
  path: string
  status: string
  complete: boolean
  items: CompatLine[]
  bytes?: number | null
  revision?: string | null
  lineCount?: number
  truncated?: boolean
  skipped?: number
  omitted?: number
  matched?: number
  total?: number
  failed?: number
  changed?: number
  phase?: string
  nextOffset?: number
  nextAction?: string
  error?: CompatError
}

/** The batch receipt. */
export interface CompatResult {
  status: string
  complete?: boolean
  total?: number
  matched?: number
  failed?: number
  changed?: number
  pending?: number
  nextIndex?: number
  truncated?: boolean
  effectState?: string
  phase?: string
  items?: CompatItem[]
  nextAction?: string
  error?: CompatError
}

/** Options for the compat entry point: read options plus the output budget. */
export interface CompatOptions extends ReadOptions {
  maxOutputBytes?: number
}

/** Fold an inner error into the original's error shape, adding the fields its callers read. */
function toCompatError(error: { code?: string, message?: string } | null | undefined, fallbackMessage: string): CompatError {
  const mapped = (error && ERROR_MAP[error.code ?? '']) ?? {} as MappedError
  return {
    code: mapped.code || (error && error.code) || 'UNKNOWN',
    message: mapped.message || (error && error.message) || fallbackMessage || 'unknown error',
    phase: 'preflight',
    effectState: 'none',
    retryable: mapped.retryable === true,
    nextAction: mapped.nextAction || 'Correct the request or inspect the manifest.',
  }
}

/**
 * Input validation against the original schema.
 *
 * The original refuses the whole batch with INVALID_ARGUMENT rather than tolerating bad entries one by one,
 * and the compat layer has to do the same: otherwise the caller receives "arguments that were quietly
 * corrected" instead of the correction signal.
 */
function validateCompatInput(files: unknown): string | null {
  if (!Array.isArray(files) || files.length === 0 || files.length > COMPAT_MAX_FILES) {
    return `read_files: files must contain 1-${COMPAT_MAX_FILES} items`
  }
  for (const entry of files) {
    if (typeof entry === 'string') {
      if (entry === '') return 'read_files: each item needs a non-empty path string'
      continue
    }
    const f = entry as CompatFileInput | null
    if (f === null || typeof f !== 'object' || typeof f.path !== 'string' || f.path === '') {
      return 'read_files: each item needs a non-empty path string'
    }
    if (f.offset !== undefined && (!Number.isInteger(f.offset) || f.offset < 1)) {
      return 'read_files: read_files offset starts at 1 and limit is 1-10000'
    }
    if (f.limit !== undefined && (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > COMPAT_MAX_LIMIT)) {
      return 'read_files: read_files offset starts at 1 and limit is 1-10000'
    }
  }
  return null
}

/** JSON size without building the string, because building it 32 times is the waste. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * One file into the original item shape, within `room` JSON bytes.
 *
 * When a full page does not fit, the cut is found by binary search over a running byte prefix; `null` means
 * not one line fits.
 */
function compatItem(f: { path: string, offset: number, limit: number }, r: ReadEntry | undefined, room: number): [CompatItem, number] | null {
  // Display paths are POSIX: the native worker returned Windows backslashes, where every separator costs two
  // bytes in JSON, and it disagreed with symbol_map and ptc (relative-to-cwd, POSIX). A model that copies a
  // path out of a receipt and back into the next call would otherwise cross two conventions. IO still uses
  // the original f.path.
  const shown = f.path.replace(/\\/g, '/')
  if (!r || r.status !== 'success') {
    const entry: CompatItem & { error: CompatError } = {
      path: shown,
      status: 'error',
      complete: false,
      items: [],
      error: toCompatError(r && r.error, 'missing result'),
    }
    let bytes = jsonBytes(entry)
    // An error entry has no lines to cut, and the old code returned it without looking at `room` at all: one
    // 3000-character path could make a maxOutputBytes=2048 call emit 6.6 KB, which breaks the budget
    // contract on the spot. Here the message is halved until the entry fits. A path that is itself over
    // budget (an extreme long path) is still returned — better to exceed slightly than to return nothing,
    // because nextIndex would not advance and a caller resuming on it would spin.
    if (bytes > room) {
      const base = entry.error.message
      let keepLength = base.length
      while (bytes > room && keepLength > 8) {
        keepLength >>= 1
        entry.error.message = `${base.slice(0, keepLength)}…`
        bytes = jsonBytes(entry)
      }
    }
    return [entry, bytes]
  }

  const page = r.rows ?? []
  const total = r.lineCount == null ? page.length : r.lineCount
  const skeleton = (n: number): CompatItem => ({
    path: shown,
    status: 'completed',
    bytes: r.bytes,
    revision: r.revision,
    lineCount: total,
    // Original semantics: complete means "no lines remain after this page".
    complete: !r.truncated && f.offset + n > total,
    truncated: r.truncated || r.rowsClipped || n < page.length,
    skipped: f.offset - 1,
    omitted: Math.max(0, total - (f.offset - 1) - n),
    matched: total,
    total,
    failed: 0,
    changed: 0,
    phase: 'verify',
    nextOffset: f.offset + n,
    items: [],
  })
  const make = (n: number): CompatItem => ({
    ...skeleton(n),
    items: page.slice(0, n).map((text, i) => ({ line: f.offset + i, path: shown, text })),
  })

  // Running byte prefix of the lines: one small stringify per line, not one per page. The old version
  // estimated 33 bytes plus the path per line, which under-estimates escape-heavy or CJK lines by 2-4×, and
  // its correction loop re-serialized the *whole page* per dropped line: a 1.2 MB quoted file cost 38.6 ms,
  // thirty times more than reading it.
  const prefix = new Float64Array(page.length + 1)
  for (let i = 0; i < page.length; i += 1) {
    prefix[i + 1] = prefix[i] + Buffer.byteLength(JSON.stringify({ line: f.offset + i, path: shown, text: page[i] }), 'utf8')
  }
  // Exact bytes for n lines = skeleton without its closing brace + ',"items":' + the array body, where a
  // body of n=0 is "[]" and n>=1 is "[" + lines + (n-1) commas + "]".
  const sizeOf = (n: number): number => Buffer.byteLength(JSON.stringify(skeleton(n)), 'utf8') - 1 + 9
    + (n === 0 ? 2 : prefix[n] + n + 1)

  const full = make(page.length)
  if (sizeOf(page.length) <= room) return [full, jsonBytes(full)]

  let lo = 0
  let hi = page.length
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sizeOf(mid) <= room) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  // The digit counts in omitted/nextOffset change, so sizeOf is not strictly monotonic; correct around the
  // found point, one skeleton at a time.
  while (best > 0 && sizeOf(best) > room) best -= 1
  while (best < page.length && sizeOf(best + 1) <= room) best += 1
  const entry = make(best)
  if (best > 0) {
    const bytes = jsonBytes(entry)
    return bytes > room ? null : [entry, bytes]
  }
  if (page.length === 0) {
    const bytes = jsonBytes(entry)
    return bytes > room ? null : [entry, bytes]
  }

  // Not even one line fits (a single 1 MiB line): deliver a prefix truncated mid-line and pin nextOffset to
  // that same line, matching the original's item.nextAction + line.truncatedInLine + bytesOmitted/bytesTotal.
  // Returning zero lines instead would leave nextOffset pointing at itself — a false success that loops.
  const lineText = page[0]
  const totalBytes = r.size
  const build = (n: number): CompatItem => {
    const text = cutChars(lineText, n)
    const item: CompatItem = {
      ...make(0),
      complete: false,
      truncated: true,
      omitted: 1,
      nextOffset: f.offset,
      nextAction: 'A line was cut by the output budget. Inspect this file with view=hex and page its 16-byte rows; nextOffset retains the incomplete line, so text paging alone cannot recover its suffix.',
    }
    item.items = [{
      line: f.offset,
      path: shown,
      text,
      truncatedInLine: true,
      bytesOmitted: totalBytes == null ? 0 : Math.max(0, totalBytes - Buffer.byteLength(text)),
      bytesTotal: totalBytes,
    }]
    return item
  }
  let lo2 = 0
  let hi2 = lineText.length
  let bestN = 0
  while (lo2 <= hi2) {
    const mid = (lo2 + hi2) >> 1
    if (jsonBytes(build(mid)) <= room) {
      bestN = mid
      lo2 = mid + 1
    } else hi2 = mid - 1
  }
  if (bestN === 0) return null
  const cut = build(bestN)
  return [cut, jsonBytes(cut)]
}

/**
 * The compat entry point: 1-32 files in, the original `ops_read_files` receipt out.
 *
 * Where it differs from the native path, every difference is measured against the original rather than
 * guessed: text drops a trailing `\r`, lineCount does not count the phantom line after a final newline,
 * nextOffset is offset plus lines actually returned, complete means "the whole file is on this page", ENOENT
 * maps to NOT_FOUND, a directory to INVALID_ARGUMENT, binary to ERR_INVALID_ENCODING, and the revision is
 * SHA-256 because the original uses it — which costs a read to EOF, paid only here.
 */
export async function readFilesCompat(files: Array<string | CompatFileInput>, options: CompatOptions = {}): Promise<CompatResult> {
  const invalid = validateCompatInput(files)
  if (invalid) {
    return {
      status: 'error',
      error: {
        code: 'INVALID_ARGUMENT',
        message: invalid,
        phase: 'preflight',
        effectState: 'none',
        retryable: false,
        nextAction: 'Correct the request or inspect the manifest.',
      },
    }
  }

  // Normalize once, so the pool and the settlement do not each recompute offset/limit.
  const list = files.map(entry => {
    const source = typeof entry === 'string' ? { path: entry } : entry
    return {
      path: source.path,
      offset: Math.max(1, Math.floor(source.offset || 1)),
      limit: Math.min(COMPAT_MAX_LIMIT, Math.max(1, Math.floor(source.limit || COMPAT_DEFAULT_LIMIT))),
    }
  })

  // Three places where the compat path is stricter than native, all matching measured original behaviour:
  // strictUtf8 — invalid UTF-8 and UTF-16 are ERR_INVALID_ENCODING (the original never substitutes);
  // allowLinks:false — symlinks and junctions are not followed (the original open_nofollow at every level);
  // maxFileSize — the original has **no** 2 MiB ceiling (3 MB and 30 MB files with offset/limit read fine,
  // measured 30 MB in 72 ms). Native keeps the ceiling because it is designed for reading a whole file into a
  // model's context, but a size limit on the replacement path would turn every large log or build artifact
  // into INVALID_ARGUMENT — a regression that only shows up after the swap.
  const opts = normalizeOptions({
    strictUtf8: true,
    allowLinks: false,
    ...options,
    stripBom: options.stripBom === true, // default matches the original: keep the BOM
    normalize: options.normalize === true, // default matches the original: no cleaning, byte-identical keys and body
    maxFileSize: (options.maxFileSize ?? 0) > 0 ? options.maxFileSize : Number.MAX_SAFE_INTEGER,
    full: true,
    hash: true,
  })
  // The link check's batch cache: 32 files are usually in one directory, so the lstat chain is paid once.
  const linkCache = new Map<string, Promise<void>>()
  // Reserve the outer envelope so the whole body stays inside the budget. The floor is 2 KiB: with less than
  // that even an empty item's skeleton does not fit, the batch returns zero items and nextIndex never moves,
  // so a caller resuming on it spins. A small allowance that advances beats a strict one that does not.
  const budget = Math.max(2048, ((options.maxOutputBytes ?? 0) > 0 ? options.maxOutputBytes as number : COMPAT_OUTPUT_BUDGET) - 1024)

  const items: CompatItem[] = []
  let used = 0
  // Batched reads: the original settles as it reads and stops when the budget is full, so 20×1 MB reads one
  // file. Reading all 20 at once would pull 20 MB in, so the first batch is conservative at 4. The old fixed
  // 4 cost five serial rounds when 20×2 KB would have fit; instead the batch adapts using the average JSON
  // bytes per returned item to estimate how many more the remaining budget holds.
  //
  // The ceiling defaults to COMPAT_MAX_FILES rather than opts.concurrency: this entry point is already capped
  // at 32 files by validateCompatInput, so the descriptor peak is naturally <= 32, far below any soft limit.
  // Measured 20×2 KB: a 10-file ceiling needs two rounds (0.72 ms), a 20-file ceiling one (0.67 ms). An
  // explicit concurrency is respected as given.
  const maxBatch = Number.isFinite(opts.concurrency) && opts.concurrency > 0
    ? Math.max(1, Math.min(COMPAT_MAX_FILES, opts.concurrency))
    : COMPAT_MAX_FILES
  let batch = Math.min(maxBatch, 4)
  let cursor = 0

  outer:
  while (cursor < list.length) {
    if (used >= budget) break
    const slice = list.slice(cursor, cursor + batch)
    const win = (f: { offset: number, limit: number }): LineWindow => ({ from: f.offset, to: f.offset + f.limit - 1, maxBytes: budget })
    // `slice` is already bounded by `batch` (<= 32), so no pool is needed: runPool's shared cursor would only
    // re-impose a limit that slice.length already guarantees. Promise.all saves a closure, a cursor increment
    // and a result write per item (measured 6% faster on 20×2 KB).
    const raw = await Promise.all(
      slice.map(f => readOne(f.path, { ...opts, lineWindow: win(f), linkCache }, Date.now())),
    )
    for (let k = 0; k < slice.length; k += 1) {
      if (used >= budget) break outer
      // compatItem returns the byte count it computed: stringifying again in the loop would serialize every
      // file twice (jsonBytes was 12.4% of a CPU profile, half of it this duplicate).
      const packed = compatItem(slice[k], raw[k], budget - used)
      if (!packed) break outer // not one line fits; leave it for the next batch
      const entry = packed[0]
      items.push(entry)
      used += packed[1]
      if (entry.truncated) break outer // this file was cut, so the budget is at its edge
    }
    cursor += slice.length
    if (items.length > 0 && used < budget) {
      const average = used / items.length
      batch = Math.max(1, Math.min(opts.concurrency, Math.ceil((budget - used) / average)))
    }
  }

  const failed = items.filter(item => item.status !== 'completed').length
  const truncated = items.some(item => item.truncated)
  const complete = items.length === list.length && failed === 0 && !truncated && items.every(item => item.complete)
  const out: CompatResult = {
    status: complete ? 'completed' : 'partial',
    complete,
    total: list.length,
    matched: items.length - failed, // original semantics: top-level matched counts returned files
    failed,
    changed: 0, // the original carries this field and always zero; omitting it breaks strict diffing callers
    pending: list.length - items.length,
    nextIndex: items.length,
    truncated,
    effectState: 'none',
    phase: 'verify',
    items,
  }
  // The original only sets a top-level nextAction when the read is incomplete; a completed receipt has no
  // such field at all.
  if (!complete) {
    out.nextAction = "Resume remaining files from nextIndex. Follow each file's nextOffset for more lines; for truncatedInLine use that file's hex inspection guidance."
  }
  return out
}

/** The old tool names, kept as aliases so a caller can swap the import without touching the call sites. */
export const ops_parallel_read = parallelRead
export const ops_read_files = readFilesCompat
export { runPool, truncate, OpsError, DEFAULTS, TRUNCATED_MARK }
export { readCacheStats, readCacheReset as clearReadCache }
