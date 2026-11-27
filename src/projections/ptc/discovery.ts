import type { JsonSchemaNode } from '../../adapter/dsh/types.js'
import type { ParameterSchema } from '../../capabilities/types.js'
import type { ToolDefinition } from '../../adapter/dsh/types.js'
import { publicToolName } from '../../policy.js'
import type { IndexedTool } from '../../ptc/tool-index.js'
import { toOutcome } from './outcome.js'

export const DISCOVERY_RAW_NAME = 'discover_tool'
export const DISCOVERY_DESCRIPTION = 'Search the compact OPS tool index and select one exact indexed entry for the next model step. Selection does not execute the tool.'
export const DISCOVERY_PARAMETERS: ParameterSchema = { type: 'object', additionalProperties: false, required: ['query'], properties: {
  query: { type: 'string', description: 'Search terms for index lookup, or exact index id to select a tool for the next step.' }, limit: { type: 'integer', enum: [1, 2, 4, 8, 16] },
} }
export const DISCOVERY_OUTPUT: JsonSchemaNode = { type: 'object', additionalProperties: false, properties: {
  status: { type: 'string', enum: ['completed', 'rejected', 'conflict', 'error', 'unknown'] },
  data: { type: 'object', additionalProperties: false, properties: {
    status: { type: 'string', enum: ['completed', 'not_found'] },
    matches: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, executor: { type: 'string' },
    } } }, id: { type: 'string' }, tool: { type: 'string' }, nextTurn: { type: 'boolean' },
  } },
  error: { type: 'object', additionalProperties: false, properties: { code: { type: 'string' }, message: { type: 'string' }, effectState: { type: 'string' }, retry: { type: 'string' }, nextAction: { type: 'string' } }, required: ['code', 'message', 'effectState', 'retry'] },
}, required: ['status'] }
export function discoveryDefinition(execute: ToolDefinition['execute']): ToolDefinition {
  return { name: publicToolName(DISCOVERY_RAW_NAME), description: DISCOVERY_DESCRIPTION, parameters: DISCOVERY_PARAMETERS as unknown as Record<string, unknown>,
    output: { schema: DISCOVERY_OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      const value = await execute(args, exec)
      const outcome = toOutcome(DISCOVERY_RAW_NAME, args, value)
      return 'error' in outcome ? { status: outcome.status, error: outcome.error } : outcome
    } }
}
export function requestedIndexQuery(args: unknown): { query: string; limit: number } | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const input = args as Record<string, unknown>
  if (Object.keys(input).some(key => key !== 'query' && key !== 'limit')) return undefined
  if (typeof input.query !== 'string' || input.query.trim() !== input.query || input.query.length < 1 || input.query.length > 256) return undefined
  const id = input.query.startsWith('id:') ? input.query.slice(3) : undefined
  if (id && !/^[a-z][a-z0-9._-]{0,63}$/.test(id)) return undefined
  if (id && input.limit === undefined) return { query: 'id:' + id, limit: 1 }
  const limit = input.limit ?? 8
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 16) return undefined
  return { query: input.query, limit }
}
