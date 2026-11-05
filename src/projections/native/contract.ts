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

export function definition(rawName: FileToolName | AstToolName, execute: ToolDefinition['execute']): ToolDefinition {
  // The AST tools carry their own schema and a flat receipt: the file renderer has no shape for them.
  if (rawName.startsWith('ast_')) {
    const ast = rawName as AstToolName
    return {
      name: publicToolName(rawName),
      description: astDescriptions[ast],
      parameters: astParameters[ast],
      ...(capability(rawName)?.concurrencySafe ? { isConcurrencySafe: () => true } : {}),
      output: { schema: astOutput(ast), render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
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
