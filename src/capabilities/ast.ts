/** AST capability data; these three names are answered in-process and never by the native worker. */
import type { JsonSchemaNode } from '../adapter/dsh/types.js'
import type { ParameterSchema } from './types.js'

const string: JsonSchemaNode = { type: 'string' }
const bounded = (properties: Record<string, JsonSchemaNode>, required: string[] = []): ParameterSchema => ({ type: 'object', properties, required, additionalProperties: false })
const count = (value: number): JsonSchemaNode => ({ type: 'integer', description: `1-500 results; default ${value}.` })

// Named paths and roots are confined to the session cwd by the host bridge, not by the engine.
const named: JsonSchemaNode = { ...string, description: 'Path relative to the session cwd.' }
const locateArgs: Record<string, JsonSchemaNode> = {
  symbol: { ...string, description: 'Exact identifier, e.g. "locateSymbol"; definitions rank above references.' },
  file: { ...named, description: 'Search one file instead of the tree.' },
  roots: { type: 'array', description: 'Search roots relative to the session cwd, each inside it; default the cwd.', items: string },
  ext: { type: 'array', description: 'Extensions, e.g. ["ts","py"]; default every registered language.', items: string },
  limit: count(5),
  body: { description: 'Off by default: the signature alone. true returns the whole node, a number returns that many lines.', oneOf: [{ type: 'boolean' }, { type: 'integer' }] },
  continuation: { ...string, description: 'Opaque cursor from a truncated scan; keep every other argument unchanged.' },
  skipDirs: { type: 'array', description: 'Directory names never descended into, e.g. ["dist","vendor"].', items: string },
}

export const PARAMETERS = Object.freeze({
  ast_locate: bounded(locateArgs, ['symbol']),
  ast_refactor: bounded({
    ...locateArgs,
    limit: count(1),
    pattern: { ...string, description: 'ast-grep pattern with $VAR metavariables, e.g. "console.log($A)".' },
    rewrite: { ...string, description: 'Replacement text; $VAR expands to the matched metavariable.' },
    mode: { type: 'string', enum: ['preview', 'apply'], description: 'Preview (default) reports the plan; apply writes it.' },
    detail: { type: 'boolean', description: 'Include the structural delta per file; default false.' },
  }, ['pattern', 'rewrite']),
  ast_audit: bounded({
    file: { ...named, description: 'Current content of the file.' },
    beforeFile: { ...named, description: 'Previous content of the same file.' },
  }, ['file', 'beforeFile']),
})

// One output contract per verb: a caller reads `hits` from locate, `files` from refactor, and the
// node counts from audit — a single wide shape would describe all three and therefore none.
const receipt: Record<string, JsonSchemaNode> = { status: string, code: string, message: string, error: { type: 'object' }, sandbox: { type: 'object' } }
const lines: JsonSchemaNode = { type: 'array', description: '[first, last] 1-based line numbers.', items: { type: 'integer' } }

export const LOCATE_OUTPUT: JsonSchemaNode = {
  type: 'object',
  properties: {
    ...receipt, discover: { type: 'object' }, continuation: string,
    truncated: { type: 'boolean', description: 'True when limit or the deadline stopped the walk: hits is not the complete set.' },
    pruned: { type: 'boolean', description: 'True when more than 48 candidates survived the prefilter and only the first 48 were parsed.' },
    hits: { type: 'array', items: { type: 'object', properties: { file: string, lang: string, lines, signature: string, body: string } } },
  },
}

export const REFACTOR_OUTPUT: JsonSchemaNode = {
  type: 'object',
  properties: {
    ...receipt, mode: { type: 'string', enum: ['preview', 'apply'] }, continuation: string,
    edits: { type: 'integer' }, filesTotal: { type: 'integer' },
    applied: { type: 'boolean' }, effectState: { type: 'string', enum: ['none', 'applied', 'partial'] },
    files: { type: 'array', items: { type: 'object', properties: { file: string, edits: { type: 'integer' }, addedLines: { type: 'integer' }, removedLines: { type: 'integer' } } } },
    filesApplied: { type: 'array', description: 'Files already committed when effectState is partial.', items: string },
    conflicts: { type: 'array', items: { type: 'object', properties: { file: string, code: string, message: string, audit: { type: 'object' } } } },
  },
}

export const AUDIT_OUTPUT: JsonSchemaNode = {
  type: 'object',
  properties: {
    ...receipt, file: string, lang: string, ok: { type: 'boolean' },
    formatOnly: { type: 'boolean' }, nodeScanTruncated: { type: 'boolean' },
    edits: { type: 'integer' }, addedLines: { type: 'integer' }, removedLines: { type: 'integer' },
    nodesBefore: { type: 'integer' }, nodesAfter: { type: 'integer' }, nodesChanged: { type: 'integer' },
    errorNodesBefore: { type: 'integer' }, errorNodesAfter: { type: 'integer' },
  },
}

export function astOutput(rawName: keyof typeof PARAMETERS): JsonSchemaNode {
  return rawName === 'ast_locate' ? LOCATE_OUTPUT : rawName === 'ast_refactor' ? REFACTOR_OUTPUT : AUDIT_OUTPUT
}

// Failures are returned values, never thrown (#44).
const RESULT = ' Failures resolve as {status:"error"|"rejected", error.code}; they are not thrown.'
export const DESCRIPTIONS = Object.freeze({
  ast_locate: 'Find a definition by exact identifier — functions, classes, methods, constructors, and function-valued declarations; a plain `const NAME = 1` is not a definition and returns no hit. Uses Tree-sitter rather than text matching over the tree below the session cwd. Definitions rank above references; file narrows the search to one file. limit defaults to 5; a truncated scan returns continuation to resume with unchanged arguments. In-process: no worker spawn, no shell.',
  ast_refactor: 'Rewrite source structurally with an ast-grep pattern ($VAR metavariables) and a rewrite template over the same scope as ops_ast_locate. mode defaults to preview, which returns the plan and writes nothing; apply returns the same plan with the replacement text and lets the native worker publish it, so one atomic-CAS writer serves every tool. Per file one atomic replacement, preserving BOM, line endings, permissions and mtime-independent content. detail adds the structural delta.' + RESULT,
  ast_audit: 'Compare two versions of one file structurally: formatOnly reports whether the change is whitespace-only; a comment is a node, so it counts as structural. Node counts before/after are always included. Read-only and never writes.' + RESULT,
})
