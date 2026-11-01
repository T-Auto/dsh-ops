/**
 * Reading one file: open, gate, decode, page — with one deadline for the whole chain.
 *
 * Three structural choices, all of them load-bearing:
 *
 *   a) `open` then `handle.stat()`, never `stat` then `open`: the fstat lands on the descriptor that was
 *      actually opened, so a path swapped underneath cannot produce a size from a different file.
 *   b) read and decode in chunks instead of probing 4 KiB, reading 2 MiB and truncating after — the
 *      character quota stops the read, which is what keeps a 2 MiB file from slowing the batch.
 *   c) **one deadline, one timer** for open/fstat/read. The previous version built a timer per phase:
 *      20 files meant 80 timers; now it is one deadline plus one `close` cap per file.
 *
 * @module dsh-ops/file/reader/read-one
 */

import { promises as fsp, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

import { emptyResult, OpsError, sleep, TRUNCATED_MARK, type ReadEntry, type ResolvedOptions } from './core.cjs'
import { assertParentDirs, fenceRealPath, LINK_DENIED, resolveTarget, startLeafCheck, type ReaderMemo } from './path-safety.cjs'
import { countNewlines, cutChars } from './text.cjs'

/** A page request: keep lines `[from, to]`, capped at `maxBytes` of line bytes. */
export interface LineWindow {
  from: number
  to: number
  maxBytes: number
}

/** The options a single read sees: the resolved defaults plus the batch memo and the page window. */
export type ReadContext = ResolvedOptions & ReaderMemo & { lineWindow?: LineWindow | null }

/** Everything a cache hit restores; `path`, `status` and `elapsedMs` are rebuilt per call. */
interface CachedPayload {
  content: string | null
  truncated: boolean
  bytes: number | null
  scannedBytes: number
  rows: string[] | null
  rowsClipped: boolean
  lineCount: number | null
  revision: string | null
}

/** A decoder that either validates (strict UTF-8) or substitutes. */
type Decoder = TextDecoder | StringDecoder

/**
 * Open with retries on descriptor exhaustion.
 *
 * Concurrency is the point of this reader, and its side effect is that a host already tight on descriptors
 * hits EMFILE sooner. Failing immediately on EMFILE would defeat the purpose, so it backs off 8/16 ms.
 */
export async function openWithRetry(target: string, opts: ReadContext, guard: <T,>(pending: Promise<T>) => Promise<T>, deadline: number, isAbandoned: () => boolean): Promise<FileHandle> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const pending = fsp.open(target, 'r')
      // The race may already have lost to the timeout while `open` is still in flight; when its handle
      // arrives nobody is waiting, and an unclosed descriptor is exactly the leak this tool exists to
      // prevent. A failing close has no actionable answer, so it is swallowed: a cleanup failure must not
      // become an unhandled rejection that takes the caller down.
      pending.then(handle => {
        if (isAbandoned()) handle.close().catch(() => {})
      }, () => {})
      return await guard(pending)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === 'EMFILE' || code === 'ENFILE' || code === 'EBUSY'
      if (!retryable || attempt >= opts.maxOpenRetries) throw error
      if (deadline - Date.now() <= 0) throw new OpsError('TIMEOUT', 'the retry budget ran out')
      await sleep(8 * (attempt + 1)) // let the other coroutines return their descriptors first
    }
  }
}

/**
 * Cross-call cache (LRU, in-process).
 *
 * Reading the same file twice in a session is normal (read, edit, read back to confirm), and every read
 * pays open + fstat + read + decode + SHA-256 + line splitting. Open and fstat must be paid every time —
 * they are the only evidence of what the file is *now*; what can be saved is the expensive part after them.
 *
 * The key carries dev:ino:size:mtime plus every switch that affects the text, so a hit is equivalent to
 * "same bytes, same window, same switches". No inode (some network shares report 0) means no key at all:
 * without identity there is no way to tell a hit from a stale answer, and stale text is worse than slow.
 */
const READ_CACHE_MAX_ENTRIES = 64
const READ_CACHE_MAX_CHARS = 8 << 20
const readCache = new Map<string, { value: CachedPayload, chars: number }>()
let readCacheChars = 0
let readCacheHits = 0
let readCacheMisses = 0

/** Look up a key, refreshing its recency on a hit. */
export function readCacheGet(key: string): CachedPayload | undefined {
  const hit = readCache.get(key)
  if (hit === undefined) {
    readCacheMisses += 1
    return undefined
  }
  readCache.delete(key)
  readCache.set(key, hit)
  readCacheHits += 1
  return hit.value
}

