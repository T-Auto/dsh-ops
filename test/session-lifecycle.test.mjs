import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { mountSessionBash } from '../lib/session-shells.js'
import * as ptcModule from '../lib/ptc/index.js'
import * as discoveryModule from '../lib/discovery/index.js'
import { mountReplacements } from '../lib/publication/replacements.js'
import { NativeFileTools } from '../lib/file/runtime.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, waitFor, TEST_HOME } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { legacyComponent } from './lib/legacy-component.mjs'
const ptc = legacyComponent(ptcModule)
const discovery = legacyComponent(discoveryModule)
requireWorker('session-lifecycle')

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)) }
async function setup() {
  const host = await bootHost()
  const agents = []
  host.ctx.provide('agents', { list: () => agents })
  host.agents = agents
  await host.ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('publication tests must not execute') } })
    inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: TEST_HOME }) })
    inner.provide('ptcRuntime', { language: 'typescript' })
  })
  return host
}
function mint(ctx, id, mode = 'danger-full-access') {
  const agent = { id, session: { id, mode, header: { cwd: TEST_HOME } } }
  agent.ctx = createScope(ctx, agent).ctx
  return agent
}

await test('Bash publication and disposal leave the real SessionStore append boundary (#386)', async () => {
  const { ctx, tools, prompt } = await setup()
  await ctx.plugin(SessionStore)
  const warnings = []
  ctx.logger.warn = message => { warnings.push(String(message)) }
  try {
    const component = await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
      mountSessionBash(inner, { publishBashTool: true }, { bash: { available: true, file: process.execPath, source: 'explicit' } })
    } })
    const session = ctx.get('sessions').create('append-window', { meta: { cwd: TEST_HOME } })
    session.mode = 'danger-full-access'
    const agent = { id: session.id, session }
    agent.ctx = createScope(ctx, agent).ctx
    let creation, disposal, writes = 0, retire = false, observer
    // A real registry notification appends a valid session event, as host
    // observers can. No register method or SessionStore guard is replaced.
    ctx.on('tools/change', () => { session.append('turn/start', { turn: ++writes }) })
    ctx.on('session/event', (seen, event) => {
      if (seen !== session || event.type !== 'sandbox/mode') return
      assert.throws(() => session.append('turn/start', { turn: 99 }), /append cannot reenter/)
      if (!creation) creation = ctx.serial('agent/created', { agent })
      if (retire) disposal = ctx.serial('agent/disposed', { agent })
      // Asynchronous observers may outlive publication; the actual host releases
      // its synchronous guard without awaiting them.
      observer = new Promise(resolve => setImmediate(resolve))
      return observer
    })
    session.append('sandbox/mode', { mode: session.mode })
    await creation
    const retained = tools.get('ops_bash', agent)
    assert.ok(retained, 'awaited agent creation includes deferred publication')
    assert.equal(writes, 1, 'the real registry change appends only after the outer mode event completes')
    session.mode = 'read-only'
    session.append('sandbox/mode', { mode: session.mode })
    const denied = await retained.execute({ command: 'must not run', description: 'Check deferred withdrawal' }, { agent, signal: new AbortController().signal })
    assert.equal(denied.status, 'failed', 'retained callbacks observe revoked authority before deferred cleanup')
    assert.match(denied.error, /AUTHORITY_CHANGED|EXECUTOR_UNAVAILABLE/)
    await flush()
    assert.equal(tools.get('ops_bash', agent), undefined)
    session.mode = 'danger-full-access'
    session.append('sandbox/mode', { mode: session.mode })
    await flush()
    const first = await prepareStep(ctx, agent)
    try { assert.ok(first.assembly.tools.some(tool => tool.name === 'ops_bash'), 'the next resolved step includes deferred publication') } finally { first.dispose() }
    retire = true
    session.append('sandbox/mode', { mode: session.mode })
    await disposal; await observer; await flush()
    assert.equal(tools.get('ops_bash', agent), undefined, 'disposal requested by an append observer also defers writes')
    assert.deepEqual(warnings, [], 'the host reports no contained reentry or lifecycle failure')
    const waiting = mint(ctx, 'unload-before-publication')
    const created = ctx.serial('agent/created', { agent: waiting })
    await component.dispose(); await created; await flush()
    assert.equal(tools.get('ops_bash', waiting), undefined, 'unload cancels publication queued by creation')
  } finally { await shutdown(ctx) }
})

