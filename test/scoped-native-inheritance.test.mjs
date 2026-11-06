/** Regression: an inactive scoped PTC definition must not erase inherited Native tools. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountPtc } from '../lib/publication/ptc.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, prepareStep, executeCall } from './lib/executor.mjs'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'

await test('Native child executes an inherited grep without exposing the parent PTC loader', async () => {
  const { ctx } = await bootHost()
  const steps = []
  try {
    // No worker is needed: this Native provider owns its implementation; PTC is admission-only.
    ctx.provide('subprocess', { spawn() { throw new Error('PTC worker must not execute in a Native child') } })
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: TEST_HOME }) })
    ctx.provide('ptcRuntime', { language: 'typescript' })
    await ctx.plugin({ apply(inner) {
      mountPtc(inner, { binaryPath: process.execPath, required: true }, { allows: () => true })
    } })
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    const mint = async (id, mode, parent) => {
      const agent = { id, session: { id, header: { cwd: TEST_HOME } } }
      agent.ctx = createScope(parent?.ctx ?? ctx, agent, parent ? { parent } : undefined).ctx
      await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
      await ctx.serial('agent/created', { agent })
      return agent
    }
    const parent = await mint('ptc-parent', 'ptc')
    const child = await mint('native-child', 'native', parent)
    const grep = publicToolName('grep'), loader = publicToolName('load_sdk')
    // Late ancestor registration reproduces the provider-restoration case without old presentAs APIs.
    await ctx.plugin({ inject: ['tools'], apply(inner) {
      inner.tools.register({
        name: grep, description: 'Inherited Native grep provider fixture.',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object', properties: { source: { type: 'string' } } },
          render: (_args, value) => [{ type: 'text', text: value.source }] },
        execute: async () => ({ source: 'ancestor-native-grep' }),
      })
    } })
    const step = await prepareStep(ctx, child); steps.push(step)
    const result = await executeCall(ctx, { agent: child, toolSet: step.toolSet,
      name: grep, arguments: {}, callId: 'inherited-grep' })
    const names = ctx.get('tools').definitions(child, step.toolSet).map(def => def.name)
    assert.deepEqual({ value: result.value, loaderVisible: names.includes(loader) },
      { value: { source: 'ancestor-native-grep' }, loaderVisible: false },
      'inactive PTC entries must not shadow the inherited Native provider')

    await parent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.restrict({ deny: [grep] }) } })
    const denied = await prepareStep(ctx, child); steps.push(denied)
    assert.equal(ctx.get('tools').executable(grep, child, denied.toolSet), undefined,
      'restoring Native inheritance must still honor ancestor deny')
  } finally {
    for (const step of steps) step.dispose()
    await shutdown(ctx)
  }
})
report('scoped-native-inheritance')
