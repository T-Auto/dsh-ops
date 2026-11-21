/** Presentation probes must resolve the same agent variables as a provider assembly. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { activationIsPtc, inspectPresentation, isNativePresentation, isPresentationProbe } from '../lib/presentation.js'
import { selectExecutor } from './lib/executor.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

async function fixture(cwd, mode = 'native') {
  const { ctx, prompt } = await bootHost()
  ctx.provide('ptcRuntime', { language: 'typescript' })
  const agent = { id: 'presentation-context', options: { model: 'probe-model', provider: 'probe-provider', cwd } }
  await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
    agent.ctx = createScope(inner, agent).ctx
    selectExecutor(agent.ctx, mode)
  } })
  for (const name of ['model', 'provider', 'cwd']) prompt.variable(name, context => context.agent?.options[name])
  agent.ctx.get('systemPrompt').section({ name: 'deployment:persona-prefix', order: 0, text: '{{model}} / {{provider}} / {{cwd}}' })
  return { ctx, prompt, agent }
}

await test('inspection resolves agent variables and preserves probe identity and signal', () => withTempDir('presentation-context', async cwd => {
  const { ctx, prompt, agent } = await fixture(cwd)
  try {
    const signal = new AbortController().signal
    let observed
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      observed = context
      assert.equal(isPresentationProbe(context), true)
      return next()
    })
    const assembly = await inspectPresentation(prompt, agent, signal)
    assert.ok(renderPrompt(assembly).includes('probe-model / probe-provider'))
    assert.equal(assembly.variables.cwd, cwd)
    assert.equal(observed.agent, agent)
    assert.equal(observed.scope, agent)
    assert.equal(observed.signal, signal)
    assert.equal(isPresentationProbe(observed), false, 'the completed probe loses its exemption')
  } finally { await shutdown(ctx) }
}))

for (const mode of ['native', 'ptc']) await test(`${mode} detection supports persona interpolation during assembly`, () => withTempDir('presentation-mode', async cwd => {
  const { ctx, prompt, agent } = await fixture(cwd, mode)
  try {
    let probes = 0
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      if (isPresentationProbe(context)) {
        probes += 1
        assert.ok(renderPrompt(assembly).includes('probe-model / probe-provider'))
        assert.equal(assembly.variables.cwd, cwd)
      }
      return next()
    })
    const signal = new AbortController().signal
    assert.equal(await isNativePresentation(prompt, agent, signal), mode === 'native')
    const activation = { agent, signal }
    assert.equal(await activationIsPtc(prompt, activation), mode === 'ptc')
    assert.equal(await activationIsPtc(prompt, activation), mode === 'ptc')
    assert.equal(probes, 2, 'one Native probe and one cached activation probe')
  } finally { await shutdown(ctx) }
}))

await test('failed inspection retires probe identity and preserves the original error', () => withTempDir('presentation-failure', async cwd => {
  const { ctx, prompt, agent } = await fixture(cwd)
  try {
    const failure = new Error('provider failed')
    let observed
    ctx.on('system-prompt/assemble', async (_assembly, context) => {
      observed = context
      assert.equal(context.agent, agent)
      assert.equal(isPresentationProbe(context), true)
      throw failure
    })
    await assert.rejects(inspectPresentation(prompt, agent), error => error === failure)
    assert.equal(isPresentationProbe(observed), false)
  } finally { await shutdown(ctx) }
}))

report('presentation-context')
