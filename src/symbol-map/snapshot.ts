/**
 * Paging and snapshots.
 *
 * A symbol map is a **snapshot**: it records the revision of the bytes it was built from, so a
 * reader can tell whether the line numbers still mean what they said. That check is the whole
 * reason `revision` is a full SHA-256 rather than a timestamp — a timestamp answers "when", which
 * is the wrong question, and a 16-character `hash` alone is a cache key, not evidence.
 *
 * Paging is bounded twice on purpose: a row limit keeps a single response small, and a byte
 * budget keeps it small even when every symbol has a very long name. Either bound alone can be
 * defeated by the other.
 *
 * @module dsh-ops/symbol-map/snapshot
 */

import fs from 'node:fs'
import path from 'node:path'

import { fail } from './errors.js'
import { displayPath, readFileBuffer, revisionOf, HASH_LEN, REVISION_RE } from './files.js'
import type { PageOptions, Symbol, SymbolMap, SymbolPage, SymbolType } from './types.js'

/** Default rows per page. */
export const DEFAULT_LIMIT = 512

/** Default bytes of serialised symbols per page (96 KiB). */
export const DEFAULT_BUDGET_BYTES = 96 * 1024

const SYMBOL_TYPES: ReadonlySet<string> = new Set<SymbolType>(['function', 'class', 'method'])

/**
 * One-letter type codes, and the reason they exist.
 *
 * A symbol is four facts and a name. In JSON those four facts cost about twenty tokens per symbol
 * purely in field names — `{"name":"…","type":"method","startLine":12,"endLine":40}` — for a tool
 * whose entire purpose is to be cheaper than reading the file. Encoded as `12-40 m name` the same
 * symbol costs five, which makes the map 2.7× smaller on a real 24-file corpus and moves the
 * crossover against a full read from ~60 lines to ~25.
 *
 * `f` / `c` / `m` are the only three values `type` can take (see `SymbolType`), so the mapping is
 * total. {@link decodeSymbol} is the inverse, and it rejects anything else rather than guessing.
 */
const TYPE_CODE: Readonly<Record<SymbolType, string>> = Object.freeze({ function: 'f', class: 'c', method: 'm' })

/** Inverse of {@link TYPE_CODE}. */
const CODE_TYPE: Readonly<Record<string, SymbolType>> = Object.freeze({ f: 'function', c: 'class', m: 'method' })

/** `"12-40 m render"`, or `"12 f alpha"` when start and end are the same line. */
export function encodeSymbol(symbol: Symbol): string {
  const span = symbol.startLine === symbol.endLine ? `${symbol.startLine}` : `${symbol.startLine}-${symbol.endLine}`
  return `${span} ${TYPE_CODE[symbol.type]} ${symbol.name}`
}

/**
 * Recover a symbol from {@link encodeSymbol}.
 *
 * The name is everything after the second space, so a name may contain spaces and punctuation —
 * `[Symbol.iterator]` and `'quoted name'` both survive. A malformed entry returns `undefined`
 * rather than a half-built symbol, because a wrong line number is worse than a missing one.
 */
export function decodeSymbol(text: string): Symbol | undefined {
  const match = /^(\d+)(?:-(\d+))? ([fcm]) (.+)$/u.exec(text)
  if (match === null) return undefined
  const startLine = Number(match[1])
  const endLine = match[2] === undefined ? startLine : Number(match[2])
  const type = CODE_TYPE[match[3] as string]
  const name = match[4]
  if (type === undefined || name === undefined || name === '') return undefined
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) return undefined
  return { name, type, startLine, endLine }
}

function whole(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.floor(value)
}

