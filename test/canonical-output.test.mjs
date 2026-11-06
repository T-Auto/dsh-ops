import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { assert, test, report } from './lib/harness.mjs'
import { canonicalOutput } from '../lib/projections/canonical-output.js'
import { toOutcome } from '../lib/projections/ptc/outcome.js'
import { definition as nativeDefinition } from '../lib/projections/native/contract.js'

const schema = { type: 'object', properties: {
  status: { type: 'string' }, complete: { type: 'boolean' },
  items: { type: 'array', items: { type: 'string' } },
  scanComplete: { type: 'boolean' }, scannedFiles: { type: 'integer' },
  matchedObserved: { type: 'integer' }, nextOffset: { type: 'integer' },
  error: { type: 'object' },
}, required: ['items'], additionalProperties: false }
const cases = [
  ['completed', { status: 'completed', complete: true, items: ['a'], scanComplete: true, scannedFiles: 2, matchedObserved: 1 }],
  ['partial', { status: 'partial', complete: false, items: ['a'], nextOffset: 2 }],
  ['rejected', { status: 'rejected', items: [], error: { code: 'POLICY_DENIED', message: 'Denied', effectState: 'none' } }],
  ['conflict', { status: 'conflict', items: [], error: { code: 'REVISION_CONFLICT', message: 'Changed', effectState: 'none' } }],
  ['error', { status: 'error', items: [], error: { code: 'INVALID_ARGUMENT', message: 'Bad input', effectState: 'none' } }],
  ['unknown', { status: 'error', items: [], error: { code: 'IO_ERROR', message: 'Unsettled', effectState: 'unknown' } }],
  ['error', { status: 'partial', complete: false, items: ['a'] }],
  ['unknown', null],
]
for (const [index, [status, raw]] of cases.entries()) {
  await test(`canonical adapter preserves receipt ${index}: ${status}`, async () => {
    const args = { offset: 1 }, exec = { signal: new AbortController().signal }
    let calls = 0
    const rendered = [], metadata = []
    const source = {
      name: 'fixture', description: 'fixture', parameters: { type: 'object', properties: {} },
      isConcurrencySafe: () => true,
      output: { schema,
        render(a, value) { assert.equal(a, args); rendered.push(value); return [{ type: 'text', text: 'Native receipt' }] },
        presentationMeta(a, value) { assert.equal(a, args); metadata.push(value); return { fixture: true } },
      },
      async execute(a, e) { calls++; assert.equal(a, args); assert.equal(e, exec); assert.equal(e.signal, exec.signal); return raw },
    }
    const tool = index === 6 ? 'glob' : 'inspect_local_file'
    const adapted = canonicalOutput(tool, source)
    assert.equal(adapted.parameters, source.parameters)
    assert.equal(adapted.isConcurrencySafe, source.isConcurrencySafe)
    const value = await adapted.execute(args, exec)
    assert.equal(value.status, status)
    assert.deepEqual(value, toOutcome(tool, args, raw))
    assert.deepEqual(validateJsonSchemaValue(adapted.output.schema, value), [])
    // Native replay must work after JSON transport, without a raw-result cache.
    const replay = JSON.parse(JSON.stringify(value))
    assert.deepEqual(adapted.output.render(args, replay), [{ type: 'text', text: 'Native receipt' }])
    adapted.output.presentationMeta(args, replay)
    const expected = raw ?? { status: 'unknown', error: value.error }
    assert.deepEqual(rendered, [expected]); assert.deepEqual(metadata, [expected])
    assert.equal(calls, 1, 'render and metadata never execute the kernel')
    if (status === 'partial') { assert.equal(value.coverage.isComplete, false); assert.match(value.continuation, /^ops-next-v1:/) }
    if (index === 0) assert.equal(value.coverage.isComplete, true)
    if (index === 5) { assert.equal(value.error.effectState, 'unknown'); assert.equal(value.error.retry, 'never') }
    if (index === 6) { assert.equal(value.error.code, 'RESULT_PARTIAL'); assert.deepEqual(value.data.items, ['a']) }
    if (index === 7) {
      const native = nativeDefinition('grep', async () => null)
      const text = canonicalOutput('grep', native).output.render(args, replay).map(b => b.text).join('\n')
      assert.match(text, /unknown: RESULT_UNKNOWN/)
      assert.match(text, /effectState=unknown; retry=never/)
      assert.match(text, /canonical object/)
    }
  })
}
await test('strict data schema still rejects invalid completed payloads', async () => {
  const source = nativeDefinition('grep', async () => ({ status: 'completed', complete: true, items: [42] }))
  source.output.schema = schema
  const adapted = canonicalOutput('grep', source)
  assert.ok(validateJsonSchemaValue(adapted.output.schema, await adapted.execute({}, {})).length > 0)
})
await test('raw content hooks retain execution identity without replacing canonical values', async () => {
  const raw = cases[0][1], exec = { token: {}, toolSet: {}, signal: new AbortController().signal }
  const seen = []
  const hook = (e, r) => { assert.equal(e, exec); assert.equal(r.value, raw); seen.push(r.content); return r.content }
  const source = { name: 'hooks', parameters: {}, output: { schema, render: () => [] },
    execute: async () => raw, projectContent: hook, finalizeContent: hook }
  const adapted = canonicalOutput('grep', source)
  const value = await adapted.execute({}, exec)
  const result = { value, content: [{ type: 'text', text: 'body' }], isError: false }
  adapted.projectContent(exec, result)
  adapted.finalizeContent(exec, result)
  assert.equal(result.value, value)
  assert.equal(value.data, raw)
  assert.deepEqual(seen, [result.content, result.content])
})
report('canonical-output')