await test('PTC presentation waterfall accepts sections without pre-attached tools (#387)', async () => {
  const { ctx, tools, prompt, agents } = await setup()
  try {
    await ctx.plugin(ptc, { binaryPath: WORKER, required: true })
    const agent = mint(ctx, 'presentation-only')
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'ptc') } })
    agents.push(agent)
    await ctx.serial('agent/created', { agent }); await flush()
    await waitFor(async () => { const step = await prepareStep(ctx, agent); try { return Boolean(tools.executable('ops_load_sdk', agent, step.toolSet)) } finally { step.dispose() } })
    await prompt.assemble({ scope: agent }); await flush()
    const step = await prepareStep(ctx, agent)
    const before = tools.executable('ops_load_sdk', agent, step.toolSet)
    assert.ok(before)
    const assembly = step.assembly
    const { tools: wire, ...presentation } = assembly
    assert.deepEqual(wire.map(tool => tool.name), ['run_code'])
    // rc.3 runs this public waterfall with PromptPresentation, then attaches
    // the authoritative tools snapshot after all listeners have returned.
    const result = await ctx.waterfall('system-prompt/assemble', presentation, { scope: agent }, async () => presentation)
    assert.equal(result, presentation)
    assert.equal(Object.hasOwn(result, 'tools'), false)
    const captured = await ctx.waterfall('system-prompt/assemble', presentation, { scope: agent, toolSet: step.toolSet }, async () => presentation)
    assert.equal(captured, presentation, 'an unchanged admitted guidance section preserves exact provider identity')
    const unrelated = { sections: [{ name: 'unrelated-provider', text: 'unchanged' }] }
    assert.equal(await ctx.waterfall('system-prompt/assemble', unrelated, { scope: agent }, async () => unrelated), unrelated, 'absence of own guidance preserves exact presentation identity')
    assert.equal(tools.get('ops_load_sdk', agent), before, 'a valid PTC projection is retained')
    try {
      const selected = await before.execute({ tools: ['stat'] }, { agent, toolSet: step.toolSet, signal: new AbortController().signal })
      assert.equal(selected.status, 'completed')
    } finally { step.dispose() }
  } finally { await shutdown(ctx) }
})
await test('delayed discovery keeps the official available until the replacement is admitted (#375)', async () => {
  const { ctx, agents } = await setup()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const original = NativeFileTools.prototype.start
  NativeFileTools.prototype.start = async function (...args) {
    entered.resolve(); await release.promise
    return original.apply(this, args)
  }
  let created
  try {
    ctx.tools.register({ name: 'read', description: 'official read', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'official' })
    await ctx.plugin({ apply(inner) { mountReplacements(inner, { id: 'delayed',
      targets: new Map([['read', 'ops_inspect_local_file']]), gate: { allows: () => true }, keepOfficial: () => false }) } })
    await ctx.plugin(discovery, { binaryPath: WORKER, required: true, enabled: false,
      allowedTools: ['inspect_local_file'], alwaysLoaded: ['inspect_local_file'] })
    const agent = mint(ctx, 'cold-start')
    agents.push(agent)
    created = ctx.serial('agent/created', { agent })
    await entered.promise
    const pending = await prepareStep(ctx, agent)
    try {
      assert.deepEqual(pending.assembly.tools.map(tool => tool.name), ['read'])
      const official = await executeCall(ctx, { agent, name: 'read', arguments: {}, toolSet: pending.toolSet })
      assert.equal(official.value, 'official', 'pending OPS startup cannot disable both tools')
      release.resolve(); await created
      await waitFor(async () => {
        const step = await prepareStep(ctx, agent)
        try { return Boolean(ctx.get('tools').executable('ops_inspect_local_file', agent, step.toolSet)) }
        finally { step.dispose() }
      })
      const first = await prepareStep(ctx, agent)
      try {
        assert.ok(first.assembly.tools.some(tool => tool.name === 'ops_inspect_local_file'))
        assert.equal(first.assembly.tools.some(tool => tool.name === 'read'), false, 'same-step replacement excludes the official declaration')
        const absent = await executeCall(ctx, { agent, name: 'read', arguments: {}, toolSet: first.toolSet })
        assert.equal(absent.error.info.code, 'UNKNOWN_TOOL', 'the official is absent, not refused by a replacement guard')
        assert.equal((await executeCall(ctx, { agent, name: 'read', arguments: {}, toolSet: pending.toolSet })).value,
          'official', 'a held official-only step never gains a retroactive replacement guard')
      } finally { first.dispose() }
    } finally { pending.dispose() }
  } finally {
    release.resolve(); NativeFileTools.prototype.start = original
    await Promise.allSettled([created]); await shutdown(ctx)
  }
})
report('session-lifecycle')
