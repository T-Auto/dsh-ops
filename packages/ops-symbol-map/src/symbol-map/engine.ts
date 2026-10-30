/**
 * The extraction core: query → symbols, plus the recovery pass that rescues a broken file.
 *
 * tree-sitter parses a file with syntax errors, but its error recovery swallows everything from
 * the first error to the point it can re-synchronise into one ERROR node. A file with a stray
 * brace on line 40 therefore yields a truncated outline even though lines 41-900 are perfectly
 * parseable. That is not a tolerable failure for a navigation tool, so {@link recoverSymbols}
 * re-parses **only the rows the main tree could not parse**, split at top-level declaration
 * boundaries, and shifts the recovered line numbers back into file coordinates.
 *
 * @module dsh-ops/symbol-map/engine
 */

import path from 'node:path'

import { fail } from './errors.js'
import { DEFAULT_MAX_BYTES, displayPath, HASH_LEN, normalizeScope, readFileBuffer, revisionOf, statRegularFile } from './files.js'
import { counters, detectLanguage, getParser, getQuery } from './grammar.js'
import { CAPTURE_ROLE } from './query.js'
import { compareSymbols, walkSymbols } from './walk.js'
import type { MapOptions, Symbol, SymbolMap, SymbolType, SyntaxMatch, SyntaxNode, SyntaxParser, SyntaxQuery, SyntaxQueryOptions, SyntaxTree } from './types.js'

export { compareSymbols }

/** A file with more than this many error nodes is reported as "at least this bad". */
const SYNTAX_ERROR_CAP = 100

/**
 * Hard ceilings on recovery work, so a pathological file cannot turn a read into a CPU sink.
 *
 * Two counters rather than one, because a chunk of one line and a chunk of a thousand cost very
 * different amounts: a chunk budget alone let a file with a single bad region spend all of it on
 * bisecting that region while the other 90% of the file was never looked at. The line budget is
 * the honest cost model — `parser.parse` is linear in the text handed to it — and the chunk
 * budget bounds the per-call overhead, which is not.
 */
const RECOVERY_MAX_CHUNKS = 512
const RECOVERY_MAX_LINES = 200_000

/** The two ceilings, exported so a test can bound recovery against the same numbers the code uses. */
export const RECOVERY_BUDGET = Object.freeze({ chunks: RECOVERY_MAX_CHUNKS, lines: RECOVERY_MAX_LINES })

/** How deep the bisection may go before a chunk is written off. */
const RECOVERY_MAX_DEPTH = 3

/** A chunk smaller than this is not worth bisecting: there is no declaration left inside it. */
const RECOVERY_MIN_SPLIT = 8

/**
 * A line that starts a top-level declaration, at column zero.
 *
 * This is the only cut that cannot split a declaration in half. A blank line is not: a blank line
 * inside a class body separates `class A {` from its methods, and the method fragment on its own
 * is a syntax error, so the whole class is lost — measured on the broken corpus, paragraph
 * splitting recovered 28 of 150 symbols and declaration splitting recovered 130.
 *
 * A declaration at column zero is a property of the language, not a convention: TypeScript has no
 * construct in which a statement-level declaration is indented.
 */
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|enum|namespace|module|type|const|let|var)\b/u

/**
 * The tree behind a map, kept off the map's own shape.
 *
 * A `SymbolMap` is a serialisable value; a `SyntaxTree` is a native handle. Hanging the handle on
 * the map as a hidden property would survive `JSON.stringify` but would also make every clone and
 * spread of a map share a handle nobody can see. A `WeakMap` says exactly what is true: the tree
 * lives as long as the map does, and disappears with it. `cache.ts` is the only reader.
 */
export const treeOfMap = new WeakMap<SymbolMap, SyntaxTree>()

/**
 * Turn a compiled query into a sorted symbol list.
 *
 * A capture pair is only trusted when both halves are present: a `.def` without a `.name` cannot
 * be named, and a `.name` without a `.def` cannot be given a range. Partial matches are dropped
 * silently rather than producing a symbol with a `null` field.
 */
export function extractSymbols(tree: SyntaxTree, query: SyntaxQuery, cursor?: SyntaxQueryOptions): Symbol[] {
  const root = tree.rootNode
  const matches: SyntaxMatch[] = cursor === undefined ? query.matches(root) : query.matches(root, cursor)
  const symbols: Symbol[] = []
  for (const match of matches) {
    let nameNode: SyntaxNode | undefined
    let defNode: SyntaxNode | undefined
    let type: SymbolType | undefined
    for (const capture of match.captures) {
      const role = CAPTURE_ROLE.get(capture.name)
      if (role === undefined) continue
      type = role.type
      if (role.part === 'name') nameNode = capture.node
      else defNode = capture.node
    }
    if (nameNode === undefined || defNode === undefined || type === undefined) continue
    symbols.push({
      name: nameNode.text,
      type,
      startLine: defNode.startPosition.row + 1,
      endLine: defNode.endPosition.row + 1,
    })
  }
  symbols.sort(compareSymbols)
  return symbols
}

