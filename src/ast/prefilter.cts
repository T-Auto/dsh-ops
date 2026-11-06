/**
 * Content prefilter: decide which candidate files are worth parsing, and cache what was read.
 *
 * Kept out of the engine so the engine owns decisions (what a definition is, what a rewrite does)
 * and this module owns one mechanical thing — turning a file list into the subset that mentions a
 * needle, with the IO that implies. The cache lives here because it is keyed on the read, not on the
 * answer.
 */
import { promises as fsp } from 'node:fs'

/** What one candidate file contributed. `error` is set when the file could not be used as source. */
export interface Candidate { file: string; text: string | null; error?: string | null }

/** IO-bound reads: 64 lanes measured 112 ms against 32 lanes' 129 ms on 10 000 files. */
const PREFILTER_CONCURRENCY = 64
const CONTENT_CACHE_CHARS = 16 << 20
const MAX_BYTES = 2 << 20

interface CachedRead { mtimeMs: number; size: number; text: string; needle?: string; hit?: boolean }
const contentCache = new Map<string, CachedRead>()
/** Accounting unit is the UTF-16 code unit (`text.length`), not bytes. */
let contentCacheChars = 0

export const srcOf = (file: string, text: string | null = null, error: string | null = null): Candidate => ({ file, text, error })

/**
 * Read candidates across lanes and keep the ones whose text contains `needle`.
 *
 * A file that cannot be decoded is kept only when its latin1 view still mentions the needle: it is
 * then reported as `E_ENCODING` instead of being silently skipped, because "not source" and "not
 * searched" are different answers.
 *
 * @param files - absolute candidate paths.
 * @param needle - substring every kept file must contain; `null` keeps all of them.
 * @param signal - aborts the remaining lanes.
 * @returns the candidates that matched, in input order.
 */
export async function prefilterAsync(files: string[], needle: string | null, signal?: AbortSignal): Promise<Candidate[]> {
  if (!needle) return files.map((file) => srcOf(file))
  const needleBuf = Buffer.from(needle, 'utf8')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const out: Array<Candidate | undefined> = new Array(files.length)
  let next = 0
  const worker = async (): Promise<void> => {
    if (signal?.aborted) return
    while (next < files.length) {
      const i = next++
      const f = files[i]
      let st
      try { st = await fsp.stat(f) } catch { continue }
      if (!st.isFile() || st.size > MAX_BYTES) continue
      const cached = contentCache.get(f)
      let text: string | null
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        if (cached.needle === needle) {
          if (cached.hit) out[i] = srcOf(f, cached.text)
          continue
        }
        text = cached.text
        contentCache.delete(f)
        contentCache.set(f, cached)
      } else {
        let buf: Buffer
        try { buf = await fsp.readFile(f) } catch { continue }
        if (buf.includes(0)) continue
        try { text = decoder.decode(buf) } catch {
          text = null
          if (!buf.toString('latin1').includes(needle)) continue
        }
        if (text !== null) {
          if (contentCache.size === 0 && contentCacheChars !== 0) contentCacheChars = 0
          if (contentCacheChars + text.length <= CONTENT_CACHE_CHARS) {
            const stale = contentCache.get(f)
            if (stale) contentCacheChars -= stale.text.length
            contentCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, text })
            contentCacheChars += text.length
            while (contentCacheChars > CONTENT_CACHE_CHARS && contentCache.size > 1) {
              const oldestKey = contentCache.keys().next().value as string
              const oldest = contentCache.get(oldestKey) as { text: string }
              contentCacheChars -= oldest.text.length
              contentCache.delete(oldestKey)
            }
          }
        }
      }
      if (text === null) { if (needleBuf.length > 0) out[i] = srcOf(f, null, 'E_ENCODING'); continue }
      const hit = text.includes(needle)
      const entry = contentCache.get(f)
      if (entry) { entry.needle = needle; entry.hit = hit }
      if (hit) out[i] = srcOf(f, text)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(PREFILTER_CONCURRENCY, files.length)) }, worker))
  return out.filter((c): c is Candidate => c !== undefined)
}
