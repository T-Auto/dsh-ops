/**
 * Lazy grammar loading plus the process-wide parser/query pools.
 *
 * `tree-sitter` and its grammar packages are **not dependencies of dsh-ops**. They are optional
 * peers: the plugin must install and boot on a machine that has no C++ toolchain, and the symbol
 * map is an accelerator, not a prerequisite. So nothing in `src/` may statically import them —
 * `tsc` would fail on a package that is not installed — and the first touch happens inside a
 * `createRequire` anchored at the package root, which resolves both a nested install
 * (`dsh-ops/node_modules`) and a hoisted one (`<project>/node_modules`).
 *
 * The pools below are the whole performance story. Compiling a query costs roughly an order of
 * magnitude more than running it, so a per-call `new Query` would erase the advantage of using a
 * symbol map at all. A parser is pooled per language because `setLanguage` re-initialises the
 * grammar's lexer; flipping languages on one parser would defeat the pool.
 *
 * @module dsh-ops/symbol-map/grammar
 */

import { createRequire } from 'node:module'
import path from 'node:path'

import { PACKAGE_ROOT } from '../paths.js'
import { fail } from './errors.js'
import { querySource } from './query.js'
import type { ParserConstructor, SourceLanguage, SyntaxLanguage, SyntaxParser, SyntaxQuery } from './types.js'

