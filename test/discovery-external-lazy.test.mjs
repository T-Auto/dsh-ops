/** External-only discovery needs no sandbox policy, and probes only real admission. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountDiscovery } from '../lib/discovery/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { prepareStep } from './lib/executor.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
await test('external-only discovery defers unknown notifications until each requesting resolve', () => withTempDir('external-lazy', async dir => {
  const { ctx } = await bootHost()
  try {
    const live = []; ctx.provide('agents', { list: () => live })
    const probes = new Map()
    ctx.systemPrompt.section({ name: 'external-counter', order: 10, text(context) {
      if (isPresentationProbe(context)) probes.set(context.scope, (probes.get(context.scope) ?? 0) + 1)
      return ''
    } })
    mountDiscovery(ctx, { required: false, allowedTools: [], alwaysLoaded: [] }, {
      allows: () => true, external: { allowed: ['acme_lookup'], alwaysLoaded: [], disabled: [] },
    })
    for (let i = 0; i < 4; i++) {
      const agent = { id: `external-${i}`, session: { id: `external-${i}`, header: { cwd: dir } } }
      agent.ctx = createScope(ctx, agent).ctx
      live.push(agent); await ctx.serial('agent/created', { agent })
    }
    probes.clear()
    await ctx.serial('tools/change', {})
    assert.equal(probes.size, 0, 'no eager representative is needed with host-owned admission')
    for (const agent of live) {
      await new Promise(resolve => setImmediate(resolve))
      const step = await prepareStep(ctx, agent)
      try { assert.deepEqual(step.assembly.tools.map(t => t.name), ['ops_discover_tools']) }
      finally { step.dispose() }
      assert.equal(probes.get(agent), 1)
    }
  } finally { await shutdown(ctx) }
}))
report('external-lazy')
