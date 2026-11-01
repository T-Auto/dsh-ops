/** One external activation stays one reconcile, even when a sibling plugin mutates
 * the tool or prompt registry from inside prompt assembly. */
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import * as discoveryModule from '../lib/components/discovery/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { assert, test, report, wait, withTempDir } from './lib/harness.mjs'
import { bootHost, scopedToolNames, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

const discovery = discoveryModule

requireWorker('discovery-feedback-loop')
const DISCOVER = 'ops_discover_tools'
const tick = () => new Promise(resolve => setImmediate(resolve))
const visible = (ctx, agent) => scopedToolNames(ctx, agent).includes(DISCOVER)
const tool = name => ({
  name, description: `feedback fixture ${name}`, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}),
})

async function setup(dir) {
  const { ctx } = await bootHost()
  const agents = []
  ctx.provide('agents', { list: () => agents })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox)
  await ctx.plugin(inner => inner.provide('sandboxPolicy', {
    resolve: ({ session } = {}) => ({
      mode: session?.mode ?? 'workspace-write', workspaceRoot: session?.header.cwd ?? dir, sessionId: session?.id,
    }),
  }))
  const prompt = ctx.get('systemPrompt'), tools = ctx.get('tools')
  const probes = { count: 0 }
  prompt.section({ name: 'feedback-probe-counter', order: 10, text: context => {
    if (isPresentationProbe(context)) ++probes.count
    return ''
  } })
  await ctx.plugin({ apply(inner) { discovery.apply(inner, { binaryPath: WORKER, required: true }) } })
  tools.register(tool('co_dummy'))
  async function mint() {
    const id = 'feedback-' + agents.length
    const agent = { id, session: { id, mode: 'workspace-write', header: { cwd: dir } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    return agent
  }
  const flush = async agent => { await prompt.assemble({ scope: agent }); await tick() }
  const warnings = []
  ctx.logger.exporter({ colors: 0, levels: { default: 4 }, export: message => warnings.push(message.args.map(String).join(' ')) })
  return { ctx, prompt, tools, agents, probes, mint, flush, warnings }
}

await test('a sibling reassembling during the probe cannot amplify one external change', () => withTempDir('feedback-loop', async dir => {
  const host = await setup(dir)
  const { ctx, tools, probes, mint, flush, warnings } = host
  try {
    // The issue's shape: a sibling assembly handler restricts on every turn, with
    // no comparison against the deny list it already installed.
    let restricts = 0
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      // The cap keeps a regression failing inside the suite deadline instead of
      // spinning until `test/run.mjs` kills the process.
      if (restricts >= 2_000) return result
      try { context.scope.ctx.tools.restrict({ deny: ['co_dummy'] }); ++restricts }
      catch { /* a probe of a not-yet-scoped agent has nothing to restrict */ }
      return result
    })
    const owner = await mint()
    await flush(owner)
    probes.count = 0
    restricts = 0
    const remove = tools.register(tool('external_marker'))
    await wait(300)
    assert.ok(restricts > 0, 'the sibling restriction must actually run during probe assembly (precondition)')
    assert.ok(probes.count <= 3, `one external change probes at most twice, got ${probes.count}`)
    assert.equal(visible(ctx, owner), true, 'the discovery surface is not torn down by the feedback')
    assert.ok(warnings.some(line => line.includes('feedback loop')), 'the ignored self-caused change is reported once')
    remove()
  } finally { await shutdown(ctx) }
}))

await test('a prompt-section registration during assembly stays bounded on the prompt channel', () => withTempDir('feedback-loop-prompt', async dir => {
  const host = await setup(dir)
  const { ctx, prompt, probes, mint, flush, warnings } = host
  try {
    let sections = 0
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (sections < 2_000) prompt.section({ name: 'feedback-extra-' + ++sections, order: 40, text: '' })
      return result
    })
    const owner = await mint()
    await flush(owner)
    probes.count = 0
    ctx.emit('system-prompt/change')
    await wait(300)
    assert.ok(sections > 0, 'the sibling section registration must run during probe assembly (precondition)')
    assert.ok(probes.count <= 3, `one external prompt change probes at most twice, got ${probes.count}`)
    assert.equal(visible(ctx, owner), true)
    assert.ok(warnings.some(line => line.includes('feedback loop')), 'the bounded prompt channel warns once')
  } finally { await shutdown(ctx) }
}))

await test('a once-only in-assembly change still converges instead of being dropped silently', () => withTempDir('feedback-settle', async dir => {
  const host = await setup(dir)
  const { ctx, tools, probes, mint, flush } = host
  try {
    let restricted = false
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (restricted) return result
      try { context.scope.ctx.tools.restrict({ deny: ['co_dummy'] }); restricted = true }
      catch { /* nothing to restrict yet */ }
      return result
    })
    const owner = await mint()
    await flush(owner)
    probes.count = 0
    restricted = false
    const remove = tools.register(tool('external_marker'))
    await wait(300)
    assert.equal(probes.count, 2, `main traversal plus exactly one trailing traversal, got ${probes.count}`)
    assert.equal(visible(ctx, owner), true)
    remove()
  } finally { await shutdown(ctx) }
}))

await test('a real external presentation change still reaches the published surface', () => withTempDir('feedback-external', async dir => {
  const host = await setup(dir)
  const { ctx, prompt, tools, mint, flush } = host
  try {
    prompt.section({ name: 'tools:ptc-only', order: 20, text: () => tools.get('presentation_switch') ? 'PTC only' : '' })
    const owner = await mint()
    await flush(owner)
    assert.equal(visible(ctx, owner), true)
    const lift = tools.register(tool('presentation_switch'))
    await flush(owner)
    assert.equal(visible(ctx, owner), false, 'an external change outside the probe must still withdraw the surface')
    lift(); await flush(owner)
    assert.equal(visible(ctx, owner), true, 'the withdrawn surface returns when the external change is reverted')
  } finally { await shutdown(ctx) }
}))

await test('repeated external activation does not accumulate memory or pending reconciles', () => withTempDir('feedback-rss', async dir => {
  const host = await setup(dir)
  const { ctx, tools, probes, mint, flush } = host
  try {
    let restricts = 0
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (restricts >= 4_000) return result
      try { context.scope.ctx.tools.restrict({ deny: ['co_dummy'] }); ++restricts } catch { /* nothing to restrict yet */ }
      return result
    })
    const owner = await mint()
    await flush(owner)
    probes.count = 0
    restricts = 0
    global.gc?.()
    const before = process.memoryUsage().rss
    const perActivation = []
    for (let i = 0; i < 50; i++) {
      const start = probes.count
      const remove = tools.register(tool('external_marker_' + i))
      await wait(10)
      remove()
      await wait(10)
      perActivation.push(probes.count - start)
    }
    await wait(300)
    global.gc?.()
    const growth = process.memoryUsage().rss - before
    assert.ok(Math.max(...perActivation) <= 4, `one activation stays within its budget, got ${perActivation.join(',')}`)
    assert.ok(restricts <= 200, `100 notifications cost at most two restrictions each, got ${restricts}`)
    assert.ok(probes.count <= 4 * 50, `two traversals per notification, got ${probes.count} probes for 100 notifications`)
    assert.ok(growth < 20 * 1024 * 1024, `RSS grew ${(growth / 1048576).toFixed(1)} MB over 50 activations`)
    assert.equal(visible(ctx, owner), true)
  } finally { await shutdown(ctx) }
}))

report('discovery-feedback-loop')
