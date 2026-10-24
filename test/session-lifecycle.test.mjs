import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { mountSessionBash } from '../lib/session-shells.js'
import * as ptc from '../lib/ptc/index.js'
import * as discovery from '../lib/discovery/index.js'
import * as hiding from '../lib/official-tool-hiding.js'
import { NativeFileTools } from '../lib/file/runtime.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)) }
async function setup() {
  const host = await bootHost()
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
    const component = await ctx.plugin({ inject: ['tools'], apply(inner) {
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
    const first = await prompt.assemble({ scope: agent })
    assert.ok(first.tools.some(tool => tool.name === 'ops_bash'), 'the first assembly waits and rebuilds its pre-hook snapshot')
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
  const { ctx, tools, prompt } = await setup()
  try {
    await ctx.plugin(ptc, { binaryPath: process.execPath, required: true })
    const agent = mint(ctx, 'presentation-only')
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('ptc') } })
    await ctx.serial('agent/created', { agent }); await flush()
    await prompt.assemble({ scope: agent }); await flush()
    const before = tools.get('ops_load_sdk', agent)
    assert.ok(before)
    const assembly = await prompt.assemble({ scope: agent })
    const { tools: wire, ...presentation } = assembly
    assert.deepEqual(wire.map(tool => tool.name), ['run_code'])
    // rc.3 runs this public waterfall with PromptPresentation, then attaches
    // the authoritative tools snapshot after all listeners have returned.
    const result = await ctx.waterfall('system-prompt/assemble', presentation, { scope: agent }, async () => presentation)
    assert.equal(result, presentation)
    assert.equal(Object.hasOwn(result, 'tools'), false)
    assert.equal(tools.get('ops_load_sdk', agent), before, 'a valid PTC projection is retained')
    const selected = await before.execute({ tools: ['stat'] }, { agent, signal: new AbortController().signal })
    assert.equal(selected.status, 'completed')
  } finally { await shutdown(ctx) }
})
await test('first prompt waits for delayed discovery before selected replacement validation (#375)', async () => {
  const { ctx, prompt } = await setup()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const original = NativeFileTools.prototype.start
  NativeFileTools.prototype.start = async function (...args) {
    entered.resolve(); await release.promise
    return original.apply(this, args)
  }
  let created, assembling
  try {
    ctx.tools.register({ name: 'read', description: 'official read', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'unused' })
    await ctx.plugin(hiding, { replaceTools: ['read'] })
    await ctx.plugin(discovery, { binaryPath: process.execPath, required: true, enabled: false,
      allowedTools: ['inspect_local_file'], alwaysLoaded: ['inspect_local_file'] })
    const agent = mint(ctx, 'cold-start')
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    created = ctx.serial('agent/created', { agent })
    await entered.promise
    let settled = false
    assembling = prompt.assemble({ scope: agent }).finally(() => { settled = true })
    void assembling.catch(() => {}) // Awaited below; keep an early rejection owned while checking the pending state.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'the first prompt cannot treat pending publication as bad configuration')
    release.resolve()
    await created
    const first = await assembling
    assert.deepEqual(first.tools.map(tool => tool.name), ['ops_inspect_local_file'])
  } finally {
    release.resolve(); NativeFileTools.prototype.start = original
    await Promise.allSettled([created, assembling]); await shutdown(ctx)
  }
})
report('session-lifecycle')
