/**
 * Read-only, bounded measurement of OPS-owned disk resources.
 *
 * Everything here is a report: no write, no rename, no delete, and no link is
 * ever followed. A path that cannot be measured (permission, race, malformed
 * tree) degrades to one bounded skip entry instead of failing the report, which
 * is what lets "disk status" answer on a half-deleted or foreign tree.
 *
 * @module dsh-ops/disk/measure
 */
import fs from 'node:fs'
import path from 'node:path'

/** Why one entry was not counted. */
export type MeasureSkipReason = 'symlink' | 'unreadable' | 'entry-budget' | 'depth-budget' | 'out-of-root'

/** One entry this measurement deliberately did not count. */
export interface MeasureSkip {
  path: string
  reason: MeasureSkipReason
  code: string | null
}

/** Size and age of one measured target or bucket. */
export interface Measure {
  bytes: number
  files: number
  count: number
  ageMs: number | null
  samples: string[]
  skipped: MeasureSkip[]
  skippedCount: number
  truncated: boolean
  buckets: Record<string, Measure>
}

/** Limits and injected clock for one measurement. */
export interface MeasureOptions {
  now?: () => number
  maxEntries?: number
  maxDepth?: number
  sampleLimit?: number
  skipLimit?: number
  buckets?: Readonly<Record<string, RegExp>>
  boundary?: string
}

/** What a resource's resolver hands to the measurement. */
export interface MeasureTarget {
  path: string
  match?: RegExp
  buckets?: Readonly<Record<string, RegExp>>
  boundary: string
}

const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_MAX_DEPTH = 8
const DEFAULT_SAMPLE_LIMIT = 5
const DEFAULT_SKIP_LIMIT = 10

const EMPTY: () => Measure = () => ({
  bytes: 0, files: 0, count: 0, ageMs: null, samples: [], skipped: [], skippedCount: 0, truncated: false, buckets: {},
})

/** Whether child is root itself or lies below it, on resolved paths only. */
export function insideRoot(child: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null
}

function noteSkip(target: Measure, skip: MeasureSkip, limit: number): void {
  target.skippedCount += 1
  if (target.skipped.length < limit) target.skipped.push(skip)
}

/**
 * Measure one tree without following links. The root itself is checked first, so
 * a symlinked or out-of-bound root yields a skip instead of a traversal.
 * @param root - absolute path to measure.
 * @param options - limits and clock.
 * @returns the measurement.
 */
export function measureTree(root: string, options: MeasureOptions = {}): Measure {
  const result = EMPTY()
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const now = options.now ?? Date.now
  const skipLimit = options.skipLimit ?? DEFAULT_SKIP_LIMIT
  const boundary = options.boundary
  const resolved = path.resolve(root)
  if (boundary !== undefined && !insideRoot(resolved, boundary)) {
    noteSkip(result, { path: resolved, reason: 'out-of-root', code: null }, skipLimit)
    return result
  }
  let info
  try {
    info = fs.lstatSync(resolved)
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') noteSkip(result, { path: resolved, reason: 'unreadable', code }, skipLimit)
    return result
  }
  if (info.isSymbolicLink()) {
    noteSkip(result, { path: resolved, reason: 'symlink', code: null }, skipLimit)
    return result
  }
  if (!info.isDirectory()) {
    if (info.isFile()) {
      result.bytes = info.size
      result.files = 1
      result.count = 1
      result.ageMs = Math.max(0, now() - info.mtimeMs)
    } else noteSkip(result, { path: resolved, reason: 'unreadable', code: null }, skipLimit)
    return result
  }
  let visited = 0
  let oldest = info.mtimeMs
  const walk = (directory: string, depth: number): boolean => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      noteSkip(result, { path: directory, reason: 'unreadable', code: errorCode(error) }, skipLimit)
      return true
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      if (visited >= maxEntries) {
        if (!result.truncated) noteSkip(result, { path: directory, reason: 'entry-budget', code: null }, skipLimit)
        result.truncated = true
        return false
      }
      visited += 1
      const child = path.join(directory, entry.name)
      if (!insideRoot(child, resolved)) {
        noteSkip(result, { path: child, reason: 'out-of-root', code: null }, skipLimit)
        continue
      }
      let childInfo
      try {
        childInfo = fs.lstatSync(child)
      } catch (error) {
        noteSkip(result, { path: child, reason: 'unreadable', code: errorCode(error) }, skipLimit)
        continue
      }
      if (childInfo.isSymbolicLink()) {
        noteSkip(result, { path: child, reason: 'symlink', code: null }, skipLimit)
        continue
      }
      if (childInfo.isFile()) {
        result.bytes += childInfo.size
        result.files += 1
        if (childInfo.mtimeMs < oldest) oldest = childInfo.mtimeMs
        continue
      }
      if (!childInfo.isDirectory()) {
        noteSkip(result, { path: child, reason: 'unreadable', code: null }, skipLimit)
        continue
      }
      if (childInfo.mtimeMs < oldest) oldest = childInfo.mtimeMs
      if (depth >= maxDepth) {
        noteSkip(result, { path: child, reason: 'depth-budget', code: null }, skipLimit)
        continue
      }
      if (!walk(child, depth + 1)) return false
    }
    return true
  }
  walk(resolved, 0)
  result.count = 1
  result.ageMs = Math.max(0, now() - oldest)
  return result
}

