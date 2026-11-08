import { createScope } from '@deepseek-ai/dsh-scope'
import { acquirePtcFile, acquireSharedFile } from '../lib/publication/scope-owner.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep } from './lib/executor.mjs'
import { assert, test, report } from './lib/harness.mjs'

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
// A shared source reads through `agent.ctx` but must subscribe through the row
// context: the agent's scope tag hides `session/event` / `session/disposed`, and
// read-dedup would stop noticing source changes. The row context is passed
// explicitly, so a reverted call path leaves it with no listener at all.
await test('a shared source subscribes through the row context it is given', async () => {
  const { ctx } = await bootHost()
  try {
    const agent = { id: 'shared-row-events', session: { id: 'shared-row-events' } }
    agent.ctx = createScope(ctx, agent).ctx
    const subscribed = [], disposed = []
    const row = { on(name) { subscribed.push(name); return () => disposed.push(name) } }
    const lease = await acquireSharedFile(agent, 'stat', { workerPath: process.execPath }, row)
    try {
      assert.ok(subscribed.includes('session/event'), `row context receives session/event: ${subscribed.join(', ')}`)
      assert.ok(subscribed.includes('session/disposed'), `row context receives session/disposed: ${subscribed.join(', ')}`)
    } finally { lease.dispose() }
    assert.ok(disposed.includes('session/event'), 'disposing the lease releases the row subscriptions')
  } finally { await shutdown(ctx) }
})

await test('subscribing on the reading ctx is refused instead of silently degrading', async () => {
  const { ctx, tools } = await bootHost()
  try {
    const agent = { id: 'shared-scoped-events', session: { id: 'shared-scoped-events' } }
    agent.ctx = createScope(ctx, agent).ctx
    await assert.rejects(acquireSharedFile(agent, 'stat', { workerPath: process.execPath }, agent.ctx),
      /must not be the reading ctx/)
    assert.deepEqual(tools.definitions(agent), [], 'a refused subscription context creates neither a source nor a registration')
    // The same config succeeds once a row context supplies the subscription: the
    // refusal leaves no source behind to be reported as a conflicting one.
    const lease = await acquireSharedFile(agent, 'stat', { workerPath: process.execPath },
      { on() { return () => {} } })
    lease.dispose()
  } finally { await shutdown(ctx) }
})

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
