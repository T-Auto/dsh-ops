/** Mode probes use public executor presentation once per resolve, never private modeFor. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountPtc } from '../lib/publication/ptc.js'
import { isPresentationProbe } from '../lib/publication/presentation.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, prepareStep } from './lib/executor.mjs'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'
async function setup() {
  const { ctx, tools, prompt } = await bootHost()
  ctx.provide('subprocess', { spawn() { throw new Error('mode admission never executes workers') } })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: TEST_HOME }) })
  ctx.provide('ptcRuntime', { language: 'typescript' })
  await ctx.plugin({ apply(inner) { mountPtc(inner, { binaryPath: process.execPath, required: true, alwaysLoaded: ['result'] }, { allows: () => true }) } })
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
  const agent = { id: 'probe', session: { id: 'probe', header: { cwd: TEST_HOME } } }
  agent.ctx = createScope(ctx, agent).ctx
  await ctx.serial('agent/created', { agent })
  const assemble = prompt.assemble.bind(prompt)
  let probes = 0
  prompt.assemble = context => { if (isPresentationProbe(context)) probes++; return assemble(context) }
  return { ctx, tools, prompt, agent, probes: () => probes }
}
await test('unattributed registry notifications do not assemble or replace stable definitions', async () => {
  const h = await setup()
  try {
    const before = h.tools.get('ops_result', h.agent)
    for (let i = 0; i < 4; i++) h.ctx.emit('tools/change')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.probes(), 0)
    assert.equal(h.tools.get('ops_result', h.agent), before)
  } finally { await shutdown(h.ctx) }
})
await test('one shared public probe per resolve selects PTC and withdrawal does not fall through', async () => {
  const h = await setup()
  try {
    const native = await prepareStep(h.ctx, h.agent)
    assert.equal(h.tools.executable('ops_result', h.agent, native.toolSet), undefined)
    assert.equal(h.probes(), 1)
    native.dispose()
    const fiber = await h.agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'ptc') } })
    const next = await prepareStep(h.ctx, h.agent)
    assert.ok(h.tools.executable('ops_result', h.agent, next.toolSet))
    assert.equal(h.probes(), 2)
    next.dispose()
    await fiber.dispose()
    await assert.rejects(prepareStep(h.ctx, h.agent), error => {
      assert.match(String(error.cause ?? error), /executor.*unavailable/i)
      return true
    })
  } finally { await shutdown(h.ctx) }
})
report('ptc-native-precheck')
