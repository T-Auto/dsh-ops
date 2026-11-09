import { createScope } from '@deepseek-ai/dsh-scope'
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
// A shared source reads through `agent.ctx` but must subscribe through the row
// context: the agent's scope tag hides `session/event` / `session/disposed`, and
// read-dedup would stop noticing source changes. The row context is passed
// explicitly, so a call path that lets it go missing must be refused rather than
// fall back to the agent scope (the three refusals below).
await test('a shared source subscribes through the row context it is given', async () => {
  const { ctx } = await bootHost()
  const rows = []
  try {
    const agent = { id: 'shared-row-events', session: { id: 'shared-row-events' } }
    agent.ctx = createScope(ctx, agent).ctx
    const { row } = await rowOf(ctx, rows)
    const seen = []
    const observers = [row.on('session/event', () => seen.push('session/event')),
      row.on('session/disposed', () => seen.push('session/disposed'))]
    const lease = await acquireSharedFile(agent, 'stat', { workerPath: process.execPath }, row)
    try {
      await ctx.serial('session/event', agent.session, { type: 'step/end' })
      await ctx.serial('session/disposed', agent.session)
      assert.deepEqual([...new Set(seen)].sort(), ['session/disposed', 'session/event'],
        `row context receives the session events: ${seen.join(', ') || 'none'}`)
    } finally { observers.forEach(observe => observe()); lease.dispose() }
  } finally { rows.forEach(row => row.dispose()); await shutdown(ctx) }
})

// Fail closed on the two shapes that silently degraded before: leaving the
// subscription context out altogether, and deriving one that shares the agent's
// single fiber. Neither is caught by the type: JS callers, `as any` and every
// argument shape the compiler never sees go straight through it.
await test('omitting, reusing or extending the reading ctx is refused instead of silently degrading', async () => {
  const { ctx, tools } = await bootHost()
  const rows = []
  try {
    const agent = { id: 'shared-scoped-events', session: { id: 'shared-scoped-events' } }
    agent.ctx = createScope(ctx, agent).ctx
    const config = { workerPath: process.execPath }
    await assert.rejects(acquireSharedFile(agent, 'stat', config),
      /subscription context is required/, 'omitting the fourth argument must not fall back to the agent scope')
    await assert.rejects(acquireSharedFile(agent, 'stat', config, agent.ctx),
      /must not be the reading ctx/, 'the reading ctx must be refused by identity')
    await assert.rejects(acquireSharedFile(agent, 'stat', config, agent.ctx.extend({})),
      /must not be the reading ctx/, 'a context extending the reading ctx shares its fiber and must be refused too')
    assert.deepEqual(tools.definitions(agent), [], 'a refused subscription context creates neither a source nor a registration')
    // The same config succeeds once a row context supplies the subscription: the
    // refusals leave no source behind to be reported as a conflicting one.
    const lease = await acquireSharedFile(agent, 'stat', config, (await rowOf(ctx, rows)).row)
    lease.dispose()
  } finally { rows.forEach(row => row.dispose()); await shutdown(ctx) }
})

// The source is built on the first caller's row context and subscribes its feed
// there, so it must not outlive that row. Agent-keyed reuse plus agent-owned
// teardown left a deaf source behind: the row unloaded, the seven feed
// subscriptions died with it, and every later call kept using the source that
// could no longer see `session/event` or `session/disposed`. The replacement is
// a whole new source, restarted from the next caller's own row.
await test('unloading the building row closes the source, and the next caller rebuilds it', async () => {
  const { ctx } = await bootHost()
  const rows = []
  const original = { start: NativeFileTools.prototype.start, stop: NativeFileTools.prototype.stop }
  const started = [], stopped = []
  NativeFileTools.prototype.start = async function (...args) {
    started.push(this)
    // No names: the real start returns before it would spawn a worker.
    return original.start.apply(this, args)
  }
  NativeFileTools.prototype.stop = async function (...args) {
    stopped.push(this)
    return original.stop.apply(this, args)
  }
  try {
    const agent = { id: 'shared-row-lifetime', session: { id: 'shared-row-lifetime' } }
    agent.ctx = createScope(ctx, agent).ctx
    const first = await rowOf(ctx, rows)
    const lease = await acquireSharedFile(agent, 'stat', { workerPath: process.execPath }, first.row)
    assert.equal(started.length, 1, 'one source is built for the agent')
    const [runtime] = started
    assert.equal(runtime.events, first.row, 'the source subscribes through the row that built it')
    assert.equal(stopped.length, 0, 'the source is running while its row is alive')
    await first.fiber.dispose()
    // Unloading the row closes its source instead of leaving it serving through
    // the still-live agent scope with a feed that died with the row.
    assert.equal(stopped.length, 1, 'the building row\'s unload must stop the source it created')
    assert.equal(stopped[0], runtime, 'the stopped runtime is exactly the one this row built')
    lease.dispose()
    // The next caller rebuilds from its own row: agent-keyed reuse must not hand
    // back the closed source.
    const second = await rowOf(ctx, rows)
    const rebuilt = await acquireSharedFile(agent, 'stat', { workerPath: process.execPath }, second.row)
    try {
      assert.equal(started.length, 2, 'the source is rebuilt rather than reused')
      assert.notEqual(started[1], runtime, 'the rebuilt source is a new runtime')
      assert.equal(started[1].events, second.row, 'the rebuilt source subscribes through the rebuilding row')
      await rebuilt.ready()
    } finally { rebuilt.dispose() }
  } finally {
    NativeFileTools.prototype.start = original.start
    NativeFileTools.prototype.stop = original.stop
    rows.forEach(row => row.dispose()); await shutdown(ctx)
  }
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
    const { fiber } = await rowOf(ctx, [])
    try { await assert.rejects(acquireSharedFile(agent, 'stat', { workerPath: process.execPath }, fiber), /inactive context/) }
    finally { fiber.dispose() }
    assert.deepEqual(tools.definitions(agent), [], 'no source or registration survives disposed ownership')
  } finally { await shutdown(ctx) }
})
report('publication-scope-owner')
