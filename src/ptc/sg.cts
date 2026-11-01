/**
 * The structural view of `@ast-grep/napi` that this engine relies on.
 *
 * It is declared here rather than imported from the package because the package is an optional peer
 * resolved at runtime — a clean machine must be able to compile this engine without it installed. Two
 * copies of this interface would drift apart the moment one of them needs another method, which is
 * exactly what happened when the audit and the in-process engine each declared their own.
 *
 * @module dsh-ops/ptc/sg
 */

/** A position in the tree. `index` is a UTF-16 character offset, not a byte offset. */
export interface SgPos {
  index: number
  line: number
  column: number
}

/** A node's half-open span. */
export interface SgRange {
  start: SgPos
  end: SgPos
}

/** The parts of a find call this engine uses: a rule, plus optional metavariable constraints. */
export interface SgFindOptions {
  rule?: Record<string, unknown>
  constraints?: Record<string, { regex: string }>
}

/** A syntax node. Only the calls the engine makes are declared. */
export interface SgNode {
  range(): SgRange
  text(): string
  kind(): string
  namedChildren(): SgNode[]
  getMatch(name: string): SgNode | null | undefined
  getMultipleMatches(name: string): SgNode[]
  findAll(options: SgFindOptions): SgNode[]
}

/** The two calls made on the napi module itself. */
export interface NapiApi {
  parse(lang: string, text: string): { root(): SgNode }
  Lang: Record<string, string>
}
