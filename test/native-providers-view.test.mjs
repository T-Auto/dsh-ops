/**
 * One provider scan reads one scope view.
 *
 * `nativeProviders` asks, for every candidate provider, whether that scope
 * resolves the provider's own definition under its name. Asking the registry
 * per provider costs one full `view()` rebuild each, because that is exactly
 * what `tools.get(name, scope)` does. A PTC publish scans every provider of
 * every live scope, so the per-provider form made a single registry event
 * rebuild the view O(live sessions × providers) times — 82,365 rebuilds for
 * one unattributed change over 198 sessions.
 *
 * The view already holds every answer the scan needs, so these tests pin both
 * halves: the answer stays the same, and one scan costs one view.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import { nativeProviders, registerNativeProviderAtScope } from '../lib/publication/providers.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

const tool = name => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
  execute: async () => ({ content: 'ok' }),
})

/**
 * Register `count` native providers into one agent's own scope.
 * @param {object} ctx - host context.
 * @param {object} agent - the owning agent.
 * @param {number} count - how many providers to publish.
 * @returns {void}
 */
const publish = (ctx, agent, count) => {
  const definitions = Array.from({ length: count }, (_unused, index) => tool(`provider_${index}`))
  registerNativeProviderAtScope(ctx, agent, definitions, definition => agent.ctx.tools.register(definition))
}

await test('one provider scan rebuilds the scope view exactly once', () => withTempDir('providers-view', async cwd => {
  const { ctx } = await bootHost()
  try {
    const agent = { id: 'providers-view', session: { id: 'providers-view', mode: 'danger-full-access', header: { cwd } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    publish(ctx, agent, 50)

    const tools = ctx.get('tools'), real = tools.view.bind(tools)
    let views = 0
    tools.view = scope => { views += 1; return real(scope) }

    const found = nativeProviders(ctx, agent)
    assert.equal(found.length, 50, 'all 50 providers resolve to their own definitions')
    assert.equal(views, 1, `one scan must read the view once, read ${views}`)
  } finally { await shutdown(ctx) }
}))

await test('a shadowed provider is still excluded when the view is read once', () => withTempDir('providers-view', async cwd => {
  const { ctx } = await bootHost()
  try {
    const parent = { id: 'providers-shadow', session: { id: 'providers-shadow', mode: 'danger-full-access', header: { cwd } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { parent.ctx = createScope(inner, parent).ctx } })
    publish(ctx, parent, 3)

    // A same-named registration in a NEARER layer shadows the provider for that
    // child, so the child no longer resolves the provider's exact definition and
    // the scan must drop it. This is the difference between "a name is visible"
    // and "this object is what the scope sees", and reading the view once must
    // preserve it: the view carries the resolved definition, not just the name.
    const child = { id: 'providers-shadow-child', session: { id: 'providers-shadow-child', mode: 'danger-full-access', header: { cwd } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { child.ctx = createScope(inner, child, { parent }).ctx } })
    await child.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(tool('provider_1')) } })

    const found = nativeProviders(ctx, child).map(provider => provider.definition.name).sort()
    assert.deepEqual(found, ['provider_0', 'provider_2'])
    assert.equal(nativeProviders(ctx, parent).length, 3, 'the parent scope itself is unshadowed')
  } finally { await shutdown(ctx) }
}))

report()