/** Store a payload, evicting least-recently-used entries until both caps hold. */
export function readCacheSet(key: string, value: CachedPayload): void {
  const chars = (value.content ? value.content.length : 0)
    + (value.rows ? value.rows.reduce((n, row) => n + row.length, 0) : 0)
  if (chars > READ_CACHE_MAX_CHARS) return // one huge entry is not worth the window
  readCache.set(key, { value, chars })
  readCacheChars += chars
  while (readCache.size > READ_CACHE_MAX_ENTRIES || readCacheChars > READ_CACHE_MAX_CHARS) {
    const oldest = readCache.keys().next()
    if (oldest.done) break
    readCacheChars -= (readCache.get(oldest.value as string) as { chars: number }).chars
    readCache.delete(oldest.value as string)
  }
}

/** Counters for the diagnostics path. */
export function readCacheStats(): { entries: number, chars: number, hits: number, misses: number } {
  return { entries: readCache.size, chars: readCacheChars, hits: readCacheHits, misses: readCacheMisses }
}

/** Drop everything the cache holds, including the counters. */
export function readCacheReset(): void {
  readCache.clear()
  readCacheChars = 0
  readCacheHits = 0
  readCacheMisses = 0
}

/**
 * Read one file.
 *
 * Returns a `ReadEntry` in every case, including failure: the caller never has to catch for a per-file
 * error, and a failed file keeps its place in the batch.
 */
