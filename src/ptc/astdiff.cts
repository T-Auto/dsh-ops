/**
 * In-process AST audit — the zero-fork replacement for difftastic.
 *
 * difftastic spawns a 36 ms child, writes both files to tmp and reads JSON back. But the three
 * questions it answers can all be computed on two trees that are already parsed:
 *
 *   ① is the file still syntactically intact?      → ERROR node count in the after tree
 *   ② did anything outside the submitted edits move? → byte comparison outside the spans + node counts
 *   ③ did the structure change a lot?               → kind-set difference inside the spans
 *
 * Cost: two parses (~0.4 ms per thousand lines) plus an O(n) walk — two orders of magnitude faster
 * than difftastic, and no external binary. `ops_ptc_audit` still keeps difftastic as an independent
 * cross-check.
 *
 * `SgNode` is declared structurally rather than imported from `@ast-grep/napi`: that package is an
 * optional peer resolved at runtime, and importing its types would make a clean machine need it just
 * to compile this file.
 *
 * @module dsh-ops/ptc/astdiff
 */

import { spawnSync } from 'node:child_process'

import { napi } from './engine-load.cjs'
import type { NapiApi, SgNode } from './sg.cjs'


/** A language name accepted by `@ast-grep/napi`. Kept as `string`: the peer resolves it at runtime. */
export type Lang = string

/**
 * A span in the domain `@ast-grep/napi` uses: **UTF-16 character indices, not byte offsets**.
 *
 * `node.replace()` / `commitEdits()` work in that same domain, so mixing byte offsets in misplaces
 * edits on any source with CJK or emoji (measured: `export function demo(){\r\n return 说明; }` is byte
 * 59 vs character 49).
 */
export interface AstSpan {
  startByte: number
  endByte: number
}

/** An edit to apply: the span it replaces and the text that lands there. */
export type AstEdit = AstSpan & { text: string }

/** The audit's verdict plus the statistics a summary line needs. */
export interface AstAudit {
  ok: boolean
  /** Edit spans that actually changed structure. */
  hunks: number
  nodesRemoved: number
  nodesAdded: number
  /** ERROR nodes in the after tree; whether that is new is what `ok` says. */
  errorNodes: number
  /** ERROR nodes in the before tree; >0 means the file was already broken. */
  errorNodesBefore: number
  /** Who judged syntax integrity: the TypeScript parser, or ERROR nodes alone. */
  parser: 'tsc' | 'tree-sitter'
  diagAfter: number
  diagBefore: number
  /** Share of bytes untouched; lower means a wider change. */
  unchangedRatio: number
  /** Kinds seen inside the spans, at most six, for the summary line. */
  kinds: string[]
  bytesBefore: number
  bytesAfter: number
  ms: number
  code?: string
  message?: string
}

/** What the `sg` CLI cross-check concluded. */
export interface SgCrossCheck {
  agree: boolean
  napiCount: number
  sgCount: number
  /** Empty when the counts agree; otherwise what each side reported. */
  diff: string[]
  ms: number
  stderr?: string
}

/** One parse, plus the ERROR nodes lazily extracted from it. */
interface RootMeta { lang: string, text: string, root: SgNode, errors: SgNode[] | null }

/** A named node reduced to what the statistics need. */
interface ReducedSpan { kind: string, start: number, end: number }

/** A syntax diagnostic, from tsc or synthesized from a tree-sitter ERROR node. */
interface Diagnostic { start: number, length: number, code: string, message: string }

const errorsOf = (meta: RootMeta | undefined): SgNode[] => {
  if (!meta) return []
  return meta.errors ?? (meta.errors = meta.root.findAll({ rule: { kind: 'ERROR' } }))
}

const auditRoots = new WeakMap<SgNode, RootMeta>()
const ROOT_CACHE_MAX_ENTRIES = 6
const ROOT_CACHE_MAX_CHARS = 4 << 20
const rootCache = new Map<string, Map<string, RootMeta>>()
let rootCacheChars = 0
let rootCacheEntries = 0

function evictOldestRoot(): boolean {
  for (const [key, bucket] of rootCache) {
    const first = bucket.keys().next()
    if (first.done) {
      rootCache.delete(key)
      continue
    }
    const meta = bucket.get(first.value)
    bucket.delete(first.value)
    if (meta) {
      rootCacheChars -= meta.text.length
      rootCacheEntries -= 1
    }
    if (bucket.size === 0) rootCache.delete(key)
    return true
  }
  return false
}