/**
 * Measure the matching direct children of one directory as separate units.
 * Used for the per-call temp families (`dsh-ops-niu-exec-*`, result roots, …).
 * @param parent - absolute directory holding the family.
 * @param match - child-name pattern; a non-match is not an error and is not counted.
 * @param options - limits, clock and optional buckets.
 * @returns the aggregate measurement, plus one bucket per requested pattern.
 */
export function measureFamily(parent: string, match: RegExp, options: MeasureOptions = {}): Measure {
  const result = EMPTY()
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const now = options.now ?? Date.now
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT
  const skipLimit = options.skipLimit ?? DEFAULT_SKIP_LIMIT
  const boundary = options.boundary ?? parent
  const resolved = path.resolve(parent)
  if (!insideRoot(resolved, boundary)) {
    noteSkip(result, { path: resolved, reason: 'out-of-root', code: null }, skipLimit)
    return result
  }
  let info
  try {
    info = fs.lstatSync(resolved)
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') noteSkip(result, { path: resolved, reason: 'unreadable', code }, skipLimit)
    return result
  }
  if (info.isSymbolicLink()) {
    noteSkip(result, { path: resolved, reason: 'symlink', code: null }, skipLimit)
    return result
  }
  if (!info.isDirectory()) {
    noteSkip(result, { path: resolved, reason: 'unreadable', code: null }, skipLimit)
    return result
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true })
  } catch (error) {
    noteSkip(result, { path: resolved, reason: 'unreadable', code: errorCode(error) }, skipLimit)
    return result
  }
  let visited = 0
  let oldest: number | null = null
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (!match.test(entry.name)) continue
    if (visited >= maxEntries) {
      if (!result.truncated) noteSkip(result, { path: path.join(resolved, entry.name), reason: 'entry-budget', code: null }, skipLimit)
      result.truncated = true
      break
    }
    visited += 1
    const child = path.join(resolved, entry.name)
    let childInfo
    try {
      childInfo = fs.lstatSync(child)
    } catch (error) {
      noteSkip(result, { path: child, reason: 'unreadable', code: errorCode(error) }, skipLimit)
      continue
    }
    if (childInfo.isSymbolicLink()) {
      noteSkip(result, { path: child, reason: 'symlink', code: null }, skipLimit)
      continue
    }
    if (oldest === null || childInfo.mtimeMs < oldest) oldest = childInfo.mtimeMs
    if (childInfo.isDirectory()) {
      for (const [key, pattern] of Object.entries(options.buckets ?? {})) {
        const bucket = measureFamily(child, pattern, { maxEntries, maxDepth, now, sampleLimit, skipLimit, boundary: child })
        result.buckets[key] = result.buckets[key] === undefined ? bucket : combineMeasures([result.buckets[key]!, bucket])
      }
      const subtree = measureTree(child, { maxEntries, maxDepth, now, skipLimit })
      result.bytes += subtree.bytes
      result.files += subtree.files
      result.skippedCount += subtree.skippedCount
      for (const skip of subtree.skipped) if (result.skipped.length < skipLimit) result.skipped.push(skip)
      if (subtree.truncated) result.truncated = true
      if (subtree.ageMs !== null) {
        const subtreeOldest = now() - subtree.ageMs
        if (oldest === null || subtreeOldest < oldest) oldest = subtreeOldest
      }
    } else if (childInfo.isFile()) {
      result.bytes += childInfo.size
      result.files += 1
    } else {
      noteSkip(result, { path: child, reason: 'unreadable', code: null }, skipLimit)
      continue
    }
    result.count += 1
    if (result.samples.length < sampleLimit) result.samples.push(child)
  }
  result.ageMs = oldest === null ? null : Math.max(0, now() - oldest)
  return result
}

/**
 * Merge several measurements of one resource into one report row.
 * @param parts - the measurements to merge.
 * @returns the merged measurement.
 */
export function combineMeasures(parts: readonly Measure[]): Measure {
  const merged = EMPTY()
  for (const part of parts) {
    merged.bytes += part.bytes
    merged.files += part.files
    merged.count += part.count
    merged.skippedCount += part.skippedCount
    merged.truncated = merged.truncated || part.truncated
    for (const skip of part.skipped) if (merged.skipped.length < DEFAULT_SKIP_LIMIT) merged.skipped.push(skip)
    for (const sample of part.samples) if (merged.samples.length < DEFAULT_SAMPLE_LIMIT) merged.samples.push(sample)
    if (part.ageMs !== null && (merged.ageMs === null || part.ageMs > merged.ageMs)) merged.ageMs = part.ageMs
    for (const [key, bucket] of Object.entries(part.buckets)) merged.buckets[key] = bucket
  }
  return merged
}
