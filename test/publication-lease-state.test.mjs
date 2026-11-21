/**
 * The explicit publication-lease lifecycle contract (#953 review).
 *
 * A boolean "pending" cannot say whether the host accepted a registration:
 * cancelled, failed and settled all look the same to it. These checks pin the
 * four explicit states so controllers never cache a lease that never landed.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import {
  publicationLeaseError, publicationLeaseState, publicationPending, publicationReady, publicationRegistration,
} from '../lib/publication/reentry.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report } from './lib/harness.mjs'

const leaseLabel = 'dsh-ops: registry publication lease'
const tick = () => new Promise(resolve => setImmediate(resolve))
const refusal = () => new Error('session append cannot reenter while another append is being published')
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
const message = error => String(error instanceof Error ? error.message : error)

await test('a cancelled lease is cancelled, never settled or pending', async () => {
  const { ctx } = await bootHost()
  const dead = createScope(ctx, { id: 'lease-cancelled' })
  let attempts = 0
  try {
    await dead.dispose()
    assert.equal(dead.ctx.fiber.uid, null)
    const cancelled = publicationRegistration(dead.ctx, () => { ++attempts; return () => {} })
    assert.equal(publicationLeaseState(cancelled), 'cancelled')
    assert.equal(publicationPending(cancelled), false, 'a cancelled lease is not pending')
    assert.match(message(publicationLeaseError(cancelled)), /Publication owner inactive/)
    await assert.rejects(publicationReady(cancelled), /Publication owner inactive/)
    cancelled()
    assert.equal(publicationLeaseState(cancelled), 'cancelled', 'disposing a cancelled lease keeps its verdict')
    assert.equal(attempts, 0, 'a cancelled lease never applies')
  } finally { await shutdown(ctx) }
})

await test('a lease is pending until the host admits it, then settled', async () => {
  const { ctx, tools } = await bootHost()
  const key = { id: 'lease-settled' }
  const scope = createScope(ctx, key)
  let locked = true, blocker, registration
  try {
    blocker = publicationRegistration(ctx, () => { if (locked) throw refusal(); return () => {} })
    registration = publicationRegistration(scope.ctx, () => scope.ctx.get('tools').register(definition('lease-state-tool')))
    assert.equal(publicationLeaseState(registration), 'pending')
    assert.equal(publicationPending(registration), true)
    locked = false
    await ready(registration)
    assert.equal(publicationLeaseState(registration), 'settled')
    assert.equal(publicationPending(registration), false)
    assert.ok(tools.get('lease-state-tool', key), 'the admitted registration is visible')
  } finally { locked = false; registration?.(); blocker?.(); await shutdown(ctx) }
})

await test('a permanent host failure is failed, distinct from cancelled', async () => {
  const { ctx } = await bootHost()
  let locked = true, blocker, failed
  const failure = new Error('fixture permanent lease failure')
  try {
    blocker = publicationRegistration(ctx, () => { if (locked) throw refusal(); return () => {} })
    failed = publicationRegistration(ctx, () => { throw failure })
    assert.equal(publicationLeaseState(failed), 'pending')
    locked = false
    await ready(blocker)
    await assert.rejects(ready(failed), error => error === failure)
    assert.equal(publicationLeaseState(failed), 'failed')
    assert.equal(publicationLeaseError(failed), failure)
    assert.equal(publicationPending(failed), false, 'a permanent failure is not pending either')
    failed()
    assert.equal(publicationLeaseError(failed), failure, 'cleanup preserves the original readiness rejection')
  } finally { locked = false; failed?.(); blocker?.(); await shutdown(ctx) }
})

await test('a restart window returns cancelled and the reloaded owner settles again', async () => {
  const { ctx } = await bootHost()
  let release
  const barrier = new Promise(resolve => { release = resolve })
  let owner, unloading = false, restarting
  const fiber = await ctx.plugin({ apply(scoped) {
    owner = scoped
    scoped.effect(() => async () => { unloading = true; await barrier }, 'fixture reload barrier')
  } })
  const effect = owner.effect.bind(owner)
  // Hold the publication lease cancellation too: Cordis unloads effects in parallel.
  owner.effect = (setup, label) => label === leaseLabel ? effect(() => {
    const dispose = setup()
    return async () => { await barrier; dispose() }
  }, label) : effect(setup, label)
  try {
    restarting = fiber.restart()
    await tick(); await tick()
    assert.equal(unloading, true)
    assert.notEqual(fiber.uid, null, 'a real restart keeps the fiber identity')
    assert.equal(fiber.state, 5, 'UNLOADING refuses new effects despite the retained uid')
    const cancelled = publicationRegistration(owner, () => { throw new Error('must not apply during UNLOADING') })
    assert.equal(publicationLeaseState(cancelled), 'cancelled')
    await assert.rejects(publicationReady(cancelled), /Publication owner inactive/)
    release()
    await restarting
    const recovered = publicationRegistration(owner, () => () => {})
    await ready(recovered)
    assert.equal(publicationLeaseState(recovered), 'settled')
    recovered()
  } finally { owner.effect = effect; release(); await restarting; await shutdown(ctx) }
})

await test('an untracked handle is never reported settled', async () => {
  assert.equal(publicationLeaseState(() => {}), 'failed')
  assert.match(message(publicationLeaseError(() => {})), /not tracked/)
})

report('publication-lease-state')
