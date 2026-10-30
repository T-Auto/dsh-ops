/**
 * In-process `read_files`: one bounded pool, one deadline per file, one descriptor per file.
 *
 * Replaces the native `ops-files` `many` arm. The contract is unchanged — a batch result whose
 * items carry `status`, `bytes`, `lineCount`, `revision`, `truncated` and a page of lines — but the
 * work happens here instead of in a freshly spawned worker process. Everything that decides *what*
 * may be read (policy, credential fence, anchoring) already ran in `worker.ts`; this module only
 * opens the descriptors it is handed and applies the read gates:
 *
 *   1. pool        — in-flight files <= concurrency, so descriptors peak at concurrency
 *   2. size gate   — `fstat` on the open descriptor, not `stat` on the path
 *   3. deadline    — one timer for open/fstat/read/close, not one per phase
 *   4. binary gate — NUL inside the decode window; UTF-16 BOM is text, not binary
 *   5. decode gate — BOM handling, fatal UTF-8 when the caller is the write path
 *   6. char cap    — stop decoding at the cap instead of reading 2 MB to throw it away
 *   7. batch budget — settled in input order by the compat renderer, deterministically
 */
import { promises as fsp } from 'node:fs'
import crypto from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import {
  DEFAULTS, OpsError, TRUNCATED_MARK, countNewlines, cutChars, emptyResult, errorOf,
  readCacheGet, readCacheSet, sleep,
} from './read-types.js'
import type { ReadOptions, ReadOverrides, ReadResult } from './read-types.js'
import { LINK_DENIED, assertParentDirs, fenceRealPath, resolveTarget, startLeafCheck } from './read-fence.js'

type Handle = Awaited<ReturnType<typeof fsp.open>>
type Decoder = StringDecoder | TextDecoder

/** Open with a short backoff on descriptor exhaustion; retrying is the point of the pool. */
async function openWithRetry(
  target: string,
  opts: ReadOptions,
  guard: <T>(pending: Promise<T>) => Promise<T>,
  deadline: number,
  abandoned: () => boolean,
): Promise<Handle> {
  for (let attempt = 0; ; attempt++) {
    try {
      const pending = fsp.open(target, 'r')
      // If the race was lost, the handle still lands later; close it or the pool leaks a descriptor.
      pending.then((handle) => { if (abandoned()) handle.close().catch(() => {}) }, () => {})
      return await guard(pending)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === 'EMFILE' || code === 'ENFILE' || code === 'EBUSY'
      if (!retryable || attempt >= opts.maxOpenRetries) throw error
      if (deadline - Date.now() <= 0) throw new OpsError('TIMEOUT', 'Retry budget exhausted')
      await sleep(8 * (attempt + 1))
    }
  }
}

