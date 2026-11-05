/**
 * #578: a replaced official tool stays callable while the assembled request
 * still carries it.
 *
 * The mask is registry state, the model's request is a snapshot taken before
 * it. When the replacement lands between the two, the model is still holding
 * `read` and has never seen the counterpart it is told to call; denying `read`
 * then leaves the session with neither half of the swap. The guard therefore
 * answers for the request that produced the call, not for the registry's
 * current opinion.
 */
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import { inspectPresentation } from '../lib/publication/presentation.js'
import { mountReplacements } from '../lib/publication/replacements.js'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, test, report, wait, waitFor, withTempDir } from './lib/harness.mjs'

const COUNTERPART = 'ops_inspect_local_file'
const tool = name => ({ name, description: 'fixture ' + name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ ran: name }) })

/** A scope that inherits the tools dependency API, so registrations and restrictions work. */
async function scopedContext(parent, key, parentKey) {
  let scoped
  await parent.plugin({ inject: ['tools'], apply(inner) { scoped = createScope(inner, key, parentKey ? { parent: parentKey } : undefined).ctx } })
  return scoped
}

/** The ordered pre-execute stage a model-direct dispatch reaches before the body. */
const preExecute = (ctx, agent, name) => ctx.waterfall('tools/pre-execute',
  { callId: 'test', name, arguments: {}, signal: new AbortController().signal, agent },
  () => Promise.resolve({ kind: 'allow' }))

/** The whole dispatch the host performs for a model-direct call, guard included. */
const dispatch = (ctx, agent, name) => ctx.get('tools').execute(
  { callId: 'test', name, arguments: {}, signal: new AbortController().signal, agent })

await test('a replaced official tool stays callable for the request that still carries it (#578)', () => withTempDir('replacement-admission', async cwd => {
  const { ctx } = await bootHost()
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }) })
  const live = []
  ctx.provide('agents', { list: () => [...live] })
  const presets = new Map()
  ctx.provide('agentPresets', { composedPreset: scoped => presets.get(scopeParentOf(scopeOf(scoped))) })
  const presetScope = await scopedContext(ctx, { preset: 'admission-preset' })
  presets.set(scopeOf(presetScope), 'standard')
  presetScope.tools.register(tool('read'))
  const agent = { id: 'admission', session: { id: 'admission', mode: 'danger-full-access', header: { cwd } } }
  agent.ctx = await scopedContext(presetScope, agent, scopeOf(presetScope))
  live.push(agent)

  const mounted = await ctx.plugin({ name: 'fixture-replacements', apply(inner) {
    mountReplacements(inner, { id: 'standard', targets: new Map([['read', COUNTERPART]]), gate: { allows: () => true }, keepOfficial: () => false })
  } })
  try {
    await ctx.serial('agent/created', { agent, source: 'startup' })
    await wait(100)
    // The request the model holds: the official tool, no replacement yet.
    const held = await ctx.get('systemPrompt').assemble({ scope: agent, agent, signal: new AbortController().signal })
    const heldNames = (held.tools ?? []).map(entry => entry.name)
    assert.equal(heldNames.includes('read'), true)
    assert.equal(heldNames.includes(COUNTERPART), false)

    // The replacement lands after that request was captured. The call the model makes next
    // names the tool that request carried, so the whole dispatch — not only the waterfall —
    // has to reach the body; a refusal here is what left the reported session with neither
    // half of the swap.
    agent.ctx.tools.register(tool(COUNTERPART))
    const carried = await dispatch(ctx, agent, 'read')
    assert.equal(carried.isError, false, 'the call the model can actually make must not be refused')
    assert.equal(carried.value?.ran, 'read', 'the official tool body must run for that call')

    await waitFor(() => scopedToolNames(ctx, agent).includes('read') === false, { what: 'the mask applies' })

    const decision = await preExecute(ctx, agent, 'read')
    assert.equal(decision.kind, 'allow', 'the model must keep the half of the swap it was actually offered')

    // A presentation probe publishes nothing, so it is not the surface the model holds and
    // must not overwrite the snapshot the guard answers for.
    await inspectPresentation(ctx.get('systemPrompt'), agent)
    const afterProbe = await preExecute(ctx, agent, 'read')
    assert.equal(afterProbe.kind, 'allow', 'a presentation probe must not become the model surface')

    // The next request carries the replacement, so the denial is correct again.
    const next = await ctx.get('systemPrompt').assemble({ scope: agent, agent, signal: new AbortController().signal })
    const nextNames = (next.tools ?? []).map(entry => entry.name)
    assert.equal(nextNames.includes(COUNTERPART), true)
    assert.equal(nextNames.includes('read'), false)
    const later = await preExecute(ctx, agent, 'read')
    assert.equal(later.kind, 'deny')
    assert.equal(String(later.reason ?? '').includes(COUNTERPART), true)
  } finally {
    await mounted?.dispose?.()
    await shutdown(ctx)
  }
}))
report('replacements-admission')
