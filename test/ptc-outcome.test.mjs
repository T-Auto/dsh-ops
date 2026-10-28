import { assertSupportedJsonSchema, jsonSchemaToTs, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { toOutcome } from '../lib/ptc/projection/outcome.js'
import { continuationFor, decodeContinuation } from '../lib/ptc/projection/continuation.js'
import { outcomeSchema } from '../lib/ptc/projection/schema.js'
import { canonicalOutput } from '../lib/ptc/projection/canonical-schema.js'
import { assert, test, report } from './lib/harness.mjs'

await test('successful observations retain exact canonical values without Native text', () => {
  const data = { status: 'completed', complete: true, items: [{ line: 1, text: 'α\r\n😀' }], revision: 'r' }
  const before = structuredClone(data), out = toOutcome('inspect_local_file', { path: '/a' }, data)
  assert.deepEqual(out, { status: 'completed', data })
  assert.equal(out.data, data)
  assert.deepEqual(data, before)
  assert.equal(toOutcome('stat', {}, { exists: false, revision: 'absent' }).status, 'completed')
})
await test('failures use stable retry policies and retain effect-bearing data', () => {
  for (const [code, effectState, status, retry] of [
    ['POLICY_DENIED','none','rejected','never'], ['REVISION_CONFLICT','none','conflict','after-state-change'],
    ['INVALID_ARGUMENT','none','error','after-input-change'], ['JOB_BUSY','none','error','bounded-transient'],
    ['REVISION_CONFLICT','applied','error','never'], ['IO_ERROR','partial','error','never'],
    ['IO_ERROR','unknown','unknown','never'],
  ]) {
    const data = { status: 'error', error: { code, effectState, message: 'failed', nextAction: 'Inspect.' } }
    const out = toOutcome('write_file', {}, data)
    assert.equal(out.status, status); assert.equal(out.error.retry, retry)
    assert.equal(out.error.effectState, effectState); assert.equal(out.data, data)
    assert.equal(out.error.nextAction, 'Inspect.')
  }
  assert.equal(toOutcome('write_file', {}, { status: 'error', error: { code: 'IO_ERROR' } }).status, 'unknown')
  assert.equal(toOutcome('batch', {}, { status: 'unknown', unknown: 1, done: 2 }).error.retry, 'never')
  assert.equal(toOutcome('write_file', {}, null).status, 'unknown')
  assert.equal(toOutcome('write_file', {}, {}).status, 'unknown')
  assert.equal(toOutcome('write_file', {}, { status: 'future-success' }).status, 'unknown')
})
await test('batch summaries distinguish successful plans from partial or unknown effects', () => {
  for (const status of ['planned','completed']) assert.equal(toOutcome('batch', {}, { status, complete: false, detailsRef: 'j-a' }).status, 'completed')
  const failed = toOutcome('batch', {}, { status: 'partial_completion', done: 2, failed: 1, detailsRef: 'j-a' })
  assert.equal(failed.status, 'error'); assert.equal(failed.error.effectState, 'partial')
  assert.equal(failed.error.retry, 'never'); assert.equal(failed.data.detailsRef, 'j-a')
  assert.equal('continuation' in failed, false, 'never turn a failed mutation into a replay cursor')
})
await test('result creation succeeds without echoing rows while partial pages continue readonly', () => {
  assert.equal(toOutcome('result', { action: 'put' }, { status: 'completed', complete: false, reference: { refId: 'ref://s/result/x' } }).status, 'completed')
  const out = toOutcome('result', { action: 'page', id: 'ref://s/result/x', root: '/original', limit: 1 }, { complete: false, nextOffset: 1, reference: { refId: 'ref://s/result/x' }, items: [{ n: 0 }] })
  assert.equal(out.status, 'partial'); assert.equal(out.coverage.isComplete, false)
  assert.deepEqual(decodeContinuation(out.continuation), { version: 1, tool: 'result', args: { action: 'page', id: 'ref://s/result/x', root: '/original', limit: 1, offset: 1 } })
})
await test('successful release and legacy put receipts remain completed', () => {
  const released = { status: 'released', id: 'ref://s/result/x' }
  assert.equal(toOutcome('result', { action: 'release' }, released).status, 'completed')
  assert.equal(toOutcome('write_file', {}, released).status, 'unknown')
  assert.equal(toOutcome('result', { action: 'put' }, { id: 'r-x', total: 2, contentHash: 'sha256:x', complete: false }).status, 'completed')
})
await test('search gaps never claim completed coverage or invent resumable scan cursors', () => {
  const data = { complete: false, scanComplete: false, pageComplete: true, scannedFiles: 10000, matchedObserved: 8, truncatedBy: 'scan-budget', items: [] }
  const out = toOutcome('grep', { pattern: 'x' }, data)
  assert.equal(out.status, 'error'); assert.equal(out.error.code, 'RESULT_PARTIAL')
  assert.equal(out.data, data); assert.equal('matchedTotal' in out.data, false)
  const page = toOutcome('grep', { pattern: 'x', glob: ['*.ts'] }, { ...data, scanComplete: true, matchedTotal: 9, continuation: 'stable', nextOffset: 8, truncatedBy: 'row-limit' })
  assert.equal(page.status, 'partial'); assert.equal(page.coverage.matchedCount, 8)
  assert.deepEqual(decodeContinuation(page.continuation).args, { pattern: 'x', glob: ['*.ts'], continuation: 'stable', offset: 8 })
})
await test('reference retrieval preserves original root and never resumes the producing mutation', () => {
  const data = { status: 'completed', changed: 3, complete: false, referenceRoot: '/original', reference: { refId: 'ref://s/replace/x' }, storageError: { code: 'QUOTA_EXCEEDED', effectState: 'applied' } }
  const out = toOutcome('replace', { pattern: 'x', replacement: 'y' }, data)
  assert.equal(out.status, 'partial')
  assert.deepEqual(decodeContinuation(out.continuation), { version: 1, tool: 'result', args: { action: 'page', id: 'ref://s/replace/x', offset: 0, root: '/original' } })
  assert.equal(out.data.storageError.effectState, 'applied'); assert.equal(out.data.changed, 3)
})
await test('line and read_files cursors retain unconsumed ranges and reject zero-progress long lines', () => {
  const args = { files: [{ path: '/a', offset: 1, limit: 2 }, { path: '/b' }, { path: '/pending' }] }
  const data = { status: 'partial', complete: false, nextIndex: 2, items: [{ complete: false, nextOffset: 3 }, { complete: true }] }
  assert.deepEqual(decodeContinuation(toOutcome('read_files', args, data).continuation).args, { files: [{ path: '/a', offset: 3, limit: 2 }, { path: '/pending' }] })
  const clipped = toOutcome('inspect_local_file', { path: '/a', offset: 1 }, { complete: false, truncated: true, nextOffset: 1, items: [{ truncatedInLine: true }] })
  assert.equal(clipped.status, 'error'); assert.equal('continuation' in clipped, false)
  assert.equal(toOutcome('read_files', args, { ...data, failed: 1 }).status, 'error')
  const original = { files: Array.from({ length: 32 }, (_, n) => ({ path: `/${n}` })) }
  const refusedSpill = { status: 'partial', complete: false, nextIndex: 0, pending: 32,
    items: Array.from({ length: 14 }, () => ({ complete: true })), storageError: { code: 'POLICY_DENIED' } }
  const halted = toOutcome('read_files', original, refusedSpill)
  assert.equal(halted.status, 'error'); assert.equal('continuation' in halted, false, 'a bounded head never repeats the same full request')
})
await test('bounded continuation decoding never admits mutation or result-release tokens', () => {
  for (const tool of ['write_file','edit_file','batch','bash']) assert.equal(decodeContinuation('ops-next-v1:' + JSON.stringify({ version: 1, tool, args: {} })), undefined)
  assert.equal(decodeContinuation('ops-next-v1:' + JSON.stringify({ version: 1, tool: 'result', args: { action: 'release' } })), undefined)
  assert.equal(decodeContinuation('garbage'), undefined)
  assert.equal(continuationFor('diff', { content: 'x'.repeat(10000) }, { nextOffset: 2 }), undefined)
  const cycle = {}; cycle.self = cycle
  assert.equal(continuationFor('diff', cycle, { nextOffset: 2 }), undefined)
})
await test('host schema validation and generated SDK enforce the discriminated envelope', () => {
  const schema = outcomeSchema({ type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false })
  assertSupportedJsonSchema(schema)
  const sdk = jsonSchemaToTs(schema)
  assert.match(sdk, /status: "completed"/); assert.match(sdk, /continuation: string/)
  assert.doesNotMatch(sdk, /\bany\b|:\s*unknown\b/)
  assert.deepEqual(validateJsonSchemaValue(schema, { status: 'completed', data: { value: 2 } }), [])
  for (const bad of [{ status: 'partial', data: { value: 2 } }, { status: 'completed', data: { value: 2 }, coverage: { scannedFiles: 0, matchedCount: 0, isComplete: false } }, { status: 'error' }]) {
    assert.ok(validateJsonSchemaValue(schema, bad).length > 0)
  }
})
await test('canonical metadata accepts unavailable timestamps without weakening numeric fields', () => {
  for (const [tool, data] of [
    ['stat', { exists: true, modifiedMs: null, bytes: 2 }],
    ['glob', { complete: true, items: [{ path: 'a', bytes: 2, modified: null }] }],
  ]) {
    const schema = outcomeSchema(canonicalOutput(tool))
    assert.deepEqual(validateJsonSchemaValue(schema, { status: 'completed', data }), [])
    const invalid = tool === 'stat' ? { ...data, modifiedMs: 'not-a-time' }
      : { ...data, items: [{ ...data.items[0], modified: 'not-a-time' }] }
    assert.ok(validateJsonSchemaValue(schema, { status: 'completed', data: invalid }).length > 0)
  }
})
report('ptc-outcome')
