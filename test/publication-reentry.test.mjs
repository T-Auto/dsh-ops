import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { publicationRegistration, publicationReady, publicationPending, appendReentry } from '../lib/publication/reentry.js'
import { acquire } from '../lib/publication/registrar.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep } from './lib/executor.mjs'
import { assert, test, report } from './lib/harness.mjs'

const refusal = () => new Error('session append cannot reenter while another append is being published')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const ready = async dispose => {
  let timer
  try {
    await Promise.race([publicationReady(dispose), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('publication did not settle within 4s')), 4000)
    })])
  } finally { clearTimeout(timer) }
}
const definition = name => ({ name, description: name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })

await test('classification is total and ordinary errors remain synchronous without retries', async () => {
  const { ctx } = await bootHost()
  try {
    assert.equal(appendReentry(refusal()), true)
    assert.equal(appendReentry({ cause: refusal() }), false)
    const hostile = { get message() { throw new Error('getter must be contained') } }
    assert.equal(appendReentry(hostile), false)
    let attempts = 0
    assert.throws(() => publicationRegistration(ctx, () => { ++attempts; throw hostile }), error => error === hostile)
    await wait(100)
    assert.equal(attempts, 1)
  } finally { await shutdown(ctx) }
})

await test('two hundred scopes share one bounded refusal queue and recover without another event', async () => {
  const { ctx, tools } = await bootHost()
  let locked = true, attempts = 0
  const messages = [], leases = [], scopes = []
  ctx.logger.warn = message => messages.push(message)
  try {
    for (let i = 0; i < 200; ++i) {
      const agent = { id: `queued-${i}` }, scope = createScope(ctx, agent)
      scopes.push({ agent, scope })
      leases.push(publicationRegistration(scope.ctx, () => {
        ++attempts
        if (locked) throw refusal()
        return scope.ctx.get('tools').register(definition('queue-fixture'))
      }))
    }
    assert.equal(attempts, 1, 'new sessions must not bypass the shared cooldown')
    await wait(1150)
    assert.ok(attempts <= 5, `held window made ${attempts} registry attempts`)
    assert.ok(messages.length <= 2, messages.join('\n'))
    for (const { agent } of scopes) assert.equal(tools.get('queue-fixture', agent), undefined)
    locked = false
    await Promise.all(leases.map(ready))
    for (const { agent } of scopes) assert.ok(tools.get('queue-fixture', agent))
    const recovery = messages.find(message => message.includes('recovered after'))
    assert.match(recovery, /\d+ refusal\(s\) \([1-9]\d* suppressed\)/)
  } finally { leases.forEach(dispose => dispose()); await shutdown(ctx) }
})

await test('refused withdrawal retains its undo and precedes a queued replacement', async () => {
  const { ctx, tools } = await bootHost()
  const agent = { id: 'withdraw-queue' }, scope = createScope(ctx, agent)
  let locked = false, removals = 0
  try {
    const original = publicationRegistration(scope.ctx, () => {
      const undo = scope.ctx.get('tools').register(definition('queue-fixture'))
      return () => { ++removals; if (locked) throw refusal(); undo() }
    })
    locked = true
    original()
    assert.ok(tools.get('queue-fixture', agent), 'refused pre-mutation cleanup must retain the actual layer')
    const replacement = publicationRegistration(scope.ctx, () => scope.ctx.get('tools').register(definition('queue-fixture')))
    assert.equal(removals, 1, 'queued replacement cannot inline-retry an owed withdrawal')
    locked = false
    await ready(replacement)
    assert.equal(removals, 2)
    assert.ok(tools.get('queue-fixture', agent))
    replacement()
    assert.equal(tools.get('queue-fixture', agent), undefined)
  } finally { await shutdown(ctx) }
})

await test('scope teardown cancels pending publication and automatic host effects leave no residue', async () => {
  const { ctx, tools } = await bootHost()
  let locked = true, attempts = 0
  const agent = { id: 'cancel-queue' }, scope = createScope(ctx, agent)
  try {
    const pending = publicationRegistration(scope.ctx, () => {
      ++attempts
      if (locked) throw refusal()
      return scope.ctx.get('tools').register(definition('queue-fixture'))
    })
    await scope.dispose()
    await assert.rejects(publicationReady(pending), /cancelled/)
    locked = false
    await wait(100)
    assert.equal(attempts, 1)
    assert.deepEqual(tools.definitions(agent), [])
    const other = { id: 'automatic-cleanup' }, otherScope = createScope(ctx, other)
    publicationRegistration(otherScope.ctx, () => {
      const undo = otherScope.ctx.get('tools').register(definition('automatic-fixture'))
      return () => { if (locked) throw refusal(); undo() }
    })
    locked = true
    await otherScope.dispose()
    locked = false
    await wait(100)
    assert.deepEqual(tools.definitions(other), [], 'the host-owned effect and queued wrapper must both settle')
  } finally { await shutdown(ctx) }
})

