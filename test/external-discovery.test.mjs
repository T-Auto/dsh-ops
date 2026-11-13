/** A third-party tool plugin and unrelated presets use public imports only. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { integration, registerNativeCapability, diagnose } from 'dsh-ops/integration'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { prepareStep, executeCall } from './lib/executor.mjs'
import { mountFakeResident } from './lib/resident.mjs'
async function setup(cwd, options = {}, prepare) {
  const { ctx } = await bootHost()
  await prepare?.(ctx)
  const agents = []; ctx.provide('agents', { list: () => [...agents] })
  ctx.provide('agentPresets', { composedPreset: () => undefined })
  await ctx.plugin(integration({ preset: 'third-party-chat', profile: 'discovery', allowedTools: [], externalTools: ['acme_lookup'], ...options }))
  const mint = async (id, preset = 'third-party-chat', parent) => {
    const agent = { id, session: { id, mode: 'read-only', header: { cwd, agentPreset: preset } } }
    await (parent?.ctx ?? ctx).plugin({ inject: ['tools'], apply(inner) {
      agent.ctx = createScope(inner, agent, parent ? { parent } : undefined).ctx
    } })
    agents.push(agent); await ctx.serial('agent/created', { agent })
    agent.prepared = await prepareStep(ctx, agent)
    return agent
  }
  return { ctx, mint, names: agent => ctx.get('tools').definitions(agent, agent.prepared.toolSet).map(tool => tool.name) }
}
const call = (ctx, agent, name, args = {}) => executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name, arguments: args, callId: name, signal: new AbortController().signal })
const commit = async (ctx, agent) => {
  ctx.emit('session/event', agent.session, { type: 'step/end' })
  agent.prepared.dispose(); agent.prepared = await prepareStep(ctx, agent)
}
function capability(execute = async () => ({ value: 'ok' }), authorize = () => true) {
  return { search: 'lookup catalogue external example', authorize, definition: {
    name: 'acme_lookup', description: 'Look up an Acme catalogue item.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { value: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute,
  } }
}
await test('pure external Native discovery needs no worker, file, shell, subprocess or sandbox services', () => withTempDir('external-discovery', async cwd => {
  const { ctx, mint, names } = await setup(cwd)
  let actions = 0
  try {
    await registerNativeCapability(ctx, capability(async () => { ++actions; return { value: 'owned' } }))
    const a = await mint('external-a'), b = await mint('external-b'), child = await mint('external-child', 'third-party-chat', a)
    const childOther = await mint('external-child-other', 'other-preset', a)
    const unrelated = await mint('external-other', 'other-preset')
    assert.deepEqual(names(unrelated), [])
    const first = await ctx.get('systemPrompt').assemble({ scope: a, agent: a, toolSet: a.prepared.toolSet })
    const selected = await call(ctx, a, 'ops_discover_tools', { query: 'select:acme_lookup' })
    assert.deepEqual(selected.value.activated, ['acme_lookup']); assert.equal(actions, 0)
    assert.equal(names(a).includes('acme_lookup'), false)
    await commit(ctx, a)
    assert.equal(names(a).includes('acme_lookup'), true)
    assert.equal(names(b).includes('acme_lookup'), false); assert.equal(names(child).includes('acme_lookup'), false)
    assert.equal(names(childOther).includes('acme_lookup'), false)
    await call(ctx, child, 'ops_discover_tools', { query: 'select:acme_lookup' }); await commit(ctx, child)
    assert.ok(names(child).includes('acme_lookup'), 'a child may independently select the same provider')
    assert.deepEqual(first.tools.map(tool => tool.name).sort(), ['ops_discover_tools', 'ops_status'])
    assert.equal((await call(ctx, a, 'acme_lookup')).value.value, 'owned'); assert.equal(actions, 1)
    const stale = ctx.get('tools').get('acme_lookup', a)
    assert.equal((await stale.execute({}, { agent: b, signal: new AbortController().signal })).status, 'rejected')
  } finally { await shutdown(ctx) }
}))
await test('mixed discovery preserves external tools across late file policy and kernel disposal', () => withTempDir('external-mixed', async cwd => {
  let owner, kernel, finish, entered, externalSignal, held = false, fileCalls = 0
  const started = new Promise(resolve => { entered = resolve })
  const { ctx, mint, names } = await setup(cwd, {
    allowedTools: ['stat'], alwaysLoaded: ['stat'], externalAlwaysLoaded: ['acme_lookup'],
  }, async ctx => {
    ctx.provide('subprocess', { spawn() { throw new Error('Publication lifetime fixture must not spawn') } })
    owner = await ctx.plugin({ async apply(inner) {
      kernel = await mountFakeResident(inner, { invoke() {
        ++fileCalls; throw new Error('Publication lifetime fixture must not execute files')
      } })
    } })
  })
  const agents = []
  try {
    await registerNativeCapability(ctx, capability(async (_args, exec) => {
      if (held) {
        externalSignal = exec.signal; entered()
        await new Promise(resolve => { finish = resolve })
      }
      return { value: 'independent' }
    }))
    const agent = await mint('mixed-before-policy'); agents.push(agent)
    assert.equal(ctx.get('sandboxPolicy'), undefined)
    assert.ok(names(agent).includes('ops_discover_tools'))
    assert.ok(names(agent).includes('acme_lookup'), 'file authority does not govern the external provider')
    assert.equal(names(agent).includes('ops_stat'), false)
    assert.equal((await call(ctx, agent, 'acme_lookup')).value.value, 'independent')
    const retainedExternal = ctx.get('tools').get('acme_lookup', agent)
    ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: 'read-only', workspaceRoot: cwd, sessionId: session.id }) })
    await commit(ctx, agent)
    assert.ok(names(agent).includes('ops_stat'), 'late file policy admits the built-in pool')
    const retainedFile = ctx.get('tools').get('ops_stat', agent), captured = agent.prepared.toolSet
    held = true
    const running = call(ctx, agent, 'acme_lookup')
    await started
    await owner.dispose()
    assert.equal(kernel.available, false)
    assert.equal(externalSignal.aborted, false, 'kernel disposal cannot cancel an unrelated external invocation')
    assert.equal(ctx.get('tools').get('acme_lookup', agent), retainedExternal, 'external publication identity survives')
    const stale = await retainedFile.execute({ path: '.' }, { agent, toolSet: captured, signal: new AbortController().signal })
    assert.ok(['rejected', 'error'].includes(stale.status), 'captured file admission cannot outlive the kernel')
    assert.equal(stale.error.effectState, 'none')
    assert.equal(fileCalls, 0)
    finish(); await running; held = false
    await commit(ctx, agent)
    assert.equal(names(agent).includes('ops_stat'), false)
    assert.ok(names(agent).includes('ops_discover_tools'))
    assert.equal((await call(ctx, agent, 'acme_lookup')).value.value, 'independent')
    const fresh = await mint('mixed-after-kernel'); agents.push(fresh)
    assert.equal(names(fresh).includes('ops_stat'), false)
    assert.ok(names(fresh).includes('ops_discover_tools'))
    assert.equal((await call(ctx, fresh, 'acme_lookup')).value.value, 'independent')
  } finally { finish?.(); agents.forEach(agent => agent.prepared.dispose()); await shutdown(ctx) }
}))
await test('unload drops pending/active tokens; reinstalling the same name requires fresh selection', () => withTempDir('external-reload', async cwd => {
  const { ctx, mint, names } = await setup(cwd)
  try {
    const remove = await registerNativeCapability(ctx, capability())
    const a = await mint('reload-a')
    await call(ctx, a, 'ops_discover_tools', { query: 'select:acme_lookup' }); await commit(ctx, a)
    const stale = ctx.get('tools').get('acme_lookup', a)
    remove(); await waitFor(() => !names(a).includes('acme_lookup'))
    assert.equal((await stale.execute({}, { agent: a, signal: new AbortController().signal })).status, 'rejected')
    await registerNativeCapability(ctx, capability(async () => ({ value: 'new' })))
    await commit(ctx, a); assert.equal(names(a).includes('acme_lookup'), false)
    await call(ctx, a, 'ops_discover_tools', { query: 'select:acme_lookup' }); await commit(ctx, a)
    assert.equal((await call(ctx, a, 'acme_lookup')).value.value, 'new')
  } finally { await shutdown(ctx) }
}))
await test('late providers, allow/disable controls, provider authorization and collisions are enforced', () => withTempDir('external-auth', async cwd => {
  const { ctx, mint, names } = await setup(cwd, { externalAlwaysLoaded: ['acme_lookup'] })
  let authorized = false, actions = 0, admissions = 0
  try {
    const a = await mint('auth-a')
    assert.equal(names(a).includes('acme_lookup'), false)
    await registerNativeCapability(ctx, capability(async () => { ++actions; return { value: 'ok' } }, () => { ++admissions; return authorized }))
    await commit(ctx, a)
    await waitFor(() => names(a).includes('acme_lookup'))
    assert.equal((await call(ctx, a, 'acme_lookup')).value.status, 'rejected'); assert.equal(actions, 0)
    admissions = 0; authorized = true; assert.equal((await call(ctx, a, 'acme_lookup')).value.value, 'ok')
    assert.equal(admissions, 1, 'one provider-owned invocation owes exactly one authorization')
    await assert.rejects(registerNativeCapability(ctx, capability()), /already has a provider/)
    await assert.rejects(registerNativeCapability(ctx, { ...capability(), definition: { ...capability().definition, name: 'ops_fake' } }), /non-reserved/)
  } finally { await shutdown(ctx) }
}))
await test('disabled providers and pending old instances never become active after reinstall', () => withTempDir('external-disabled', async cwd => {
  const { ctx, mint, names } = await setup(cwd, { externalDisabled: ['acme_lookup'] })
  try {
    await registerNativeCapability(ctx, capability())
    const a = await mint('disabled-a')
    assert.deepEqual((await call(ctx, a, 'ops_discover_tools', { query: 'select:acme_lookup' })).value.activated, [])
    await commit(ctx, a); assert.equal(names(a).includes('acme_lookup'), false)
  } finally { await shutdown(ctx) }
  const second = await setup(cwd)
  try {
    const remove = await registerNativeCapability(second.ctx, capability())
    const a = await second.mint('pending-a')
    await call(second.ctx, a, 'ops_discover_tools', { query: 'select:acme_lookup' })
    remove(); await registerNativeCapability(second.ctx, capability())
    await commit(second.ctx, a); assert.equal(second.names(a).includes('acme_lookup'), false)
  } finally { await shutdown(second.ctx) }
}))
await test('provider disposal aborts active execution without transferring authority to a new instance', () => withTempDir('external-cancel', async cwd => {
  const { ctx, mint } = await setup(cwd, { externalAlwaysLoaded: ['acme_lookup'] })
  let entered
  const started = new Promise(resolve => { entered = resolve })
  try {
    const remove = await registerNativeCapability(ctx, capability(async (_args, exec) => {
      entered()
      await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
      return { value: 'cancelled' }
    }))
    const a = await mint('cancel-a')
    const result = call(ctx, a, 'acme_lookup')
    await started; remove(); await result
  } finally { await shutdown(ctx) }
}))
await test('ordinary host collisions never enter external provider admission', () => withTempDir('external-collision', async cwd => {
  const { ctx, mint } = await setup(cwd, { externalAlwaysLoaded: ['acme_lookup'] })
  let admissions = 0, actions = 0
  try {
    await ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(capability(async () => { ++actions; return { value: 'host' } }).definition) } })
    await registerNativeCapability(ctx, capability(undefined, () => { ++admissions; return false }))
    const agent = await mint('host-collision')
    assert.equal((await call(ctx, agent, 'acme_lookup')).value.value, 'host')
    assert.equal(actions, 1); assert.equal(admissions, 0)
    assert.equal((await diagnose(ctx, agent)).external[0].state, 'available', 'a colliding host tool is not an active provider publication')
  } finally { await shutdown(ctx) }
}))
await test('one session preset switch preserves other sessions active and pending external selections', () => withTempDir('external-session', async cwd => {
  const { ctx, mint, names } = await setup(cwd)
  try {
    await registerNativeCapability(ctx, capability())
    const switched = await mint('switch'), active = await mint('active'), pending = await mint('pending')
    await call(ctx, active, 'ops_discover_tools', { query: 'select:acme_lookup' }); await commit(ctx, active)
    await call(ctx, pending, 'ops_discover_tools', { query: 'select:acme_lookup' })
    const retained = ctx.get('tools').get('acme_lookup', active)
    switched.session.header.agentPreset = 'other-preset'
    await ctx.serial('session/event', switched.session, { type: 'agent-preset/selected' })
    await ctx.get('systemPrompt').assemble({ scope: switched, agent: switched })
    assert.equal(ctx.get('tools').get('acme_lookup', active), retained)
    assert.ok(names(active).includes('acme_lookup'))
    await commit(ctx, pending); assert.ok(names(pending).includes('acme_lookup'))
  } finally { await shutdown(ctx) }
}))
report('external-discovery')
