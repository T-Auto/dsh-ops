import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import * as discovery from '../lib/discovery/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, scopedToolNames, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

requireWorker('discovery-incremental')
const DISCOVER = 'ops_discover_tools'
const tick = () => new Promise(resolve => setImmediate(resolve))
const visible = (ctx, agent, name = DISCOVER) => scopedToolNames(ctx, agent).includes(name)
const step = (ctx, agent) => ctx.waterfall('agent/pre-step', {
  agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal,
}, async () => ({ kind: 'continue' }))
const call = (ctx, agent, name, args) => ctx.get('tools').execute({
  agent, name, arguments: args, callId: 'incremental', signal: new AbortController().signal,
})

async function setup(dir, config = {}) {
  const { ctx } = await bootHost()
  const agents = [], counts = new Map()
  ctx.provide('agents', { list: () => agents })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox)
  const policyRow = await ctx.plugin(inner => inner.provide('sandboxPolicy', {
    resolve: ({ session } = {}) => ({
      mode: session?.mode ?? 'workspace-write', workspaceRoot: session?.header.cwd ?? dir, sessionId: session?.id,
    }),
  }))
  const prompt = ctx.get('systemPrompt')
  prompt.section({ name: 'incremental-counter', order: 10, text: context => {
    if (isPresentationProbe(context)) counts.set(context.scope, (counts.get(context.scope) ?? 0) + 1)
    return ''
  } })
  const mount = (target = ctx, extra = {}) => target.plugin({
    apply(inner) { discovery.apply(inner, { binaryPath: WORKER, required: true, ...config, ...extra }) },
  })
  const row = await mount()
  async function mint(parent) {
    const id = 'incremental-' + agents.length
    const agent = { id, session: { id, mode: 'workspace-write', header: { cwd: dir } } }
    await (parent?.ctx ?? ctx).plugin({ inject: ['tools'], apply(inner) {
      agent.ctx = createScope(inner, agent, parent ? { parent } : undefined).ctx
    } })
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    return agent
  }
  const flush = async agent => { await prompt.assemble({ scope: agent }); await tick() }
  return { ctx, prompt, row, policyRow, agents, counts, mint, mount, flush }
}

await test('adding an agent probes it once and never reassembles unchanged agents', () => withTempDir('discovery-incremental', async dir => {
  const host = await setup(dir)
  const { ctx, counts, mint, flush } = host
  try {
    const old = []
    for (let i = 0; i < 12; i++) old.push(await mint())
    await flush(old[0]); counts.clear()
    let promptChanges = 0, toolChanges = 0
    ctx.on('system-prompt/change', () => { ++promptChanges })
    ctx.on('tools/change', () => { ++toolChanges })
    const added = await mint()
    await flush(added)
    const oldCount = old.reduce((sum, agent) => sum + (counts.get(agent) ?? 0), 0)
    console.log(`  added agent: old=${oldCount}, new=${counts.get(added) ?? 0}, old agents=${old.length}`)
    console.log(`  real registration events: prompt=${promptChanges}, tools=${toolChanges}`)
    assert.equal(oldCount, 0, 'agent/created must not reassemble unrelated agents')
    assert.equal(counts.get(added), 1)
    assert.equal(promptChanges, 0, 'the per-row prompt provider must not be registered per agent')
    assert.ok(toolChanges > 0, 'the counted path must include real host tool registration')
    assert.ok(old.every(agent => visible(ctx, agent)) && visible(ctx, added))
    counts.clear()
    await ctx.serial('agent/disposed', { agent: added }); await flush(old[0])
    assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 0, 'disposal does not invalidate surviving presentation')
  } finally { await shutdown(ctx) }
}))

