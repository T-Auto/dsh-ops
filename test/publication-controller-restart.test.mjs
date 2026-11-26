/**
 * Real-host restart regressions for the publication-lease verdicts (#953 review).
 *
 * A Cordis restart keeps the fiber identity but enters UNLOADING, where every new
 * effect is refused. A registration attempted in that window returns a cancelled
 * lease; controllers must not cache it as a live layer, shadow or mask.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { mountSessionBash } from '../lib/session-shells.js'
import { mountReplacements } from '../lib/publication/replacements.js'
import * as hidingModule from '../lib/official-tool-hiding.js'
import { legacyComponent } from './lib/legacy-component.mjs'
import { registerNativeProvider } from '../lib/file/result-provider.js'
import { BASH_TOOL, publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, executeCall } from './lib/executor.mjs'
import { assert, test, report, waitFor, TEST_HOME } from './lib/harness.mjs'

const tick = async (count = 8) => { for (let i = 0; i < count; ++i) await new Promise(resolve => setImmediate(resolve)) }
const tool = (name, description = name) => ({ name, description, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ ran: description }) })
const textTool = name => ({ name, description: 'fixture ' + name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'ran:' + name })
/** Resolve one model step's admitted surface without executing it. */
const surface = async (ctx, agent) => {
  const step = await prepareStep(ctx, agent)
  return { names: step.assembly.tools.map(entry => entry.name), done: () => step.dispose(), step }
}

// ---- session-shells.admit: a cancelled lease must not mark the session served ----
await test('a cancelled bash registration during a restart is retried into a live layer', async () => {
  const { ctx, tools } = await bootHost()
  const agents = []
  ctx.provide('agents', { list: () => agents })
  await ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('restart fixture never spawns') } })
    inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: TEST_HOME }) })
  })
  const warnings = []
  ctx.logger.warn = message => warnings.push(String(message))
  let release
  const barrier = new Promise(resolve => { release = resolve })
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
      mountSessionBash(inner, { publishBashTool: true },
        { bash: { available: true, file: process.execPath, source: 'explicit' } }, { allows: () => true })
    } })
    const session = ctx.get('sessions').create('lease-restart-bash', { meta: { cwd: TEST_HOME } })
    session.mode = 'danger-full-access'
    const agent = { id: session.id, session }
    agent.ctx = createScope(ctx, agent).ctx
    agents.push(agent)
    // Capture the bash entry fiber and its injected tools context.
    let entryFiber, injectFiber, entryCtx, unloading = false
    const originalPlugin = agent.ctx.plugin.bind(agent.ctx)
    agent.ctx.plugin = (plugin, config) => {
      // `inject` re-enters `plugin` with an object shape: that fiber owns the
      // publication lease (entry.ctx is its injected context), so capture it too.
      if (typeof plugin !== 'function') { injectFiber = originalPlugin(plugin, config); return injectFiber }
      const capture = child => {
        const originalInject = child.inject.bind(child)
        child.inject = (deps, callback) => originalInject(deps, inner => { entryCtx = inner; return callback(inner) })
        return plugin(child)
      }
      entryFiber = originalPlugin(capture, config)
      return entryFiber
    }
    await ctx.serial('agent/created', { agent })
    await waitFor(() => Boolean(tools.get(BASH_TOOL, agent)), { what: 'the initial bash layer' })
    // Hold the entry fiber in UNLOADING so the window is deterministic.
    entryCtx.effect(() => async () => { unloading = true; await barrier }, 'fixture restart barrier')
    const ownerFiber = injectFiber ?? entryFiber
    const restarting = ownerFiber.restart()
    await waitFor(() => unloading, { what: 'the entry fiber unload barrier' })
    assert.equal(ownerFiber.state, 5, 'the publication owner fiber is really unloading')
    // A preset selection rebuilds definitions and bumps the reconcile generation.
    session.append('agent-preset/selected', { preset: 'restart-fixture' })
    await tick()
    assert.equal(tools.get(BASH_TOOL, agent), undefined, 'a cancelled registration never publishes a layer')
    release()
    await restarting
    await tick()
    // The restarted inject must be able to publish again at the same generation:
    // the cancelled attempt may not be cached as a served session.
    session.append('sandbox/mode', { mode: session.mode })
    await waitFor(() => Boolean(tools.get(BASH_TOOL, agent)), { timeoutMs: 10_000, what: 'the republished bash layer' })
    assert.ok(warnings.some(message => message.includes('bash publication cancelled')),
      'the cancelled attempt is reported instead of looking served: ' + warnings.join('; '))
    await ownerFiber.restart()
    await tick()
    assert.ok(tools.get(BASH_TOOL, agent), 'a plain tools restart must also restore a previously admitted layer')
  } finally { release(); await shutdown(ctx) }
})

