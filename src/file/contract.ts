import type { ToolDefinition } from '../adapter/dsh/types.js'
import { publicToolName } from '../policy.js'
import { capability } from '../capabilities/registry.js'
import type { FileToolName } from '../capabilities/registry.js'
import { PARAMETERS, DESCRIPTIONS, OUTPUT, fileOutput } from '../capabilities/file.js'
export { FILE_TOOLS } from '../capabilities/registry.js'
export { PARAMETERS, DESCRIPTIONS, OUTPUT }
import { renderNative } from './native/render.js'
import { presentationMeta } from '../kernel/presentation-outcome.js'

/** Drop unused empty placeholders strict adapters send for optional fields; never mutate the caller's object. */
export function normalizeArguments(rawName: string, args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const entry = capability(rawName)
  const schema = entry?.component === 'file' ? entry.parameters : undefined
  if (!schema) return { ...args }
  const required = new Set(schema.required)
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    const field = schema.properties[key]
    if (field && !required.has(key)) {
      if (field.type === 'string' && typeof value === 'string' && value.trim() === '') continue
      if (field.type === 'array' && Array.isArray(value) && value.length === 0) continue
    }
    result[key] = value
  }
  return result
}

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
