/** Discriminated PTC envelopes feed the pinned host's validation and SDK generator. */
import type { JsonSchemaNode } from '../../adapter/dsh/types.js'
const string: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer' }
const object = (properties: Record<string, JsonSchemaNode>, required: string[]): JsonSchemaNode =>
  ({ type: 'object', properties, required, additionalProperties: false })
const coverage = (complete: boolean): JsonSchemaNode => object({ scannedFiles: integer, matchedCount: integer,
  isComplete: { type: 'boolean', const: complete },
  truncatedBy: { type: 'string', enum: ['scan-budget', 'output-budget', 'time-limit', 'row-limit'] },
}, ['scannedFiles', 'matchedCount', 'isComplete'])
export const ERROR_SCHEMA = object({ code: string, message: string, nextAction: string,
  effectState: { type: 'string', enum: ['none', 'applied', 'partial', 'unknown'] },
  retry: { type: 'string', enum: ['never', 'after-input-change', 'after-state-change', 'bounded-transient'] },
}, ['code', 'message', 'effectState', 'retry'])
export function outcomeSchema(data: JsonSchemaNode): JsonSchemaNode {
  const failureData: JsonSchemaNode = { ...data, required: [], properties: { ...data.properties, error: { type: 'object' } } }
  return { oneOf: [
    object({ status: { type: 'string', const: 'completed' }, data, coverage: coverage(true) }, ['status', 'data']),
    object({ status: { type: 'string', const: 'partial' }, data, coverage: coverage(false), continuation: string }, ['status', 'data', 'coverage', 'continuation']),
    object({ status: { type: 'string', enum: ['rejected', 'conflict', 'error', 'unknown'] }, error: ERROR_SCHEMA, data: failureData }, ['status', 'error']),
  ] }
}
