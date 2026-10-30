/**
 * The structural walk that replaced the S-expression query on the hot path.
 *
 * A `query.matches(root)` walks **every node in the file**, including the inside of every function
 * body — measured over 24 real files that is 15.8 ms of the 59 ms a cold map costs, and 34× more
 * than the walk below. The query is the right tool when the pattern is irregular; symbol extraction
 * is not that. Three node types matter, all of them declarative, and a declaration's body can
 * never contain a declaration a reader wants in an outline (a nested `function` inside a body is
 * an implementation detail, not a symbol of the file).
 *
 * So the walk descends only into nodes that can *contain* a top-level declaration — `program`,
 * `export_statement`, `ambient_declaration`, `class_body`, `statement_block` — and stops at the
 * declaration itself. Everything else (imports, interfaces, type aliases, expressions, bodies) is
 * skipped without being visited, which makes the cost proportional to the number of declarations
 * rather than to the size of the file.
 *
 * The name of each declaration is read through `childForFieldName`, which is a direct field
 * lookup in the grammar rather than a search. `property_identifier` / `private_property_identifier`
 * / `computed_property_name` / `string` / `number` are all accepted because all five are ordinary
 * method names and a narrower check drops four of them silently.
 *
 * @module dsh-ops/symbol-map/walk
 */

import type { Symbol, SymbolType, SyntaxNode, SyntaxTree } from './types.js'

/**
 * One dispatch table for the whole walk: node type → what the walk does with it.
 *
 * A single lookup rather than a chain of set memberships, because this runs once per visited node
 * and the visited set is every named node in the file. The cost is the same table either way; the
 * difference is one hash instead of five.
 *
 * `function` / `class` / `method` — the three reported kinds. The grammar splits a declaration by
 * "has a body", not by "is a declaration": `declare function f(): void`, a `.d.ts` signature and an
 * overload header are `function_signature`; a `declare class` body holds `method_signature`; an
 * abstract method is `abstract_method_signature`; an abstract class is
 * `abstract_class_declaration`. Reporting only the body-carrying spelling silently shortens the
 * outline of exactly the files that are all API surface — measured before the fix, an abstract
 * class produced one orphan method and no class, and every `declare function` produced nothing.
 *
 * Anonymous `export default class {}` is the `class` node, not a `class_declaration`. There is no
 * name to report, so the class is skipped and its methods are kept: they are real declarations at
 * real lines, and the query path already reported them, so the two tiers have to agree.
 *
 * `container` — the node holds declarations and is not one itself. `program`, `export_statement`,
 * `ambient_declaration` and `class_body` are the structural ones; `lexical_declaration` /
 * `variable_declaration` are what `const handler = () => {}` sits under; the statement containers
 * exist because a `function_declaration` can legitimately sit under a `try`, an `if` or a
 * `switch` (`ptc/worker.ts:86` declares a `const` inside a `try`). Expressions are never entered.
 *
 * `namespace` — `namespace N {}` parses as `expression_statement > internal_module`, while the
 * legacy `module M {}` spelling is a top-level `module`. Entering an expression statement only
 * when it wraps a namespace keeps the walk out of every other expression statement in the file.
 */
type Kind = 'function' | 'class' | 'method' | 'container' | 'namespace'

const KIND: ReadonlyMap<string, Kind> = new Map<string, Kind>([
  ['function_declaration', 'function'],
  ['generator_function_declaration', 'function'],
  ['function_signature', 'function'],
  ['class_declaration', 'class'],
  ['abstract_class_declaration', 'class'],
  ['class', 'class'],
  ['method_definition', 'method'],
  ['method_signature', 'method'],
  ['abstract_method_signature', 'method'],
  ['program', 'container'],
  ['export_statement', 'container'],
  ['ambient_declaration', 'container'],
  ['class_body', 'container'],
  ['statement_block', 'container'],
  ['module', 'container'],
  ['internal_module', 'container'],
  ['lexical_declaration', 'container'],
  ['variable_declaration', 'container'],
  ['if_statement', 'container'],
  ['else_clause', 'container'],
  ['for_statement', 'container'],
  ['for_in_statement', 'container'],
  ['while_statement', 'container'],
  ['do_statement', 'container'],
  ['try_statement', 'container'],
  ['catch_clause', 'container'],
  ['finally_clause', 'container'],
  ['switch_statement', 'container'],
  ['switch_case', 'container'],
  ['switch_default', 'container'],
  ['labeled_statement', 'container'],
  ['with_statement', 'container'],
  ['expression_statement', 'namespace'],
])

