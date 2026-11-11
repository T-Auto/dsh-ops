/** Typed fields describe canonical data, independently of the Native display projection. */
import type { JsonSchemaNode } from '../../adapter/dsh/types.js'
import { DOCUMENT_FACTS, isDocumentTool } from '../../capabilities/documents.js'
import { capability } from '../../capabilities/registry.js'
import type { FileToolName, PtcToolName } from '../../capabilities/registry.js'
import { publicToolName } from '../../policy.js'
import { STORAGE_REFERENCE } from '../../capabilities/result.js'
const string: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer' }
const boolean: JsonSchemaNode = { type: 'boolean' }
const nullableInteger: JsonSchemaNode = { oneOf: [integer, { type: 'null' }] }
const object = (properties: Record<string, JsonSchemaNode>): JsonSchemaNode => ({ type: 'object', properties })
const array = (items: JsonSchemaNode): JsonSchemaNode => ({ type: 'array', items })
const row = (properties: Record<string, JsonSchemaNode>, required: string[]): JsonSchemaNode =>
  ({ type: 'object', properties, required, additionalProperties: false })
const clipping = { truncatedInLine: boolean, bytesTotal: integer, bytesOmitted: integer }
const physicalLine = object({ path: string, line: integer, text: string, view: string, offset: integer,
  truncatedInLine: boolean, bytesTotal: integer, bytesOmitted: integer })
const receipt = object({ path: string, to: string, revision: string, revisionBefore: string,
  bytes: integer, bytesBefore: integer, bytesAfter: integer, lineCount: integer, removed: boolean,
  metadataWarnings: array(string) })
const replacementReceipt = object({ path: string, revision: string, revisionAfter: string,
  replacements: integer, bytesBefore: integer, bytesAfter: integer, lineCountBefore: integer, lineCount: integer,
  status: { type: 'string', enum: ['pending', 'completed', 'error'] },
  error: { type: 'object' }, metadataWarnings: array(string) })
const facts = { revision: string, bytes: integer, lineCount: { oneOf: [integer, { type: 'null' }] } satisfies JsonSchemaNode }
const cache = { reference: { ...STORAGE_REFERENCE, description: `Page ref:// via result; load it with tools.${publicToolName('load_sdk')}({tools:['result']}) if absent.` }, referenceRoot: string,
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
  else if (tool === 'glob') properties.items = { ...array({ oneOf: [string,
    row({ path: string, bytes: integer, modified: nullableInteger, kind: { type: 'string', enum: ['file', 'directory'] } }, ['path', 'bytes', 'modified'])] }),
    description: 'paths (default): string[]; details: {path,bytes,modified,kind?}[]. kind is included for directory/all queries.' }
  else if (tool === 'grep') properties.items = { ...array({ oneOf: [
    row({ path: string }, ['path']), row({ path: string, count: integer }, ['path', 'count']),
    row({ path: string, line: integer, text: string, ...clipping }, ['path', 'line', 'text']),
    row({ path: string, line: integer, text: string, kind: string, ...clipping }, ['path', 'line', 'text', 'kind']),
  ] }), description: 'files_with_matches: {path}[]; count: {path,count}[]; content (default): {path,line,text}[]; definitions adds kind; summary: [] with files/matches totals.' }
  else if (tool === 'stat') Object.assign(properties, facts, { exists: boolean, path: string, readonly: boolean, mode: string, modifiedMs: nullableInteger })
  else if (tool === 'diff') Object.assign(properties, { before: object(facts), after: object(facts),
    hunk: object({ startLine: integer, removed: integer, added: integer }), items: array(object({ kind: string, line: integer, text: string })) })
  else if (tool === 'result') properties.source = object({ ...range, ...coverage, ...DOCUMENT_FACTS, root: string,
    itemEncoding: string, capturedItems: integer, captureComplete: boolean })
  else if (tool === 'replace') Object.assign(properties, { pending: integer, items: array(replacementReceipt) })
  else if (tool !== 'batch') properties.items = array(receipt)
  // Search never returns file metadata or a write preview at its top level.
  if (tool === 'glob' || tool === 'grep') {
    for (const field of ['revision', 'bytes', 'lineCount', 'dryRun']) delete properties[field]
    if (tool === 'glob') for (const field of ['files', 'matches']) delete properties[field]
  }
  return { ...entry.output, properties }
}
