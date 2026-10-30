/**
 * The per-process map cache and the batch entry point.
 *
 * The cache key is `path + language + tier`, joined with NUL. The language is in the key because
 * the same file can be mapped as `typescript` or as `javascript` — a `.js` file that is really
 * generated TypeScript, a `.ts` file forced to `tsx` by a caller. Keying on the path alone would
 * serve the wrong map and, worse, would not fail: the line numbers would be plausible and the
 * symbols would be subtly wrong. That is the worst kind of cache bug, so it is designed out.
 *
 * A scoped map is never cached. It is a view of the file, not a map of it, and storing it under
 * the unscoped key would poison every later full read.
 *
 * @module dsh-ops/symbol-map/cache
 */

import path from 'node:path'

import { describe } from './errors.js'
import { buildFromBuffer, treeOfMap } from './engine.js'
import { DEFAULT_MAX_BYTES, readFileBuffer, revisionOf, statRegularFile } from './files.js'
import { counters, detectLanguage, poolStats, resetPools } from './grammar.js'
import type { MapFileOptions, SymbolMap, SyntaxEdit, SyntaxTree } from './types.js'

interface CacheEntry {
  revision: string
  map: SymbolMap
  /** The pool generation the entry's tree belongs to; see {@link counters.poolEpoch}. */
  epoch: number
  /** The exact text that was parsed, so the next revision can be turned into a single edit. */
  text: string
  /** `stat` identity from the read that produced this entry; see {@link getSymbolMap}. */
  mtimeMs: number
  size: number
}

/**
 * The single contiguous replacement that turns `before` into `after`, or `undefined` if the two
 * are equal.
 *
 * Common prefix and suffix are stripped, so one edited line collapses to one small edit even in a
 * 16k-line file. Several distant edits collapse into one large edit — still correct, just less of
 * a saving: tree-sitter re-parses the whole span between the first and last change. That is the
 * deliberate trade. Emitting N separate edits would need N `tree.edit()` calls in reverse order
 * and a second diff pass to keep their offsets consistent, and a wrong offset there corrupts the
 * map silently instead of slowly.
 */
function editBetween(before: string, after: string): SyntaxEdit | undefined {
  if (before === after) return undefined
  const shortest = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1
  let suffix = 0
  while (
    suffix < shortest - prefix
    && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) suffix += 1
  return {
    startIndex: prefix,
    oldEndIndex: before.length - suffix,
    newEndIndex: after.length - suffix,
    startPosition: pointAt(before, prefix),
    oldEndPosition: pointAt(before, before.length - suffix),
    newEndPosition: pointAt(after, after.length - suffix),
  }
}

/** The row/column of a UTF-16 index. `column` is a code-unit offset, matching the binding. */
function pointAt(text: string, index: number): { row: number, column: number } {
  let row = 0
  let lineStart = 0
  for (let at = 0; at < index; at += 1) {
    if (text.charCodeAt(at) === 10) {
      row += 1
      lineStart = at + 1
    }
  }
  return { row, column: index - lineStart }
}

/**
 * Bounds on the cache, in entries and in UTF-16 code units of retained source.
 *
 * The cache holds the parsed text and, through `treeOfMap`, a native tree — so an unbounded map is
 * a leak with a slow fuse: a session that maps one thousand files keeps one thousand trees alive
 * in a plugin process that may run for days. The byte ceiling is the one that matters (a tree costs
 * a multiple of its source), and the entry ceiling only stops a directory of tiny files from
 * parking an unreasonable number of handles. Both are large enough that the 24-file sweep the
 * benchmarks use never evicts anything.
 */
const FILE_CACHE_MAX_ENTRIES = 512
const FILE_CACHE_MAX_UNITS = 32 * 1024 * 1024

const fileCache = new Map<string, CacheEntry>()

/** Retained source size, so eviction does not have to walk the map to find out. */
let cacheUnits = 0

/** Move a key to the young end: `Map` iterates in insertion order, which is the LRU order here. */
function touch(key: string, entry: CacheEntry): void {
  fileCache.delete(key)
  fileCache.set(key, entry)
}

/** Drop the oldest entries until both ceilings hold again. */
function evict(): void {
  while (fileCache.size > FILE_CACHE_MAX_ENTRIES || cacheUnits > FILE_CACHE_MAX_UNITS) {
    const oldest = fileCache.keys().next()
    if (oldest.done === true) return
    const entry = fileCache.get(oldest.value)
    if (entry !== undefined) cacheUnits -= entry.text.length
    fileCache.delete(oldest.value)
  }
}

/**
 * Identify a cached map.
 *
 * An unknown language becomes `?` rather than throwing: the key must be computable before the
 * build so a miss can be detected, and a file with no known extension still deserves a cache slot
 * once the caller has supplied `lang`.
 */
export function cacheKeyOf(abs: string, options: MapFileOptions = {}): string {
  let lang = options.lang
  if (lang === undefined) lang = detectLanguage(abs)
  return `${abs}\u0000${lang ?? '?'}\u0000${options.extended === true ? 'ext' : 'core'}`
}

/** Mark a map as served-from-cache without making `cacheHit` part of the serialised shape. */
function markCacheHit(map: SymbolMap, hit: boolean): SymbolMap {
  Object.defineProperty(map, 'cacheHit', { value: hit, enumerable: false, configurable: true, writable: true })
  return map
}

