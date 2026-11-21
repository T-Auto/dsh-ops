import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { jsonSchemaToTs } from '@deepseek-ai/dsh-tool-executor-ptc'
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
await test('partial pages recommend the same-path next page and a complete page recommends none', () => {
  const args = { path: '/tmp/p6/eleven.txt', offset: 1, limit: 5 }
  const partial = { status: 'partial', complete: false, nextOffset: 6, total: 11, items: [{ line: 5, text: 'line-5' }] }
  const page1 = toOutcome('inspect_local_file', args, structuredClone(partial))
  assert.equal(page1.status, 'partial')
  assert.match(page1.nextAction, /ops_inspect_local_file \{"path":"\/tmp\/p6\/eleven\.txt","offset":6,"limit":5\}/)
  assert.match(page1.nextAction, /complete=true/)
  assert.deepEqual(validateJsonSchemaValue(outcomeSchema(canonicalOutput('inspect_local_file')), page1), [])
  const page2 = toOutcome('inspect_local_file', { ...args, offset: 6 }, { ...structuredClone(partial), nextOffset: 11, items: [{ line: 10, text: 'line-10' }] })
  assert.match(page2.nextAction, /"offset":11/)
  const last = toOutcome('inspect_local_file', { ...args, offset: 11 }, { status: 'completed', complete: true, total: 11, items: [{ line: 11, text: 'line-11' }] })
  assert.equal(last.status, 'completed')
  assert.equal('nextAction' in last, false, 'a complete page is the stop signal, never another read')
})
await test('directory rejections recommend only listing APIs callable in this step', () => {
  const refused = () => ({ status: 'error', error: { code: 'INVALID_ARGUMENT', effectState: 'none',
    message: 'inspect_local_file: path is a directory; choose a file, or list directory entries with the shell',
    nextAction: 'Correct the request or inspect the manifest.' } })
  const surface = names => ({ callable: new Set(names), readOnly: false })
  const listed = toOutcome('inspect_local_file', { path: '/tmp/p6/adir' }, refused(), surface(['ops_inspect_local_file', 'ops_glob']))
  assert.equal(listed.status, 'error')
  assert.match(listed.error.nextAction, /ops_glob \{"path":"\/tmp\/p6\/adir","pattern":\["\*"\]\}/)
  assert.match(listed.error.nextAction, /concrete file path/)
  const unloaded = toOutcome('inspect_local_file', { path: '/tmp/p6/adir' }, refused(), surface(['ops_inspect_local_file']))
  assert.doesNotMatch(unloaded.error.nextAction, /ops_glob|ops_grep/)
  assert.match(unloaded.error.nextAction, /concrete file path/)
  const unknown = toOutcome('inspect_local_file', { path: '/tmp/p6/adir' }, refused())
  assert.doesNotMatch(unknown.error.nextAction, /ops_glob|ops_grep|shell/)
  assert.match(unknown.error.nextAction, /concrete file path/)
})
await test('invalid UTF-8 recommends a parameterized hex view the reader schema accepts', () => {
  const refused = () => ({ status: 'error', error: { code: 'ERR_INVALID_ENCODING', effectState: 'none',
    message: 'inspect_local_file: File is not valid UTF-8',
    nextAction: 'Use a dedicated document/binary reader, or inspect with view=hex; do not replace invalid bytes with lossy text.' } })
  const inspect = toOutcome('inspect_local_file', { path: '/tmp/p6/blob.bin' }, refused())
  assert.equal(inspect.status, 'error')
  assert.match(inspect.error.nextAction, /ops_inspect_local_file \{"path":"\/tmp\/p6\/blob\.bin","view":"hex"\}/)
  const items = () => ({ status: 'partial', complete: false, nextIndex: 1, failed: 1,
    items: [{ path: '/tmp/p6/blob.bin', error: { code: 'ERR_INVALID_ENCODING', effectState: 'none', message: 'File is not valid UTF-8' } }] })
  const pointed = toOutcome('read_files', { files: [{ path: '/tmp/p6/blob.bin' }] }, items(), { callable: new Set(['ops_read_files', 'ops_inspect_local_file']), readOnly: false })
  assert.equal(pointed.status, 'error')
  assert.match(pointed.error.nextAction, /ops_inspect_local_file \{"path":"\/tmp\/p6\/blob\.bin","view":"hex"\}/)
  const stranded = toOutcome('read_files', { files: [{ path: '/tmp/p6/blob.bin' }] }, items())
  assert.doesNotMatch(stranded.error.nextAction, /"view":"hex"/)
  assert.match(stranded.error.nextAction, /not valid UTF-8/)
})
await test('revision conflicts recommend the concrete fresh-revision read; read-only never re-submits', () => {
  const refused = () => ({ status: 'conflict', error: { code: 'REVISION_CONFLICT', effectState: 'none',
    message: 'edit_file: Revision differs from expectedRevision; nothing was changed. Inspect before retrying.',
    nextAction: 'Inspect the current revision before preparing a new request; do not blindly retry.' } })
  const args = { path: '/tmp/p6/editable.txt', expectedRevision: 'a'.repeat(64), edits: [{ oldText: 'alpha', newText: 'beta' }] }
  const writable = toOutcome('edit_file', args, refused(), { callable: new Set(['ops_edit_file', 'ops_stat']), readOnly: false })
  assert.equal(writable.status, 'conflict')
  assert.match(writable.error.nextAction, /ops_stat \{"path":"\/tmp\/p6\/editable\.txt"\}/)
  assert.match(writable.error.nextAction, /expectedRevision/)
  const unknown = toOutcome('edit_file', args, refused())
  assert.match(unknown.error.nextAction, /revision/)
  assert.doesNotMatch(unknown.error.nextAction, /do not blindly retry/)
  const fenced = toOutcome('edit_file', args, refused(), { callable: new Set(['ops_stat']), readOnly: true })
  assert.doesNotMatch(fenced.error.nextAction, /re-submit|retry/)
  assert.match(fenced.error.nextAction, /ops_stat \{"path":"\/tmp\/p6\/editable\.txt"\}/)
})
await test('read-only scopes never receive a write-class recommendation', () => {
  const readOnly = { callable: new Set(['ops_inspect_local_file', 'ops_glob', 'ops_stat', 'ops_read_files']), readOnly: true }
  const cases = [
    ['inspect_local_file', { path: '/tmp/p6/adir' }, { status: 'error', error: { code: 'INVALID_ARGUMENT', effectState: 'none', message: 'inspect_local_file: path is a directory; choose a file' } }],
    ['inspect_local_file', { path: '/tmp/p6/blob.bin' }, { status: 'error', error: { code: 'ERR_INVALID_ENCODING', effectState: 'none', message: 'inspect_local_file: File is not valid UTF-8' } }],
    ['edit_file', { path: '/tmp/p6/e', expectedRevision: 'a'.repeat(64), edits: [{ oldText: 'a', newText: 'b' }] }, { status: 'conflict', error: { code: 'REVISION_CONFLICT', effectState: 'none', message: 'edit_file: Revision differs' } }],
    ['inspect_local_file', { path: '/tmp/p6/f', offset: 1, limit: 5 }, { status: 'partial', complete: false, nextOffset: 6, items: [{ line: 5, text: 'x' }] }],
  ]
  const writes = ['ops_write_file', 'ops_edit_file', 'ops_copy', 'ops_move', 'ops_remove', 'ops_replace', 'ops_batch', 'ops_bash']
  for (const [tool, args, data] of cases) {
    const out = toOutcome(tool, args, structuredClone(data), readOnly)
    const text = (out.status === 'partial' ? out.nextAction : out.error.nextAction) ?? ''
    for (const name of writes) assert.ok(!text.includes(name), tool + ' recommended ' + name)
    assert.doesNotMatch(text, /re-submit|overwrite|unlink|delete/i)
  }
})
await test('after-input-change failures say what to change; other worker guidance is preserved', () => {
  const invalid = toOutcome('grep', { pattern: '[', path: '/tmp/p6' }, { status: 'error', error: { code: 'INVALID_ARGUMENT', effectState: 'none', message: 'grep: pattern is not a valid regex' } })
  assert.equal(invalid.status, 'error')
  assert.equal(invalid.error.retry, 'after-input-change')
  assert.match(invalid.error.nextAction, /identical request fails identically/)
  assert.doesNotMatch(invalid.error.nextAction, /retry the same|just retry/i)
  const advised = toOutcome('grep', { pattern: '[', path: '/tmp/p6' }, { status: 'error', error: { code: 'INVALID_ARGUMENT', effectState: 'none', message: 'grep: pattern is not a valid regex', nextAction: 'Correct the request or inspect the manifest.' } })
  assert.equal(advised.error.nextAction, 'Correct the request or inspect the manifest.')
  const kept = toOutcome('copy', { path: '/tmp/p6/s', to: '/tmp/p6/d', expectedRevision: 'a'.repeat(64) },
    { status: 'error', error: { code: 'CLEANUP_FAILED', effectState: 'unknown', message: 'Could not remove staging sibling x', nextAction: 'Inspect the staging sibling and target before retrying; unpublished bytes may remain.' } })
  assert.equal(kept.error.nextAction, 'Inspect the staging sibling and target before retrying; unpublished bytes may remain.')
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
