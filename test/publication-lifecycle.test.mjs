/** Direct shared-helper contracts; no replacement controller or agent notification is mounted. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { publicationRegistration, publicationReady, publicationLeaseState, publicationPending } from '../lib/publication/reentry.js'
import { acquire } from '../lib/publication/registrar.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report } from './lib/harness.mjs'

const leaseLabel = 'dsh-ops: registry publication lease'
const queueLabel = 'dsh-ops: registry refusal queue'
const tick = () => new Promise(resolve => setImmediate(resolve))
const refusal = () => new Error('session append cannot reenter while another append is being published')
const contains = (error, target) => error === target || error instanceof AggregateError && error.errors.some(item => contains(item, target))
const definition = name => ({ name, description: name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
const ready = async dispose => {
  let timer
  try {
    await Promise.race([publicationReady(dispose), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('publication did not settle within 4s')), 4000)
    })])
  } finally { clearTimeout(timer) }
}

// Characterize the current synchronous failure contract, not a new swallow-error policy.
// A proposed guard returning an untracked no-op must also expose its false readiness here.
async function setupFailure(register, matches) {
  let dispose, failure
  try { dispose = register() } catch (error) { failure = error }
  if (!failure) {
    let outcome = 'resolved'
    try { await ready(dispose) } catch (error) { outcome = 'rejected: ' + error.message }
    dispose?.()
    assert.fail('setup must fail synchronously for rollback; returned readiness=' + outcome)
  }
  assert.ok(matches(failure), 'the original setup error must reach the caller: ' + failure)
  return failure
}

await test('a disposed scope returns cancelled readiness without applying or stopping a healthy sibling', async () => {
  const { ctx, tools } = await bootHost()
  const stale = { id: 'direct-stale' }, healthy = { id: 'direct-healthy' }
  const dead = createScope(ctx, stale), live = createScope(ctx, healthy)
  let attempts = 0, dispose
  try {
    await dead.dispose()
    assert.equal(dead.ctx.fiber.uid, null)
    const cancelled = publicationRegistration(dead.ctx, () => {
      ++attempts
      return dead.ctx.get('tools').register(definition('dead-publication'))
    })
    const rejected = publicationReady(cancelled)
    assert.equal(publicationReady(cancelled), rejected, 'the cancelled handle must retain its failed work')
    await assert.rejects(rejected, /Publication owner inactive/)
    assert.equal(publicationLeaseState(cancelled), 'cancelled')
    assert.equal(publicationPending(cancelled), false)
    cancelled()
    cancelled()
    await assert.rejects(publicationReady(cancelled), /Publication owner inactive/)
    assert.equal(attempts, 0)
    assert.equal(tools.get('dead-publication', stale), undefined)
    dispose = publicationRegistration(live.ctx, () => live.ctx.get('tools').register(definition('healthy-publication')))
    await ready(dispose)
    assert.equal(publicationLeaseState(dispose), 'settled')
    assert.equal(publicationPending(dispose), false)
    assert.ok(tools.get('healthy-publication', healthy))
    dispose()
    dispose()
    assert.equal(tools.get('healthy-publication', healthy), undefined)
  } finally { dispose?.(); await shutdown(ctx) }
})

await test('disposal between queue setup and lease creation returns cancelled readiness without applying', async () => {
  const { ctx } = await bootHost()
  const scope = createScope(ctx, { id: 'direct-setup-race' })
  const effect = scope.ctx.effect.bind(scope.ctx)
  let disposal, attempts = 0, reached = false
  scope.ctx.effect = (body, label) => {
    if (label === leaseLabel) {
      reached = true
      disposal = scope.rawDispose()
    }
    return effect(body, label)
  }
  try {
    const cancelled = publicationRegistration(scope.ctx, () => { ++attempts; return () => {} })
    await assert.rejects(publicationReady(cancelled), /Publication owner inactive/)
    assert.equal(publicationLeaseState(cancelled), 'cancelled')
    assert.equal(publicationPending(cancelled), false)
    cancelled()
    assert.equal(reached, true)
    assert.equal(scope.ctx.fiber.uid, null)
    assert.equal(attempts, 0)
  } finally { scope.ctx.effect = effect; await disposal; await shutdown(ctx) }
})

await test('a live lease setup failure retains the original synchronous error and never applies', async () => {
  const { ctx } = await bootHost()
  const scope = createScope(ctx, { id: 'direct-live-setup-error' })
  const effect = scope.ctx.effect.bind(scope.ctx)
  const failure = new Error('fixture original setup error')
  let attempts = 0
  scope.ctx.effect = (body, label) => {
    if (label === leaseLabel) throw failure
    return effect(body, label)
  }
  try {
    await setupFailure(() => publicationRegistration(scope.ctx, () => { ++attempts; return () => {} }),
      error => error === failure)
    assert.notEqual(scope.ctx.fiber.uid, null, 'ordinary setup errors are not scope disposal')
    assert.equal(attempts, 0)
  } finally { scope.ctx.effect = effect; await shutdown(ctx) }
})

await test('a live lease setup error reaches the registrar and rolls back its grant', async () => {
  const { ctx, tools } = await bootHost()
  const agent = { id: 'direct-grant-rollback' }, scope = createScope(ctx, agent)
  const effect = scope.ctx.effect.bind(scope.ctx)
  const failure = new Error('fixture lease setup refused')
  const { name, execute: _execute, ...canonical } = definition('rollback-publication')
  let lease, cancellations = 0
  try {
    lease = await acquire(scope.ctx, agent, name, canonical)
    scope.ctx.effect = (body, label) => {
      if (label === leaseLabel) throw failure
      return effect(body, label)
    }
    assert.throws(() => lease.grant({ consumer: {}, agent, token: {}, entitled: true,
      dispatch: async () => ({}), cancel: () => { ++cancellations } }), error => contains(error, failure))
    assert.equal(cancellations, 1, 'a synchronous setup failure must cancel the rejected grant')
    assert.equal(tools.get(name, agent), undefined)
    scope.ctx.effect = effect
    const revoke = lease.grant({ consumer: {}, agent, token: {}, entitled: true, dispatch: async () => ({}) })
    await lease.ready()
    assert.ok(tools.get(name, agent), 'a failed generation must not prevent a later valid grant')
    revoke()
    assert.equal(tools.get(name, agent), undefined)
  } finally { scope.ctx.effect = effect; lease?.dispose(); await shutdown(ctx) }
})

await test('failed queue lifetime setup rolls back the cache and a healthy call installs teardown', async () => {
  const { ctx } = await bootHost()
  const scope = createScope(ctx, { id: 'direct-queue-setup' })
  const rootEffect = ctx.effect.bind(ctx), effect = scope.ctx.effect.bind(scope.ctx)
  const failure = new Error('fixture queue lifetime refused')
  let rootCalls = 0, scopeCalls = 0, attempts = 0, available = false
  ctx.effect = (body, label) => {
    if (label === queueLabel) { ++rootCalls; if (!available) throw failure }
    return rootEffect(body, label)
  }
  scope.ctx.effect = (body, label) => {
    if (label === queueLabel) { ++scopeCalls; if (!available) throw failure }
    return effect(body, label)
  }
  try {
    await setupFailure(() => publicationRegistration(scope.ctx, () => { ++attempts; return () => {} }),
      error => error === failure)
    assert.equal(rootCalls, 1)
    assert.equal(scopeCalls, 1)
    assert.equal(attempts, 0)
    available = true
    const recovered = publicationRegistration(scope.ctx, () => { ++attempts; return () => {} })
    await ready(recovered)
    assert.equal(rootCalls, 2, 'failed initialization must not leave an unowned queue cached')
    assert.equal(scopeCalls, 1)
    assert.equal(attempts, 1)
    recovered()
  } finally { ctx.effect = rootEffect; scope.ctx.effect = effect; await shutdown(ctx) }
})

await test('a deferred registry failure rejects the exact ready promise and does not stop a healthy sibling', async () => {
  const { ctx, tools } = await bootHost()
  const broken = { id: 'direct-deferred-failure' }, healthy = { id: 'direct-deferred-healthy' }
  const dead = createScope(ctx, broken), live = createScope(ctx, healthy)
  const failure = new Error('fixture permanent registry failure')
  let locked = true, attempts = 0, blocker, failed, sibling
  try {
    blocker = publicationRegistration(ctx, () => { if (locked) throw refusal(); return () => {} })
    failed = publicationRegistration(dead.ctx, () => { ++attempts; throw failure })
    sibling = publicationRegistration(live.ctx, () => live.ctx.get('tools').register(definition('deferred-healthy')))
    assert.equal(publicationPending(failed), true)
    const first = publicationReady(failed)
    assert.equal(publicationReady(failed), first)
    assert.equal(attempts, 0)
    assert.equal(tools.get('deferred-healthy', healthy), undefined)
    locked = false
    await ready(sibling)
    await assert.rejects(first, error => error === failure)
    assert.equal(publicationLeaseState(failed), 'failed')
    assert.equal(publicationPending(failed), false)
    assert.equal(attempts, 1)
    assert.ok(tools.get('deferred-healthy', healthy))
    await assert.rejects(publicationReady(failed), error => error === failure)
    assert.equal(attempts, 1, 'observing readiness must not retry a permanent error')
  } finally { locked = false; failed?.(); sibling?.(); blocker?.(); await shutdown(ctx) }
})

await test('queued apply skips a dead owner before its delayed lease cancellation and rejects readiness', async () => {
  const { ctx, tools } = await bootHost()
  const stale = { id: 'direct-queued-stale' }, healthy = { id: 'direct-queued-healthy' }
  const dead = createScope(ctx, stale), live = createScope(ctx, healthy)
  const effect = dead.ctx.effect.bind(dead.ctx)
  let release
  const barrier = new Promise(resolve => { release = resolve })
  let started = false, leases = 0, locked = true, attempts = 0, blocker, pending, sibling, disposal
  const warnings = []
  ctx.logger.warn = message => warnings.push(message)
  // Hold the publication lease's own disposer; other Cordis effects unload in parallel.
  dead.ctx.effect = (body, label) => label === leaseLabel ? effect(() => {
    ++leases
    const dispose = body()
    return async () => { started = true; await barrier; dispose() }
  }, label) : effect(body, label)
  try {
    blocker = publicationRegistration(ctx, () => { if (locked) throw refusal(); return () => {} })
    pending = publicationRegistration(dead.ctx, () => {
      ++attempts
      return dead.ctx.get('tools').register(definition('queued-dead'))
    })
    sibling = publicationRegistration(live.ctx, () => live.ctx.get('tools').register(definition('queued-healthy')))
    assert.equal(leases, 1)
    assert.equal(attempts, 0)
    assert.equal(publicationPending(pending), true)
    disposal = dead.rawDispose()
    assert.equal(dead.ctx.fiber.uid, null)
    await tick()
    assert.equal(started, true, 'the real lease cancellation must be blocked')
    assert.equal(publicationPending(pending), true)
    locked = false
    await ready(sibling)
    await assert.rejects(publicationReady(pending), /Publication owner inactive/)
    assert.equal(attempts, 0, 'dead owners must not reach even a callback without its own liveness guard')
    assert.equal(publicationLeaseState(pending), 'cancelled')
    assert.equal(publicationPending(pending), false)
    assert.equal(tools.get('queued-dead', stale), undefined)
    assert.ok(tools.get('queued-healthy', healthy))
    assert.equal(warnings.filter(message => message.includes('deferred registry publication failed')).length, 0)
    release()
    await disposal
    assert.equal(attempts, 0)
    await assert.rejects(publicationReady(pending), /Publication owner inactive/)
  } finally {
    locked = false
    dead.ctx.effect = effect
    release()
    await disposal
    pending?.(); sibling?.(); blocker?.()
    await shutdown(ctx)
  }
})

await test('disposing the root rejects queued readiness and never applies work after teardown', async () => {
  const { ctx } = await bootHost()
  let attempts = 0, blocker, pending
  try {
    blocker = publicationRegistration(ctx, () => { throw refusal() })
    pending = publicationRegistration(ctx, () => { ++attempts; return () => {} })
    assert.equal(publicationPending(pending), true)
    await shutdown(ctx)
    await assert.rejects(publicationReady(pending), /Publication root disposed|Publication cancelled before registration/)
    await assert.rejects(publicationReady(blocker), /Publication root disposed|Publication cancelled before registration/)
    assert.equal(publicationLeaseState(pending), 'cancelled')
    assert.equal(publicationPending(pending), false)
    assert.equal(attempts, 0)
  } finally { pending?.(); blocker?.(); await shutdown(ctx) }
})

await test('synchronous owner disposal after apply rejects readiness and runs the exact undo once', async () => {
  const { ctx, tools } = await bootHost()
  const agent = { id: 'dispose-inside-apply' }, scope = createScope(ctx, agent)
  let disposal, attempts = 0, undos = 0, registration
  try {
    registration = publicationRegistration(scope.ctx, () => {
      ++attempts
      const undo = scope.ctx.get('tools').register(definition('disposed-after-apply'))
      disposal = scope.rawDispose()
      assert.equal(scope.ctx.fiber.uid, null)
      return () => { ++undos; undo() }
    })
    await assert.rejects(publicationReady(registration), /Publication owner inactive/)
    assert.equal(publicationLeaseState(registration), 'cancelled')
    assert.equal(attempts, 1)
    assert.equal(undos, 1, 'the callback returned an undo which remains owed after owner disposal')
    assert.equal(tools.get('disposed-after-apply', agent), undefined)
    await disposal
    registration()
    assert.equal(undos, 1)
  } finally { await disposal; registration?.(); await shutdown(ctx) }
})

await test('owner disposal during apply contains only INACTIVE_EFFECT and preserves ordinary errors', async () => {
  const { ctx } = await bootHost()
  const failure = new Error('fixture ordinary failure after disposal')
  let attempts = 0
  try {
    for (const ordinary of [false, true]) {
      const scope = createScope(ctx, { id: 'dispose-during-apply-' + ordinary })
      let disposal, registration
      const publish = () => publicationRegistration(scope.ctx, () => {
        ++attempts
        disposal = scope.rawDispose()
        if (ordinary) throw failure
        return scope.ctx.get('tools').register(definition('disposed-during-apply'))
      })
      try {
        if (ordinary) assert.throws(publish, error => error === failure)
        else {
          registration = publish()
          await assert.rejects(publicationReady(registration), /Publication owner inactive/)
          assert.equal(publicationLeaseState(registration), 'cancelled')
        }
      } finally { await disposal; registration?.() }
    }
    assert.equal(attempts, 2)
  } finally { await shutdown(ctx) }
})

report('publication-lifecycle')