/** Read one file under every gate. Never throws: the batch needs per-file isolation. */
export async function readOne(filePath: string, opts: ReadOptions, startedAt: number): Promise<ReadResult> {
  const deadline = startedAt + opts.timeoutMs
  const base = emptyResult(opts.normalize ? filePath.replace(/\\/g, '/') : filePath)

  let timer: ReturnType<typeof setTimeout> | null = null
  let abandoned = false
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandoned = true
      reject(new OpsError('TIMEOUT', `Exceeded the ${opts.timeoutMs}ms budget`))
    }, Math.max(1, opts.timeoutMs))
  })
  timeout.catch(() => {})

  const signal = opts.signal
  let onAbort: (() => void) | null = null
  const aborted = signal && typeof signal.addEventListener === 'function'
    ? new Promise<never>((_, reject) => {
      onAbort = () => { abandoned = true; reject(new OpsError('ABORTED', 'The caller cancelled this batch')) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    : null
  if (aborted) aborted.catch(() => {})

  const guard = <T>(pending: Promise<T>): Promise<T> => {
    pending.catch(() => {})
    return aborted ? Promise.race([pending, timeout, aborted]) : Promise.race([pending, timeout])
  }

  let handle: Handle | undefined
  try {
    if (signal?.aborted) throw new OpsError('ABORTED', 'The caller cancelled this batch')

    const target = resolveTarget(filePath, opts.root)
    // Pay `realpath` only when a root was supplied: the lexical check handles `..`, the real path
    // handles junctions. The root's own realpath is memoised on the batch.
    let opened = target
    if (opts.root) opened = await guard(fenceRealPath(target, opts.root, opts))

    let leafCheck: ReturnType<typeof startLeafCheck> | null = null
    if (!opts.allowLinks) {
      await guard(assertParentDirs(opened, opts.linkCache ?? (opts.linkCache = new Map())))
      leafCheck = startLeafCheck(opened)
    }

    handle = await openWithRetry(opened, opts, guard, deadline, () => abandoned)
    const leafStat = leafCheck ? await guard(leafCheck) : null
    if (leafStat?.isSymbolicLink()) throw new OpsError('PATH_RESTRICTED', LINK_DENIED)

    const stat = await guard(handle.stat())
    // `lstat` and `open` run concurrently; a swap between them leaves the check saying "regular"
    // while the descriptor followed the link. Matching dev+ino closes that window for free.
    if (leafStat && stat.ino !== 0 && leafStat.ino !== 0
      && (stat.ino !== leafStat.ino || stat.dev !== leafStat.dev)) {
      throw new OpsError('PATH_RESTRICTED', LINK_DENIED + ' (replaced between check and open)')
    }
    if (!stat.isFile()) throw new OpsError('NOT_A_FILE', 'Not a regular file (directory, device or pipe)')
    base.size = stat.size
    base.mtimeMs = Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null
    if (stat.size > opts.maxFileSize) {
      throw new OpsError('FILE_TOO_LARGE', `File is ${stat.size} bytes, above the ${opts.maxFileSize} byte limit`)
    }

    const window = opts.lineWindow ?? null
    const rows: string[] = []
    const windowMaxBytes = window && window.maxBytes > 0 ? window.maxBytes : 0
    let windowBytes = 0
    let rowsClipped = false
    let windowStop = 0
    let carry = ''
    let lineNo = 0

    let text = ''
    let bytes = 0
    let position = 0
    let lineBreaks = 0
    let lastChar = ''
    let truncated = false
    let textCut = false
    let decoder: Decoder | null = null
    let encoding = opts.encoding
    let nulGate = opts.nulGate
    const keep = opts.full ? opts.maxChars : Math.min(opts.maxChars, opts.maxTotalChars)

    const cacheKey = stat.ino !== 0
      ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}|${opts.full ? 1 : 0}${opts.hash ? 1 : 0}${opts.normalize ? 1 : 0}${opts.stripBom ? 1 : 0}${opts.strictUtf8 ? 1 : 0}|${keep}|${window ? `${window.from}:${window.to}:${window.maxBytes}` : '-'}`
      : null
    if (cacheKey !== null) {
      const cached = readCacheGet(cacheKey)
      if (cached !== undefined) return { ...base, ...cached, elapsedMs: Date.now() - startedAt }
    }

    // A digest must cover the whole file. Early stop would fingerprint a prefix and the caller
    // uses `revision` as a CAS token, so hash only when the read reaches EOF.
    const hasher = opts.hash && opts.full ? crypto.createHash('sha256') : null
    const buffer = Buffer.allocUnsafe(Math.max(3, Math.min(opts.chunkBytes, Math.max(1, stat.size))))

    const feed = (piece: string): void => {
      if (piece.length === 0) return
      lastChar = piece[piece.length - 1] as string
      if (!window) {
        if (opts.full) lineBreaks += countNewlines(piece)
        if (textCut) return
        const room = keep - text.length
        if (piece.length > room) {
          textCut = true
          text += cutChars(piece, room)
        } else {
          text += piece
        }
        return
      }
      let start = 0
      for (;;) {
        const newline = piece.indexOf('\n', start)
        if (newline === -1) break
        lineNo++
        if (windowStop === 0 && lineNo >= window.from && lineNo <= window.to) {
          const line = carry.length > 0 ? carry + piece.slice(start, newline) : piece.slice(start, newline)
          if (windowMaxBytes > 0 && windowBytes + line.length > windowMaxBytes && rows.length > 0) {
            // Once a line is dropped the page must end here: the renderer derives line numbers as
            // `offset + i`, so a hole would shift every later line and lose the giant one silently.
            rowsClipped = true
            windowStop = lineNo
          } else {
            rows.push(line.charCodeAt(line.length - 1) === 13 ? line.slice(0, -1) : line)
            windowBytes += line.length
          }
        }
        carry = ''
        start = newline + 1
      }
      if (start < piece.length && windowStop === 0 && lineNo + 1 >= window.from && lineNo + 1 <= window.to) {
        const rest = piece.length - start
        if (windowMaxBytes > 0 && windowBytes + carry.length + rest > windowMaxBytes && rows.length > 0) {
          rowsClipped = true
          windowStop = lineNo + 1
        } else {
          carry += piece.slice(start)
        }
      }
    }

    while (bytes < stat.size) {
      if (signal?.aborted) throw new OpsError('ABORTED', 'The caller cancelled this batch')
      const cap = Math.min(buffer.length, stat.size - bytes)
      const { bytesRead } = await guard(handle.read(buffer, 0, cap, position))
      if (bytesRead === 0) break
      // Judge against `buffer.length`, not `cap`: the final read is usually short, and slicing by
      // `cap` re-decodes the previous tail (content duplication plus a false truncation).
      const view = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead)
      bytes += bytesRead
      position += bytesRead
      if (hasher) hasher.update(view)

      let body: Buffer = view
      if (decoder === null) {
        if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
          if (opts.stripBom) body = body.subarray(3)
        } else if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
          // The write path is UTF-8 only; admitting UTF-16 would let an edit write a broken file.
          if (opts.strictUtf8) throw new OpsError('INVALID_UTF8', 'File is not valid UTF-8')
          encoding = 'utf16le'
          nulGate = false
          body = body.subarray(2)
        } else if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
          throw new OpsError(opts.strictUtf8 ? 'INVALID_UTF8' : 'UNSUPPORTED_ENCODING',
            opts.strictUtf8 ? 'File is not valid UTF-8' : 'UTF-16BE BOM is not supported; convert to UTF-8 first')
        }
        decoder = opts.strictUtf8
          ? new TextDecoder(encoding, { fatal: true, ignoreBOM: true })
          : new StringDecoder(encoding as BufferEncoding)
      }

      if (nulGate && body.includes(0)) {
        throw new OpsError('BINARY_FILE', `NUL within the first ${bytes} bytes; refusing to return text`)
      }

      try {
        feed(opts.strictUtf8
          ? (decoder as TextDecoder).decode(body, { stream: true })
          : (decoder as StringDecoder).write(body))
      } catch (error) {
        if (opts.strictUtf8 && (error as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
          throw new OpsError('INVALID_UTF8', 'File is not valid UTF-8')
        }
        throw error
      }

      if (!opts.full && !window && textCut) { truncated = true; break }
    }

    if (decoder) {
      let tail = ''
      try {
        tail = opts.strictUtf8 ? (decoder as TextDecoder).decode() : (decoder as StringDecoder).end()
      } catch (error) {
        if (opts.strictUtf8 && (error as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
          throw new OpsError('INVALID_UTF8', 'File is not valid UTF-8')
        }
        throw error
      }
      if (tail.length > 0) feed(tail)
    }
    if (window && lastChar && lastChar !== '\n') {
      lineNo++
      if (windowStop === 0 && carry.length > 0 && lineNo >= window.from && lineNo <= window.to) {
        // Only lines terminated by '\n' lose a '\r'. A lone trailing '\r' is content.
        rows.push(carry)
      }
    }

    // Normalise CRLF after truncation and before the marker: the marker itself contains '\n'.
    if (opts.normalize && text.indexOf('\r') !== -1) text = text.replace(/\r\n/g, '\n')
    if (!window && textCut) truncated = true
    if (truncated) text += TRUNCATED_MARK

    const payload = {
      status: 'success' as const,
      content: text,
      truncated,
      bytes,
      scannedBytes: bytes,
      rows: window ? rows : null,
      rowsClipped,
      lineCount: window ? lineNo : (opts.full ? lineBreaks + (lastChar && lastChar !== '\n' ? 1 : 0) : null),
      revision: hasher ? hasher.digest('hex') : null,
      elapsedMs: Date.now() - startedAt,
    }
    if (cacheKey !== null && !signal?.aborted) {
      const { elapsedMs: _elapsed, ...rest } = { ...base, ...payload }
      readCacheSet(cacheKey, { ...rest, rows: rest.rows ? rest.rows.slice() : rest.rows })
    }
    return { ...base, ...payload }
  } catch (error) {
    return { ...base, error: errorOf(error), elapsedMs: Date.now() - startedAt }
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort)
    }
    // The descriptor is always released. `close` can hang on the same bad media, so cap it.
    if (handle) {
      const remaining = deadline - Date.now()
      const capMs = remaining > 0 ? Math.min(opts.closeMs, remaining) : 1
      let closeTimer: ReturnType<typeof setTimeout> | null = null
      const cap = new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, capMs)
        if (typeof closeTimer.unref === 'function') closeTimer.unref()
      })
      try {
        await Promise.race([handle.close().catch(() => {}), cap])
      } finally {
        if (closeTimer) clearTimeout(closeTimer)
      }
    }
  }
}

/** Normalise caller overrides once, so the pool and the renderer cannot disagree. */
export function normalizeOptions(options: ReadOverrides = {}): ReadOptions {
  const opts: ReadOptions = { ...DEFAULTS, ...options }
  opts.concurrency = Math.max(1, Math.floor(opts.concurrency) || 1)
  if (!(opts.maxFileSize > 0)) opts.maxFileSize = DEFAULTS.maxFileSize
  if (!(opts.maxChars > 0)) opts.maxChars = DEFAULTS.maxChars
  if (!(opts.maxTotalChars > 0)) opts.maxTotalChars = DEFAULTS.maxTotalChars
  if (!(opts.timeoutMs > 0)) opts.timeoutMs = DEFAULTS.timeoutMs
  if (!(opts.chunkBytes > 0)) opts.chunkBytes = DEFAULTS.chunkBytes
  if (!(opts.closeMs > 0)) opts.closeMs = DEFAULTS.closeMs
  return opts
}

/**
 * Read a batch. Keys are the caller's paths; a failed file stays in the map with `status: 'error'`
 * so one bad path never hides the other files.
 */
export async function parallelRead(filePaths: readonly string[], options: ReadOverrides = {}): Promise<Record<string, ReadResult>> {
  if (!Array.isArray(filePaths)) throw new TypeError('filePaths must be an array of strings')
  const opts = normalizeOptions(options)
  const unique = [...new Set(filePaths.map(String))]
  const raw = await Promise.all(unique.map((file) => readOne(file, opts, Date.now())))

  // settle in input order so the batch budget is deterministic regardless of completion order
  const out: Record<string, ReadResult> = Object.create(null) as Record<string, ReadResult>
  let used = 0
  for (const item of raw) {
    if (item.status !== 'success' || item.content === null || item.content.length === 0) {
      out[item.path] = item
      continue
    }
    const room = opts.maxTotalChars - used
    if (room <= TRUNCATED_MARK.length) {
      out[item.path] = {
        ...item, status: 'error', content: null, truncated: false,
        error: { code: 'BUDGET_EXHAUSTED', message: `The batch ${opts.maxTotalChars} character budget is spent` },
      }
      continue
    }
    const cap = Math.min(opts.maxChars, room)
    const content = cutChars(item.content, cap)
    out[item.path] = { ...item, content, truncated: item.truncated || item.content.length > cap }
    used += content.length
  }
  return out
}
