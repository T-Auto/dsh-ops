import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as discoveryModule from '../lib/discovery/index.js'
import * as ptcModule from '../lib/ptc/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { assert, test, report, wait, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { legacyComponent } from './lib/legacy-component.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

const discovery = legacyComponent(discoveryModule)
const ptc = legacyComponent(ptcModule)

const bulkTool = (index) => ({
  name: `probe_bulk_${index}`,
  description: `Bulk fixture tool ${index} with realistic nested parameters`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the target resource' },
      pattern: { type: 'string', description: 'Pattern to match' },
      options: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum results' },
          encoding: { type: 'string', enum: ['utf-8', 'utf-16'], description: 'Text encoding' },
          range: { type: 'array', items: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } } },
          filter: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' }, operator: { type: 'string', enum: ['eq', 'ne', 'gt', 'lt'] } } },
        },
      },
    },
    required: ['path'],
  },
  output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, items: { type: 'array', items: { type: 'object' } } } }, render: () => [] },
  execute: async () => ({ content: 'ok' }),
})

const disposeAll = async disposers => { while (disposers.length) await disposers.pop()() }

requireWorker('discovery-lazy-invalidation')
await test('unattributed tools/change probes one session, not every live session', () => withTempDir('lazy-invalidation', async dir => {
  const { ctx } = await bootHost({ toolsMode: 'ptc' })
  const created = []
  try {
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox, {})
    await ctx.plugin(inner => inner.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
    }))
    await ctx.plugin(inner => inner.provide('ptcRuntime', { language: 'typescript', programFormat: 'inline' }))
    await ctx.plugin(discovery, { binaryPath: WORKER, required: true })
    await ctx.plugin(ptc, { binaryPath: WORKER, required: true })

    const prompt = ctx.get('systemPrompt'), assemble = prompt.assemble.bind(prompt)
    const counts = new Map()
    prompt.assemble = context => {
      if (isPresentationProbe(context)) {
        const agent = context.scope
        counts.set(agent, (counts.get(agent) ?? 0) + 1)
      }
      return assemble(context)
    }

    for (let index = 0; index < 150; index++) created.push(await ctx.get('tools').register(bulkTool(index)))

    const create = async (id) => {
      const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd: dir } } }
      await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
      await ctx.serial('agent/created', { agent, source: 'startup' })
      return agent
    }

    // Create 8 live sessions
    const live = []
    for (let i = 0; i < 8; i++) live.push(await create(`live-${i}`))
    await wait(300)

    const countFor = agent => counts.get(agent) ?? 0
    const totalProbes = () => [...counts.values()].reduce((a, b) => a + b, 0)

    // Reset counts after initial setup
    counts.clear()

    // Simulate an unattributed tools/change (official host sends no payload)
    await ctx.serial('tools/change', {})
    await wait(400)

    // After the fix: only one representative session should be probed, not all 8.
    // The fresh session (if any) is not part of this test; we only measure the
    // re-probe cost on the 8 existing live sessions.
    const liveProbes = live.reduce((sum, agent) => sum + countFor(agent), 0)
    const probed = live.filter(agent => countFor(agent) > 0).length
    const total = totalProbes()

    console.log(`[lazy-invalidation] live=8 liveProbes=${liveProbes} probedSessions=${probed} totalProbes=${total}`)

    // Before the fix every live session was re-probed (probedSessions = 8). Discovery
    // and ptc each probe their own representative, so the bound is the number of
    // components in this mount — exactly 2 — never the number of live sessions.
    assert.equal(probed, 1, `an unattributed change must probe exactly one representative, never one per live session (probed ${probed} of 8)`)
    assert.equal(total, liveProbes, 'no session outside the live set may be probed')

    // Verify that a second unattributed change also probes only once
    counts.clear()
    await ctx.serial('tools/change', {})
    await wait(400)
    const secondProbes = live.filter(agent => countFor(agent) > 0).length
    console.log(`[lazy-invalidation] second change: probedSessions=${secondProbes}`)
    assert.equal(secondProbes, 1, 'a second unattributed change must not scale either')

    // A prompt change moves presentation only, so it takes the same lazy path:
    // one representative probe, the rest stay stale until their next assembly.
    counts.clear()
    await ctx.serial('system-prompt/change', {})
    await wait(400)
    const promptProbes = live.filter(agent => countFor(agent) > 0).length
    console.log(`[lazy-invalidation] system-prompt change: probedSessions=${promptProbes}`)
    assert.equal(promptProbes, 1, 'a system-prompt/change must not scale with live sessions')
  } finally {
    await disposeAll(created)
    await shutdown(ctx)
  }
}))

report('lazy-invalidation')
