/** Batch and PTC result schemas; the same result capability also owns a Native projection. */
import type { JsonSchemaNode } from '../adapter/dsh/types.js'
import { STORAGE_REFERENCE, NATIVE_RESULT_PARAMETERS } from './result.js'
import type { ParameterSchema } from './types.js'

const string: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer' }
const object = (properties: Record<string, JsonSchemaNode>, required: string[] = []): ParameterSchema => ({ type: 'object', properties, required, additionalProperties: false })
export const PARAMETERS = {
  batch: object({
    root: string,
    action: { type: 'string', enum: ['plan', 'run', 'resume'] },
    operations: { type: 'array', description: '1-512 operations; enforced by the native worker.', items: object({ op: { type: 'string', enum: ['copy', 'move', 'remove'] }, path: string, to: string }, ['op', 'path']) },
    operationsRef: string,
    protect: { type: 'array', description: 'At most 128 protected relative paths.', items: string },
    id: string,
  }, ['action']),
  result: NATIVE_RESULT_PARAMETERS,
}
// Open JSON values exist only in the data plane (caller-owned rows), not in operation inputs.
export const OUTPUT: JsonSchemaNode = {
  type: 'object', properties: {
    id: string, root: string, status: string, phase: string, done: integer, total: integer,
    failed: integer, unknown: integer, logicalBytes: integer, byteSemantics: string,
    detailsRef: string, complete: { type: 'boolean' }, omitted: integer, nextAction: string,
    sourceTotal: integer, contentHash: string, reference: STORAGE_REFERENCE,
    source: { type: 'object', description: 'Original execution facts, itemEncoding, capturedItems and captureComplete; independent of page completeness.' },
    expires: { oneOf: [integer, { type: 'null' }] }, items: { type: 'array', items: { type: 'object' } }, nextOffset: integer,
    sandbox: object({ mode: string, enforcement: string }, ['mode']),
    error: object({ code: string, phase: string, retryable: { type: 'boolean' }, effectState: string, nextAction: string, message: string,
      permission: object({ current: string, required: string, operation: string, workspaceRoot: string }),
    }, ['code', 'phase', 'retryable', 'effectState', 'nextAction', 'message']),
  },
}
export const DESCRIPTIONS = {
  batch: 'Preflight and verify copy/move/remove. action=plan requires operations and creates a no-effect audit plan; execute that exact plan with action=resume plus id (do not change it to run). action=run requires operations and executes immediately. root, when supplied, must be an absolute path: a relative root is rejected at preflight with INVALID_ARGUMENT. Omit root to use the session workspace root; an absolute root follows DSH permissions (unrestricted in full access). Operations use relative / paths, no overwrite or link traversal. Page detailsRef with ops_result, passing the same root whenever the plan root differs from the session workspace root. Parameter errors return structured error objects.',
  result: 'Session-owned object rows: put items (up to 10000; 2 MiB whole request and 10 MiB physical reference cap), page, release. Pages default to offset=0, limit=64, maxBytes=16384; follow nextOffset until complete. equals filters top-level exact values before fields projection; offset/total/omitted count filtered rows. sourceTotal/contentHash identify all ordered rows before filtering/projection (SHA-256 of worker compact JSON with sorted object keys); compare hashes across pages to detect changed audits, never as authority. An oversized row returns OUTPUT_LIMIT: project fewer fields or raise maxBytes (max 65536). New ref:// snapshots default to session lifetime (ttlMs=0); put may set ttlMs up to 604800000. reference.createdAt is Unix milliseconds. Legacy r- snapshots expire after 24h; audit pages have expires=null and cannot be released. Page complete describes stored rows only; source execution and capture completeness remain independent. Tagged-json-v1 item-json-chunk text must be joined by index and byteOffset before JSON.parse, only after complete=true. operationsRef in ops_batch accepts only owned unexpired result rows. Pass the same root as the batch when paging detailsRef, or expect NOT_FOUND. Failures are structured values, not thrown errors. In run_code, process pages locally and return only needed summaries.',
}