/**
 * Identity of a symbol for de-duplication.
 *
 * The line is part of the key because the same name legitimately appears twice — two `parse`
 * functions in different classes are two symbols, not a duplicate. `offset` exists so a caller can
 * compare a chunk-local symbol with a file-local one without materialising a shifted copy.
 */
export function symbolKey(symbol: Symbol, offset: number): string {
  return `${symbol.type}\u0000${symbol.name}\u0000${symbol.startLine + offset}`
}

/** What the error scan produces: how bad it is, and which rows could not be parsed. */
export interface ErrorScan {
  /** Outer error nodes, capped at {@link SYNTAX_ERROR_CAP}. */
  count: number
  /** Zero-based inclusive row spans covered by an ERROR or MISSING node, sorted and merged. */
  spans: Array<[number, number]>
}

/**
 * Find the rows tree-sitter could not parse, and count the outer error nodes.
 *
 * The traversal only descends into subtrees whose `hasError` is true. That is the whole
 * difference between this and walking the tree: on a 1,640-line module with one bad brace the
 * full walk costs 37 ms because it visits every node, and this costs 0.05 ms because it visits
 * the path to the error and nothing else. Both report the same count.
 *
 * Traversal stops at an error node's own subtree: tree-sitter nests one ERROR around a whole
 * broken region, and counting its children would report hundreds of errors for one bad brace.
 *
 * A missing node is reported by its parent, which must itself carry `hasError`, so descending on
 * `hasError` alone cannot lose one.
 */
export function scanErrors(root: SyntaxNode): ErrorScan {
  if (root.hasError !== true) return { count: 0, spans: [] }
  const raw: Array<[number, number]> = []
  const stack: SyntaxNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode
    if (node.isError || node.isMissing) {
      raw.push([node.startPosition.row, node.endPosition.row])
      if (raw.length >= SYNTAX_ERROR_CAP) break
      continue
    }
    for (const child of node.children) if (child.hasError === true) stack.push(child)
  }
  raw.sort((a, b) => a[0] - b[0])
  const spans: Array<[number, number]> = []
  for (const span of raw) {
    const last = spans[spans.length - 1]
    // Adjacent spans merge: an ERROR that contains a MISSING reports the same rows twice, and
    // handing the recovery pass overlapping chunks would parse the same text for nothing.
    if (last !== undefined && span[0] <= last[1] + 1) {
      if (span[1] > last[1]) last[1] = span[1]
    } else {
      spans.push([span[0], span[1]])
    }
  }
  return { count: raw.length, spans }
}

/** Count error nodes, capped. Kept as its own name because it is the engine's public report. */
export function countSyntaxErrors(root: SyntaxNode): number {
  return scanErrors(root).count
}

/** The chunk boundaries of a file: row 0, every top-level declaration, and the end. */
function declarationCuts(lines: readonly string[]): number[] {
  const cuts: number[] = [0]
  for (let index = 1; index < lines.length; index += 1) {
    if (TOP_LEVEL_DECLARATION.test(lines[index] as string)) cuts.push(index)
  }
  cuts.push(lines.length)
  return cuts
}

/** Index of the cut block that contains `row`, clamped into range. */
function blockAt(cuts: readonly number[], row: number): number {
  let lo = 0
  let hi = cuts.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((cuts[mid] as number) <= row) lo = mid
    else hi = mid - 1
  }
  return Math.max(0, lo)
}

export interface RecoveryOptions {
  /**
   * The rows the main tree failed on, from {@link scanErrors}.
   *
   * Without this the pass falls back to the whole file, which is what the standalone package does
   * when it has no tree to consult. With it, a file that is broken on one line pays for one chunk
   * instead of one chunk per declaration in the file.
   */
  spans?: ReadonlyArray<readonly [number, number]>
}

/**
 * Recover symbols from a file whose tree has errors.
 *
 * Work is scoped three ways, each of which was measured rather than assumed:
 *
 * 1. **Only failed rows.** The main tree already returned every symbol outside an ERROR node; on
 *    a file with one or three bad lines that is all of them, so re-parsing the rest is pure cost
 *    (59 ms → 0.02 ms on the benchmark corpus).
 * 2. **Only declaration boundaries.** A chunk is one top-level declaration, because that is the
 *    only cut that keeps a class with its methods.
 * 3. **Breadth first.** Every candidate chunk is tried once before any chunk is bisected, so a
 *    single bad region cannot consume the budget the rest of the file needs.
 */
