import type { ToolDefinition } from '../../adapter/dsh/types.js'
import { publicToolName } from '../../policy.js'
import { capability } from '../../capabilities/registry.js'
import type { AstToolName, FileToolName } from '../../capabilities/registry.js'
import { PARAMETERS, DESCRIPTIONS, OUTPUT, fileOutput } from '../../capabilities/file.js'
import { PARAMETERS as astParameters, DESCRIPTIONS as astDescriptions, astOutput } from '../../capabilities/ast.js'
export { FILE_TOOLS } from '../../capabilities/registry.js'
export { PARAMETERS, DESCRIPTIONS, OUTPUT }
import { renderNative } from './render.js'
import { presentationMeta } from '../../kernel/presentation-outcome.js'

export { normalizeArguments } from '../../capabilities/arguments.js'


/**
 * The AST receipts as the model reads them.
 *
 * Compact text, not JSON: the same information in about half the bytes, and it matches how the
 * native tools already render. A refusal keeps its code and message because the caller has to act on
 * both.
 * @param tool - the raw tool name.
 * @param value - the receipt the bridge returned.
 * @returns one text block.
 */
function renderAst(tool: AstToolName, value: unknown): string {
  const receipt = (value ?? {}) as Record<string, unknown>
  const error = receipt.error as { code?: string; message?: string } | undefined
  if (error?.code) return `${error.code}: ${error.message ?? ''}`.trim()
  if (tool === 'ast_locate') {
    const hits = Array.isArray(receipt.hits) ? receipt.hits as Array<Record<string, unknown>> : []
    const lines = hits.map(hit => {
      const span = Array.isArray(hit.lines) ? `${hit.lines[0]}-${hit.lines[1]}` : '?'
      const body = typeof hit.body === 'string' ? `\n${hit.body}` : ''
      return `${String(hit.file)}:${span} ${String(hit.signature ?? '')}${body}`
    })
    if (receipt.pruned) lines.push('[pruned: more candidates than were parsed]')
    if (receipt.truncated) lines.push('[truncated: this is not the complete set]')
    if (typeof receipt.continuation === 'string') lines.push(`[continue with continuation=${receipt.continuation}]`)
    return lines.length ? lines.join('\n') : 'no definition found'
  }
  if (tool === 'ast_refactor') {
    const files = Array.isArray(receipt.files) ? receipt.files as Array<Record<string, unknown>> : []
    const head = `${String(receipt.mode)}: ${String(receipt.planned ?? 0)} file(s), ${String(receipt.edits ?? 0)} edit(s)${receipt.remaining === null ? ', more not counted (limit)' : ''}`
    const body = files.map(file => `${String(file.file)}  +${String(file.addedLines ?? 0)} -${String(file.removedLines ?? 0)}`)
    const applied = Array.isArray(receipt.filesApplied) && receipt.filesApplied.length ? [`applied: ${receipt.filesApplied.join(', ')}`] : []
    const conflicts = Array.isArray(receipt.conflicts) ? receipt.conflicts as Array<Record<string, unknown>> : []
    const blocked = conflicts.map(c => `${String(c.file)}: ${String(c.code)} ${String(c.message)}`)
    return [head, ...body, ...applied, ...blocked].join('\n')
  }
  return `formatOnly: ${String(receipt.formatOnly)} | nodes ${String(receipt.nodesBefore)}->${String(receipt.nodesAfter)} (changed ${String(receipt.nodesChanged)})`
}

export function definition(rawName: FileToolName | AstToolName, execute: ToolDefinition['execute']): ToolDefinition {
  // The AST tools carry their own schema and a flat receipt: the file renderer has no shape for them.
  if (rawName.startsWith('ast_')) {
    const ast = rawName as AstToolName
    return {
      name: publicToolName(rawName),
      description: astDescriptions[ast],
      parameters: astParameters[ast],
      ...(capability(rawName)?.concurrencySafe ? { isConcurrencySafe: () => true } : {}),
      output: { schema: astOutput(ast), render: (_args, value) => [{ type: 'text', text: renderAst(ast, value) }] },
      execute,
    }
  }
  return fileDefinition(rawName as FileToolName, execute)
}

function fileDefinition(rawName: FileToolName, execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name: publicToolName(rawName),
    description: DESCRIPTIONS[rawName],
    parameters: PARAMETERS[rawName],
    ...(capability(rawName)?.concurrencySafe ? { isConcurrencySafe: () => true } : {}),
    output: { schema: fileOutput(rawName), render: (args, value) => [{ type: 'text', text: renderNative(rawName, args, value) }], presentationMeta },
    execute,
  }
}
