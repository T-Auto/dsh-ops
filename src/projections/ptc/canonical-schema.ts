/** Typed fields describe canonical data, independently of the Native display projection. */
import type { JsonSchemaNode } from '../../adapter/dsh/types.js'
import { DOCUMENT_FACTS, isDocumentTool } from '../../capabilities/documents.js'
import { capability } from '../../capabilities/registry.js'
import type { FileToolName, PtcToolName } from '../../capabilities/registry.js'
import { STORAGE_REFERENCE } from '../../capabilities/result.js'
const string: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer' }
const boolean: JsonSchemaNode = { type: 'boolean' }
const nullableInteger: JsonSchemaNode = { oneOf: [integer, { type: 'null' }] }
const object = (properties: Record<string, JsonSchemaNode>): JsonSchemaNode => ({ type: 'object', properties })
const array = (items: JsonSchemaNode): JsonSchemaNode => ({ type: 'array', items })
const physicalLine = object({ path: string, line: integer, text: string, view: string, offset: integer,
  truncatedInLine: boolean, bytesTotal: integer, bytesOmitted: integer })
const receipt = object({ path: string, to: string, revision: string, revisionBefore: string,
  bytes: integer, bytesBefore: integer, bytesAfter: integer, lineCount: integer, removed: boolean,
  metadataWarnings: array(string) })
const facts = { revision: string, bytes: integer, lineCount: { oneOf: [integer, { type: 'null' }] } satisfies JsonSchemaNode }
const cache = { reference: STORAGE_REFERENCE, referenceRoot: string,
  storageError: object({ code: string, message: string, effectState: { type: 'string', enum: ['none', 'applied', 'partial', 'unknown'] } }) }
const coverage = { scanComplete: boolean, pageComplete: boolean, scannedFiles: integer, skippedFiles: integer,
  skipReasons: { type: 'object', description: 'Nonnegative counts keyed by skip reason.' } satisfies JsonSchemaNode,
  matchedObserved: integer, matchedTotal: integer, truncatedBy: string, continuation: string }
const range = { ...facts, path: string, status: string, complete: boolean, truncated: boolean,
  nextOffset: integer, total: integer, omitted: integer, nextAction: string, error: { type: 'object' } satisfies JsonSchemaNode }

export function canonicalOutput(tool: FileToolName | PtcToolName): JsonSchemaNode {
  const entry = capability(tool)
  if (!entry || !('output' in entry)) throw new Error(`Missing canonical schema: ${tool}`)
  const properties: Record<string, JsonSchemaNode> = { ...entry.output.properties, ...cache }
  if (isDocumentTool(tool)) return { ...entry.output, properties }
  if (tool === 'inspect_local_file') Object.assign(properties, facts, { path: string, items: array(physicalLine) })
  else if (tool === 'read_files') properties.items = array(object({ ...range, items: array(physicalLine) }))
  else if (tool === 'glob') properties.items = array({ oneOf: [string, object({ path: string, bytes: integer, modified: nullableInteger })] })
  else if (tool === 'grep') properties.items = array(object({ path: string, line: integer, text: string, count: integer, matches: integer }))
  else if (tool === 'stat') Object.assign(properties, facts, { exists: boolean, path: string, readonly: boolean, mode: string, modifiedMs: nullableInteger })
  else if (tool === 'diff') Object.assign(properties, { before: object(facts), after: object(facts),
    hunk: object({ startLine: integer, removed: integer, added: integer }), items: array(object({ kind: string, line: integer, text: string })) })
  else if (tool === 'result') properties.source = object({ ...range, ...coverage, ...DOCUMENT_FACTS, root: string,
    itemEncoding: string, capturedItems: integer, captureComplete: boolean })
  else if (tool !== 'batch') properties.items = array(receipt)
  return { ...entry.output, properties }
}
