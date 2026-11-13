/** PTC declarations must follow the step admission, including loader-less scopes. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, test, report } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep } from './lib/executor.mjs'
import { mountPtc } from '../lib/publication/ptc.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

/** The ops_ members one assembly declares in tools:sdk, sorted. */
function declared(assembly) {
  const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
  return [...new Set([...sdk.matchAll(/^\s{2}(ops_[a-z_]+): \{/gm)].map(match => match[1]))].sort()
}

async function setup(gate) {
  const { ctx } = await bootHost({ withWorkingDirectory: true, toolsMode: 'ptc' })
  const agents = []
  ctx.provide('agents', { list: () => agents })
  await ctx.plugin(inner => {
    inner.provide('ptcRuntime', { language: 'typescript' })
    inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) })
    inner.provide('subprocess', { spawn() { throw new Error('declaration probe must never spawn') } })
  })
  mountPtc(ctx, { binaryPath: process.execPath, required: true }, { allows: () => true, ...gate })
  const agent = { id: 'surface', session: { id: 'surface', mode: 'danger-full-access', header: { cwd: process.cwd() }, append() {}, read() { return [] } } }
  agent.ctx = createScope(ctx, agent).ctx
  agents.push(agent)
  await ctx.serial('agent/created', { agent })
  await tick(); await tick()
  return { ctx, agent }
}

await test('a loader-less scope declares no selectable API even without a step tool set', async () => {
  const { ctx, agent } = await setup({ resident: false, dynamic: false })
  try {
    const step = await prepareStep(ctx, agent)
    const admitted = declared(step.assembly)
    step.dispose()
    // A host assembly that omits the step tool set reads every registered definition.
    // Nothing from the allowed pool may be registered when no loader can select it.
    assert.deepEqual(declared(await ctx.get('systemPrompt').assemble({ scope: agent })), [])
    assert.deepEqual(admitted, [])
  } finally { await shutdown(ctx) }
})
report('ptc-declaration-surface')