export function recoverSymbols(
  lines: readonly string[],
  parser: SyntaxParser,
  query?: SyntaxQuery,
  options: RecoveryOptions = {},
): Symbol[] {
  const found: Symbol[] = []
  const seen = new Set<string>()
  const budget = {
    chunks: RECOVERY_MAX_CHUNKS,
    lines: Math.min(RECOVERY_MAX_LINES, lines.length * 4),
  }
  const cuts = declarationCuts(lines)

  // Candidate chunks: everything when the caller has no tree, otherwise only the blocks that
  // overlap a failed row.
  const wanted = new Set<number>()
  const spans = options.spans
  if (spans === undefined || spans.length === 0) {
    for (let index = 0; index < cuts.length - 1; index += 1) wanted.add(index)
  } else {
    for (const [lo, hi] of spans) {
      const first = blockAt(cuts, lo)
      const last = blockAt(cuts, Math.min(hi, lines.length - 1))
      for (let index = first; index <= last; index += 1) wanted.add(index)
    }
  }

  const queue: Array<{ from: number, to: number, depth: number }> = []
  for (const index of [...wanted].sort((a, b) => a - b)) {
    queue.push({ from: cuts[index] as number, to: cuts[index + 1] as number, depth: 0 })
  }

  // Bisection is only worth anything when the file has no declaration boundary to cut on. A chunk
  // that already *is* one declaration has no second declaration inside it, so splitting it can
  // only produce statement fragments — and each fragment is handed to tree-sitter's error
  // recovery, which is the most expensive path in the parser. Measured on the broken corpus:
  // bisecting a file that had boundaries recovered no extra symbol and cost 33 ms.
  const splittable = cuts.length === 2

  /**
   * Keep the symbols of one parsed chunk, shifted into file coordinates.
   *
   * `bad` is the chunk-local error spans when the chunk itself did not parse. A symbol whose rows
   * overlap an ERROR is dropped: its range was produced by tree-sitter's recovery, which is where
   * a truncated `endLine` comes from, and a plausible-but-wrong range is worse than a missing one.
   * Everything outside the bad rows parsed normally and is reported.
   */
  const collect = (symbols: Symbol[], from: number, bad?: ReadonlyArray<readonly [number, number]>): void => {
    for (const symbol of symbols) {
      if (bad !== undefined) {
        const lo = symbol.startLine - 1
        const hi = symbol.endLine - 1
        if (bad.some(span => lo <= span[1] && hi >= span[0])) continue
      }
      const shifted: Symbol = {
        name: symbol.name,
        type: symbol.type,
        startLine: symbol.startLine + from,
        endLine: symbol.endLine + from,
      }
      const key = symbolKey(shifted, 0)
      if (seen.has(key)) continue
      seen.add(key)
      found.push(shifted)
    }
  }

  for (let head = 0; head < queue.length; head += 1) {
    const { from, to, depth } = queue[head] as { from: number, to: number, depth: number }
    const size = to - from
    if (size <= 0) continue
    if (budget.chunks <= 0 || budget.lines < size) break
    budget.chunks -= 1
    budget.lines -= size
    counters.recoveryParses += 1
    const tree = parser.parse(lines.slice(from, to).join('\n'))
    if (tree.rootNode.hasError !== true) {
      collect(query === undefined ? walkSymbols(tree) : extractSymbols(tree, query), from)
      continue
    }
    // A chunk is one declaration, so an error inside it usually costs the tail of that
    // declaration only — the methods above the bad brace are still in the tree. Reporting them is
    // the difference between "a class with one broken method" and "a class that vanished", and
    // the row filter above is what keeps a recovered range honest.
    const local = scanErrors(tree.rootNode).spans
    collect(query === undefined ? walkSymbols(tree) : extractSymbols(tree, query), from, local)
    if (!splittable || depth >= RECOVERY_MAX_DEPTH || size < RECOVERY_MIN_SPLIT) continue
    // Bisect on a blank line inside the chunk — the last resort, only reachable for a file whose
    // text has no top-level declaration in it at all.
    const mid = from + (size >> 1)
    let cut = -1
    for (let index = mid; index < to; index += 1) {
      if ((lines[index] as string).trim() === '') {
        cut = index + 1
        break
      }
    }
    if (cut <= from || cut >= to) continue
    queue.push({ from, to: cut, depth: depth + 1 }, { from: cut, to, depth: depth + 1 })
  }

  return found
}

/**
 * Map in-memory source. This is the only place a parse happens, so it is also the only place the
 * pool counters move.
 *
 * `prune` and `scope` are two different things and both are supported:
 * - `prune: false` (default) queries the whole tree, then keeps symbols that *intersect* the
 *   window. Correct even when a class starts above the window and its methods are inside it.
 * - `prune: true` hands the window to the query, which never walks the rest of the tree. Cheaper,
 *   but a symbol that begins above the window is invisible.
 *
 * Recovery only runs on an unpruned parse: a chunk-local re-parse inside a window would report
 * line numbers relative to the window, and the whole point of the pass is file coordinates.
 */
