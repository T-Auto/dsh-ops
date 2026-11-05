/** Conditional admission is read-only and independent across concurrent host resolves. */
import { createScope, scopeChainOf } from '@deepseek-ai/dsh-scope'
import * as ptcModule from '../lib/ptc/index.js'
import * as discoveryModule from '../lib/discovery/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, prepareStep } from './lib/executor.mjs'
import { assert, test, report, TEST_HOME, waitFor } from './lib/harness.mjs'
import { legacyComponent } from './lib/legacy-component.mjs'
const ptc = legacyComponent(ptcModule), discovery = legacyComponent(discoveryModule)
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 2000) })]) }
  finally { clearTimeout(timer) }
}
function mint(ctx, id, parent) {
  const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd: TEST_HOME } } }
  agent.ctx = createScope(parent?.ctx ?? ctx, agent, parent ? { parent } : undefined).ctx
  return agent
}
async function services(ctx) {
  await ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('admission test must not execute a worker') } })
    inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: TEST_HOME, sessionId: session.id }) })
    inner.provide('ptcRuntime', { language: 'typescript' })
  })
}
async function names(ctx, agent) {
  const captured = await prepareStep(ctx, agent)
  try { return ctx.tools.schemas(agent, captured.toolSet).map(tool => tool.name) } finally { captured.dispose() }
}
const resolve = (ctx, agent, signal = new AbortController().signal) => ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'fixture', model: 'scripted' } })
for (const [mode, plugins] of [['native', [discovery]], ['ptc', [ptc]], ['native', [discovery, ptc]], ['ptc', [discovery, ptc]]]) await test(`unanswered ${mode} resolve with ${plugins.length} component(s) leaves unrelated roots and teardown independent`, async () => {
  const { ctx } = await bootHost({ toolsMode: mode })
  const held = deferred(), entered = deferred(), controller = new AbortController()
  let blocker, resolving, blocked = true
  try {
    await services(ctx)
    const components = []
    for (const plugin of plugins) components.push(await ctx.plugin(plugin, { binaryPath: process.execPath, required: true }))
    await flush()
    blocker = mint(ctx, 'unanswered')
    await bounded(ctx.serial('agent/created', { agent: blocker }), 'creation must not probe presentation')
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (blocked && context.scope === blocker && isPresentationProbe(context)) { entered.resolve(); await held.promise }
      return next()
    })
    resolving = resolve(ctx, blocker, controller.signal)
    const rejected = assert.rejects(resolving, /cancelled|abort/i)
    await bounded(entered.promise, 'the controlled admission probe was not reached')
    const healthy = mint(ctx, 'healthy')
    await bounded(ctx.serial('agent/created', { agent: healthy }), 'one unanswered resolve blocked independent creation')
    const ownName = mode === 'ptc' ? 'ops_load_sdk' : 'ops_discover_tools'
    assert.ok((await bounded(names(ctx, healthy), 'independent resolve blocked')).includes(ownName))
    const retained = ctx.tools.get(ownName, healthy)
    healthy.session.mode = 'unsupported'
    await ctx.serial('session/event', healthy.session, { type: 'sandbox/mode' })
    assert.equal((await bounded(names(ctx, healthy), 'authority reconciliation blocked')).includes(ownName), false)
    await bounded(ctx.serial('agent/disposed', { agent: healthy }), 'independent disposal blocked')
    assert.equal((await retained.execute({}, { agent: healthy, signal: new AbortController().signal })).status, 'rejected')
    await bounded(ctx.serial('agent/disposed', { agent: blocker }), 'disposal waited for a foreign prompt handler')
    await bounded(Promise.all(components.map(component => component.dispose())), 'unload waited for a foreign prompt handler')
    controller.abort(new Error('cancelled resolve')); blocked = false; held.resolve()
    await rejected; await flush()
    assert.equal(ctx.tools.get(ownName, blocker), undefined, 'late admission cannot resurrect an unloaded registration')
  } finally { controller.abort(); blocked = false; held.resolve(); await resolving?.catch(() => {}); await shutdown(ctx) }
})
for (const [mode, plugin, ownName] of [['native', discovery, 'ops_discover_tools'], ['ptc', ptc, 'ops_load_sdk']]) await test(`late ${mode} admission cannot overwrite a fresh executor selection`, async () => {
  const { ctx } = await bootHost({ toolsMode: mode })
  const held = deferred(), entered = deferred()
  let agent, first = true, old
  try {
    await services(ctx); await ctx.plugin(plugin, { binaryPath: process.execPath, required: true })
    await flush()
    agent = mint(ctx, 'changed-during-resolve'); await ctx.serial('agent/created', { agent })
    const definition = ctx.tools.get(ownName, agent)
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (first && context.scope === agent && isPresentationProbe(context)) { first = false; entered.resolve(); await held.promise }
      return result
    })
    old = resolve(ctx, agent)
    await bounded(entered.promise, 'the old admission did not enter')
    let lift
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { lift = selectExecutor(inner, mode === 'ptc' ? 'native' : 'ptc') } })
    assert.equal((await bounded(names(ctx, agent), 'fresh admission waited on an obsolete response')).includes(ownName), false)
    held.resolve(); (await old).dispose(); await flush()
    assert.equal((await names(ctx, agent)).includes(ownName), false)
    assert.equal(ctx.tools.get(ownName, agent), definition, 'read-only admission never republishes stable definitions')
    lift()
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
    assert.ok((await names(ctx, agent)).includes(ownName))
  } finally { held.resolve(); (await old)?.dispose(); await shutdown(ctx) }
})
for (const [mode, plugin, ownName] of [['native', discovery, 'ops_discover_tools'], ['ptc', ptc, 'ops_load_sdk']]) await test(`cancelled ${mode} admission cannot withdraw newer authorization`, async () => {
  const { ctx } = await bootHost({ toolsMode: mode })
  const held = deferred(), entered = deferred(), controller = new AbortController()
  let first = true, pending
  try {
    await services(ctx); await ctx.plugin(plugin, { binaryPath: process.execPath, required: true })
    await flush()
    const agent = mint(ctx, 'late-withdrawal'); await ctx.serial('agent/created', { agent })
    assert.ok((await names(ctx, agent)).includes(ownName))
    const original = ctx.tools.get(ownName, agent)
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (first && context.scope === agent && isPresentationProbe(context)) { first = false; entered.resolve(); await held.promise }
      return result
    })
    pending = resolve(ctx, agent, controller.signal)
    const rejected = assert.rejects(pending, /cancelled/)
    await bounded(entered.promise, 'the cancelled admission was not reached')
    controller.abort(new Error('cancelled admission'))
    assert.ok((await bounded(names(ctx, agent), 'fresh authorization waited on cancelled admission')).includes(ownName))
    held.resolve(); await rejected
    assert.equal(ctx.tools.get(ownName, agent), original)
    assert.ok((await names(ctx, agent)).includes(ownName))
  } finally { held.resolve(); await pending?.catch(() => {}); await shutdown(ctx) }
})
for (const [mode, plugin, ownName] of [['native', discovery, 'ops_discover_tools'], ['ptc', ptc, 'ops_load_sdk']]) await test(`${mode} parent and child resolve independently and late child admission cannot restore disposed grants`, async () => {
  const { ctx } = await bootHost({ toolsMode: mode })
  const held = deferred(), entered = deferred()
  let child, pending, blocked = true
  try {
    await services(ctx); await ctx.plugin(plugin, { binaryPath: process.execPath, required: true })
    await flush()
    const parent = mint(ctx, 'parent'); await ctx.serial('agent/created', { agent: parent })
    child = mint(ctx, 'child', parent); await ctx.serial('agent/created', { agent: child })
    assert.deepEqual(scopeChainOf(child), [child, parent])
    const retained = ctx.tools.get(ownName, child)
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (blocked && context.scope === child && isPresentationProbe(context)) { entered.resolve(); await held.promise }
      return next()
    })
    pending = resolve(ctx, child)
    await bounded(entered.promise, 'child admission did not enter')
    assert.ok((await bounded(names(ctx, parent), 'a blocked child serialized parent admission')).includes(ownName))
    const other = mint(ctx, 'independent'); await ctx.serial('agent/created', { agent: other })
    assert.ok((await bounded(names(ctx, other), 'a blocked child serialized independent admission')).includes(ownName))
    await bounded(ctx.serial('agent/disposed', { agent: child }), 'child disposal waited for its prompt response')
    blocked = false; held.resolve(); const obsolete = await pending
    assert.equal(ctx.tools.executable(ownName, child, obsolete), undefined); obsolete.dispose()
    assert.equal((await retained.execute({}, { agent: child, signal: new AbortController().signal })).error.code, 'POLICY_DENIED')
    assert.ok((await names(ctx, parent)).includes(ownName)); assert.ok((await names(ctx, other)).includes(ownName))
  } finally { blocked = false; held.resolve(); (await pending)?.dispose(); await shutdown(ctx) }
})
for (const [mode, plugin, ownName] of [['native', discovery, 'ops_discover_tools'], ['ptc', ptc, 'ops_load_sdk']]) await test(`${mode} aborted admission preserves pending selection and aborted calls never queue new selection`, async () => {
  const { ctx } = await bootHost({ toolsMode: mode })
  let gate, pending
  const releases = []
  try {
    await services(ctx); await ctx.plugin(plugin, { binaryPath: process.execPath, required: true })
    await flush()
    const agent = mint(ctx, 'abort-fresh'); await ctx.serial('agent/created', { agent })
    const request = name => mode === 'ptc' ? { tools: [name] } : { query: 'select:ops_' + name }
    const initial = await prepareStep(ctx, agent)
    const entry = ctx.tools.executable(ownName, agent, initial.toolSet)
    assert.equal((await entry.execute(request('stat'), { agent, toolSet: initial.toolSet, signal: new AbortController().signal })).status, 'completed')
    initial.dispose()
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (gate && context.scope === agent && isPresentationProbe(context)) {
        const current = gate
        assert.equal(context.signal, current.controller.signal)
        current.entered.resolve(); await current.held.promise
      }
      return next()
    })
    gate = { held: deferred(), entered: deferred(), controller: new AbortController() }; releases.push(gate.held.resolve)
    pending = resolve(ctx, agent, gate.controller.signal)
    const rejected = assert.rejects(pending, /cancelled/)
    await bounded(gate.entered.promise, 'fresh admission did not enter')
    gate.controller.abort(new Error('cancelled admission')); gate.held.resolve(); gate = undefined; await rejected
    assert.equal((await names(ctx, agent)).includes('ops_stat'), false, 'aborted resolve and later diagnostics cannot commit selection')
    await ctx.serial('session/event', agent.session, { type: 'step/end' })
    assert.ok((await names(ctx, agent)).includes('ops_stat'), 'committed step consumes the preserved selection')
    const captured = await prepareStep(ctx, agent), cancelled = new AbortController(); cancelled.abort()
    const outcome = await ctx.tools.executable(ownName, agent, captured.toolSet).execute(request('grep'), { agent, toolSet: captured.toolSet, signal: cancelled.signal })
    assert.equal(outcome.status, 'rejected'); captured.dispose()
    await ctx.serial('session/event', agent.session, { type: 'step/end' })
    assert.equal((await names(ctx, agent)).includes('ops_grep'), false, 'aborted call never queues a new selection')
  } finally { gate = undefined; for (const release of releases) release(); await pending?.catch(() => {}); await shutdown(ctx) }
})
report('probe-isolation')