export async function readOne(filePath: string, opts: ReadContext, startedAt: number): Promise<ReadEntry> {
  const deadline = startedAt + opts.timeoutMs
  // The key and the reported path come from the same place: POSIX under `normalize`, verbatim otherwise —
  // the compat entry point needs byte-identical paths.
  const base = emptyResult(opts.normalize ? filePath.replace(/\\/g, '/') : filePath)

  let timer: ReturnType<typeof setTimeout> | null = null
  let abandoned = false // the timer fired; a handle that arrives later must be closed by openWithRetry
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandoned = true
      reject(new OpsError('TIMEOUT', `exceeded the ${opts.timeoutMs}ms budget`))
    }, Math.max(1, opts.timeoutMs))
  })
  timeout.catch(() => {}) // after the timeout nobody awaits it

  // Cancellation has to interrupt an *in-flight* open or read: checking `aborted` only at chunk boundaries
  // lets an open stuck on a bad disk run until the timeout. The listener must come off in `finally`, or a
  // batch of 20 files hangs 20 closures on one signal.
  const signal = opts.signal
  let onAbort: (() => void) | null = null
  const aborted = signal && typeof signal.addEventListener === 'function'
    ? new Promise<never>((_, reject) => {
      onAbort = () => {
        abandoned = true
        reject(new OpsError('ABORTED', 'the caller cancelled this batch'))
      }
      if (signal.aborted) (onAbort as () => void)()
      else signal.addEventListener('abort', onAbort as () => void, { once: true })
    })
    : null
  if (aborted) aborted.catch(() => {}) // a file that finishes first leaves this rejection unobserved

  const guard = <T,>(pending: Promise<T>): Promise<T> => {
    pending.catch(() => {}) // the losing side of every race still needs a handler
    return aborted ? Promise.race([pending, timeout, aborted]) as Promise<T> : Promise.race([pending, timeout]) as Promise<T>
  }

  let handle: FileHandle | undefined
  try {
    if (opts.signal?.aborted) throw new OpsError('ABORTED', 'the caller cancelled this batch')

    // 1) Open once; every piece of metadata comes off this descriptor afterwards.
    const target = resolveTarget(filePath, opts.root)
    // The realpath is only paid with a root: the lexical check stops '../', the real check stops links.
    const opened = opts.root ? await guard(fenceRealPath(target, opts.root, opts)) : target
    let leafPending: Promise<Stats> | null = null
    if (!opts.allowLinks) {
      await guard(assertParentDirs(opened, opts)) // the directory chain, cached per batch
      leafPending = startLeafCheck(opened) as Promise<Stats> // the leaf, in the same syscall window as the open
    }
    handle = await openWithRetry(opened, opts, guard, deadline, () => abandoned)
    let leafStat: Stats | null = null
    if (leafPending) {
      leafStat = await guard(leafPending)
      if (leafStat.isSymbolicLink()) throw new OpsError('PATH_RESTRICTED', LINK_DENIED)
    }

    // 2) Size gate on the fstat: refuse before reading a byte.
    const stat = await guard(handle.stat()) as Stats
    // The lstat and the open run concurrently: swapping a regular file for a link between them leaves the
    // lstat saying "regular" while the open already followed the link. A dev+ino mismatch is that swap.
    // The handle is closed by `finally`; this check costs no extra syscall.
    if (leafStat && leafStat.ino !== 0 && stat.ino !== 0
      && (stat.ino !== leafStat.ino || stat.dev !== leafStat.dev)) {
      throw new OpsError('PATH_RESTRICTED', `${LINK_DENIED} (replaced between check and open)`)
    }
    if (!stat.isFile()) throw new OpsError('NOT_A_FILE', 'not a regular file (directory, device or pipe)')
    base.size = stat.size
    base.mtimeMs = Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null
    if (stat.size > opts.maxFileSize) {
      throw new OpsError('FILE_TOO_LARGE', `the file is ${stat.size} bytes, over the ${opts.maxFileSize}-byte ceiling; refusing to read it`)
    }

    // 3) Chunked read with the gates applied while decoding.
    //    Window mode keeps only lines [from, to]: the body never enters memory
    //    (measured 20×1MB: 28.6 MB of heap down to 1.6 MB).
    const win = opts.lineWindow ?? null
    const rows: string[] | null = win ? [] : null
    const winMaxBytes = win && win.maxBytes > 0 ? win.maxBytes : 0
    let winBytes = 0
    let rowsClipped = false
    let winStop = 0 // the page's closing line: page rows must be a dense prefix from `from`
    let carry = ''
    let lineNo = 0

    let text = ''
    let bytes = 0
    let position = 0
    let lineBreaks = 0
    let lastChar = ''
    let truncated = false
    let textCut = false // the body really was cut by `keep`, as opposed to "the bytes ran out"
    let decoder: Decoder | null = null // built after the first chunk reveals a BOM
    let enc = opts.encoding
    let nulGate = true // UTF-16 contains NUL by nature; the BOM turns this gate off
    // native: how many characters one file may deliver; full: how much body to keep for line counting
    const keep = opts.full ? opts.maxChars : Math.min(opts.maxChars, opts.maxTotalChars)

    // 3.5) Cache hit: identity plus every switch that affects the text, so a hit means identical output.
    const cacheKey = stat.ino !== 0
      ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}|${opts.full ? 1 : 0}${opts.hash ? 1 : 0}${opts.normalize ? 1 : 0}${opts.stripBom ? 1 : 0}${opts.strictUtf8 ? 1 : 0}|${keep}|${win ? `${win.from}:${win.to}:${win.maxBytes}` : '-'}`
      : null
    if (cacheKey !== null) {
      const cached = readCacheGet(cacheKey)
      if (cached !== undefined) return { ...base, status: 'success', ...cached, elapsedMs: Date.now() - startedAt }
    }
    // A digest has to cover the whole file. In early-stop mode it would cover only a prefix, and the
    // revision would then be used upstream as a content fingerprint for CAS — wrong, and silently so. So
    // hashing only happens in full mode, which reads to EOF.
    const hasher = opts.hash && opts.full ? createHash('sha256') : null
    // One buffer per file. At least 3 bytes, because the BOM decision must fit in a single chunk: with
    // chunkBytes of 1 or 2 the BOM would straddle chunks — U+FEFF would leak into the first line, and UTF-16
    // would be killed by the NUL gate as binary.
    const buf = Buffer.allocUnsafe(Math.max(3, Math.min(opts.chunkBytes, Math.max(1, stat.size))))

    /** Feed decoded text: window mode records line numbers and matching lines; otherwise it accumulates. */
    const feed = (piece: string): void => {
      if (piece.length === 0) return
      lastChar = piece[piece.length - 1] // a trailing newline decides whether lineCount needs +1
      if (!win) {
        if (opts.full) lineBreaks += countNewlines(piece)
        if (textCut) return // quota spent: keep counting lines and hashing, stop building text
        const room = keep - text.length
        // The test is "this chunk is longer than what is left", and it must stay in force after textCut is
        // set: with small chunks the old code stopped reporting truncation once the body filled up.
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
        const nl = piece.indexOf('\n', start)
        if (nl === -1) break
        lineNo += 1
        if (winStop === 0 && lineNo >= win.from && lineNo <= win.to) {
          // `carry` only accumulates while the current line is inside the window, so an enormous line
          // outside it cannot eat memory.
          const line = carry.length > 0 ? carry + piece.slice(start, nl) : piece.slice(start, nl)
          if (winMaxBytes && winBytes + line.length > winMaxBytes && (rows as string[]).length > 0) {
            // Clipping a line closes the page immediately. The old code skipped the line and kept adding
            // later ones, producing a page with a hole — while the caller derives line numbers as
            // offset+i, so every line after the huge one was reported one number too early (measured after
            // a 400 KB line) and the huge line itself was lost. Closing here keeps rows a dense prefix.
            rowsClipped = true
            winStop = lineNo
          } else {
            ;(rows as string[]).push(line.charCodeAt(line.length - 1) === 13 ? line.slice(0, -1) : line)
            winBytes += line.length
          }
        }
        carry = ''
        start = nl + 1
      }
      // An unclosed tail: keep accumulating only while the page is still open, and close it if this single
      // line busts the budget. Otherwise a huge line would be delivered as "first part + last chunk" with
      // the middle missing.
      if (start < piece.length && winStop === 0 && lineNo + 1 >= win.from && lineNo + 1 <= win.to) {
        const rest = piece.length - start
        if (winMaxBytes && winBytes + carry.length + rest > winMaxBytes && (rows as string[]).length > 0) {
          rowsClipped = true
          winStop = lineNo + 1
        } else {
          carry += piece.slice(start)
        }
      }
    }

    while (bytes < stat.size) {
      if (opts.signal?.aborted) throw new OpsError('ABORTED', 'the caller cancelled this batch')

      const cap = Math.min(buf.length, stat.size - bytes)
      const { bytesRead } = await guard(handle.read(buf, 0, cap, position))
      if (bytesRead === 0) break // the file was truncated underneath us
      // The test is against buf.length, not cap. The last read usually has cap < buf.length (the size is not
      // a multiple of the chunk), and testing against cap re-decodes the whole buffer including the previous
      // chunk's tail — measured: 34464 extra bytes decoded on a 100000-byte file, i.e. duplicated content
      // plus a fake truncation.
      const view = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead)
      bytes += bytesRead
      position += bytesRead
      if (hasher) hasher.update(view) // the digest covers raw bytes including BOM, matching the original

      let body: Buffer = view
      if (decoder === null) {
        // 4) Decode gate: a BOM outranks the caller's encoding.
        if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
          if (opts.stripBom) body = body.subarray(3) // the compat path does not strip: text must match disk
        } else if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
          // Strict mode only accepts UTF-8; and letting UTF-16 through is worse — an upstream writer that
          // writes UTF-8 would corrupt the whole file.
          if (opts.strictUtf8) throw new OpsError('INVALID_UTF8', 'File is not valid UTF-8')
          enc = 'utf16le'
          nulGate = false
          body = body.subarray(2) // Windows "Unicode" text
        } else if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
          throw new OpsError(
            opts.strictUtf8 ? 'INVALID_UTF8' : 'UNSUPPORTED_ENCODING',
            opts.strictUtf8 ? 'File is not valid UTF-8' : 'a UTF-16BE BOM was detected, which is not supported; convert to UTF-8 first',
          )
        }
        // Strict mode uses a fatal TextDecoder: invalid bytes throw instead of filling the context with
        // U+FFFD. It buffers across chunks itself, so a UTF-8 sequence split at a boundary is not a false
        // positive (StringDecoder does not validate). `ignoreBOM` must be explicit: TextDecoder strips a BOM
        // by default, which would double-strip on top of the subarray(3) above — a double-BOM file would
        // lose two U+FEFF in the compat path and only one in native.
        decoder = opts.strictUtf8 ? new TextDecoder(enc, { fatal: true, ignoreBOM: true }) : new StringDecoder(enc)
      }

      // 5) Binary gate: a NUL in the decoded window means binary; never return megabytes of mojibake.
      if (nulGate && body.includes(0)) {
        throw new OpsError('BINARY_FILE', `a NUL was found within the first ${bytes} bytes; treating this as binary and refusing to return text`)
      }

      try {
        const active = decoder
        feed(opts.strictUtf8 ? (active as TextDecoder).decode(body, { stream: true }) : (active as StringDecoder).write(body))
      } catch (error) {
        if (opts.strictUtf8 && (error as { code?: string }).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
          throw new OpsError('INVALID_UTF8', 'File is not valid UTF-8')
        }
        throw error
      }

      // 6) Per-file truncation: once the character quota really cut something, stop reading — this is what
      //    keeps a 2 MiB file from slowing the whole batch. The test is `textCut`, not `text.length >= keep`:
      //    a file smaller than one chunk reads to EOF in a single pass, so `bytes === stat.size` while the
      //    body was still cut by `keep` (a 60000-character file read as 50000); byte-counting alone would
      //    report that as truncated=false.
      if (!opts.full && !win && textCut) {
        truncated = true
        break
      }
      // A short read is deliberately not treated as EOF: SMB and network shares return partial reads, and
      // stopping there would silently return half a file. Only `bytes >= stat.size` or a zero read ends it.
    }

    let tail = ''
    if (decoder) {
      try {
        tail = opts.strictUtf8 ? (decoder as TextDecoder).decode() : (decoder as StringDecoder).end()
      } catch (error) {
        if (opts.strictUtf8 && (error as { code?: string }).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
          throw new OpsError('INVALID_UTF8', 'File is not valid UTF-8')
        }
        throw error
      }
    }
    if (tail.length > 0) feed(tail)
    if (win && lastChar && lastChar !== '\n') {
      // The last line has no newline.
      lineNo += 1
      if (winStop === 0 && carry.length > 0 && lineNo >= win.from && lineNo <= win.to) {
        // Only a line ended by '\n' loses its '\r' (that half of a CRLF). A lone '\r' at end of file is
        // content: the original returns "a\rb\rc\r" and its callers diff and edit exactly that.
        ;(rows as string[]).push(carry)
      }
    }

    // CRLF to LF, probing before replacing: a pure-LF file allocates nothing, and 1.5 MB with CRs costs
    // 2.15 ms against 4.97 ms for an unconditional replace (2.3×) because V8 fast-paths a regex that never
    // matches. This runs after truncation and before the marker: the marker itself contains '\n', and
    // normalizing it first would cut a '\r' in half.
    if (opts.normalize && text.indexOf('\r') !== -1) text = text.replace(/\r\n/g, '\n')

    // Full mode reads the whole file for lineCount and the digest, but its body is still cut by `keep`.
    // Only the early-break path used to set `truncated`, so a full read of 80000 characters that returned
    // 50000 claimed truncated=false — the same silent error as the native early stop.
    if (!win && textCut) truncated = true
    // The body is already cut to `keep`; this only appends the marker. `truncate()` cannot be used: a cut
    // that lands exactly on `keep` would not append the marker.
    if (truncated) text += TRUNCATED_MARK

    const payload: CachedPayload & { status: 'success', elapsedMs: number } = {
      status: 'success',
      content: text,
      truncated,
      bytes,
      // Bytes covered by the binary and decode gates. Below `size` when the read stopped early — that is how
      // a caller knows "this is a prefix, and nothing after it was checked for NULs" rather than reading
      // `truncated` as a prefix length.
      scannedBytes: bytes,
      rows,
      rowsClipped,
      // Line counts only mean something in full mode, which reads to EOF; the early-stop mode reports null
      // rather than a wrong number.
      lineCount: win ? lineNo : (opts.full ? lineBreaks + (lastChar && lastChar !== '\n' ? 1 : 0) : null),
      revision: hasher ? hasher.digest('hex') : null,
      elapsedMs: Date.now() - startedAt,
    }
    // Only a successful, uncancelled read is cached: a cancellation is the caller's business and a half
    // result must not be handed to the next call.
    if (cacheKey !== null && !(signal && signal.aborted)) {
      const { elapsedMs, ...rest } = payload
      readCacheSet(cacheKey, { ...rest, rows: rest.rows ? rest.rows.slice() : rest.rows })
    }
    return { ...base, ...payload }
  } catch (error) {
    const problem = error as NodeJS.ErrnoException
    return {
      ...base,
      error: { code: problem.code || problem.name || 'UNKNOWN', message: problem.message || String(error) },
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(timer as unknown as ReturnType<typeof setTimeout>)
    if (signal && onAbort && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort as () => void)
    }
    // The descriptor is returned on every path — that is why this tool exists. `close` itself can hang on
    // the same bad disk, so it gets a cap: past it the process reclaims the handle, which is better than one
    // broken file holding up the batch.
    if (handle) {
      const remaining = deadline - Date.now()
      const capMs = remaining > 0 ? Math.min(opts.closeMs, remaining) : 1
      // This timer must be cleared explicitly: on the normal path `close` takes microseconds, but
      // Promise.race does not cancel the loser, so an uncleared 100 ms timer per file would pile up on
      // libuv's timer heap.
      let closeTimer: ReturnType<typeof setTimeout> | null = null
      const cap = new Promise<void>(resolve => {
        closeTimer = setTimeout(resolve, capMs)
        closeTimer.unref?.()
      })
      try {
        // A failing close has no actionable answer either; what this guards against is a close that hangs,
        // and that is what the cap is for.
        await Promise.race([handle.close().catch(() => {}), cap])
      } finally {
        clearTimeout(closeTimer as unknown as ReturnType<typeof setTimeout>)
      }
    }
  }
}