function cachedRoot(lang: Lang, text: string): RootMeta | undefined {
  const bucket = rootCache.get(String(lang))
  const hit = bucket?.get(text)
  if (!hit || !bucket) return undefined
  // Refresh recency: Map preserves insertion order, so re-inserting moves it to the end.
  bucket.delete(text)
  bucket.set(text, hit)
  return hit
}

/** Parse `text` as `lang`, reusing a cached root when the same text was parsed recently. */
export function parseAuditRoot(lang: Lang, text: string): SgNode {
  const hit = cachedRoot(lang, text)
  if (hit) return hit.root
  const root = (napi as unknown as NapiApi).parse(lang, text).root()
  const meta: RootMeta = { lang, text, root, errors: null }
  auditRoots.set(root, meta)
  const key = String(lang)
  let bucket = rootCache.get(key)
  if (!bucket) {
    bucket = new Map<string, RootMeta>()
    rootCache.set(key, bucket)
  }
  bucket.set(text, meta)
  rootCacheChars += text.length
  rootCacheEntries += 1
  while (rootCacheEntries > ROOT_CACHE_MAX_ENTRIES || rootCacheChars > ROOT_CACHE_MAX_CHARS) {
    if (!evictOldestRoot()) break
  }
  return root
}

const collect = (node: SgNode, out: ReducedSpan[]): void => {
  for (const child of node.namedChildren()) {
    const range = child.range()
    out.push({ kind: String(child.kind()), start: range.start.index, end: range.end.index })
    collect(child, out)
  }
}

/** First span whose end is after `start`; spans must be sorted by `startByte`. */
const firstEndingAfter = (spans: AstSpan[], start: number): number => {
  let lo = 0
  let hi = spans.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (spans[mid].endByte <= start) lo = mid + 1
    else hi = mid
  }
  return lo
}

const collectWithin = (node: SgNode, spans: AstSpan[], out: ReducedSpan[]): void => {
  for (const child of node.namedChildren()) {
    const range = child.range()
    const span = spans[firstEndingAfter(spans, range.start.index)]
    if (!span || range.end.index <= span.startByte) continue
    if (range.start.index >= span.startByte && range.end.index <= span.endByte) {
      out.push({ kind: String(child.kind()), start: range.start.index, end: range.end.index })
    }
    collectWithin(child, spans, out)
  }
}

/**
 * For each span, whether it contains any of `nodes`.
 *
 * `minEnds` is a suffix minimum of the nodes' ends, so one pass over spans and one over nodes answers
 * every query — the naive form was O(spans × nodes) on every audit.
 */
const containedSpans = (spans: AstSpan[], nodes: ReducedSpan[]): boolean[] => {
  const minEnds = new Array<number>(nodes.length + 1)
  minEnds[nodes.length] = Infinity
  for (let i = nodes.length - 1; i >= 0; i -= 1) minEnds[i] = Math.min(nodes[i].end, minEnds[i + 1])
  let cursor = 0
  return spans.map(span => {
    while (cursor < nodes.length && nodes[cursor].start < span.startByte) cursor += 1
    return minEnds[cursor] <= span.endByte
  })
}

const normalizeSpans = (spans: AstSpan[]): AstSpan[] => [...spans].sort((a, b) => a.startByte - b.startByte)

let tsMod: typeof import('typescript') | null | undefined

const loadTs = (): typeof import('typescript') | null => {
  if (tsMod !== undefined) return tsMod
  try {
    tsMod = require('typescript') as typeof import('typescript')
  } catch {
    tsMod = null
  }
  return tsMod
}

const diagnosticCaches = new Map<string, Map<string, Diagnostic[] | null>>()
const DIAGNOSTIC_CACHE_ENTRIES = 16
const DIAGNOSTIC_CACHE_CHARS = 4_000_000
let diagnosticCacheChars = 0

/**
 * TypeScript parse diagnostics for `text`, or `null` when tsc is unavailable or the language is not
 * one it parses.
 *
 * `null` is a real answer, not a failure: callers fall back to tree-sitter ERROR nodes, and the audit
 * reports which oracle it used.
 */
