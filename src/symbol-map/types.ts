/**
 * Structural grammar types plus the public Symbol Map shapes.
 *
 * `tree-sitter` is an OPTIONAL peer of this package and is never a dependency, so nothing here
 * may import from it. These interfaces describe only the surface the engine actually calls, which
 * keeps `tsc` honest without forcing a native module on every install. A wrong assumption about
 * the binding shows up as a runtime type error inside `require`, not as a build failure.
 *
 * @module dsh-ops/symbol-map/types
 */

/** A zero-based row/column pair: tree-sitter's `Point`. */
export interface SyntaxPoint { readonly row: number, readonly column: number }

/** The subset of `SyntaxNode` the engine reads. Nothing else is part of the contract. */
export interface SyntaxNode {
  readonly type: string
  readonly text: string
  readonly startPosition: SyntaxPoint
  readonly endPosition: SyntaxPoint
  readonly hasError: boolean
  readonly isError: boolean
  readonly isMissing: boolean
  readonly children: readonly SyntaxNode[]
  /**
   * The named-child view, for the one place the walk must look at a node's only child without
   * materialising `children`.
   *
   * `children` includes anonymous tokens and is built on every read, so touching it for every
   * expression statement in a file cost 1.3 ms over a 24-file corpus — while these two are direct
   * reads on the native node. Optional because the interface is also implemented by test doubles;
   * the walk falls back to `children` when they are absent.
   */
  readonly namedChildCount?: number
  readonly firstNamedChild?: SyntaxNode | null
  /**
   * Direct field lookup in the grammar (`name`, `body`, `value`).
   *
   * Optional because the interface is also implemented by test doubles. On a real node it is a
   * field index lookup, not a search: `children.find(c => c.type === 'identifier')` would be both
   * slower and wrong for `class A { name() {} }`, where the first identifier is a method.
   */
  childForFieldName?(name: string): SyntaxNode | null
}

export interface SyntaxTree {
  readonly rootNode: SyntaxNode
  /**
   * Record one text change before re-parsing.
   *
   * This is not optional decoration. Re-parsing a new string against an old tree **without** an
   * edit produces correct node structure but stale byte offsets, so `node.text` returns whatever
   * now sits at the old offsets — measured on a 6-class fixture, every method name came back as a
   * fragment of a neighbouring line. The edit is what lets tree-sitter relocate the reused nodes.
   */
  edit?(edit: SyntaxEdit): void
}

/**
 * One contiguous replacement in UTF-16 code units, which is the unit this binding uses.
 *
 * `startIndex` / `oldEndIndex` / `newEndIndex` index into the JS string, so `string.length` and
 * `charCodeAt` are the correct primitives — byte offsets would drift on any file with non-ASCII
 * comments. Verified against a fixture whose header is Chinese text.
 */
export interface SyntaxEdit {
  startIndex: number
  oldEndIndex: number
  newEndIndex: number
  startPosition: SyntaxPoint
  oldEndPosition: SyntaxPoint
  newEndPosition: SyntaxPoint
}
export interface SyntaxCapture { readonly name: string, readonly node: SyntaxNode }
export interface SyntaxMatch { readonly pattern: number, readonly captures: readonly SyntaxCapture[] }

/**
 * `tree-sitter` 0.21 accepts a point window. This is what actually bounds a query: `#offset!` is a
 * Helix/nvim query directive and does not exist in the npm binding.
 */
export interface SyntaxQueryOptions {
  startPosition?: SyntaxPoint
  endPosition?: SyntaxPoint
  matchLimit?: number
  maxStartDepth?: number
}

export interface SyntaxQuery {
  matches(node: SyntaxNode, options?: SyntaxQueryOptions): SyntaxMatch[]
  delete?(): void
}

export interface SyntaxParser {
  setLanguage(language: SyntaxLanguage): void
  /**
   * Parse `input`, optionally reusing `previousTree`.
   *
   * When a previous tree of the *same parser instance* is supplied, tree-sitter diffs the old text
   * against the new one and re-parses only the changed subtrees. That is what makes a re-map after
   * a one-line edit cost microseconds instead of a full pass. A tree from a different parser
   * (or one that has been deleted) is not a valid argument: the native handles no longer line up.
   */
  parse(input: string, previousTree?: SyntaxTree): SyntaxTree
  delete?(): void
}

/** A compiled grammar as the language packages export it. */
export interface SyntaxLanguage {
  readonly name?: string
  readonly language?: unknown
  readonly nodeTypeInfo?: readonly unknown[]
}

/** `require('tree-sitter')` IS the Parser constructor; `Parser.Query` is its static class. */
export interface ParserConstructor {
  new (): SyntaxParser
  readonly Query: new (language: SyntaxLanguage, source: string) => SyntaxQuery
}

export type SymbolType = 'function' | 'class' | 'method'
export type SourceLanguage = 'typescript' | 'tsx' | 'javascript'

/** A symbol is a position, never a code body. Lines are 1-based and inclusive. */
export interface Symbol { name: string, type: SymbolType, startLine: number, endLine: number }

export interface SymbolMap {
  file: string
  lang: SourceLanguage
  /** 64 lowercase hex SHA-256 of the exact bytes that were parsed. */
  revision: string
  /** First 16 hex of `revision`; a snapshot key, never a substitute for `revision`. */
  hash: string
  bytes: number
  /** True when the file has syntax errors and symbols were recovered best-effort. */
  partial: boolean
  syntaxErrors?: number
  total: number
  symbols: Symbol[]
  /** Set when the map was served from the process cache. Never part of the serialised shape. */
  cacheHit?: boolean
}

/** A 1-based inclusive line window; a reversed pair is normalized by `normalizeScope`. */
export interface Scope { lo: number, hi: number }

export interface MapOptions {
  file?: string
  lang?: SourceLanguage
  /**
   * A line window, either pre-parsed or as the `"START-END"` string the `symbol_map` tool accepts.
   * `normalizeScope` is the only reader, so a reversed or zero-based pair is fixed in one place.
   */
  scope?: Scope | string
  /** Prune the query itself to the scope window. Cheaper, but can miss a symbol that starts above it. */
  prune?: boolean
  extended?: boolean
  recover?: boolean
  maxBytes?: number
  /**
   * A tree from a previous parse of the SAME file, by the SAME pooled parser.
   *
   * Supplying it turns the parse into an incremental one: tree-sitter re-uses every subtree whose
   * text is unchanged. This is the single largest saving available to the engine — on a 16k-line
   * module a one-line edit drops the parse from ~106 ms to under 1 ms — and it is why the cache
   * holds trees and not just maps. Omitting it costs nothing but speed.
   */
  previousTree?: SyntaxTree
}

export interface MapFileOptions extends MapOptions {
  /** Rebuild even when the cached revision still matches. */
  force?: boolean
  /** Keep going after a per-file failure instead of throwing. Defaults to true. */
  continueOnError?: boolean
}

export interface PageOptions { offset?: number, limit?: number, budgetBytes?: number, name?: string }

export interface SymbolPage {
  total: number
  offset: number
  symbols: Symbol[]
  omitted: number
  complete: boolean
  nextOffset?: number
  truncatedBy?: 'row-limit' | 'output-budget'
}