/**
 * Slice one page out of a map.
 *
 * `offset` counts **symbols**, not lines — a caller that has already seen 40 symbols asks for
 * `offset: 40` regardless of which lines they came from. `scanned` is therefore the position
 * reached in the symbol array, and `omitted` is everything after it. `name` filters before either
 * bound applies, so a filtered page reports the offsets a caller can actually resume from.
 *
 * The `name` match is **case-sensitive**, deliberately. Folding case here would make `name: "get"`
 * also return `GetValue` — a wider set than the caller asked for, hiding a distinction the file
 * really does make. It is also the contract the tool schema and `docs/component-reference.md`
 * publish.
 */
export function paginate(map: SymbolMap, options: PageOptions = {}): SymbolPage {
  const needle = typeof options.name === 'string' && options.name !== '' ? options.name : undefined
  // Filter once, then page: `total`, `omitted` and `nextOffset` all describe the FILTERED set.
  // The old loop skipped non-matches inline but kept `map.total` as the denominator, so a name
  // that matches one symbol still reported `omitted: 50` — the caller kept paging through symbols
  // it had already excluded.
  const symbols = needle === undefined ? map.symbols : map.symbols.filter((symbol) => symbol.name.includes(needle))
  const total = symbols.length
  const offset = Math.min(Math.max(0, whole(options.offset, 0)), total)
  const limit = options.limit === 0 ? Number.POSITIVE_INFINITY : Math.max(1, whole(options.limit, DEFAULT_LIMIT))
  // The floor is one encoded line's worth, not the 256 the object form needed: a page that cannot
  // hold a single symbol would report `complete: false` with nothing to resume from.
  const budget = options.budgetBytes === 0 ? Number.POSITIVE_INFINITY : Math.max(32, whole(options.budgetBytes, DEFAULT_BUDGET_BYTES))

  const page: Symbol[] = []
  let used = 0
  let scanned = offset
  let truncatedBy: 'row-limit' | 'output-budget' | undefined

  for (let index = offset; index < total; index += 1) {
    scanned = index + 1
    const symbol = symbols[index]
    if (symbol === undefined) break
    if (page.length >= limit) {
      truncatedBy = 'row-limit'
      scanned = index
      break
    }
    // The budget is charged in the units the caller actually receives: one encoded line, plus the
    // JSON quotes and separator it will carry. Charging the old object form here would under-fill
    // a page by roughly half, which is a silent loss of information rather than a smaller answer.
    const cost = Buffer.byteLength(encodeSymbol(symbol), 'utf8') + 3
    if (used + cost > budget) {
      truncatedBy = 'output-budget'
      scanned = index
      break
    }
    used += cost
    page.push(symbol)
  }

  const complete = scanned >= total && truncatedBy === undefined
  const result: SymbolPage = {
    total,
    offset,
    symbols: page,
    omitted: Math.max(0, total - scanned),
    complete,
  }
  if (!complete) {
    result.nextOffset = scanned
    result.truncatedBy = truncatedBy ?? 'row-limit'
  }
  return result
}

/** Freshness of a snapshot relative to the file on disk. */
export interface SnapshotCheck {
  valid: boolean
  reason: 'fresh' | 'stale' | 'missing'
  /** Revision of the file on disk, or `null` when it could not be read. */
  revision: string | null
  /** What the snapshot claimed: the full revision, else the short hash, else `null`. */
  expected: string | null
  file: string
}

/**
 * Check whether a snapshot still describes the file.
 *
 * A short `hash` is accepted as `expected` because that is what a token-conscious caller will
 * carry around, but the comparison is still against the full revision: `revision.slice(0, 16)`
 * cannot collide in practice, and refusing the short form would make the hash useless.
 */
export function verifySymbolMap(snapshot: Pick<SymbolMap, 'file' | 'revision' | 'hash'>, file?: string): SnapshotCheck {
  const raw = file !== undefined && file !== '' ? file : snapshot.file
  if (raw === undefined || raw === '' || raw === '<memory>') {
    fail('E_NO_FILE', 'A snapshot of in-memory source cannot be verified; pass the file to check.')
  }
  const target = path.resolve(raw)
  const expected = snapshot.revision !== undefined && snapshot.revision !== '' ? snapshot.revision : (snapshot.hash ?? null)
  let buffer: Buffer
  try {
    buffer = readFileBuffer(target)
  } catch {
    return { valid: false, reason: 'missing', revision: null, expected, file: displayPath(target) }
  }
  const revision = revisionOf(buffer)
  const valid = expected !== null && (expected === revision || expected === revision.slice(0, HASH_LEN))
  return { valid, reason: valid ? 'fresh' : 'stale', revision, expected, file: displayPath(target) }
}