function tsDiagnostics(text: string, lang: string): Diagnostic[] | null {
  let cache = diagnosticCaches.get(lang)
  const cached = cache?.get(text)
  if (cached !== undefined && cache) {
    cache.delete(text)
    cache.set(text, cached)
    return cached
  }
  const ts = loadTs()
  if (!ts) return null
  const kinds: Record<string, import('typescript').ScriptKind> = {
    TypeScript: ts.ScriptKind.TS,
    Tsx: ts.ScriptKind.TSX,
    JavaScript: ts.ScriptKind.JS,
  }
  const kind = kinds[lang]
  if (kind === undefined) return null
  const sourceFile = ts.createSourceFile('ptc.ts', text, ts.ScriptTarget.Latest, false, kind)
  // `parseDiagnostics` is on the SourceFile at runtime but is not part of the public type surface;
  // naming the shape here is the smallest honest bridge.
  const parseDiagnostics = (sourceFile as unknown as {
    parseDiagnostics: ReadonlyArray<{ start?: number, length?: number, code: number, messageText: string | import('typescript').DiagnosticMessageChain }>
  }).parseDiagnostics
  const diagnostics: Diagnostic[] = parseDiagnostics.map(d => ({
    start: d.start ?? 0,
    length: d.length ?? 0,
    code: String(d.code),
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  }))
  if (!cache) {
    cache = new Map<string, Diagnostic[] | null>()
    diagnosticCaches.set(lang, cache)
  }
  if (text.length <= DIAGNOSTIC_CACHE_CHARS) {
    while (diagnosticCaches.size > 0 && (diagnosticCacheChars + text.length > DIAGNOSTIC_CACHE_CHARS
      || [...diagnosticCaches.values()].reduce((n, c) => n + c.size, 0) >= DIAGNOSTIC_CACHE_ENTRIES)) {
      const oldestLang = diagnosticCaches.keys().next().value as string
      const oldest = diagnosticCaches.get(oldestLang) as Map<string, Diagnostic[] | null>
      const oldestText = oldest.keys().next().value as string
      oldest.delete(oldestText)
      diagnosticCacheChars -= oldestText.length
      if (oldest.size === 0) diagnosticCaches.delete(oldestLang)
    }
    cache.set(text, diagnostics)
    diagnosticCacheChars += text.length
  }
  return diagnostics
}

/**
 * Whether `after` carries a diagnostic that `before` did not.
 *
 * Diagnostics outside the edited spans are matched by identity (start, length, code, message) after
 * shifting them by the byte delta of the edits before them, so an edit earlier in the file does not
 * make every later diagnostic look new.
 */
function hasNewDiagnostics(before: Diagnostic[], after: Diagnostic[], edits: AstEdit[], beforeText: string): boolean {
  if (after.length === 0) return false
  if (before.length === 0) return true
  const changed = edits.filter(edit => beforeText.slice(edit.startByte, edit.endByte) !== edit.text)
  const key = (d: Diagnostic): string => JSON.stringify([d.start, d.length, d.code, d.message])
  const remaining = new Map<string, number>()
  for (const d of before) {
    const end = d.start + d.length
    const overlaps = changed.some(edit => {
      if (edit.startByte === edit.endByte) return edit.startByte > d.start && edit.startByte < end
      return d.length === 0
        ? d.start >= edit.startByte && d.start < edit.endByte
        : edit.startByte < end && edit.endByte > d.start
    })
    if (overlaps) continue
    const delta = changed.reduce((n, edit) => edit.endByte <= d.start ? n + edit.text.length - (edit.endByte - edit.startByte) : n, 0)
    const k = key({ ...d, start: d.start + delta })
    remaining.set(k, (remaining.get(k) ?? 0) + 1)
  }
  for (const d of after) {
    const k = key(d)
    const count = remaining.get(k) ?? 0
    if (count === 0) return true
    remaining.set(k, count - 1)
  }
  return false
}

function spliceSorted(before: string, sorted: AstSpan[]): string {
  const parts: string[] = []
  let cursor = 0
  for (const edit of sorted as AstEdit[]) {
    if (!Number.isSafeInteger(edit.startByte) || !Number.isSafeInteger(edit.endByte)
      || edit.startByte < cursor || edit.endByte < edit.startByte || edit.endByte > before.length) {
      throw new Error(`illegal span ${edit.startByte}-${edit.endByte} (file is ${before.length} characters)`)
    }
    parts.push(before.slice(cursor, edit.startByte), edit.text)
    cursor = edit.endByte
  }
  parts.push(before.slice(cursor))
  return parts.join('')
}