await test('a permanent error after cooldown rejects readiness once and never retries', async () => {
  const { ctx } = await bootHost()
  let locked = true, failures = 0
  const messages = []
  ctx.logger.warn = message => messages.push(message)
  try {
    const blocker = publicationRegistration(ctx, () => { if (locked) throw refusal(); return () => {} })
    const failed = publicationRegistration(ctx, () => { ++failures; throw new Error('permanent configuration error') })
    locked = false
    await ready(blocker)
    await assert.rejects(publicationReady(failed), /permanent configuration error/)
    assert.equal(publicationPending(failed), false, 'permanent failure must not freeze controller reconciliation as pending')
    await wait(150)
    assert.equal(failures, 1)
    assert.equal(messages.filter(message => message.includes('permanent configuration error')).length, 1)
  } finally { await shutdown(ctx) }
})

await test('shared lease readiness follows a queued grant generation replaced by another consumer', async () => {
  const { ctx, tools } = await bootHost()
  const agent = { id: 'shared-ready-generation' }, scope = createScope(ctx, agent)
  const name = publicToolName('stat'), { name: _name, execute: _execute, ...canonical } = definition(name)
  let locked = true, first, second
  try {
    const blocker = publicationRegistration(ctx, () => { if (locked) throw refusal(); return () => {} })
    first = await acquire(scope.ctx, agent, name, canonical)
    second = await acquire(scope.ctx, agent, name, canonical)
    const dispatch = async () => ({})
    first.grant({ consumer: {}, agent, token: {}, entitled: true, dispatch })
    const readiness = first.ready()
    void readiness.catch(() => {})
    second.grant({ consumer: {}, agent, token: {}, entitled: true, dispatch })
    locked = false
    await ready(blocker)
    await readiness
    await second.ready()
    assert.ok(tools.get(name, agent), 'both consumer leases await the current shared registration')
    assert.equal(tools.definitions(agent).filter(tool => tool.name === name).length, 1)
  } finally { locked = false; first?.dispose(); second?.dispose(); await shutdown(ctx) }
})

await test('synchronous cancellation during queued registration retains a refused undo before replacement', async () => {
  const { ctx, tools } = await bootHost()
  const agent = { id: 'cancel-during-register' }, scope = createScope(ctx, agent)
  let held = true, refuseUndo = true, target, replacement, cancelled = false
  try {
    const blocker = publicationRegistration(ctx, () => { if (held) throw refusal(); return () => {} })
    const unwatch = ctx.on('tools/change', () => {
      if (cancelled || !target || !tools.get('in-flight-fixture', agent)) return
      cancelled = true
      target()
      replacement = publicationRegistration(scope.ctx, () => scope.ctx.get('tools').register(definition('in-flight-fixture')))
    })
    target = publicationRegistration(scope.ctx, () => {
      const undo = scope.ctx.get('tools').register(definition('in-flight-fixture'))
      return () => { if (refuseUndo) throw refusal(); undo() }
    })
    held = false
    await ready(blocker)
    await assert.rejects(publicationReady(target), /cancelled during/)
    assert.ok(tools.get('in-flight-fixture', agent), 'refused synchronous cancellation still owes the exact undo')
    refuseUndo = false
    await ready(replacement)
    assert.equal(tools.definitions(agent).filter(tool => tool.name === 'in-flight-fixture').length, 1)
    replacement()
    assert.equal(tools.get('in-flight-fixture', agent), undefined)
    unwatch()
  } finally { held = false; refuseUndo = false; await shutdown(ctx) }
})

await test('real session append ordering rolls back refused registry effects and recovers grant rotation', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create('real-publication-reentry')
    const agent = { id: 'real-publication-reentry', session }
    agent.ctx = createScope(ctx, agent).ctx
    const { name, execute: _execute, ...canonical } = definition('grant-fixture')
    const lease = await acquire(agent.ctx, agent, name, canonical)
    const grant = { consumer: {}, agent, token: {}, entitled: true, dispatch: async () => ({ source: 'current' }) }
    let revoke = lease.grant(grant)
    const old = await prepareStep(ctx, agent); steps.push(old)
    let rotate = false, rejected = 0
    ctx.on('tools/change', () => {
      try { appendPluginRecord(session, 'plugin:reentry/registry', {}) }
      catch (error) { ++rejected; throw error }
    })
    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'plugin:reentry/trigger' || rotate) return
      rotate = true
      revoke()
      revoke = lease.grant({ ...grant, token: {} })
    })
    appendPluginRecord(session, 'plugin:reentry/trigger', {})
    assert.ok(rejected > 0, 'the actual host append lock must reject the nested append')
    assert.equal(tools.executable(name, agent, old.toolSet), undefined, 'old captured admission cannot gain the replacement grant')
    await wait(100)
    const fresh = await prepareStep(ctx, agent); steps.push(fresh)
    assert.ok(tools.executable(name, agent, fresh.toolSet), 'a fresh step recovers without a further host event')
    assert.equal(tools.definitions(agent).filter(tool => tool.name === name).length, 1)
    revoke(); lease.dispose()
    assert.equal(tools.get(name, agent), undefined)
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
})

