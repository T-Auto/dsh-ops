/**
 * The compiled-once S-expression and the capture table that gives it meaning.
 *
 * Two rules govern everything here:
 *
 * 1. **No predicates.** `#eq?` / `#match?` force the binding to materialise the matched text, and
 *    `#offset!` does not exist in the npm binding at all — it is a Helix/nvim query directive.
 *    Range narrowing is done with `QueryOptions.startPosition/endPosition` instead.
 * 2. **No `(program ...)` wrapper.** Anchoring at the program node costs a full top-level walk
 *    before the first match can be reported. Each pattern anchors on the node it wants.
 *
 * The query is assembled **per grammar family**, not shared. `abstract_class_declaration`,
 * `function_signature`, `method_signature` and `abstract_method_signature` exist in the TypeScript
 * and TSX grammars and do not exist in the JavaScript grammar, and a query that names a node type
 * its grammar does not define fails to compile — `TSQueryErrorNodeType`, at the first such name.
 * The JavaScript source is therefore the TypeScript source minus those four names, and
 * {@link querySource} is the only place that decision is made.
 *
 * @module dsh-ops/symbol-map/query
 */

import type { SourceLanguage, SymbolType } from './types.js'

/**
 * Core patterns: declarations only, no expressions.
 *
 * `generator_function_declaration` is a distinct node in both grammars — `function* g() {}` is NOT
 * a `function_declaration` — so omitting it silently loses every generator in the file.
 */
const FUNCTIONS = `(function_declaration
  name: (identifier) @function.name) @function.def

(generator_function_declaration
  name: (identifier) @function.name) @function.def`

/**
 * Bodyless functions: `declare function f(): void` in a `.d.ts`, and every overload header.
 *
 * The grammar splits on "has a body", not on "is a declaration": `function t(a: string): void` on
 * its own is a `function_signature`, and a file of nothing but ambient declarations parses to a
 * tree with no `function_declaration` in it at all. Omitting this node type made the map report an
 * empty outline for exactly the files whose whole content is an API surface.
 */
const SIGNATURE_FUNCTIONS = `(function_signature
  name: (identifier) @function.name) @function.def`

/**
 * Class patterns. The TypeScript family adds `abstract_class_declaration`; the JavaScript grammar
 * has no such node, so the two are separate strings rather than one alternation that only half the
 * grammars can compile.
 *
 * The name is the anonymous wildcard `_` because the node differs between grammars: `identifier`
 * in JavaScript, `type_identifier` in TypeScript.
 */
const CLASSES_JS = `(class_declaration
  name: (_) @class.name) @class.def`

const CLASSES_TS = `[
  (class_declaration name: (_) @class.name)
  (abstract_class_declaration name: (_) @class.name)
] @class.def`

/**
 * Method patterns, anchored on `class_body` so an object-literal method is never a symbol.
 *
 * A method name is five different nodes, and `property_identifier` is only the plain case.
 * `#secret()` is a `private_property_identifier`, `[Symbol.iterator]()` and `'quoted'()` are
 * `computed_property_name`, and `42()` is a `number`; all four are ordinary declarations that a
 * `property_identifier`-only pattern drops *without an error* — the outline simply shows a class
 * with fewer methods, which is the one failure a reader cannot notice.
 *
 * `method_signature` covers a `declare class` body and `abstract_method_signature` an abstract
 * method; both are the same declaration with the body left out.
 */
const METHODS_JS = `(class_body
  (method_definition
    name: [(property_identifier) (private_property_identifier) (computed_property_name) (string) (number)] @method.name) @method.def)`

const METHODS_TS = `(class_body
  [
    (method_definition
      name: [(property_identifier) (private_property_identifier) (computed_property_name) (string) (number)] @method.name)
    (method_signature
      name: (property_identifier) @method.name)
    (abstract_method_signature
      name: (property_identifier) @method.name)
  ] @method.def)`

/**
 * Extended tier adds the one idiom that hides a top-level function behind a variable:
 * `const handler = async (req) => {...}`. It is off by default because it widens the match set
 * from "declarations" to "declarations plus bindings", which is a different question.
 *
 * `new Promise(resolve => …)` is the case this tier cannot express as a walk: the binding sits in
 * an argument position, inside an expression, which is why the extended tier stays on the query.
 */
const BINDINGS = `(variable_declarator
  name: (identifier) @function.name
  value: [(arrow_function) (function_expression)]) @function.def`

/** The two auxiliary pattern sets, resolved once per language family. */
function parts(lang: SourceLanguage): { classes: string, methods: string, signatures: string } {
  return lang === 'javascript'
    ? { classes: CLASSES_JS, methods: METHODS_JS, signatures: '' }
    : { classes: CLASSES_TS, methods: METHODS_TS, signatures: SIGNATURE_FUNCTIONS }
}

const cache = new Map<string, string>()

/**
 * The query source for one grammar and tier.
 *
 * Composed rather than concatenated from two constants because the TypeScript-only patterns must
 * *replace* the shared class and method patterns, not join them: two patterns that both match a
 * `class_declaration` produce two identical symbols, and nothing downstream de-duplicates them.
 */
export function querySource(lang: SourceLanguage, extended: boolean): string {
  const key = `${lang}:${extended ? 'ext' : 'core'}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const { classes, methods, signatures } = parts(lang)
  const text = [FUNCTIONS, signatures, classes, methods, extended ? BINDINGS : '']
    .filter(part => part !== '')
    .join('\n\n')
  cache.set(key, text)
  return text
}

/**
 * The JavaScript-compatible source, kept exported for callers that compile it themselves.
 *
 * It carries no TypeScript-only node name, so it compiles against all three grammars; a caller that
 * wants the full TypeScript surface (abstract classes, ambient signatures) asks
 * {@link querySource} instead.
 */
export const SYMBOL_QUERY = querySource('javascript', false)

/** The same, with variable-bound functions included. */
export const SYMBOL_QUERY_EXT = querySource('javascript', true)

/** What a capture means: which symbol type it belongs to, and whether it names or spans. */
export interface CaptureRole {
  readonly type: SymbolType
  readonly part: 'name' | 'def'
}

/**
 * Static capture table. Looked up once per capture — never rebuilt, never searched linearly.
 *
 * A capture name that is absent here is ignored on purpose: it means the query grew a capture the
 * extractor does not understand yet, and inventing a role for it would corrupt the map.
 */
const role = (type: SymbolType, part: 'name' | 'def'): CaptureRole => Object.freeze({ type, part })

export const CAPTURE_ROLE: ReadonlyMap<string, CaptureRole> = new Map<string, CaptureRole>([
  ['function.name', role('function', 'name')],
  ['function.def', role('function', 'def')],
  ['class.name', role('class', 'name')],
  ['class.def', role('class', 'def')],
  ['method.name', role('method', 'name')],
  ['method.def', role('method', 'def')],
])