export function mapSource(source: Buffer | string, options: MapOptions = {}): SymbolMap {
  const buffer = typeof source === 'string' ? Buffer.from(source, 'utf8') : source
  const text = buffer.toString('utf8')
  const absolute = options.file === undefined ? undefined : path.resolve(options.file)
  let lang = options.lang
  if (lang === undefined && absolute !== undefined) lang = detectLanguage(absolute)
  if (lang === undefined) lang = 'typescript'

  const parser = getParser(lang)
  const scope = normalizeScope(options.scope)
  // The query is compiled only for the pruning path and for the extended tier. The default path
  // walks the tree instead, which is 34× cheaper on real files and lets a first call skip the
  // compile entirely.
  const cursor: SyntaxQueryOptions | undefined = scope !== undefined && options.prune === true
    ? { startPosition: { row: scope.lo - 1, column: 0 }, endPosition: { row: scope.hi, column: 0 } }
    : undefined
  // The walk is core-only: an extended binding can live inside an expression, which the walk never
  // enters, so that tier keeps the query rather than quietly reporting fewer symbols.
  const useWalk = cursor === undefined && options.extended !== true
  const query = useWalk ? undefined : getQuery(lang, options.extended === true)

  counters.parses += 1
  const tree = options.previousTree === undefined ? parser.parse(text) : parser.parse(text, options.previousTree)
  const root = tree.rootNode
  const partial = root.hasError === true
  const scan = partial ? scanErrors(root) : undefined

  let symbols = useWalk ? walkSymbols(tree) : extractSymbols(tree, query as SyntaxQuery, cursor)
  if (scope !== undefined && cursor === undefined) {
    symbols = symbols.filter(symbol => symbol.startLine <= scope.hi && symbol.endLine >= scope.lo)
  }

  if (partial && scan !== undefined && options.recover !== false && cursor === undefined) {
    const seen = new Set(symbols.map(symbol => symbolKey(symbol, 0)))
    // The same tier is used for recovery as for the main parse. Passing no query here meant the
    // extended tier silently fell back to the core walk, so a broken file lost every
    // `const handler = () => {}` even though the clean file found it.
    const recovered = recoverSymbols(text.split('\n'), parser, useWalk ? undefined : query as SyntaxQuery, {
      spans: scan.spans,
    })
    for (const symbol of recovered) {
      if (scope !== undefined && !(symbol.startLine <= scope.hi && symbol.endLine >= scope.lo)) continue
      const key = symbolKey(symbol, 0)
      if (seen.has(key)) continue
      seen.add(key)
      symbols.push(symbol)
    }
    symbols.sort(compareSymbols)
  }

  const revision = revisionOf(buffer)
  const map: SymbolMap = {
    file: absolute === undefined ? '<memory>' : displayPath(absolute),
    lang,
    revision,
    hash: revision.slice(0, HASH_LEN),
    bytes: buffer.length,
    partial,
    total: symbols.length,
    symbols,
  }
  if (scan !== undefined) map.syntaxErrors = scan.count
  treeOfMap.set(map, tree)
  return map
}

/**
 * Map a buffer that is already in memory, enforcing the size ceiling and resolving the language.
 *
 * The language is resolved here rather than in `mapSource` so that an explicit `lang` still wins
 * over the extension — the caller may be mapping a `.txt` that happens to hold TypeScript.
 */
export function buildFromBuffer(abs: string, buffer: Buffer, options: MapOptions = {}): SymbolMap {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  if (buffer.length > maxBytes) {
    fail('E_FILE_TOO_LARGE', `${displayPath(abs)} is ${buffer.length} bytes, over the ${maxBytes} byte ceiling.`, {
      path: displayPath(abs),
      size: buffer.length,
      maxBytes,
    })
  }
  let lang = options.lang
  if (lang === undefined) lang = detectLanguage(abs)
  if (lang === undefined) {
    fail('E_LANG_UNKNOWN', `Cannot infer a language for ${displayPath(abs)}; pass lang explicitly.`, { path: displayPath(abs) })
  }
  const map = mapSource(buffer, { ...options, lang, file: abs })
  map.file = displayPath(abs)
  return map
}

/** Map a file from disk: stat first, so an oversized file never reaches the parser. */
export function buildSymbolMap(file: string, options: MapOptions = {}): SymbolMap {
  const abs = path.resolve(file)
  statRegularFile(abs, options.maxBytes ?? DEFAULT_MAX_BYTES)
  return buildFromBuffer(abs, readFileBuffer(abs), options)
}
