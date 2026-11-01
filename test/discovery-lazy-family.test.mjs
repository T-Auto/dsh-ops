/**
 * A representative probe walks its whole scope family, so the lazy invalidation has
 * to happen after that walk. Clearing the siblings first empties their cached
 * verdicts before `reconcile` runs and the family is re-probed member by member —
 * the per-live-session cost this change exists to remove, just one family at a time.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as discoveryModule from '../lib/discovery/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { legacyComponent } from './lib/legacy-component.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { assert, test, report, wait, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

const discovery = legacyComponent(discoveryModule)

requireWorker('discovery-lazy-family')
await test('the representative probe must not cascade into its scope family', () => withTempDir('lazy-family', async dir => {
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox, {})
    await ctx.plugin(inner => inner.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
    }))
    await ctx.plugin(discovery, { binaryPath: WORKER, required: true })

    const prompt = ctx.get('systemPrompt'), assemble = prompt.assemble.bind(prompt)
    const probes = new Map()
    prompt.assemble = context => {
      if (isPresentationProbe(context)) probes.set(context.scope, (probes.get(context.scope) ?? 0) + 1)
      return assemble(context)
    }

    const make = id => ({ id, session: { id, mode: 'danger-full-access', header: { cwd: dir } } })

    // The parent is created first, so it is the representative an unattributed
    // change picks; the children hang off it and share its scope family.
    const parent = make('parent')
    await ctx.plugin({ inject: ['tools'], apply(inner) { parent.ctx = createScope(inner, parent).ctx } })
    await ctx.serial('agent/created', { agent: parent, source: 'startup' })
    await wait(80)

    const children = []
    for (let index = 0; index < 3; index += 1) {
      const child = make(`child-${index}`)
      await ctx.plugin({ inject: ['tools'], apply(inner) { child.ctx = createScope(inner, child, { parent }).ctx } })
      await ctx.serial('agent/created', { agent: child, source: 'startup' })
      await wait(80)
      children.push(child)
    }
    await wait(300)

    const family = [parent, ...children]
    const countFor = agent => probes.get(agent) ?? 0

    probes.clear()
    await ctx.serial('tools/change', {})
    await wait(500)

    const probed = family.filter(agent => countFor(agent) > 0).map(agent => agent.id)
    console.log(`[lazy-family] family=${family.length} probed=${JSON.stringify(probed)}`)
    assert.deepEqual(probed, ['parent'], 'only the representative pays a probe; its family stays cached for this round')
    assert.equal(family.reduce((sum, agent) => sum + countFor(agent), 0), 1, 'the family members must not be re-probed individually')
  } finally { await shutdown(ctx) }
}))

report('lazy-family')
