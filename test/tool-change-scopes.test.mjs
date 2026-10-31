/** A host that names the changed scope must not cost every live session a probe. */
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as discoveryModule from '../lib/discovery/index.js'
import { legacyComponent } from './lib/legacy-component.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { isPresentationProbe } from '../lib/presentation.js'
import { assert, test, report, wait, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

const discovery = legacyComponent(discoveryModule)

const liveCount = 4

requireWorker('tool-change-scopes')
await test('a host-attributed tools/change probes only the named scope, while a bare one stays conservative', () => withTempDir('tool-change-scopes', async dir => {
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

    const makeAgent = id => ({ id, session: { id, mode: 'danger-full-access', header: { cwd: dir } } })
    const live = []
    for (let index = 0; index < liveCount; index += 1) {
      const agent = makeAgent(`live-${index}`)
      agent.ctx = createScope(ctx, agent).ctx
      await ctx.serial('agent/created', { agent, source: 'startup' })
      await wait(60)
      live.push(agent)
    }
    const fresh = makeAgent('fresh')
    fresh.ctx = createScope(ctx, fresh).ctx
    await ctx.serial('agent/created', { agent: fresh, source: 'create' })
    await wait(200)

    const liveProbes = () => live.reduce((sum, agent) => sum + (probes.get(agent) ?? 0), 0)

    // A host that names the changed scope: only that scope may be re-probed.
    probes.clear()
    await ctx.serial('tools/change', { scope: fresh })
    await wait(250)
    assert.equal(liveProbes(), 0, 'a scope-attributed change must not re-probe sibling sessions')

    // A host that names nothing: every scope may have moved, so the cached verdicts
    // are all invalidated, but only one representative session pays a probe now.
    probes.clear()
    await ctx.serial('tools/change', {})
    await wait(250)
    assert.equal(liveProbes(), 1, 'an unattributed change must probe exactly one representative session')

    // A named scope that sits on no tracked session's chain still means the registry
    // moved. Dropping it would leave every cached verdict standing on a registry that
    // already changed, so it must fall back to the conservative path.
    probes.clear()
    const stranger = makeAgent('stranger')
    await ctx.serial('tools/change', { scope: stranger })
    await wait(250)
    assert.equal(liveProbes(), 1, 'a scope on no tracked chain must fall back to the conservative path')

  } finally { await shutdown(ctx) }
}))

report('tool-change-scopes')
