/** Only final public probe verdicts survive until the next public change. */
import { Context } from '@deepseek-ai/cordis'
import { inspectPresentation, isNativePresentation, isPtcPresentation, observePresentation } from '../lib/publication/presentation.js'
import { assert, test, report } from './lib/harness.mjs'

function fixture() {
  const ctx = new Context(), scopes = [{ ptc: true }, { ptc: false }]
  let calls = 0, pause
  const prompt = { async assemble({ scope }) {
    calls++
    const result = { tools: [{ name: scope.ptc ? 'run_code' : 'native' }],
      sections: scope.ptc ? [{ name: 'tools:ptc-only', text: 'PTC' }] : [] }
    if (pause) { const wait = pause; pause = undefined; await wait }
    return result
  } }
  return { ctx, scopes, prompt, calls: () => calls, pause: promise => { pause = promise } }
}

await test('observed public probe verdicts eliminate repeated execution assemblies without crossing scopes', async () => {
  const f = fixture()
  try {
    observePresentation(f.ctx, f.prompt)
    for (const scope of f.scopes) await inspectPresentation(f.prompt, scope)
    assert.equal(f.calls(), 2)
    for (let i = 0; i < 10; i++) {
      assert.equal(await isPtcPresentation(f.prompt, f.scopes[0]), true)
      assert.equal(await isNativePresentation(f.prompt, f.scopes[1]), true)
    }
    assert.equal(f.calls(), 2)
    const aborted = AbortSignal.abort()
    assert.equal(await isPtcPresentation(f.prompt, f.scopes[0], aborted), false)
    assert.equal(f.calls(), 2)
    f.scopes[0].ptc = false
    f.ctx.emit('system-prompt/change')
    assert.equal(await isPtcPresentation(f.prompt, f.scopes[0]), false)
    assert.equal(f.calls(), 3)
    f.ctx.emit('tools/change')
    assert.equal(await isNativePresentation(f.prompt, f.scopes[0]), true)
    assert.equal(f.calls(), 4)
  } finally { await f.ctx.fiber.dispose() }
})

await test('unobserved or disposed owners fall back to fresh public probes', async () => {
  const f = fixture()
  assert.equal(await isPtcPresentation(f.prompt, f.scopes[0]), true)
  f.scopes[0].ptc = false
  assert.equal(await isPtcPresentation(f.prompt, f.scopes[0]), false)
  assert.equal(f.calls(), 2)
  observePresentation(f.ctx, f.prompt)
  assert.equal(await isNativePresentation(f.prompt, f.scopes[0]), true)
  await f.ctx.fiber.dispose()
  f.scopes[0].ptc = true
  assert.equal(await isPtcPresentation(f.prompt, f.scopes[0]), true)
  assert.equal(f.calls(), 4)
})

await test('a probe crossing invalidation cannot authorize execution or overwrite the current verdict', async () => {
  const f = fixture()
  try {
    observePresentation(f.ctx, f.prompt)
    const gate = Promise.withResolvers()
    f.pause(gate.promise)
    const obsolete = isPtcPresentation(f.prompt, f.scopes[0])
    f.scopes[0].ptc = false
    f.ctx.emit('system-prompt/change')
    assert.equal(await isNativePresentation(f.prompt, f.scopes[0]), true)
    gate.resolve()
    assert.equal(await obsolete, false)
    assert.equal(await isPtcPresentation(f.prompt, f.scopes[0]), false)
    assert.equal(f.calls(), 2)
  } finally { await f.ctx.fiber.dispose() }
})
report('presentation-cache')
