/** PTC declarations must follow the step admission, including loader-less scopes. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, test, report, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep } from './lib/executor.mjs'
import { mountPtc } from '../lib/publication/ptc.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

/** The ops_ members one assembly declares in tools:sdk, sorted. */
function declared(assembly) {
  const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
  return [...new Set([...sdk.matchAll(/^\s{2}(ops_[a-z_]+): \{/gm)].map(match => match[1]))].sort()
}

async function setup(gate, ptc = {}, sandboxMode = 'danger-full-access') {
  const { ctx } = await bootHost({ withWorkingDirectory: true, toolsMode: 'ptc' })
  const agents = []
  ctx.provide('agents', { list: () => agents })
  await ctx.plugin(inner => {
    inner.provide('ptcRuntime', { language: 'typescript' })
    inner.provide('sandboxPolicy', { resolve: () => ({ mode: sandboxMode, workspaceRoot: process.cwd() }) })
    inner.provide('subprocess', { spawn() { throw new Error('declaration probe must never spawn') } })
  })
  mountPtc(ctx, { binaryPath: process.execPath, required: true, ...ptc }, { allows: () => true, ...gate })
  const agent = { id: 'surface', session: { id: 'surface', mode: sandboxMode, header: { cwd: process.cwd() }, append() {}, read() { return [] } } }
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

/** Poll the first-round SDK declaration until publication settles. */
async function declaredNow(ctx, agent) {
  const step = await prepareStep(ctx, agent)
  try { return declared(step.assembly) } finally { step.dispose() }
}

await test('an explicit full tier declares the whole permitted pool in the first round, loader-less', async () => {
  // D1 truth-table row T (#987): the declaration half of the dual verification;
  // the run_code binding half lives in the worker-backed ptc-full-disclosure suite.
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { disclosurePolicy: 'full', allowedTools: ['grep', 'stat'] })
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_grep'),
      { what: 'ops_grep declared in the first round', timeoutMs: 10_000 })
    const admitted = await declaredNow(ctx, agent)
    assert.deepEqual(admitted, ['ops_grep', 'ops_inspect_local_file', 'ops_result', 'ops_stat'])
    assert.equal(admitted.includes('ops_load_sdk'), false, 'the full tier publishes no loader (#979 §2)')
    assert.equal(admitted.includes('ops_glob'), false, 'a pool-outside business API stays undeclared')
  } finally { await shutdown(ctx) }
})

await test('read-only keeps mutating APIs out of the full-tier declaration', async () => {
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { disclosurePolicy: 'full', allowedTools: ['write_file', 'stat'] }, 'read-only')
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_stat'),
      { what: 'ops_stat declared under read-only', timeoutMs: 10_000 })
    assert.deepEqual(await declaredNow(ctx, agent), ['ops_inspect_local_file', 'ops_result', 'ops_stat'],
      'the mutating member of the cap is never declared')
  } finally { await shutdown(ctx) }
})

await test('an empty allowed pool declares only the resident surface plus result', async () => {
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { disclosurePolicy: 'full', allowedTools: [] })
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_result'),
      { what: 'ops_result declared over an empty pool', timeoutMs: 10_000 })
    const admitted = await declaredNow(ctx, agent)
    assert.deepEqual(admitted, ['ops_inspect_local_file', 'ops_result'], 'nothing else to publish, and still no loader')
    assert.equal(admitted.includes('ops_load_sdk'), false)
  } finally { await shutdown(ctx) }
})

await test('duplicate allowed names register exactly once in the full tier', async () => {
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { disclosurePolicy: 'full', allowedTools: ['stat', 'stat', 'grep'] })
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_grep'),
      { what: 'ops_grep declared', timeoutMs: 10_000 })
    const step = await prepareStep(ctx, agent)
    try {
      const registered = ctx.get('tools').definitions(agent, step.toolSet).map(tool => tool.name)
      assert.equal(registered.filter(name => name === 'ops_stat').length, 1, 'a duplicated name registers exactly once')
      assert.deepEqual(declared(step.assembly), ['ops_grep', 'ops_inspect_local_file', 'ops_result', 'ops_stat'])
    } finally { step.dispose() }
  } finally { await shutdown(ctx) }
})

report('ptc-declaration-surface')
