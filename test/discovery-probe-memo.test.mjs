/**
 * The discovery probe memo must actually skip the probe it claims to skip.
 *
 * `settledNative` caches a `native()` verdict per agent keyed by the scope view's surface.
 * A `tools/change` with no registry movement behind it reconciles against an unchanged
 * surface, so the memo must answer without assembling. Reverting the memo to a direct
 * `native()` call re-assembles on every such pass — exactly what #369 measured — and this
 * suite counts probe assemblies to tell the two apart.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as discovery from '../lib/components/discovery/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { assert, test, report, wait, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

const foreignTool = name => ({
  name,
  description: `probe memo fixture ${name}`,
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
  execute: async () => ({ content: 'ok' }),
})

await test('an unchanged surface reconciles without re-probing the agent', () => withTempDir('discovery', async dir => {
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox, {})
    await ctx.plugin(inner => inner.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
    }))
    await ctx.plugin(discovery, { required: true })
    const agent = { id: 'probe-memo', session: { id: 'probe-memo', mode: 'danger-full-access', header: { cwd: dir } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await ctx.serial('agent/created', { agent, source: 'startup' })

    const prompt = ctx.get('systemPrompt'), assemble = prompt.assemble.bind(prompt)
    let probes = 0
    prompt.assemble = context => { if (isPresentationProbe(context)) ++probes; return assemble(context) }
    try {
      // A real registration moves the surface, so the first reconcile owes (and makes) a probe.
      const registered = ctx.get('tools').register(foreignTool('probe_memo_alpha'))
      await wait(300)
      const settled = probes
      assert.ok(settled > 0, 'a registry change probes the agent at least once (precondition)')
      // A tools/change with no registry movement behind it must NOT re-probe: the memo hits.
      await ctx.serial('tools/change', {})
      await wait(300)
      assert.equal(probes, settled, 'an unchanged surface answers from the memo; a revert to a direct probe re-assembles per change')
      registered[Symbol.dispose]?.() ?? registered.dispose?.()
    } finally { prompt.assemble = assemble }
  } finally { await shutdown(ctx) }
}))

report('discovery-probe-memo')
