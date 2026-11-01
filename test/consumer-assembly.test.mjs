/** Regression coverage for the shared consumer path and cancellation contract. */
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { integration, registerNativeCapability } from 'dsh-ops/integration'
import * as Bundle from '../lib/index.js'
import { resolveMergedConfig, hostConfig } from '../lib/settings/merged.js'
import { effectiveMode } from '../lib/settings/merged.js'
import { NativeFileTools } from '../lib/projections/native/runtime.js'
import { definition as ptcDefinition } from '../lib/projections/ptc/contract.js'
import { InvocationLifetime, InvocationNotStarted } from '../lib/lifecycle/invocations.js'
import { searchCapabilities } from '../lib/discovery/candidates.js'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
const capability = (execute = async () => ({ ok: true })) => ({ search: 'lookup external catalogue', authorize: () => true,
  definition: { name: 'acme_lookup', description: 'Look up external catalogue.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, execute } })
async function host(cwd, services = true) {
  const { ctx } = await bootHost()
  const agents = []; ctx.provide('agents', { list: () => agents })
  ctx.provide('agentPresets', { composedPreset: () => undefined })
  if (services) {
    await ctx.plugin(Subprocess)
    ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: cwd, sessionId: session.id }) })
  }
  const mint = async (preset = 'standard') => {
    const id = `${preset}-${agents.length}`, agent = { id, session: { id, mode: 'read-only', header: { cwd, agentPreset: preset } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    agents.push(agent); await ctx.serial('agent/created', { agent }); return agent
  }
  return { ctx, mint, names: agent => scopedToolNames(ctx, agent) }
}
const disabledBuiltins = { minimal: { enabled: false, dynamicTools: false }, standard: { enabled: false, dynamicTools: false },
  ptc: { enabled: false, dynamicTools: false }, cordis: { enabled: false, dynamicTools: false } }

await test('custom preset settings validate and preserve independent switches through host normalization', () => {
  const raw = { presets: { acme: { files: true, residentTools: true, residentNames: ['stat'], discovery: false, promptPolicy: false } } }
  assert.deepEqual(hostConfig(raw).presets, raw.presets)
  assert.equal(resolveMergedConfig(raw).presets.acme.options.residentTools, true)
  const again = resolveMergedConfig(resolveMergedConfig(raw))
  assert.deepEqual(again.presets, resolveMergedConfig(raw).presets)
  const resolved = resolveMergedConfig({ standard: { bash: false, promptPolicy: false, required: true, binaryPath: 'C:/selected/worker' } })
  const reentered = resolveMergedConfig(resolved)
  assert.equal(effectiveMode(reentered.standard, reentered.global).bash, false)
  assert.equal(effectiveMode(reentered.standard, reentered.global).binaryPath, 'C:/selected/worker')
  for (const presets of [[], { acme: { preset: 'other' } }, { acme: { typo: true } }, { acme: { residentNames: ['missing'] } }]) assert.throws(() => resolveMergedConfig({ presets }))
})
await test('single-row custom consumers publish exact residents without discovery or unrelated presets', () => withTempDir('consumer-custom', async cwd => {
  const { ctx, mint, names } = await host(cwd)
  try {
    await ctx.plugin(Bundle, { ...disabledBuiltins, discovery: { enabled: false }, presets: {
      acme: { residentNames: ['stat'], discovery: false, shell: false, promptPolicy: false },
    } })
    const own = await mint('acme'), other = await mint('unselected')
    await waitFor(() => names(own).includes('ops_stat'))
    assert.deepEqual(names(own).filter(name => name.startsWith('ops_')).sort(), ['ops_stat', 'ops_status'])
    assert.deepEqual(names(other), [])
  } finally { await shutdown(ctx) }
}))
for (const integrationFirst of [true, false]) await test(`explicit built-in identity overrides bundle discovery in either mount order (${integrationFirst})`, () => withTempDir('consumer-override', async cwd => {
  const { ctx, mint, names } = await host(cwd)
  try {
    const explicit = () => ctx.plugin(integration({ preset: 'standard', discovery: false, residentNames: ['stat'] }))
    if (integrationFirst) await explicit()
    await ctx.plugin(Bundle, {})
    if (!integrationFirst) await explicit()
    const agent = await mint()
    await ctx.get('systemPrompt').assemble({ scope: agent, agent })
    await waitFor(() => names(agent).includes('ops_stat'))
    assert.equal(names(agent).includes('ops_discover_tools'), false)
    assert.equal(names(agent).includes('ops_read_files'), false)
  } finally { await shutdown(ctx) }
}))
for (const retire of ['consumer', 'agent', 'preset', 'authority', 'presentation']) await test(`external in-flight calls cancel with ${retire} retirement`, () => withTempDir('consumer-cancel', async cwd => {
  const { ctx, mint } = await host(cwd, false)
  let entered, seen
  const started = new Promise(resolve => { entered = resolve })
  try {
    await registerNativeCapability(ctx, capability(async (_args, exec) => {
      seen = exec.signal; entered()
      await new Promise(resolve => exec.signal.aborted ? resolve() : exec.signal.addEventListener('abort', resolve, { once: true }))
      return { cancelled: true }
    }))
    const row = await ctx.plugin(integration({ preset: 'acme', profile: 'discovery', allowedTools: [], externalTools: ['acme_lookup'], externalAlwaysLoaded: ['acme_lookup'] }))
    const agent = await mint('acme')
    const running = ctx.get('tools').get('acme_lookup', agent).execute({}, { agent, signal: new AbortController().signal })
    await started
    if (retire === 'consumer') await row.dispose()
    if (retire === 'agent') await ctx.serial('agent/disposed', { agent })
    if (retire === 'preset') { agent.session.header.agentPreset = 'other'; await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' }) }
    if (retire === 'authority') await ctx.serial('session/event', agent.session, { type: 'sandbox/mode' })
    if (retire === 'presentation') {
      ctx.provide('ptcRuntime', { language: 'typescript' })
      agent.ctx.tools.presentAs('ptc')
      await ctx.get('systemPrompt').assemble({ scope: agent, agent })
    }
    await waitFor(() => seen.aborted)
    await running
  } finally { await shutdown(ctx) }
}))
await test('mixed discovery reads late policy services instead of capturing an absent service', () => withTempDir('consumer-late-policy', async cwd => {
  const { ctx, mint, names } = await host(cwd, false)
  try {
    await ctx.plugin(integration({ preset: 'acme', profile: 'discovery', allowedTools: ['stat'], alwaysLoaded: ['stat'], externalTools: ['acme_lookup'] }))
    const agent = await mint('acme')
    assert.equal(names(agent).includes('ops_stat'), false)
    await ctx.plugin(Subprocess)
    ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: 'read-only', workspaceRoot: cwd, sessionId: session.id }) })
    await waitFor(() => names(agent).includes('ops_stat'))
  } finally { await shutdown(ctx) }
}))
await test('mixed candidates share a score and only then apply maximum', () => {
  const external = { capability: capability(), token: 'fixture', active: true, calls: new Set() }
  assert.deepEqual(searchCapabilities('file external catalogue', ['stat'], [external], 1).providers, [external])
})
await test('invocation owner registers before user code and drains cooperative cancellation', async () => {
  const calls = new InvocationLifetime()
  let entered = false
  const result = calls.run(undefined, async signal => { entered = true; return signal.aborted })
  await calls.stop()
  await assert.rejects(result)
  assert.equal(entered, false)
  assert.equal(calls.active.size, 0)
})
await test('public Native and typed PTC pre-dispatch cancellation return no-effect values', async () => {
  const runtime = new NativeFileTools({ ctx: {}, config: { workerPath: 'unused' } })
  await runtime.start([])
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  const exec = { signal: controller.signal, agent: { session: { id: 'cancel' } } }
  const value = await runtime.definition('stat').execute({}, exec)
  assert.equal(value.error.code, 'ABORTED'); assert.equal(value.error.effectState, 'none')
  const between = runtime.definition('stat').execute({}, { ...exec, signal: new AbortController().signal })
  runtime.cancel('cancel before dispatch')
  assert.equal((await between).error.effectState, 'none')
  const calls = new InvocationLifetime()
  const typed = ptcDefinition('stat', async (_args, exec) => {
    try { return await calls.run(exec.signal, async () => ({ status: 'completed' })) }
    catch (error) { if (error instanceof InvocationNotStarted) return { status: 'error', error: { code: 'ABORTED', effectState: 'none' } }; throw error }
  })
  const outcome = await typed.execute({}, exec)
  assert.equal(outcome.error.code, 'ABORTED'); assert.equal(outcome.error.effectState, 'none')
  await runtime.stop()
})
await test('non-cooperative external execution cannot pin consumer unload or be replayed', () => withTempDir('consumer-uncooperative', async cwd => {
  const { ctx, mint, names } = await host(cwd, false)
  let finish, entered, signal, actions = 0
  const started = new Promise(resolve => { entered = resolve })
  try {
    await registerNativeCapability(ctx, capability(async (_args, exec) => {
      actions++; signal = exec.signal; entered()
      return new Promise(resolve => { finish = resolve })
    }))
    const row = await ctx.plugin(integration({ preset: 'acme', profile: 'discovery', allowedTools: [], externalTools: ['acme_lookup'], externalAlwaysLoaded: ['acme_lookup'] }))
    const agent = await mint('acme')
    const running = ctx.get('tools').get('acme_lookup', agent).execute({}, { agent })
    await started
    await row.dispose()
    assert.equal(signal.aborted, true); assert.equal(names(agent).includes('acme_lookup'), false); assert.equal(actions, 1)
    finish({ settled: true }); await running
  } finally { finish?.({}); await shutdown(ctx) }
}))
await test('discovered built-in worker cancels when its preset consumer is withdrawn', () => withTempDir('consumer-built-in-cancel', async cwd => {
  const { ctx, mint } = await host(cwd, false)
  let workerSignal
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: 'read-only', workspaceRoot: cwd, sessionId: session.id }) })
  ctx.provide('subprocess', { spawn(spec) {
    workerSignal = spec.signal
    return { done: new Promise(resolve => spec.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })),
      collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } } }
  } })
  try {
    await ctx.plugin(integration({ preset: 'acme', profile: 'discovery', allowedTools: ['stat'], alwaysLoaded: ['stat'] }))
    const agent = await mint('acme')
    const running = ctx.get('tools').get('ops_stat', agent).execute({ path: '.' }, { agent, signal: new AbortController().signal })
    await waitFor(() => Boolean(workerSignal))
    agent.session.header.agentPreset = 'other'
    await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' })
    assert.equal(workerSignal.aborted, true)
    await running
  } finally { await shutdown(ctx) }
}))
await test('bundle Bash gates a real shell-only replacement consumer without losing saved intent', () => withTempDir('consumer-shell-gates', async cwd => {
  for (const bash of [true, false]) {
    const { ctx, mint, names } = await host(cwd)
    try {
      await ctx.plugin(Sandbox); await ctx.plugin(FileSystem)
      await ctx.plugin(Bundle, { ...disabledBuiltins, discovery: { enabled: false }, global: { bash },
        presets: { acme: { profile: 'shell', replaceOfficial: true } } })
      const agent = await mint('acme')
      await ctx.get('systemPrompt').assemble({ scope: agent, agent })
      await waitFor(() => names(agent).includes('ops_status'))
      if (bash) await waitFor(() => names(agent).includes('ops_bash'))
      assert.equal(names(agent).includes('ops_bash'), bash)
      assert.equal(names(agent).includes('ops_read_files'), false)
    } finally { await shutdown(ctx) }
  }
}))
await test('an existing agent switches to an explicit override and restores the built-in consumer on withdrawal', () => withTempDir('consumer-live-override', async cwd => {
  const { ctx, mint, names } = await host(cwd)
  try {
    await ctx.plugin(Bundle, {})
    const agent = await mint()
    await waitFor(() => names(agent).includes('ops_read_files'))
    const previous = ctx.get('tools').get('ops_read_files', agent)
    const row = await ctx.plugin(integration({ preset: 'standard', residentNames: ['stat'], discovery: false }))
    await ctx.get('systemPrompt').assemble({ scope: agent, agent })
    await waitFor(() => names(agent).includes('ops_stat') && !names(agent).includes('ops_read_files'))
    assert.equal((await previous.execute({ files: [] }, { agent })).status, 'rejected')
    const custom = ctx.get('tools').get('ops_stat', agent)
    await row.dispose()
    await ctx.get('systemPrompt').assemble({ scope: agent, agent })
    await waitFor(() => names(agent).includes('ops_read_files') && !names(agent).includes('ops_stat'))
    assert.equal((await custom.execute({ path: '.' }, { agent })).status, 'rejected')
    assert.notEqual(ctx.get('tools').get('ops_read_files', agent), previous)
  } finally { await shutdown(ctx) }
}))
report('consumer-assembly')
