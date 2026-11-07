import fs from 'node:fs'
import path from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'
import { requireWorker } from './lib/boundary.mjs'
import { executeCall } from './lib/executor.mjs'
import { canonicalFixture } from './lib/canonical-file-runtime.mjs'
import { fixture, full, elided } from './lib/context-read.mjs'
import { publicToolName } from '../lib/policy.js'
requireWorker('canonical-file-runtime')

await test('real worker Native text and run_code share the canonical file outcome', async () => {
  const h = await canonicalFixture()
  const dir = fs.mkdtempSync(path.join(TEST_HOME, 'canonical-files-'))
  const file = path.join(dir, 'canonical-file.txt')
  try {
    fs.writeFileSync(file, 'canonical worker payload\n')
    fs.writeFileSync(path.join(dir, 'second-file.txt'), 'second worker payload\n')
    const parent = await h.agent('file-ptc', 'ptc')
    const child = await h.agent('file-native', 'native', parent)
    const p = await h.step(parent), c = await h.step(child)
    const args = { path: file }
    const native = await executeCall(h.ctx, { agent: child, toolSet: c.toolSet,
      callId: 'file-native', name: h.definition.name, arguments: args })
    assert.equal(native.isError, false, JSON.stringify(native))
    assert.equal(native.value.status, 'completed')
    assert.equal(native.value.data.items[0].text, 'canonical worker payload')
    assert.equal(native.value.items, undefined)
    assert.match(native.content.map(b => b.text ?? '').join('\n'), /1(?: \| |\|)canonical worker payload/)
    const ptc = await executeCall(h.ctx, { agent: parent, toolSet: p.toolSet, callId: 'file-ptc', name: 'run_code',
      arguments: { description: 'Read a real worker receipt',
        code: `return await tools.${h.definition.name}(${JSON.stringify(args)});` } })
    assert.equal(ptc.isError, false, JSON.stringify(ptc))
    assert.deepEqual(ptc.value.result, native.value)
    assert.deepEqual(validateJsonSchemaValue(h.definition.output.schema, native.value), [])
    const raw = await h.runtime.call('inspect_local_file', args, { agent: child, signal: new AbortController().signal })
    assert.equal(raw.items[0].text, 'canonical worker payload')
    assert.equal(raw.data, undefined, 'kernel-facing call stays raw')
    console.log('       Real worker Native and run_code:', native.value.status, native.value.data.items.length, 'rows')
    for (const [name, arguments_, expected] of [
      ['glob', { path: dir, pattern: ['**/*.txt'], limit: 1 }, 'partial'],
      ['inspect_local_file', { path: path.join(TEST_HOME, 'missing-file') }, 'error'],
      ['result', { action: 'page', id: 'ref://missing', root: TEST_HOME }, 'error'],
    ]) {
      const result = await executeCall(h.ctx, { agent: child, toolSet: c.toolSet, callId: `case-${name}`,
        name: publicToolName(name), arguments: arguments_ })
      assert.equal(result.value.status, expected, JSON.stringify(result))
      assert.deepEqual(validateJsonSchemaValue(h.runtime.definition(name).output.schema, result.value), [])
      if (expected === 'partial') {
        assert.equal(result.value.coverage.isComplete, false)
        assert.match(result.value.continuation, /^ops-next-v1:/)
        assert.equal(result.value.data.items.length, 1)
      }
      console.log('       Real worker branch:', name, result.value.status, result.value.error?.code ?? 'continuation')
    }
  } finally {
    try { await h.dispose() } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
})

await test('real read finalize keeps canonical data while deduplicating Native text', () => fixture(async ({ read, request }) => {
  const first = await read()
  full(first)
  await request()
  const repeat = await read()
  elided(repeat)
  assert.deepEqual(repeat.value, first.value)
  assert.equal(repeat.value.data.items.length, 30)
}))
report('canonical-file-runtime')