/**
 * Map a file, reusing a cached map when the revision still matches.
 *
 * The revision is recomputed from the bytes on every call — that is the point of the cache. It
 * costs one SHA-256 pass over a file that is already in page cache, and it is the only way to know
 * whether the stored line numbers still describe the file.
 *
 * When the revision has moved the cached *tree* is still worth keeping: it is handed back to the
 * parser as `previousTree`, and tree-sitter re-parses only the subtrees whose text changed. A
 * one-line edit to a 16k-line module drops the parse from ~106 ms to well under a millisecond,
 * which is the difference between a navigation tool an agent can afford to call per step and one
 * it has to budget. The tree is only reusable while the pool that produced it is alive, which is
 * what `epoch` tracks: `resetPools()` deletes every native handle, and a tree from before the
 * reset would be a use-after-free rather than a slow path.
 */
export function getSymbolMap(file: string, options: MapFileOptions = {}): SymbolMap {
  const abs = path.resolve(file)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const stat = statRegularFile(abs, maxBytes)
  const cacheable = options.scope === undefined && options.force !== true
  const key = cacheKeyOf(abs, options)

  // Fast path: same file, same size, same mtime. Skipping the read and the hash takes a warm
  // 24-file sweep from ~8 ms to well under one, which matters because in a session most map
  // requests are repeats.
  //
  // What it costs: if a file is rewritten so that neither size nor mtime changes (both write
  // inside the same 100 ns timestamp tick), the cached map is served as if it were current. That
  // window is vanishingly small, and it is not a correctness hole for a writer — a stale
  // `revision` handed to `edit_file`/`write_file` fails their compare-and-swap rather than
  // overwriting silently. `force: true` bypasses this path entirely.
  if (cacheable) {
    const cached = fileCache.get(key)
    if (cached !== undefined && cached.epoch === counters.poolEpoch
      && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      touch(key, cached)
      return markCacheHit(cached.map, true)
    }
  }

  const buffer = readFileBuffer(abs)
  const revision = revisionOf(buffer)

  let previousTree: SyntaxTree | undefined
  if (cacheable) {
    const cached = fileCache.get(key)
    if (cached !== undefined && cached.revision === revision) {
      // Same bytes but a moved timestamp: refresh the stat identity so the next call takes the
      // fast path instead of hashing again.
      cached.mtimeMs = stat.mtimeMs
      cached.size = stat.size
      touch(key, cached)
      return markCacheHit(cached.map, true)
    }
    if (cached !== undefined && cached.epoch === counters.poolEpoch) {
      previousTree = treeOfMap.get(cached.map)
      // The edit must be recorded before the parse. Without it tree-sitter keeps the old node
      // offsets and every reused node reports the text that now sits at those offsets.
      const edit = previousTree === undefined ? undefined : editBetween(cached.text, buffer.toString('utf8'))
      if (edit !== undefined) previousTree?.edit?.(edit)
    }
  }

  const map = buildFromBuffer(abs, buffer, { ...options, maxBytes, previousTree })
  if (cacheable) {
    const text = buffer.toString('utf8')
    const previous = fileCache.get(key)
    if (previous !== undefined) {
      cacheUnits -= previous.text.length
      fileCache.delete(key)
    }
    fileCache.set(key, {
      revision, map, epoch: counters.poolEpoch, text,
      mtimeMs: stat.mtimeMs, size: stat.size,
    })
    cacheUnits += text.length
    evict()
  }
  return markCacheHit(map, false)
}

/** One entry of a batch: a map, or a failure that did not stop the batch. */
export type MapFileResult = SymbolMap | { file: string, error: { code: string, message: string } }

/**
 * Map several files, collecting failures instead of aborting.
 *
 * The default is to keep going: a batch read is a navigation aid, and one unreadable file in a
 * directory should not cost the caller the other twenty. `continueOnError: false` is available
 * when the caller wants all-or-nothing semantics.
 */
export function mapFiles(files: readonly string[], options: MapFileOptions = {}): { files: MapFileResult[], total: number, failed: number } {
  const out: MapFileResult[] = []
  let failed = 0
  for (const file of files) {
    try {
      out.push(getSymbolMap(file, options))
    } catch (error) {
      const { code, message } = describe(error)
      failed += 1
      if (options.continueOnError === false) throw error
      out.push({ file, error: { code, message } })
    }
  }
  return { files: out, total: out.length, failed }
}

/** Drop every cached map and every pooled parser/query. */
export function resetCaches(): void {
  fileCache.clear()
  cacheUnits = 0
  resetPools()
}

/** Counters plus pool sizes. `queryCompiles` staying at a small constant is the proof the pool works. */
export function stats(): { parserCreations: number, queryCompiles: number, parses: number, recoveryParses: number, cachedFiles: number, cachedUnits: number, poolParsers: number, poolQueries: number } {
  const pools = poolStats()
  return {
    parserCreations: counters.parserCreations,
    queryCompiles: counters.queryCompiles,
    parses: counters.parses,
    recoveryParses: counters.recoveryParses,
    cachedFiles: fileCache.size,
    cachedUnits: cacheUnits,
    poolParsers: pools.parsers,
    poolQueries: pools.queries,
  }
}
