import type { ToolDefinition } from '../../adapter/dsh/types.js'
import { publicToolName } from '../../policy.js'
import { capability } from '../../capabilities/registry.js'
import type { FileToolName } from '../../capabilities/registry.js'
import { PARAMETERS, DESCRIPTIONS, OUTPUT, fileOutput } from '../../capabilities/file.js'
export { FILE_TOOLS } from '../../capabilities/registry.js'
export { PARAMETERS, DESCRIPTIONS, OUTPUT }
import { renderNative } from './render.js'
import { presentationMeta } from '../../kernel/presentation-outcome.js'

export { normalizeArguments } from '../../capabilities/arguments.js'

export function definition(rawName: FileToolName, execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name: publicToolName(rawName),
    description: DESCRIPTIONS[rawName],
    parameters: PARAMETERS[rawName],
    ...(capability(rawName)?.concurrencySafe ? { isConcurrencySafe: () => true } : {}),
    output: { schema: fileOutput(rawName), render: (args, value) => [{ type: 'text', text: renderNative(rawName, args, value) }], presentationMeta },
    execute,
  }
}