/** Rebuild `after` from `before` and the edits — the proof that nothing else moved. */
export function spliceExpect(before: string, edits: AstEdit[]): string {
  return spliceSorted(before, normalizeSpans(edits))
}

/**
 * Syntax-only audit for the pipeline preflight: did the edit leave the file parseable?
 *
 * Cheaper than `auditAst` because it skips the hunk statistics nobody reads at that point.
 */
export function auditSyntax(beforeText: string, afterText: string, lang: Lang, edits: AstEdit[]): Pick<AstAudit, 'ok' | 'code' | 'message'> {
  const spans = normalizeSpans(edits)
  let expect: string
  try {
    expect = spliceSorted(beforeText, spans)
  } catch (error) {
    return { ok: false, code: 'E_AST_AUDIT_SPAN', message: String((error as Error).message) }
  }
  if (expect !== afterText) {
    return {
      ok: false,
      code: 'E_AST_AUDIT_SPLICE',
      message: `unexpected change outside the edited spans (expected ${expect.length} characters, got ${afterText.length})`,
    }
  }
  const tscBefore = tsDiagnostics(beforeText, String(lang))
  const tscAfter = tsDiagnostics(afterText, String(lang))
  let diagnosticsBefore: Diagnostic[]
  let diagnosticsAfter: Diagnostic[]
  if (tscBefore !== null && tscAfter !== null) {
    diagnosticsBefore = tscBefore
    diagnosticsAfter = tscAfter
  } else {
    const treeDiagnostics = (root: SgNode): Diagnostic[] => root.findAll({ rule: { kind: 'ERROR' } }).map(node => {
      const start = node.range().start.index
      const end = node.range().end.index
      return { start, length: end - start, code: 'ERROR', message: node.text() }
    })
    diagnosticsBefore = treeDiagnostics(parseAuditRoot(lang, beforeText))
    diagnosticsAfter = treeDiagnostics(parseAuditRoot(lang, afterText))
  }
  const broke = hasNewDiagnostics(diagnosticsBefore, diagnosticsAfter, spans as AstEdit[], beforeText)
  return {
    ok: !broke,
    code: broke ? 'E_AST_AUDIT_BROKEN' : undefined,
    message: broke
      ? `the rewrite introduced new syntax diagnostics (${diagnosticsAfter.length} after, ${diagnosticsBefore.length} before, oracle=${tscBefore ? 'tsc' : 'tree-sitter'}); the file is broken`
      : undefined,
  }
}

/**
 * The full audit: splice proof + hunk statistics + syntax verdict.
 *
 * `beforeRoot` is the whole-file root the caller already parsed for this same text; passing it skips a
 * parse. It is ignored when it does not belong to `beforeText`.
 */
