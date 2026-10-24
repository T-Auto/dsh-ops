import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { ParameterSchema, SchemaCapability } from './types.js'
export const SDK_PARAMETERS: ParameterSchema = { type: 'object', properties: {
  tools: { type: 'array', items: { type: 'string' },
    description: '1-5 exact raw OPS API names, without the public prefix. Select only from the allowed catalogue in this tool description.' },
}, required: ['tools'], additionalProperties: false }
export const SDK_OUTPUT: JsonSchemaNode = { type: 'object', properties: {
  status: { type: 'string', const: 'completed' }, tools: { type: 'array', items: { type: 'string' } }, nextTurn: { type: 'boolean', const: true },
}, required: ['status', 'tools', 'nextTurn'], additionalProperties: false }
export const SDK_CAPABILITIES = Object.freeze([Object.freeze({
  rawName: 'load_sdk', component: 'ptc', presentations: Object.freeze(['ptc'] as const), availability: 'resident', ptcAvailability: 'resident',
  mutates: false, concurrencySafe: false, parameters: SDK_PARAMETERS, output: SDK_OUTPUT,
  description: 'Load 1-5 named OPS APIs into this agent’s typed SDK on the next model step. The current run_code snapshot cannot call newly requested APIs. No file operation runs here. Native/both presentations do not expose this loader.',
} as const satisfies SchemaCapability)])