/** Extension → grammar. Keys are lowercase with the dot, matching `path.extname` output. */
export const LANG_BY_EXT: ReadonlyMap<string, SourceLanguage> = new Map<string, SourceLanguage>([
  ['.ts', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.jsx', 'javascript'],
])

/**
 * The exact command a user needs when the engine is missing. Repeated verbatim in the error.
 *
 * `tree-sitter` is pinned to 0.25.x because `QueryOptions.startPosition`/`endPosition` — the only
 * way to scope a query to a byte window in this binding — is not honoured by 0.21.x. The grammar
 * packages stay on their own line of versions; their peer range still declares `^0.21.1`, which is
 * why installing them next to 0.25.x needs `--legacy-peer-deps` (see `README`).
 */
export const INSTALL_HINT =
  'Install the optional grammar packages next to dsh-ops: npm install --legacy-peer-deps tree-sitter@0.25.1 tree-sitter-typescript@0.23.2 tree-sitter-javascript@0.23.1'

type GrammarLoader = () => SyntaxLanguage

/**
 * Loaders are thunks so that `require` runs at first use, not at import time.
 *
 * `tree-sitter-typescript` ships two grammars in one package; `typescript` and `tsx` are separate
 * languages with different node sets, which is why `.tsx` is not folded into `.ts`.
 */
const GRAMMAR_LOADERS: Readonly<Record<SourceLanguage, GrammarLoader>> = Object.freeze({
  typescript: () => (engineLoad('tree-sitter-typescript') as { typescript: SyntaxLanguage }).typescript,
  tsx: () => (engineLoad('tree-sitter-typescript') as { tsx: SyntaxLanguage }).tsx,
  javascript: () => engineLoad('tree-sitter-javascript') as SyntaxLanguage,
})

/**
 * Anchors tried in order: the package root, then the self-held copy under `vendor/deps`.
 *
 * `dependencies` in `dsh-ops/package.json` are `null`, so a reinstall or a `pnpm install` run in
 * the package directory deletes `dsh-ops/node_modules` and every grammar with it — the tool then
 * reports `E_ENGINE_UNAVAILABLE` for a package that is still sitting on disk. The vendored copy
 * (win32-x64 prebuilds only) costs nothing at runtime and makes that reinstall survivable, which
 * is cheaper than winning a manifest argument upstream.
 */
const ENGINE_ANCHORS: readonly string[] = Object.freeze([
  path.join(PACKAGE_ROOT, 'package.json'),
  path.join(PACKAGE_ROOT, 'vendor', 'deps', 'package.json'),
])

let anchors: ReturnType<typeof createRequire>[] | undefined

function engineAnchors(): ReturnType<typeof createRequire>[] {
  if (anchors !== undefined) return anchors
  const override = process.env.DSH_OPS_SYMBOL_MAP_ROOT
  anchors =
    override === undefined || override === ''
      ? ENGINE_ANCHORS.map(anchor => createRequire(anchor))
      : [createRequire(path.join(path.resolve(override), 'package.json'))]
  return anchors
}

/**
 * Resolve an optional engine module through the anchors in order.
 *
 * The first anchor that has the module wins. The last error is rethrown so the caller's message
 * still names the real reason (missing module vs. broken native binding).
 */
function engineLoad(name: string): unknown {
  let last: unknown
  for (const chunk of engineAnchors()) {
    try {
      return chunk(name)
    } catch (error) {
      last = error
    }
  }
  throw last
}

let engine: ReturnType<typeof createRequire> | undefined

/**
 * A `require` anchored at the package root, created once.
 *
 * `DSH_OPS_SYMBOL_MAP_ROOT` exists for bundle layouts where dsh-ops is copied out of
 * `node_modules` and its own directory no longer sits under the project that installed the
 * grammars. Without it those users have no way to point the engine at their install.
 */
function engineRequire(): ReturnType<typeof createRequire> {
  if (engine !== undefined) return engine
  engine = engineAnchors()[0]
  return engine
}

let parserCtor: ParserConstructor | undefined

/** The `tree-sitter` module itself: it exports the Parser constructor, with `Query` as a static. */
export function parserConstructor(): ParserConstructor {
  if (parserCtor !== undefined) return parserCtor
  let loaded: unknown
  try {
    loaded = engineLoad('tree-sitter')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fail('E_ENGINE_UNAVAILABLE', `tree-sitter is not available to dsh-ops (${reason}). ${INSTALL_HINT}`)
  }
  if (typeof loaded !== 'function' || typeof (loaded as { Query?: unknown }).Query !== 'function') {
    fail('E_ENGINE_UNAVAILABLE', `tree-sitter loaded but does not export a Parser constructor with a Query class. ${INSTALL_HINT}`)
  }
  parserCtor = loaded as ParserConstructor
  return parserCtor
}

/** Resolve and validate the grammar for a language. */
export function grammar(lang: SourceLanguage): SyntaxLanguage {
  const loader = GRAMMAR_LOADERS[lang]
  if (loader === undefined) fail('E_LANG_UNSUPPORTED', `No grammar is registered for "${String(lang)}".`)
  let loaded: unknown
  try {
    loaded = loader()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fail('E_ENGINE_UNAVAILABLE', `The ${lang} grammar is not available to dsh-ops (${reason}). ${INSTALL_HINT}`)
  }
  // The grammar packages hand back `{ name, language, nodeTypeInfo }`; very old bindings handed
  // back a bare string. Anything else means the package is present but is not a grammar.
  if (typeof loaded !== 'object' || loaded === null) {
    fail('E_ENGINE_UNAVAILABLE', `The ${lang} grammar did not load as a language object. ${INSTALL_HINT}`)
  }
  return loaded as SyntaxLanguage
}

/** Detect a language from a path. Returns `undefined` rather than guessing. */
export function detectLanguage(filePath: string): SourceLanguage | undefined {
  if (typeof filePath !== 'string' || filePath === '') return undefined
  return LANG_BY_EXT.get(path.extname(filePath).toLowerCase())
}

/** Lifecycle counters. Exposed by `stats()` so a caller can prove the pools are actually working. */
export const counters = {
  parserCreations: 0,
  queryCompiles: 0,
  parses: 0,
  recoveryParses: 0,
  /**
   * Monotonic count of pool resets. Never cleared by `resetPools`, unlike the counters above.
   *
   * A pooled `Tree` owns native memory that dies with its parser. Anything holding a tree across
   * calls — the map cache does — must be able to tell "this tree is still valid" from "this tree
   * outlived its parser", and a value that resets to zero cannot answer that: after a reset the
   * next parse would hand back `1` again and a stale tree would look current. Incrementing instead
   * makes every epoch unique for the life of the process.
   */
  poolEpoch: 0,
}

const parsers = new Map<SourceLanguage, SyntaxParser>()
const queries = new Map<string, SyntaxQuery>()

/**
 * One parser per language, configured once.
 *
 * `setLanguage` is called exactly once per parser instance: the grammar swap rebuilds the lexer
 * state, so re-issuing it per parse would cost more than the parse itself.
 */
export function getParser(lang: SourceLanguage): SyntaxParser {
  const pooled = parsers.get(lang)
  if (pooled !== undefined) return pooled
  const Parser = parserConstructor()
  const parser = new Parser()
  parser.setLanguage(grammar(lang))
  counters.parserCreations += 1
  parsers.set(lang, parser)
  return parser
}

/**
 * One compiled query per (language, tier) pair.
 *
 * The source is built per grammar family, not shared: the TypeScript grammars define
 * `abstract_class_declaration` and the signature nodes, the JavaScript grammar does not, and a
 * query naming a node type its grammar lacks fails to compile instead of returning fewer matches.
 * See `query.ts`.
 *
 * The tier is part of the key on purpose: `extended` changes the match set, so a map built with
 * one tier must never be served to a caller who asked for the other.
 */
export function getQuery(lang: SourceLanguage, extended: boolean): SyntaxQuery {
  const key = `${lang}:${extended ? 'ext' : 'core'}`
  const pooled = queries.get(key)
  if (pooled !== undefined) return pooled
  const source = querySource(lang, extended)
  const query = new (parserConstructor().Query)(grammar(lang), source)
  counters.queryCompiles += 1
  queries.set(key, query)
  return query
}

/** Pool sizes, for `stats()`. */
export function poolStats(): { parsers: number, queries: number } {
  return { parsers: parsers.size, queries: queries.size }
}

/** Drop every pooled parser and query. Tests use this; production never needs it. */
export function resetPools(): void {
  for (const query of queries.values()) query.delete?.()
  queries.clear()
  for (const parser of parsers.values()) parser.delete?.()
  parsers.clear()
  engine = undefined
  parserCtor = undefined
  counters.parserCreations = 0
  counters.queryCompiles = 0
  counters.parses = 0
  counters.recoveryParses = 0
  // Deliberately not zeroed: a cached tree from the previous epoch is now invalid, and the only
  // way a holder can notice is for this value to keep moving forward.
  counters.poolEpoch += 1
}