await test('a pre-step probes only its own agent once while committing pending tools', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, counts, mint, flush } = await setup(dir)
  try {
    const owner = await mint(), other = await mint()
    await call(ctx, owner, DISCOVER, { query: 'select:ops_stat' })
    await flush(owner); counts.clear()
    await step(ctx, owner); await flush(owner)
    console.log(`  pre-step: owner=${counts.get(owner) ?? 0}, other=${counts.get(other) ?? 0}`)
    assert.equal(counts.get(owner), 1, 'pre-step and its reconcile share one presentation probe')
    assert.equal(counts.get(other) ?? 0, 0)
    assert.equal(visible(ctx, owner, 'ops_stat'), true)
    assert.equal(visible(ctx, other, 'ops_stat'), false)
  } finally { await shutdown(ctx) }
}))

await test('prompt registry and runtime config changes invalidate cached presentation', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, prompt, mint, flush } = await setup(dir)
  try {
    const owner = await mint()
    let ptc = false
    const dynamic = await ctx.plugin({ inject: ['systemPrompt'], apply(inner) {
      inner.on('internal/update', (config, _noSave, _next) => { ptc = config.ptc })
      inner.systemPrompt.section({ name: 'tools:ptc-only', order: 20, text: () => ptc ? 'PTC only' : '' })
    } })
    await flush(owner)
    dynamic.update({ ptc: true }, true); await flush(owner)
    assert.equal(visible(ctx, owner), false, 'in-place runtime update has no prompt registration event')
    dynamic.update({ ptc: false }, true); await flush(owner)
    assert.equal(visible(ctx, owner), true)
    await dynamic.dispose()
    const lift = prompt.section({ name: 'tools:ptc-only', order: 20, text: 'PTC only' })
    await flush(owner)
    assert.equal(visible(ctx, owner), false)
    lift(); await flush(owner)
    assert.equal(visible(ctx, owner), true)
  } finally { await shutdown(ctx) }
}))

await test('runtime invalidation waits for the real asynchronous Fiber restart to finish', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, prompt, mint, flush } = await setup(dir)
  let release
  try {
    const owner = await mint()
    let ptc = false, entered
    const entering = new Promise(resolve => { entered = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    prompt.section({ name: 'tools:ptc-only', order: 20, text: () => ptc ? 'PTC only' : '' })
    const dynamic = await ctx.plugin({ async apply(_inner, config) {
      if (config.ptc) { entered(); await blocked }
      ptc = config.ptc
    } }, { ptc: false })
    await flush(owner)
    dynamic.update({ ptc: true }, true)
    await entering
    await flush(owner)
    assert.equal(visible(ctx, owner), true, 'pending configuration still has its old value')
    release(); await dynamic; await tick()
    assert.equal(visible(ctx, owner), false, 'invalidate after next() resolves, not just after it returns a Promise')
    dynamic.update({ ptc: false }, true)
    await dynamic; await flush(owner)
    assert.equal(visible(ctx, owner), true)
  } finally { release?.(); await shutdown(ctx) }
}))

await test('Native, PTC and both mode changes retain scoped ownership and restore on unload', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, mint, mount, flush } = await setup(dir)
  try {
    ctx.provide('ptcRuntime', { language: 'typescript' })
    const parent = await mint(), child = await mint(parent), sibling = await mint()
    const lift = parent.ctx.tools.presentAs('ptc')
    await flush(parent); await flush(child)
    assert.equal(visible(ctx, parent), false); assert.equal(visible(ctx, child), false)
    assert.equal(visible(ctx, sibling), true)
    const both = child.ctx.tools.presentAs('both')
    await flush(child)
    assert.equal(visible(ctx, child), true)
    const second = await mount(child.ctx, { alwaysLoaded: ['stat'] })
    await waitFor(() => visible(ctx, child, 'ops_stat'))
    assert.equal(visible(ctx, sibling, 'ops_stat'), false)
    const cached = ctx.get('tools').get('ops_stat', child)
    await second.dispose(); await flush(child)
    assert.equal(visible(ctx, child, 'ops_stat'), false)
    assert.equal((await cached.execute({ path: '.' }, { agent: child })).status, 'rejected')
    both(); lift(); await flush(parent); await flush(child)
    assert.equal(visible(ctx, parent), true); assert.equal(visible(ctx, child), true)
  } finally { await shutdown(ctx) }
}))