export function auditAst(beforeText: string, afterText: string, lang: Lang, edits: AstEdit[], beforeRoot?: SgNode): AstAudit {
  const t0 = performance.now()
  const spans = normalizeSpans(edits)
  const base: AstAudit = {
    ok: true,
    hunks: 0,
    nodesRemoved: 0,
    nodesAdded: 0,
    errorNodes: 0,
    errorNodesBefore: 0,
    parser: 'tree-sitter',
    diagAfter: 0,
    diagBefore: 0,
    unchangedRatio: 1,
    kinds: [],
    bytesBefore: Buffer.byteLength(beforeText, 'utf8'),
    bytesAfter: Buffer.byteLength(afterText, 'utf8'),
    ms: 0,
  }
  let expect: string
  try {
    expect = spliceSorted(beforeText, spans)
  } catch (error) {
    return { ...base, ok: false, code: 'E_AST_AUDIT_SPAN', message: String((error as Error).message), ms: performance.now() - t0 }
  }
  if (expect !== afterText) {
    return {
      ...base,
      ok: false,
      code: 'E_AST_AUDIT_SPLICE',
      message: `unexpected change outside the edited spans (expected ${expect.length} characters, got ${afterText.length})`,
      ms: performance.now() - t0,
    }
  }
  const touchedBytes = spans.reduce((n, span) => n + Buffer.byteLength(beforeText.slice(span.startByte, span.endByte), 'utf8'), 0)
  base.unchangedRatio = base.bytesBefore ? Math.max(0, 1 - touchedBytes / base.bytesBefore) : 1
  const provenance = beforeRoot ? auditRoots.get(beforeRoot) : undefined
  const reuseBefore = provenance?.lang === lang && provenance.text === beforeText
  const rootBefore = reuseBefore && beforeRoot ? beforeRoot : parseAuditRoot(lang, beforeText)
  const rootAfter = parseAuditRoot(lang, afterText)
  const errorsBefore = errorsOf(reuseBefore ? provenance : auditRoots.get(rootBefore))
  const errorsAfter = errorsOf(auditRoots.get(rootAfter))
  const errBefore = errorsBefore.length
  const errAfter = errorsAfter.length
  const removed: ReducedSpan[] = []
  const added: ReducedSpan[] = []
  let delta = 0
  const afterSpans: AstSpan[] = spans.map(span => {
    const startByte = span.startByte + delta
    delta += (span as AstEdit).text.length - (span.endByte - span.startByte)
    return { startByte, endByte: startByte + (span as AstEdit).text.length }
  })
  collectWithin(rootBefore, spans, removed)
  collectWithin(rootAfter, afterSpans, added)
  const inBefore = containedSpans(spans, removed)
  const inAfter = containedSpans(afterSpans, added)
  const hunks = spans.filter((_, index) => inBefore[index] || inAfter[index]).length
  const kinds = [...new Set([...removed, ...added].map(node => node.kind))].slice(0, 6)
  const tscBefore = tsDiagnostics(beforeText, String(lang))
  const tscAfter = tsDiagnostics(afterText, String(lang))
  const useTsc = tscBefore !== null && tscAfter !== null
  const parser: AstAudit['parser'] = useTsc ? 'tsc' : 'tree-sitter'
  const treeDiagnostics = (nodes: SgNode[]): Diagnostic[] => nodes.map(node => ({
    start: node.range().start.index,
    length: node.range().end.index - node.range().start.index,
    code: 'ERROR',
    message: node.text(),
  }))
  const diagnosticsBefore = tscBefore ?? treeDiagnostics(errorsBefore)
  const diagnosticsAfter = tscAfter ?? treeDiagnostics(errorsAfter)
  const dBefore = diagnosticsBefore.length
  const dAfter = diagnosticsAfter.length
  const broke = hasNewDiagnostics(diagnosticsBefore, diagnosticsAfter, spans as AstEdit[], beforeText)
  return {
    ...base,
    ok: !broke,
    hunks,
    nodesRemoved: removed.length,
    nodesAdded: added.length,
    errorNodes: errAfter,
    errorNodesBefore: errBefore,
    parser,
    diagAfter: useTsc ? dAfter : errAfter,
    diagBefore: useTsc ? dBefore : errBefore,
    kinds,
    code: broke ? 'E_AST_AUDIT_BROKEN' : undefined,
    message: broke
      ? `the rewrite introduced new syntax diagnostics (${dAfter} after, ${dBefore} before, oracle=${parser}); the file is broken`
      : undefined,
    ms: Math.round((performance.now() - t0) * 100) / 100,
  }
}

/**
 * Run the `sg` CLI over the same pattern and reconcile the hit counts.
 *
 * The point is not speed but falsification: napi and the CLI share one Rust core through different
 * call paths (addon vs binary, rule object vs argv), and only their agreement shows the rewrite
 * matched the pattern rather than the addon version's behaviour drifting.
 */
export function sgCrossCheck(file: string, pattern: string, lang: string, napiCount: number, sgPath = 'ast-grep', timeoutMs = 20_000): SgCrossCheck {
  const t0 = performance.now()
  const result = spawnSync(sgPath, ['run', '--pattern', pattern, '--lang', lang, '--json=stream', file], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  })
  if (result.error || result.status !== 0) {
    return {
      agree: false,
      napiCount,
      sgCount: -1,
      diff: [],
      ms: Math.round((performance.now() - t0) * 100) / 100,
      stderr: String(result.error?.message ?? result.stderr ?? '').slice(0, 300),
    }
  }
  let sgCount = 0
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate || candidate[0] !== '{') continue
    try {
      JSON.parse(candidate)
      sgCount += 1
    } catch { /* a progress line that starts with '{' but is not JSON; not a hit */ }
  }
  const agree = sgCount === napiCount
  return {
    agree,
    napiCount,
    sgCount,
    diff: agree ? [] : [`napi=${napiCount}`, `sg=${sgCount}`],
    ms: Math.round((performance.now() - t0) * 100) / 100,
  }
}