/**
 * Validate and normalise a snapshot document.
 *
 * Strict on purpose. A snapshot is a cache entry that may have been written by an older build,
 * edited by hand, or truncated mid-write; accepting a malformed one would hand a caller line
 * numbers that point at the wrong code, which is worse than an error. `hash` is recomputed from
 * `revision` rather than trusted, so a stale hash cannot smuggle in a wrong identity.
 */
export function parseSnapshot(raw: string | unknown): SymbolMap {
  let value: unknown
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      fail('E_SNAPSHOT', `Snapshot is not valid JSON: ${reason}`)
    }
  } else {
    value = raw
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('E_SNAPSHOT', 'Snapshot must be a JSON object.')
  }
  const record = value as Record<string, unknown>
  const revision = record.revision
  if (typeof revision !== 'string' || !REVISION_RE.test(revision)) {
    fail('E_SNAPSHOT', 'Snapshot revision must be a 64 character lowercase hex SHA-256.')
  }
  const list = record.symbols
  if (!Array.isArray(list)) fail('E_SNAPSHOT', 'Snapshot symbols must be an array.')

  const symbols: Symbol[] = []
  for (const entry of list as unknown[]) {
    if (typeof entry !== 'object' || entry === null) fail('E_SNAPSHOT', 'Every snapshot symbol must be an object.')
    const item = entry as Record<string, unknown>
    const name = item.name
    const type = item.type
    const startLine = item.startLine
    const endLine = item.endLine
    if (typeof name !== 'string' || name === '') fail('E_SNAPSHOT', 'A snapshot symbol has no name.')
    if (typeof type !== 'string' || !SYMBOL_TYPES.has(type)) fail('E_SNAPSHOT', `Unknown snapshot symbol type: ${String(type)}.`)
    if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
      fail('E_SNAPSHOT', `Snapshot symbol ${name} has an invalid startLine.`)
    }
    if (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < startLine) {
      fail('E_SNAPSHOT', `Snapshot symbol ${name} has an invalid endLine.`)
    }
    symbols.push({ name, type: type as SymbolType, startLine, endLine })
  }

  const map: SymbolMap = {
    file: typeof record.file === 'string' && record.file !== '' ? record.file : '<unknown>',
    lang: record.lang === 'tsx' || record.lang === 'javascript' || record.lang === 'typescript' ? record.lang : 'typescript',
    revision,
    hash: revision.slice(0, HASH_LEN),
    bytes: typeof record.bytes === 'number' && Number.isFinite(record.bytes) ? record.bytes : 0,
    partial: record.partial === true,
    total: symbols.length,
    symbols,
  }
  if (typeof record.syntaxErrors === 'number' && Number.isFinite(record.syntaxErrors)) {
    map.syntaxErrors = record.syntaxErrors
  }
  return map
}

/**
 * Write a snapshot atomically.
 *
 * `rename` within one directory is atomic on every platform this runs on, so a reader either sees
 * the previous snapshot or the new one — never a half-written file. The temp name carries pid and
 * time so two concurrent writers cannot collide.
 */
export function writeSnapshot(map: SymbolMap, outPath: string): string {
  const abs = path.resolve(outPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, abs)
  return abs
}

/** Read and validate a snapshot from disk. */
export function readSnapshot(snapshotPath: string): SymbolMap {
  const abs = path.resolve(snapshotPath)
  return parseSnapshot(readFileBuffer(abs).toString('utf8'))
}