await test('session authority changes refresh only that session and live calls use its cwd', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, counts, mint, flush } = await setup(dir, { alwaysLoaded: ['stat', 'write_file'] })
  try {
    const owner = await mint(), other = await mint()
    fs.writeFileSync(path.join(dir, 'sample'), 'first')
    const childDir = path.join(dir, 'changed'); fs.mkdirSync(childDir)
    fs.writeFileSync(path.join(childDir, 'sample'), 'different')
    await flush(owner); counts.clear()
    owner.session.mode = 'read-only'; owner.session.header.cwd = childDir
    await ctx.serial('session/event', owner.session, { type: 'sandbox/mode', data: { mode: 'read-only' } })
    await flush(owner)
    assert.equal(visible(ctx, owner, 'ops_write_file'), false)
    assert.equal(visible(ctx, other, 'ops_write_file'), true)
    assert.equal(counts.get(other) ?? 0, 0, 'session-local policy invalidation must not probe a sibling')
    assert.equal((await call(ctx, owner, 'ops_stat', { path: 'sample' })).value.bytes, 9)
    assert.equal((await call(ctx, owner, 'ops_write_file', { path: 'new', content: 'denied' })).isError, true)
  } finally { await shutdown(ctx) }
}))

await test('service unload and reload discard cached failures and stale registrations', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, policyRow, mint, flush } = await setup(dir)
  try {
    const owner = await mint()
    const cached = ctx.get('tools').get(DISCOVER, owner)
    await policyRow.dispose()
    assert.equal(visible(ctx, owner), false)
    assert.equal((await cached.execute({ query: 'stat' }, { agent: owner })).status, 'rejected')
    await ctx.plugin(inner => inner.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: 'read-only', workspaceRoot: session.header.cwd, sessionId: session.id }),
    }))
    await flush(owner)
    assert.equal(visible(ctx, owner), true)
    assert.notEqual(ctx.get('tools').get(DISCOVER, owner), cached)
  } finally { await shutdown(ctx) }
}))

await test('same agent with changed session cwd or policy is reprobed even without an event', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, prompt, counts, mint, flush } = await setup(dir)
  try {
    const owner = await mint(), other = await mint()
    prompt.section({ name: 'tools:ptc-only', order: 20, text: ({ scope }) =>
      scope.session.mode === 'read-only' || scope.session.header.cwd !== dir ? 'PTC only' : '' })
    await flush(owner); counts.clear()
    owner.session.header.cwd = path.join(dir, 'changed')
    await mint()
    assert.equal(visible(ctx, owner), false)
    assert.ok(counts.get(owner) > 0, 'changed cwd must invalidate the owner; withdrawal may rebuild its SDK')
    assert.equal(counts.get(other) ?? 0, 0)
    owner.session.header.cwd = dir; await mint()
    assert.equal(visible(ctx, owner), true)
    owner.session.mode = 'read-only'; await mint()
    assert.equal(visible(ctx, owner), false)
    owner.session.mode = 'workspace-write'; await mint()
    assert.equal(visible(ctx, owner), true)
  } finally { await shutdown(ctx) }
}))

await test('external tool registration and disposal invalidate presentation, not just schemas', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, prompt, mint, flush } = await setup(dir)
  try {
    const owner = await mint(), tools = ctx.get('tools')
    prompt.section({ name: 'tools:ptc-only', order: 20, text: () => tools.get('presentation_switch') ? 'PTC only' : '' })
    await flush(owner)
    const lift = tools.register({ name: 'presentation_switch', description: '', parameters: { type: 'object' },
      output: { schema: {}, render: () => [] }, execute: () => ({}) })
    await flush(owner)
    assert.equal(visible(ctx, owner), false)
    lift(); await flush(owner)
    assert.equal(visible(ctx, owner), true)
  } finally { await shutdown(ctx) }
}))

