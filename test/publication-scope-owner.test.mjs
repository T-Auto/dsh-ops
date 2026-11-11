import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { acquirePtcFile, acquireSharedFile } from '../lib/publication/scope-owner.js'
import { NativeFileTools } from '../lib/projections/native/runtime.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep } from './lib/executor.mjs'
import { assert, test, report } from './lib/harness.mjs'

// The row ctx a caller hands over: a real plugin row is a sibling fiber, so it
// owns its own lifetime. ctx.plugin resolves to the row's Fiber (dispose, no
// event surface), so the ctx itself is captured from apply.
const rowOf = async (ctx, rows) => {
  let row
  const fiber = await ctx.plugin({ apply(inner) { row = inner } })
  rows.push(fiber)
  return { row, fiber }
}

await test('file owner shares static contracts and leases without transferring old step authority', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const agent = { id: 'shared-file-owner', session: { id: 'shared-file-owner' } }
    agent.ctx = createScope(ctx, agent).ctx
    const first = await acquirePtcFile(agent, 'grep')
    const second = await acquirePtcFile(agent, 'grep')
    const name = publicToolName('grep')
    const grant = label => ({ consumer: {}, agent, token: {}, entitled: true,
      dispatch: async () => ({ source: label }) })
    first.grant(grant('first'))
    const old = await prepareStep(ctx, agent); steps.push(old)
    second.grant(grant('second'))
    assert.equal(tools.definitions(agent).filter(def => def.name === name).length, 1)
    const ambiguous = await prepareStep(ctx, agent); steps.push(ambiguous)
    assert.equal(tools.executable(name, agent, ambiguous.toolSet), undefined)
    first.dispose()
    assert.equal(tools.executable(name, agent, old.toolSet), undefined)
    const fresh = await prepareStep(ctx, agent); steps.push(fresh)
    const current = tools.executable(name, agent, fresh.toolSet)
    assert.ok(current, 'remaining lease must keep the owner registered')
    assert.deepEqual(await current.execute({}, { agent, toolSet: fresh.toolSet }), { source: 'second' })
    second.dispose()
    assert.equal(tools.get(name, agent), undefined)
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
})

await test('presentation predicate only narrows a captured consumer', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const agent = { id: 'file-presentation', session: { id: 'file-presentation' } }
    agent.ctx = createScope(ctx, agent).ctx
    const lease = await acquirePtcFile(agent, 'grep')
    let visible = false
    lease.grant({ consumer: {}, agent, token: {}, entitled: true,
      present: () => visible, dispatch: async () => ({ source: 'fixed-consumer' }) })
    const name = publicToolName('grep'), definition = tools.get(name, agent)
    const hidden = await prepareStep(ctx, agent); steps.push(hidden)
    assert.equal(tools.executable(name, agent, hidden.toolSet), undefined)
    visible = true
    const shown = await prepareStep(ctx, agent); steps.push(shown)
    assert.equal(tools.get(name, agent), definition, 'when must not mutate registration')
    assert.equal(tools.executable(name, agent, hidden.toolSet), undefined, 'old hidden step must stay hidden')
    assert.equal(tools.executable(name, agent, shown.toolSet), definition)
    lease.dispose()
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
})
// One source serves every consumer row of an agent, so its event feed cannot
// belong to whichever row acquired first: the row that created the source may
// unload while the others keep working, and a feed that died with it left them
// with a runtime that could no longer invalidate evidence. The feed is owned by
// the source instead — an unscoped scope minted under the agent scope, which is
// the only combination of "agent lifetime" and "no scope tag" (the tag hides
// `session/event` and `session/disposed`).
const FEED_EVENTS = ['agent/disposed', 'llm/stream', 'session/disposed', 'session/event', 'tools/result']

await test('the shared source owns an unscoped feed that outlives the acquiring row', async () => {
  const { ctx, tools } = await bootHost()
  const owners = new Map()
  // Cordis reports every listener registration with the registering context as
  // `this`; no private bus state is read.
  const observe = ctx.on('internal/listener', function (name) {
    if (FEED_EVENTS.includes(name)) owners.set(name, this)
  })
  try {
    const agent = { id: 'shared-owner', session: { id: 'shared-owner' } }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    const { row, fiber } = await rowOf(ctx, [])
    const first = await acquireSharedFile(agent, 'stat', { workerPath: process.execPath })
    assert.deepEqual([...owners.keys()].sort(), [...FEED_EVENTS].sort(), 'every feed listener is registered exactly once')
    const feed = owners.get('session/event')
    assert.notEqual(feed, row, 'the acquiring row must not own the feed')
    assert.notEqual(feed, agent.ctx, 'the tagged agent view would lose the session events')
    assert.notEqual(feed, ctx, 'the feed must not be the composition root')
    assert.equal(scopeOf(feed), undefined, 'the feed must carry no scope tag')
    const second = await acquireSharedFile(agent, 'stat', { workerPath: process.execPath })
    assert.deepEqual([...owners.keys()].sort(), [...FEED_EVENTS].sort(), 'a second consumer reuses the feed instead of re-subscribing')
    await fiber.dispose()
    assert.doesNotThrow(() => feed.fiber.assertActive(), 'the feed outlives the row that acquired it')
    first.dispose()
    assert.doesNotThrow(() => feed.fiber.assertActive(), 'another consumer still holds the source')
    second.dispose()
    assert.equal(tools.get(publicToolName('stat'), agent), undefined, 'the last lease releases the publication')
    await scope.dispose()
    assert.throws(() => feed.fiber.assertActive(), /inactive/i, 'the feed dies with the agent scope')
  } finally { observe(); await shutdown(ctx) }
})

// Ownership is checked before any source is built: an acquisition that started
// against a scope which then disappears must not revive that scope's source.

await test('asynchronous acquisition cannot revive a disposed source owner', async () => {
  const { ctx, tools } = await bootHost()
  try {
    const agent = { id: 'disposed-owner', session: { id: 'disposed-owner' } }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    const acquisition = acquirePtcFile(agent, 'grep')
    const rejection = assert.rejects(acquisition, /inactive context/)
    await scope.dispose()
    await rejection
    await assert.rejects(acquireSharedFile(agent, 'stat', { workerPath: process.execPath }), /inactive context/)
    assert.deepEqual(tools.definitions(agent), [], 'no source or registration survives disposed ownership')
  } finally { await shutdown(ctx) }
})
report('publication-scope-owner')