// ---- replacements: a cancelled shadow lease must not be cached as a ghost ----
for (const changeSource of [false, true]) await test(
  `a replacement refresh restores the shadow after restart with ${changeSource ? 'a changed' : 'the same'} source`, async () => {
  const { ctx, tools } = await bootHost()
  const counterpart = publicToolName('inspect_local_file')
  let release
  const barrier = new Promise(resolve => { release = resolve })
  try {
    const agent = { id: 'replacement-restart', session: { id: 'replacement-restart' } }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    ctx.provide('agents', { list: () => [agent] })
    let removeOfficial = tools.register(tool('read', 'original read'))
    tools.register(tool(counterpart))
    await ctx.plugin({ apply(inner) { mountReplacements(inner, { id: 'restart',
      targets: new Map([['read', counterpart]]), gate: { allows: () => true }, keepOfficial: () => false }) } })
    await tick()
    let step = await surface(ctx, agent)
    assert.equal(step.names.includes('read'), false, 'the official read is replaced before the restart')
    assert.equal(step.names.includes(counterpart), true)
    step.done()
    scope.ctx.effect(() => async () => { await barrier }, 'fixture restart barrier')
    const restarting = scope.ctx.fiber.restart()
    await tick(3)
    // Replace the official source while the agent scope is UNLOADING: the refresh
    // must not cache a shadow whose publication is cancelled.
    if (changeSource) {
      removeOfficial()
      removeOfficial = tools.register(tool('read', 'updated read'))
    }
    await tick(3)
    release()
    await restarting
    await tick()
    await ctx.serial('session/event', {}, { type: 'agent-preset/selected' })
    await waitFor(async () => {
      const current = await surface(ctx, agent)
      current.done()
      return !current.names.includes('read')
    }, { timeoutMs: 10_000, what: 'the replacement shadow after the restart' })
    step = await surface(ctx, agent)
    try {
      assert.equal(step.names.includes('read'), false, 'no unregistered ghost shadow may keep the official read visible')
      assert.equal(step.names.includes(counterpart), true, 'the replacement remains the visible counterpart')
    } finally { step.done() }
  } finally { release(); await shutdown(ctx) }
})

// ---- official-tool-hiding: a cancelled lift fails open and recovers after restart ----
await test('a cancelled restriction during a restart keeps official tools callable and re-hides after reload', async () => {
  const { ctx } = await bootHost()
  const counterpart = publicToolName('inspect_local_file')
  const warnings = []
  ctx.logger.exporter({ levels: { default: 4 }, export(message) {
    if (message.type === 'warn' || message.type === 'error') warnings.push(message.type + ': ' + message.args.join(' '))
  } })
  let release
  const barrier = new Promise(resolve => { release = resolve })
  try {
    await registerNativeProvider(ctx, [textTool(counterpart)], definition => ctx.tools.register(definition))
    for (const name of ['read', 'foreign']) ctx.tools.register(textTool(name))
    await ctx.plugin({ name: 'fixture-hide', apply: legacyComponent(hidingModule).apply }, { replaceTools: ['read'] })
    await tick()
    const agent = { id: 'hiding-restart' }
    await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await ctx.serial('agent/created', { agent })
    await tick()
    let step = await surface(ctx, agent)
    assert.equal(step.names.includes('read'), false, 'the official read is masked before the restart')
    step.done()
    agent.ctx.effect(() => async () => { await barrier }, 'fixture restart barrier')
    const restarting = agent.ctx.fiber.restart()
    await tick(3)
    // Inside UNLOADING the restriction is cancelled: fail open, do not hide, and do
    // not throw a readiness error that would wedge the scope.
    step = await surface(ctx, agent)
    try {
      assert.equal(step.names.includes('read'), true, 'an unregistered lift must not hide the official tool')
      const result = await executeCall(ctx, { agent, name: 'read', arguments: {}, callId: 'hide-open-read', toolSet: step.step.toolSet })
      assert.equal(result.isError, false, 'the official tool stays callable while the mask is unregistered')
    } finally { step.done() }
    assert.ok(warnings.some(message => message.includes('was not published')), 'the fail-open decision is reported')
    release()
    await restarting
    await waitFor(async () => {
      const current = await surface(ctx, agent)
      current.done()
      return !current.names.includes('read')
    }, { timeoutMs: 10_000, what: 'the restored hide-official mask' })
    step = await surface(ctx, agent)
    try { assert.equal(step.names.includes('read'), false, 'the restarted scope re-registers its mask') } finally { step.done() }
  } finally { release(); await shutdown(ctx) }
})

report('publication-controller-restart')