await test('unsignalled dynamic providers are fresh at pre-step and cached-definition execution', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, prompt, mint, flush } = await setup(dir)
  try {
    const owner = await mint()
    let ptc = false
    prompt.section({ name: 'tools:ptc-only', order: 20, text: () => ptc ? 'PTC only' : '' })
    await flush(owner)
    const cached = ctx.get('tools').get(DISCOVER, owner)
    ptc = true
    assert.equal((await cached.execute({ query: 'stat' }, { agent: owner })).status, 'rejected')
    assert.equal(visible(ctx, owner), false)
    ptc = false
    await step(ctx, owner)
    assert.equal(visible(ctx, owner), true, 'no registry event is required at the model-step boundary')
    ptc = true
    await step(ctx, owner)
    assert.equal(visible(ctx, owner), false)
  } finally { await shutdown(ctx) }
}))

await test('an invalidation during asynchronous assembly cannot publish the retired result', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, prompt, mint, flush } = await setup(dir)
  let release
  try {
    const owner = await mint()
    let ptc = false, hold = false, entered
    const entering = new Promise(resolve => { entered = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    prompt.section({ name: 'tools:ptc-only', order: 20, text: () => ptc ? 'PTC only' : '' })
    await flush(owner)
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (isPresentationProbe(context) && context.scope === owner && hold) {
        hold = false; entered(); await blocked
      }
      return next()
    })
    hold = true
    await ctx.serial('tools/change'); await entering
    ptc = true
    await ctx.serial('tools/change')
    release(); await flush(owner)
    assert.equal(visible(ctx, owner), false)
    ptc = false; await ctx.serial('tools/change'); await flush(owner)
    assert.equal(visible(ctx, owner), true)
  } finally { release?.(); await shutdown(ctx) }
}))

await test('overlapping agent creation preserves new work without reprobes of old agents', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, counts, mint, flush } = await setup(dir)
  let release
  try {
    const old = await mint()
    await flush(old); counts.clear()
    let entered, hold = true
    const entering = new Promise(resolve => { entered = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (isPresentationProbe(context) && context.scope !== old && hold) {
        hold = false; entered(); await blocked
      }
      return next()
    })
    const first = mint()
    await entering
    const second = mint()
    release()
    const added = await Promise.all([first, second])
    await flush(old)
    assert.equal(counts.get(old) ?? 0, 0)
    for (const agent of added) {
      assert.equal(counts.get(agent), 1)
      assert.equal(visible(ctx, agent), true)
    }
  } finally { release?.(); await shutdown(ctx) }
}))

await test('optional PTC runtime mount and unmount refresh failed both-mode probes', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, mint, flush } = await setup(dir)
  try {
    const owner = await mint()
    const lift = owner.ctx.tools.presentAs('both')
    // Without a runtime the host rejects this presentation before its waterfall.
    await waitFor(() => !visible(ctx, owner))
    const mountRuntime = () => ctx.plugin(inner => inner.provide('ptcRuntime', { language: 'typescript' }))
    const runtime = await mountRuntime()
    await flush(owner)
    assert.equal(visible(ctx, owner), true)
    await runtime.dispose()
    await waitFor(() => !visible(ctx, owner))
    await mountRuntime(); await flush(owner)
    assert.equal(visible(ctx, owner), true)
    lift()
  } finally { await shutdown(ctx) }
}))

await test('unloading during a probe cannot resurrect registrations or leave change listeners', () => withTempDir('discovery-incremental', async dir => {
  const { ctx, row, counts, mint } = await setup(dir)
  let release
  try {
    const owner = await mint(), cached = ctx.get('tools').get(DISCOVER, owner)
    let entered, hold = true
    const entering = new Promise(resolve => { entered = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (isPresentationProbe(context) && hold) { hold = false; entered(); await blocked }
      return next()
    })
    await ctx.serial('tools/change'); await entering
    const closing = row.dispose()
    release(); await closing
    assert.equal(visible(ctx, owner), false)
    assert.equal((await cached.execute({ query: 'stat' }, { agent: owner })).status, 'rejected')
    counts.clear()
    await ctx.serial('tools/change'); await ctx.serial('system-prompt/change'); await tick()
    assert.equal(counts.size, 0)
  } finally { release?.(); await shutdown(ctx) }
}))

report('discovery-incremental')