await test('two rows share one refusal window and the first row leaving keeps it alive', async () => {
  const { ctx, tools } = await bootHost()
  const agents = [{ id: 'shared-window-a' }, { id: 'shared-window-b' }]
  const [rowA, rowB] = agents.map(agent => createScope(ctx, agent))
  let locked = true, attempts = 0
  try {
    publicationRegistration(rowA.ctx, () => {
      if (locked) throw refusal()
      return rowA.ctx.get('tools').register(definition('row-a-fixture'))
    })
    const second = publicationRegistration(rowB.ctx, () => {
      ++attempts
      if (locked) throw refusal()
      return rowB.ctx.get('tools').register(definition('row-b-fixture'))
    })
    await wait(160)
    assert.equal(attempts, 0, 'one queue holds row B behind the row A operation that opened the window')
    locked = false
    await rowA.dispose()
    await ready(second)
    assert.ok(tools.get('row-b-fixture', agents[1]), 'row B settles after row A is gone')
    assert.equal(tools.get('row-a-fixture', agents[0]), undefined, 'row A never published')
  } finally { locked = false; await rowB.dispose(); await shutdown(ctx) }
})

await test('a fiber buys one queue life however many contexts it derives', async () => {
  const { ctx, tools } = await bootHost()
  let inner
  const fiber = await ctx.plugin({ inject: ['tools'], apply(pluginCtx) { inner = pluginCtx } })
  let locked = true
  const owned = fiber => fiber.getEffects().filter(effect => effect.label === 'dsh-ops: registry refusal queue').length
  try {
    const derived = [inner.extend(), inner.extend()]
    assert.notEqual(derived[0], derived[1], 'extend returns distinct context objects')
    assert.equal(derived[0].fiber, derived[1].fiber, 'both derived contexts belong to the one plugin fiber')
    const pending = derived.map(entry => publicationRegistration(entry, () => {
      if (locked) throw refusal()
      return entry.get('tools').register(definition('derived-fixture'))
    }))
    assert.equal(owned(derived[0].fiber), 1, 'two derived contexts buy one queue reference, not one each')
    assert.equal(owned(ctx.fiber), 0, 'the composition root owns no part of the queue')
    await fiber.dispose()
    for (const dispose of pending) await assert.rejects(publicationReady(dispose), /cancelled/)
    // The queue must be destroyed, not merely stopped: the next row has to get a working one.
    const nextAgent = { id: 'derived-contexts-next' }, next = createScope(ctx, nextAgent)
    try {
      const lease = publicationRegistration(next.ctx, () => next.ctx.get('tools').register(definition('next-fixture')))
      await ready(lease)
      assert.ok(tools.get('next-fixture', nextAgent), 'the queue is rebuilt after its last owner released it')
    } finally { await next.dispose() }
  } finally { locked = false; await shutdown(ctx) }
})

await test('a queue refused the effect that would release it is not left half built', async () => {
  const { ctx } = await bootHost()
  let attempts = 0
  const agent = { id: 'half-built-queue' }, scope = createScope(ctx, agent)
  try {
    // A guarded host refuses the effect the queue has to own itself; the lease
    // of the registration itself is untouched, exactly like dsh-tui's refusal.
    const inherited = scope.ctx.effect.bind(scope.ctx)
    const guarded = scope.ctx.extend()
    guarded.effect = (execute, label) => {
      if (label === 'dsh-ops: registry refusal queue') throw new Error('root.effect is unavailable from a plugin activation')
      return inherited(execute, label)
    }
    const register = () => publicationRegistration(guarded, () => { ++attempts; return () => {} })
    assert.throws(register, /root.effect is unavailable/)
    assert.throws(register, /root.effect is unavailable/, 'a rejected retain must not leave a reusable queue behind')
    assert.equal(attempts, 0, 'the half-built queue must never run the work it failed to own')
  } finally { await scope.dispose(); await shutdown(ctx) }
})

report('publication-reentry')
