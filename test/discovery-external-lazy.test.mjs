/**
 * External-only discovery mounts without `sandboxPolicy`, so the readiness gate is
 * the only admission signal there. An unattributed change must still probe one
 * representative session — a pick that required a resolved sandbox policy would
 * find none and silently degrade the "at least one probe" contract to zero.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountDiscovery } from '../lib/discovery/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { assert, test, report, wait, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

await test('an external-only discovery mount still probes one representative on an unattributed change', () => withTempDir('external-lazy', async dir => {
  const { ctx } = await bootHost()
  try {
    const prompt = ctx.get('systemPrompt'), assemble = prompt.assemble.bind(prompt)
    const probes = new Map()
    prompt.assemble = context => {
      if (isPresentationProbe(context)) probes.set(context.scope, (probes.get(context.scope) ?? 0) + 1)
      return assemble(context)
    }

    mountDiscovery(ctx, { required: false }, {
      allows: () => true,
      external: { allowed: ['acme_lookup'], alwaysLoaded: [], disabled: [] },
    })
    await wait(50)

    const live = []
    for (let index = 0; index < 4; index += 1) {
      const agent = { id: `live-${index}`, session: { id: `live-${index}`, mode: 'read-only', header: { cwd: dir } } }
      agent.ctx = createScope(ctx, agent).ctx
      await ctx.serial('agent/created', { agent, source: 'startup' })
      await wait(40)
      live.push(agent)
    }
    await wait(200)

    const total = () => live.reduce((sum, agent) => sum + (probes.get(agent) ?? 0), 0)
    const probed = () => live.filter(agent => (probes.get(agent) ?? 0) > 0).length

    probes.clear()
    await ctx.serial('tools/change', {})
    await wait(300)

    console.log(`[external-lazy] live=4 probes=${total()} sessionsProbed=${probed()}`)
    assert.equal(probed(), 1, 'exactly one representative session must be probed without a sandbox policy')
    assert.equal(total(), 1, 'the remaining sessions stay lazily invalidated')
  } finally { await shutdown(ctx) }
}))

report('external-lazy')