/** Method name nodes, in the order the grammar uses them. */
const METHOD_NAME = new Set(['property_identifier', 'private_property_identifier', 'computed_property_name', 'string', 'number'])

/** `childForFieldName` exists on a real tree-sitter node; the interface keeps it optional. */
function field(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return node.childForFieldName?.(name) ?? undefined
}

/**
 * The node's only named child, if it has exactly one.
 *
 * Reads the native counters when they exist; `children` is the fallback for a test double. The
 * distinction is not cosmetic — `children` is an array built on demand that includes anonymous
 * tokens, and asking for it on every expression statement in the file cost 1.3 ms across the
 * 24-file benchmark corpus.
 */
function onlyNamedChild(node: SyntaxNode): SyntaxNode | undefined {
  if (node.namedChildCount !== undefined) {
    return node.namedChildCount === 1 ? node.firstNamedChild ?? undefined : undefined
  }
  return node.children.length === 1 ? node.children[0] : undefined
}

function descend(stack: SyntaxNode[], node: SyntaxNode): void {  const children = node.children
  // Push in reverse so the walk visits siblings in document order; the stack is LIFO.
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]
    if (child !== undefined) stack.push(child)
  }
}

function nameOf(node: SyntaxNode): SyntaxNode | undefined {
  const named = field(node, 'name')
  if (named !== undefined) return named
  // A computed name such as `[Symbol.iterator]()` has no `name` field in some grammar versions;
  // the first matching child is the name in that case.
  for (const child of node.children) if (METHOD_NAME.has(child.type)) return child
  return undefined
}

function push(out: Symbol[], name: SyntaxNode, type: SymbolType, node: SyntaxNode): void {
  const text = name.text
  if (text === '') return
  out.push({
    name: text,
    type,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  })
}

/**
 * Every function, class and class method in the tree, best-effort on a tree with errors.
 *
 * This walks the **core tier only**. The extended tier stays on `query.matches`: a
 * `const f = () => {}` can be declared in an argument position (`new Promise(resolve => …)`), which
 * is inside an expression, and entering expressions is exactly what makes the query 34× slower.
 * Core cannot hit that case — a `function_declaration` only ever sits at statement level — so the
 * two paths are provably equivalent where this one is used.
 */
export function walkSymbols(tree: SyntaxTree): Symbol[] {
  const out: Symbol[] = []
  const stack: SyntaxNode[] = [tree.rootNode]
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode
    const kind = KIND.get(node.type)
    if (kind === undefined) continue
    if (kind === 'function') {
      const name = field(node, 'name')
      if (name !== undefined) push(out, name, 'function', node)
      // The body is entered for exactly one level. A declaration nested directly in a function is
      // still a symbol of the file (`collect.ts` has six such helpers), and skipping them entirely
      // made the walk disagree with the query it replaced. Expressions are still not descended,
      // which is where the 34x saving comes from.
      const body = field(node, 'body')
      if (body !== undefined) descend(stack, body)
      continue
    }
    if (kind === 'class') {
      const name = field(node, 'name')
      if (name !== undefined) push(out, name, 'class', node)
      const body = field(node, 'body')
      if (body !== undefined) stack.push(body)
      continue
    }
    if (kind === 'method') {
      const name = nameOf(node)
      if (name !== undefined) push(out, name, 'method', node)
      const body = field(node, 'body')
      if (body !== undefined) descend(stack, body)
      continue
    }
    if (kind === 'namespace') {
      const only = onlyNamedChild(node)
      if (only?.type === 'internal_module') stack.push(only)
      continue
    }
    descend(stack, node)
  }
  out.sort(compareSymbols)
  return out
}

/**
 * Outer-first: earlier start wins, and among equal starts the longer span wins.
 *
 * The one copy of this ordering. `engine.ts` used to keep an identical second implementation for
 * its query path, which is a drift waiting to happen: two comparators that disagree by one branch
 * produce two different outlines for one file, and nothing fails.
 */
export function compareSymbols(a: Symbol, b: Symbol): number {
  if (a.startLine !== b.startLine) return a.startLine - b.startLine
  if (a.endLine !== b.endLine) return b.endLine - a.endLine
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}
