/** A real host hook that never answers must not serialize unrelated roots. */
import { createScope, scopeChainOf } from '@deepseek-ai/dsh-scope'
import * as ptc from '../lib/ptc/index.js'
import * as discovery from '../lib/discovery/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 2000) })]) }
  finally { clearTimeout(timer) }
}
function mint(ctx, id, parent) {
  const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd: TEST_HOME } } }
  agent.ctx = createScope(ctx, agent, parent ? { parent } : undefined).ctx
  return agent
}
for (const [mode, plugins] of [['native', [discovery]], ['ptc', [ptc]], ['native', [discovery, ptc]], ['ptc', [discovery, ptc]]]) await test(`unanswered ${mode} probe with ${plugins.length} component(s) does not block another root or unload (#359)`, async () => {
  const { ctx, tools, prompt } = await bootHost({ toolsMode: mode })
  const held = deferred(), entered = deferred()
  let blocker, blocked = true, components = [], creation
  try {
    await ctx.plugin(inner => {
      inner.provide('subprocess', { spawn() { throw new Error('publication test must not execute a worker') } })
      inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: TEST_HOME, sessionId: session.id }) })
      inner.provide('ptcRuntime', { language: 'typescript' })
    })
    // This is the public production waterfall, not a replaced assemble method.
    // It deliberately ignores the cancellation signal, like an uncooperative plugin.
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (blocked && context.scope === blocker && isPresentationProbe(context)) { entered.resolve(); await held.promise }
      return next()
    })
    for (const plugin of plugins) components.push(await ctx.plugin(plugin, { binaryPath: process.execPath, required: true }))
    blocker = mint(ctx, 'unanswered')
    creation = ctx.serial('agent/created', { agent: blocker })
    await bounded(entered.promise, 'the controlled host probe was not reached')
    const healthy = mint(ctx, 'healthy')
    await bounded(ctx.serial('agent/created', { agent: healthy }), 'one unanswered probe blocked an independent root')
    const ownName = mode === 'ptc' ? 'ops_load_sdk' : 'ops_discover_tools'
    assert.ok(tools.get(ownName, healthy), 'the unrelated root publishes its own capability')
    assert.equal(tools.get(ownName, blocker), undefined, 'an unanswered initial probe grants no capability')
    await bounded(prompt.assemble({ scope: healthy }), 'the unrelated root cannot assemble')
    const retained = tools.get(ownName, healthy)
    healthy.session.mode = 'unsupported'
    ctx.emit('session/event', healthy.session, { type: 'sandbox/mode' })
    await flush()
    await bounded(prompt.assemble({ scope: healthy }), 'authority reconciliation waits on the blocked root')
    if (mode === 'native') assert.equal(tools.get(ownName, healthy), undefined, 'authority downgrade withdraws Native publication')
    await bounded(ctx.serial('agent/disposed', { agent: healthy }), 'the unrelated root cannot dispose')
    const result = await bounded(retained.execute({}, { agent: healthy, signal: new AbortController().signal }), 'a retired callback waits on the blocked root')
    assert.equal(result.status, 'rejected')
    await bounded(ctx.serial('agent/disposed', { agent: blocker }), 'disposal must cancel its own unanswered probe wait')
    await bounded(creation, 'cancelled creation cannot settle')
    // A second hung creation is cancelled by component unload, not by its host hook.
    blocker = mint(ctx, 'unload-unanswered')
    creation = ctx.serial('agent/created', { agent: blocker })
    await flush()
    await bounded(Promise.all(components.map(component => component.dispose())), 'unload waits forever for a host hook')
    await bounded(creation, 'unloaded creation cannot settle')
    blocked = false; held.resolve(); await flush()
    assert.equal(tools.get(ownName, blocker), undefined, 'a late host result cannot publish after unload')
    assert.equal(tools.get(ownName, healthy), undefined)
  } finally { blocked = false; held.resolve(); await creation; await shutdown(ctx) }
})
for (const [mode, plugin, ownName] of [['native', discovery, 'ops_discover_tools'], ['ptc', ptc, 'ops_load_sdk']]) await test(`late ${mode} probe cannot overwrite a newer presentation`, async () => {
  const { ctx, tools, prompt } = await bootHost({ toolsMode: mode })
  const held = deferred(), entered = deferred()
  let first = true, agent, creation
  try {
    await ctx.plugin(inner => {
      inner.provide('subprocess', { spawn() { throw new Error('publication test must not execute a worker') } })
      inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: TEST_HOME }) })
      inner.provide('ptcRuntime', { language: 'typescript' })
    })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (first && context.scope === agent && isPresentationProbe(context)) {
        first = false; entered.resolve(); await held.promise
      }
      return result
    })
    await ctx.plugin(plugin, { binaryPath: process.execPath, required: true })
    agent = mint(ctx, 'changed-during-probe')
    creation = ctx.serial('agent/created', { agent })
    await bounded(entered.promise, 'the old probe did not capture its presentation')
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(mode === 'ptc' ? 'native' : 'ptc') } })
    // A real configuration notification cancels the old generation. The new
    // generation must complete without releasing the obsolete host response.
    ctx.emit('tools/change')
    await bounded(creation, 'new presentation still waits on the obsolete host response')
    await bounded(prompt.assemble({ scope: agent }), 'new presentation cannot settle')
    assert.equal(tools.get(ownName, agent), undefined)
    held.resolve(); await flush()
    assert.equal(tools.get(ownName, agent), undefined, 'the obsolete presentation must not republish its tools')
  } finally { held.resolve(); await creation; await shutdown(ctx) }
})
for (const [mode, plugin, ownName] of [['native', discovery, 'ops_discover_tools'], ['ptc', ptc, 'ops_load_sdk']]) await test(`cancelled ${mode} assembly cannot withdraw a newer publication`, async () => {
  const { ctx, tools, prompt } = await bootHost({ toolsMode: mode })
  const held = deferred(), entered = deferred()
  let agent, first = true
  try {
    await ctx.plugin(inner => {
      inner.provide('subprocess', { spawn() { throw new Error('publication test must not execute a worker') } })
      inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: TEST_HOME }) })
      inner.provide('ptcRuntime', { language: 'typescript' })
    })
    await ctx.plugin(plugin, { binaryPath: process.execPath, required: true })
    agent = mint(ctx, 'late-withdrawal')
    await ctx.serial('agent/created', { agent })
    await prompt.assemble({ scope: agent })
    assert.ok(tools.get(ownName, agent))
    // Install inside the component's withdrawal guard: its await next() must
    // reject obsolete authority as well as the reconciliation commit itself.
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (first && context.scope === agent && isPresentationProbe(context)) {
        first = false; entered.resolve(); await held.promise
      }
      return result
    })
    const switched = await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(mode === 'ptc' ? 'native' : 'ptc') } })
    await bounded(entered.promise, 'the old withdrawal was not reached')
    await switched.dispose()
    ctx.emit('tools/change')
    await bounded(prompt.assemble({ scope: agent }), 'restored presentation still waits on obsolete withdrawal')
    const restored = tools.get(ownName, agent)
    assert.ok(restored)
    held.resolve(); await flush()
    assert.equal(tools.get(ownName, agent), restored, 'the cancelled waterfall must not clear the current registration')
  } finally { held.resolve(); await shutdown(ctx) }
})
for (const [mode, plugin, ownName] of [['native', discovery, 'ops_discover_tools'], ['ptc', ptc, 'ops_load_sdk']]) await test(`${mode} inheritance family waits together without blocking another root`, async () => {
  const { ctx, tools, prompt } = await bootHost({ toolsMode: mode })
  let child, gate, creation
  const releases = []
  try {
    await ctx.plugin(inner => {
      inner.provide('subprocess', { spawn() { throw new Error('publication test must not execute a worker') } })
      inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: TEST_HOME }) })
      inner.provide('ptcRuntime', { language: 'typescript' })
    })
    await ctx.plugin(plugin, { binaryPath: process.execPath, required: true })
    const parent = mint(ctx, 'parent')
    await ctx.serial('agent/created', { agent: parent }); await prompt.assemble({ scope: parent })
    const previous = tools.get(ownName, parent)
    assert.ok(previous)
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (gate && context.scope === child && isPresentationProbe(context)) {
        const current = gate; current.entered.resolve(); await current.held.promise
      }
      return next()
    })
    const hold = () => { gate = { held: deferred(), entered: deferred() }; releases.push(gate.held.resolve); return gate }
    const first = hold()
    child = mint(parent.ctx, 'child', parent)
    assert.deepEqual(scopeChainOf(child), [child, parent], 'the production host sees the intended dependency')
    creation = ctx.serial('agent/created', { agent: child })
    await bounded(first.entered.promise, 'the child probe did not enter')
    let parentReady = false
    const waitingParent = prompt.assemble({ scope: parent }).then(() => { parentReady = true })
    const other = mint(ctx, 'independent')
    await bounded(ctx.serial('agent/created', { agent: other }), 'dependent family blocked independent creation')
    const independent = tools.get(ownName, other)
    assert.ok(independent)
    await flush()
    assert.equal(parentReady, false, 'a parent must await its dependent family publication')
    assert.equal(tools.get(ownName, parent), previous, 'the family has not partially republished')
    gate = undefined; first.held.resolve()
    await bounded(Promise.all([creation, waitingParent]), 'the released family did not commit')
    const childOwned = tools.get(ownName, child)
    assert.ok(childOwned)
    const second = hold()
    child.session.mode = 'read-only'
    ctx.emit('session/event', child.session, { type: 'sandbox/mode' })
    await bounded(second.entered.promise, 'the child revalidation did not enter')
    const retiringFamily = prompt.assemble({ scope: parent })
    await bounded(ctx.serial('agent/disposed', { agent: child }), 'child disposal did not cancel the dependent family wait')
    await bounded(retiringFamily, 'the surviving parent cannot settle after child disposal')
    const afterDisposal = tools.get(ownName, child)
    assert.notEqual(afterDisposal, childOwned, 'the disposed child loses its own definition')
    gate = undefined; second.held.resolve(); await flush()
    assert.equal(tools.get(ownName, child), afterDisposal, 'a late child response cannot resurrect owned tools')
    const denied = await childOwned.execute({}, { agent: child, signal: new AbortController().signal })
    assert.equal(denied.error.code, 'POLICY_DENIED', 'an inherited parent definition does not authorize a retired child')
    assert.ok(tools.get(ownName, parent))
    assert.equal(tools.get(ownName, other), independent, 'family cancellation preserves the unrelated root definition')
  } finally { gate = undefined; for (const release of releases) release(); await creation; await shutdown(ctx) }
})
for (const [mode, plugin, ownName] of [['native', discovery, 'ops_discover_tools'], ['ptc', ptc, 'ops_load_sdk']]) await test(`${mode} aborted fresh probes cannot consume selections or queue new ones`, async () => {
  const { ctx, tools, prompt } = await bootHost({ toolsMode: mode })
  let gate, agent
  const releases = []
  const step = signal => ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 1, signal }, async () => ({ kind: 'continue' }))
  const request = name => mode === 'ptc' ? { tools: [name] } : { query: 'select:ops_' + name }
  try {
    await ctx.plugin(inner => {
      inner.provide('subprocess', { spawn() { throw new Error('publication test must not execute a worker') } })
      inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: TEST_HOME }) })
      inner.provide('ptcRuntime', { language: 'typescript' })
    })
    await ctx.plugin(plugin, { binaryPath: process.execPath, required: true })
    agent = mint(ctx, 'abort-fresh')
    await ctx.serial('agent/created', { agent }); await prompt.assemble({ scope: agent })
    const entry = tools.get(ownName, agent)
    assert.equal((await entry.execute(request('stat'), { agent, signal: new AbortController().signal })).status, 'completed')
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (gate && context.scope === agent && isPresentationProbe(context)) {
        const current = gate
        assert.equal(context.signal, current.controller.signal, 'fresh probes forward the active turn/call signal')
        current.entered.resolve(); await current.held.promise
      }
      return next()
    })
    const hold = () => { gate = { held: deferred(), entered: deferred(), controller: new AbortController() }; releases.push(gate.held.resolve); return gate }
    const pendingStep = hold(), stepping = step(pendingStep.controller.signal)
    await bounded(pendingStep.entered.promise, 'the fresh step probe was not reached')
    pendingStep.controller.abort(); gate = undefined; pendingStep.held.resolve(); await stepping
    await prompt.assemble({ scope: agent })
    assert.equal(tools.get('ops_stat', agent), undefined, 'an aborted step does not publish a queued selection')
    await step(new AbortController().signal); await prompt.assemble({ scope: agent })
    assert.ok(tools.get('ops_stat', agent), 'the next valid step can consume the preserved selection')
    const pendingCall = hold(), calling = tools.get(ownName, agent).execute(request('grep'), { agent, signal: pendingCall.controller.signal })
    await bounded(pendingCall.entered.promise, 'the fresh call probe was not reached')
    pendingCall.controller.abort(); gate = undefined; pendingCall.held.resolve()
    assert.equal((await calling).error.code, 'POLICY_DENIED')
    await step(new AbortController().signal); await prompt.assemble({ scope: agent })
    assert.equal(tools.get('ops_grep', agent), undefined, 'an aborted call never queues a new selection')
  } finally { gate = undefined; for (const release of releases) release(); await shutdown(ctx) }
})
report('probe-isolation')
