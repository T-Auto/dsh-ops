import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
/** Independently named preset consumes the public package export, not OPS internals. */
import fs from 'node:fs'
import path from 'node:path'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { integration, resolveIntegrationConfig } from 'dsh-ops/integration'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import * as Standard from '../lib/components/mode-standard/index.js'
import * as DiscoveryModule from '../lib/components/discovery/index.js'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { legacyComponent } from './lib/legacy-component.mjs'
const Discovery = legacyComponent(DiscoveryModule)
const tool = name => ({ name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
async function boot(subprocess) {
  const { ctx } = await bootHost()
  if (subprocess) ctx.provide('subprocess', subprocess); else await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }) })
  ctx.provide('agentPresets', { composedPreset: () => undefined })
  const live = []; ctx.provide('agents', { list: () => [...live] })
  const mint = async (id, cwd, parent) => {
    const base = createScope(parent?.ctx ?? ctx, { preset: id }, parent ? { parent } : undefined).ctx
    await base.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { for (const name of ['read', 'glob', 'grep']) inner.tools.register(tool(name)) } })
    const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd, agentPreset: id } } }
    await base.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { agent.ctx = createScope(inner, agent, { parent: scopeOf(base) }).ctx } })
    live.push(agent); await ctx.serial('agent/created', { agent })
    return agent
  }
  return { ctx, mint, names: async agent => { const captured = await prepareStep(ctx, agent); try { return ctx.tools.schemas(agent, captured.toolSet).map(tool => tool.name).sort() } finally { captured.dispose() } } }
}
const execute = (ctx, agent, raw, args) => executeCall(ctx, { agent, name: `ops_${raw}`, arguments: args, callId: 'third-party', signal: new AbortController().signal })
const next = (ctx, agent) => ctx.serial('session/event', agent.session, { type: 'step/end' })
await test('simple and detailed configuration are explicit and reject inert or invalid options', () => {
  const simple = resolveIntegrationConfig({ preset: 'acme-native' })
  assert.equal(simple.files, true); assert.equal(simple.shell, false); assert.equal(simple.replaceOfficial, false)
  assert.equal(simple.native.enabled, true)
  for (const raw of [{ preset: '' }, { preset: 'x', typo: true }, { preset: 'x', shell: 'yes' }, { preset: 'x', alwaysLoaded: ['bash'] },
    { preset: 'x', allowedTools: [], alwaysLoaded: ['stat'] }, { preset: 'x', profile: 'ptc', files: false },
    { preset: 'x', profile: 'ptc', extraGuidance: 'not implemented' },
    { preset: 'x', profile: 'ptc', denyCredentialReads: false }]) assert.throws(() => resolveIntegrationConfig(raw))
  assert.equal(resolveIntegrationConfig({ preset: 'x', shell: false, bashPath: 'C:/bash.exe', hidePwsh: true }).hidePwsh, false)
})
await test('unknown presets stay unchanged, opted-in files retain official tools and unload revokes callbacks', () => withTempDir('preset-integration', async cwd => {
  const { ctx, mint, names } = await boot()
  try {
    await ctx.plugin(Discovery, { required: true })
    const unrelated = await mint('acme-unselected', cwd)
    assert.deepEqual((await names(unrelated)), ['glob', 'grep', 'read'])
    const row = await ctx.plugin(integration({ preset: 'acme-selected', discovery: false }))
    const own = await mint('acme-selected', cwd)
    await waitFor(async () => (await names(own)).includes('ops_read_files'))
    for (const official of ['read', 'glob', 'grep']) assert.ok((await names(own)).includes(official))
    assert.equal((await names(own)).includes('ops_discover_tools'), false)
    assert.equal((await names(own)).includes('ops_bash'), false)
    fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hello')
    assert.equal((await execute(ctx, own, 'read_files', { files: [{ path: 'hello.txt' }] })).isError, false)
    const stale = ctx.get('tools').get('ops_read_files', own)
    assert.equal((await stale.execute({ files: [] }, { agent: unrelated, signal: new AbortController().signal })).status, 'rejected')
    await row.dispose()
    assert.deepEqual((await names(own)), ['glob', 'grep', 'read'])
    assert.equal((await stale.execute({ files: [] }, { agent: own, signal: new AbortController().signal })).status, 'rejected')
  } finally { await shutdown(ctx) }
}))
await test('independent preset discovery pools activate only after a committed step', () => withTempDir('preset-pools', async cwd => {
  const { ctx, mint, names } = await boot()
  try {
    await ctx.plugin(integration({ preset: 'acme-one', profile: 'discovery', allowedTools: ['stat'] }))
    await ctx.plugin(integration({ preset: 'acme-two', profile: 'discovery', allowedTools: ['diff'] }))
    const a = await mint('acme-one', cwd), b = await mint('acme-two', cwd), pending = await mint('acme-two', cwd)
    await waitFor(async () => (await names(a)).includes('ops_discover_tools') && (await names(b)).includes('ops_discover_tools'))
    assert.deepEqual((await execute(ctx, a, 'discover_tools', { query: 'select:ops_diff' })).value.activated, [])
    assert.deepEqual((await execute(ctx, a, 'discover_tools', { query: 'select:ops_stat' })).value.activated, ['ops_stat'])
    assert.equal((await names(a)).includes('ops_stat'), false)
    await next(ctx, a); await waitFor(async () => (await names(a)).includes('ops_stat'))
    assert.equal((await names(b)).includes('ops_stat'), false)
    await execute(ctx, b, 'discover_tools', { query: 'select:ops_diff' }); await next(ctx, b)
    await waitFor(async () => (await names(b)).includes('ops_diff'))
    await execute(ctx, pending, 'discover_tools', { query: 'select:ops_diff' })
    const retained = ctx.get('tools').get('ops_diff', b)
    a.session.header.agentPreset = 'acme-unselected'
    await ctx.serial('session/event', a.session, { type: 'agent-preset/selected' })
    await waitFor(async () => !(await names(a)).includes('ops_stat') && !(await names(a)).includes('ops_discover_tools'))
    assert.equal(ctx.get('tools').get('ops_diff', b), retained)
    await next(ctx, pending); await waitFor(async () => (await names(pending)).includes('ops_diff'))
  } finally { await shutdown(ctx) }
}))
await test('a missing worker never hides the official alternatives (#436)', () => withTempDir('preset-no-worker', async cwd => {
  const { ctx, mint, names } = await boot()
  try {
    await ctx.plugin(integration({ preset: 'acme-broken', binaryPath: path.join(cwd, 'missing-worker'), replaceOfficial: true }))
    const own = await mint('acme-broken', cwd)
    const assembly = await ctx.get('systemPrompt').assemble({ scope: own, agent: own })
    for (const name of ['read', 'glob', 'grep']) {
      assert.ok((await names(own)).includes(name))
      assert.equal((await executeCall(ctx, { agent: own, name, arguments: {}, callId: name, signal: new AbortController().signal })).isError, false)
    }
    assert.equal(assembly.sections.some(section => section.name.startsWith('dsh-ops:') && section.text.trim()), false)
  } finally { await shutdown(ctx) }
}))
await test('PTC uses actual host presentation, keeps another native preset intact and respects prompt/dynamic switches', () => withTempDir('preset-ptc', async cwd => {
  const { ctx, mint, names } = await boot()
  try {
    ctx.provide('ptcRuntime', { language: 'typescript' })
    await ctx.plugin(integration({ preset: 'acme-ptc-label', profile: 'ptc', discovery: false, promptPolicy: false }))
    await ctx.plugin(integration({ preset: 'acme-native' }))
    const labeled = await mint('acme-ptc-label', cwd), native = await mint('acme-native', cwd)
    const first = await ctx.get('systemPrompt').assemble({ scope: labeled, agent: labeled })
    assert.equal((await names(labeled)).some(name => name.startsWith('ops_') && name !== 'ops_status'), false, 'a preset id is not PTC-only presentation')
    assert.ok(first.tools.some(tool => tool.name === 'read'))
    const lift = selectExecutor(labeled.ctx, 'ptc')
    await ctx.get('systemPrompt').assemble({ scope: labeled, agent: labeled })
    await waitFor(async () => (await names(labeled)).includes('ops_inspect_local_file'))
    assert.equal((await names(labeled)).includes('ops_load_sdk'), false)
    const actual = await ctx.get('systemPrompt').assemble({ scope: labeled, agent: labeled })
    assert.deepEqual(actual.tools.map(tool => tool.name), ['run_code'])
    assert.equal(actual.sections.some(section => section.name.startsWith('dsh-ops:') && section.text.trim()), false)
    assert.ok((await names(native)).includes('ops_read_files'))
    const stale = ctx.get('tools').get('ops_inspect_local_file', labeled)
    labeled.session.header.agentPreset = 'acme-unselected'
    await ctx.serial('session/event', labeled.session, { type: 'agent-preset/selected' })
    await ctx.get('systemPrompt').assemble({ scope: labeled, agent: labeled })
    assert.equal((await names(labeled)).some(name => name.startsWith('ops_')), false, 'preset switch withdraws the PTC SDK and diagnostics')
    assert.equal((await stale.execute({}, { agent: labeled })).status, 'rejected')
    labeled.session.header.agentPreset = 'acme-ptc-label'
    await ctx.serial('session/event', labeled.session, { type: 'agent-preset/selected' })
    await waitFor(async () => (await names(labeled)).includes('ops_inspect_local_file'))
    assert.equal((await stale.execute({}, { agent: labeled })).status, 'rejected', 'reselection must not revive retained callbacks')
    lift()
  } finally { await shutdown(ctx) }
}))
await test('PTC preset withdrawal aborts an in-flight worker call', () => withTempDir('preset-ptc-abort', async cwd => {
  let workerSignal
  const { ctx, mint, names } = await boot({ spawn(spec) {
    workerSignal = spec.signal
    return { done: new Promise(resolve => spec.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })),
      collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } } }
  } })
  try {
    ctx.provide('ptcRuntime', { language: 'typescript' })
    await ctx.plugin(integration({ preset: 'abort-ptc', profile: 'ptc', discovery: false }))
    const agent = await mint('abort-ptc', cwd)
    selectExecutor(agent.ctx, 'ptc')
    await ctx.get('systemPrompt').assemble({ scope: agent, agent })
    await waitFor(async () => (await names(agent)).includes('ops_inspect_local_file'))
    const captured = await prepareStep(ctx, agent)
    const running = ctx.get('tools').executable('ops_inspect_local_file', agent, captured.toolSet).execute({ path: 'example.txt' }, { agent, toolSet: captured.toolSet, signal: new AbortController().signal }).finally(() => captured.dispose())
    await waitFor(async () => Boolean(workerSignal))
    agent.session.header.agentPreset = 'unselected'
    await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' })
    await ctx.get('systemPrompt').assemble({ scope: agent, agent })
    assert.equal(workerSignal.aborted, true)
    await running
  } finally { await shutdown(ctx) }
}))
await test('conditional replacements stay agent bound and explicit ancestor masks still intersect', () => withTempDir('preset-host-masks', async cwd => {
  const { ctx, mint, names } = await boot()
  try {
    await ctx.plugin(integration({ preset: 'selected-parent', discovery: false, replaceOfficial: true }))
    const parent = await mint('selected-parent', cwd)
    await waitFor(async () => (await names(parent)).includes('ops_read_files'))
    const inherited = { id: 'inherited-child', session: { id: 'inherited-child', mode: 'read-only', header: { cwd, agentPreset: 'other' } } }
    await parent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { inherited.ctx = createScope(inner, inherited, { parent }).ctx } })
    await ctx.serial('agent/created', { agent: inherited })
    assert.equal((await names(inherited)).includes('ops_read_files'), false, 'an inherited registration does not grant another preset admission')
    assert.ok((await names(inherited)).includes('read'), 'conditional counterparts leave the official fallback visible for unrelated presets')
    assert.equal((await execute(ctx, inherited, 'read_files', { files: [] })).isError, true, 'inherited OPS callback cannot execute for another preset')
    assert.equal((await executeCall(ctx, { agent: inherited, name: 'read', arguments: {}, callId: 'inherited', signal: new AbortController().signal })).isError, false)
    const parentMask = parent.ctx.tools.restrict({ deny: ['read'] })
    const allow = inherited.ctx.tools.restrict({ allow: ['read', 'ops_read_files'] })
    assert.equal((await names(inherited)).includes('read'), false, 'child allow cannot lift ancestor deny')
    allow()
    const own = await mint('own-child', cwd, parent)
    await own.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { inner.tools.register(tool('read')) } })
    assert.ok((await names(own)).includes('read'), 'child-own registration bypasses ancestor mask')
    assert.equal((await executeCall(ctx, { agent: own, name: 'read', arguments: {}, callId: 'own', signal: new AbortController().signal })).isError, false)
    parentMask()
  } finally { await shutdown(ctx) }
}))
report('preset-integration')
