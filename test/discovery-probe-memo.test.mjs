/** Discovery uses attributed OPS changes locally and conservatively probes unknown host notifications. */
import { createScope } from '@deepseek-ai/dsh-scope'
import fs from 'node:fs'
import path from 'node:path'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as discoveryModule from '../lib/components/discovery/index.js'
import { withToolChange } from '../lib/tool-changes.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { assert, test, report, wait, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { legacyComponent } from './lib/legacy-component.mjs'
const discovery = legacyComponent(discoveryModule)

const foreignTool = name => ({
  name,
  description: `probe memo fixture ${name}`,
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
  execute: async () => ({ content: 'ok' }),
})

await test('an attributed unrelated scope change skips probes but unknown host notifications stay fresh', () => withTempDir('discovery', async dir => {
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
      // Package-owned sibling changes carry exact scope attribution; they cannot
      // affect this root agent, unlike an unknown external prompt/tool provider.
      await withToolChange([{}], () => ctx.serial('tools/change', {}))
      await wait(300)
      assert.equal(probes, settled, 'unrelated OPS registration must not re-probe')
      await ctx.serial('tools/change', {})
      await wait(300)
      assert.ok(probes > settled, 'unknown registry notifications conservatively invalidate the verdict')
      registered()
    } finally { prompt.assemble = assemble }
  } finally { await shutdown(ctx) }
}))

await test('a live cwd change invalidates the presentation memo while the session header stays fixed', () => withTempDir('discovery-live-cwd', async root => {
  const { ctx } = await bootHost()
  try {
    const live = path.join(root, 'tools'); fs.mkdirSync(live)
    let cwd = root
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
    await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: 'danger-full-access', workspaceRoot: root, sessionId: session.id }) }))
    await ctx.plugin(inner => inner.provide('workingDirectory', { get: () => cwd, ensure: async () => cwd }))
    const agents = [0, 1, 2].map(i => ({ id: 'memo-cwd-' + i, session: { id: 'memo-cwd-' + i, header: { cwd: root } } }))
    for (const agent of agents) agent.ctx = createScope(ctx, agent).ctx
    await ctx.plugin(discovery, { required: true })
    const prompt = ctx.get('systemPrompt'), assemble = prompt.assemble.bind(prompt)
    let probes = 0
    prompt.assemble = context => { if (isPresentationProbe(context) && context.scope === agents[0]) probes++; return assemble(context) }
    try {
      await ctx.serial('agent/created', { agent: agents[0], source: 'startup' })
      const first = probes
      assert.ok(first > 0)
      await ctx.serial('agent/created', { agent: agents[1], source: 'startup' })
      assert.equal(probes, first, 'unchanged roots retain their presentation verdict')
      cwd = live
      await ctx.serial('agent/created', { agent: agents[2], source: 'startup' })
      assert.ok(probes > first, 'an observed live cwd change must invalidate the old verdict')
      assert.equal(agents[0].session.header.cwd, root)
    } finally { prompt.assemble = assemble }
  } finally { await shutdown(ctx) }
}))

report('discovery-probe-memo')
