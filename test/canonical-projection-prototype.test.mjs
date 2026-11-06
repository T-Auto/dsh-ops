/** Prototype evidence, not a production OPS contract migration. */
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { assert, test, report } from './lib/harness.mjs'
import { executeCall } from './lib/executor.mjs'
import { canonicalFixture } from './lib/canonical-projection-prototype.mjs'

async function invoke(h, agent, step, ptc = false) {
  return executeCall(h.ctx, { agent, toolSet: step.toolSet, callId: 'canonical-probe',
    name: ptc ? 'run_code' : h.definition.name,
    arguments: ptc ? { description: 'Read canonical fixture outcome',
      code: `const value = await tools.${h.definition.name}({}); if (value.status !== 'completed' || value.data.items[0].line !== 1) throw new Error('Not a typed Outcome'); return value;` } : {} })
}

await test('one ancestor identity renders Native text and real run_code returns typed Outcome', async () => {
  const h = await canonicalFixture()
  try {
    const parent = await h.agent('ptc-parent', 'ptc')
    const child = await h.agent('native-child', 'native', parent)
    const p = await h.step(parent), c = await h.step(child)
    const inherited = h.tools.executable(h.definition.name, parent, p.toolSet)
    assert.equal(h.tools.executable(h.definition.name, child, c.toolSet), inherited,
      'both executors must inherit the same registration object')
    const native = await invoke(h, child, c)
    assert.equal(native.isError, false, JSON.stringify(native))
    assert.deepEqual(native.value, { status: 'completed', data: h.raw })
    assert.equal(native.value.items, undefined, 'Native structured value now nests raw items in data')
    assert.match(native.content.map(b => b.text ?? '').join('\n'), /fixture\.txt.*1.*canonical fixture/)
    assert.ok(!native.content.some(b => b.text?.includes('"status"')), 'Native content is not Outcome JSON')
    const ptc = await invoke(h, parent, p, true)
    assert.equal(ptc.isError, false, JSON.stringify(ptc))
    assert.deepEqual(ptc.value.result, native.value)
    assert.deepEqual(validateJsonSchemaValue(h.schema, ptc.value.result), [])
    assert.equal(h.calls(), 2)
    console.log('       Native content:', JSON.stringify(native.content))
    console.log('       Native value / PTC program result:', JSON.stringify(native.value))

    await parent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.restrict({ deny: [h.definition.name] }) } })
    const deniedParent = await h.step(parent), deniedChild = await h.step(child)
    assert.equal(h.tools.executable(h.definition.name, child, deniedChild.toolSet), undefined)
    const deniedNative = await invoke(h, child, deniedChild)
    assert.equal(deniedNative.isError, true)
    const deniedPtc = await invoke(h, parent, deniedParent, true)
    assert.equal(deniedPtc.isError, true)
    assert.equal(h.calls(), 2, 'ancestor deny blocks both execution paths')
  } finally { await h.dispose() }
})

await test('source disposal revokes both previously captured executor toolSets', async () => {
  const h = await canonicalFixture()
  try {
    const parent = await h.agent('disposal-parent', 'ptc')
    const child = await h.agent('disposal-child', 'native', parent)
    const p = await h.step(parent), c = await h.step(child)
    assert.ok(h.tools.executable(h.definition.name, child, c.toolSet))
    await h.source.dispose()
    const native = await invoke(h, child, c)
    const ptc = await invoke(h, parent, p, true)
    assert.equal(native.isError, true, JSON.stringify(native))
    assert.equal(ptc.isError, true, JSON.stringify(ptc))
    assert.equal(h.calls(), 0, 'captured toolSets cannot revive disposed implementations')
  } finally { await h.dispose() }
})
report('canonical-projection-prototype')
