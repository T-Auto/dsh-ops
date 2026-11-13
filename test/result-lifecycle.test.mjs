import { setImmediate } from 'node:timers/promises'
import path from 'node:path'
import { assert, test, report, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountExchangeResident } from './lib/resident.mjs'
import {
  deferredCleanupCount, resultSessionNonce, registerResultCleanup, retryDeferredResultCleanup,
  withResultSession, expireResultSession, mountResultLifecycle,
} from '../lib/kernel/result-lifecycle.js'
import { listPendingCleanup, registerCleanupRoot, resetCleanupHostBoot, setCleanupRegistryDir } from '../lib/kernel/result-cleanup-registry.js'
import { invoke as fileCall } from '../lib/file/worker.js'
import { withTempDir } from './lib/harness.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

await test('disposal cancels owned work, waits for settlement, then purges exactly once', async () => {
  const ctx = {}, session = { id: 'one' }, settled = deferred(), events = []
  const nonce = resultSessionNonce(ctx, session)
  assert.equal(resultSessionNonce(ctx, session), nonce)
  assert.notEqual(resultSessionNonce({}, session), nonce)
  registerResultCleanup(ctx, session, 'cache', async () => { events.push('purged') })
  const work = withResultSession(ctx, session, undefined, async signal => {
    signal.addEventListener('abort', () => events.push('aborted'), { once: true })
    await settled.promise; events.push('settled')
  })
  await setImmediate()
  const closing = expireResultSession(ctx, session)
  assert.equal(expireResultSession(ctx, session), closing)
  assert.deepEqual(events, ['aborted'])
  await assert.rejects(withResultSession(ctx, session, undefined, async () => assert.fail('disposed work ran')), /expired/)
  const reopened = { id: 'one' }
  const next = withResultSession(ctx, reopened, undefined, async () => events.push('reopened'))
  await setImmediate(); assert.deepEqual(events, ['aborted'])
  settled.resolve(); await Promise.all([work, closing, next])
  assert.deepEqual(events, ['aborted', 'settled', 'purged', 'reopened'])
  assert.notEqual(resultSessionNonce(ctx, reopened), nonce)
  await expireResultSession(ctx, reopened)
})

await test('two component owners share the live session; last unload expires it', async () => {
  const { ctx } = await bootHost(), session = { id: 'components' }
  let purged = 0
  try {
    const first = await ctx.plugin(inner => mountResultLifecycle(inner))
    const second = await ctx.plugin(inner => mountResultLifecycle(inner))
    registerResultCleanup(ctx, session, 'cache', async () => { purged++ })
    const nonce = resultSessionNonce(ctx, session)
    await first.dispose()
    assert.equal(purged, 0); assert.equal(resultSessionNonce(ctx, session), nonce)
    await second.dispose()
    assert.equal(purged, 1)
    const reopened = await ctx.plugin(inner => mountResultLifecycle(inner))
    assert.notEqual(resultSessionNonce(ctx, session), nonce)
    assert.equal(await withResultSession(ctx, session, undefined, async () => 'resumed'), 'resumed')
    await reopened.dispose()
  } finally { await shutdown(ctx) }
})

await test('a failed cleanup is recorded and retried instead of forgotten', async () => {
  await withTempDir('lifecycle-deferred', async dir => {
    setCleanupRegistryDir(path.join(dir, 'registry'))
    const { ctx } = await bootHost(), session = { id: 'event' }, done = deferred(), root = path.join(dir, 'dsh-ops-results-' + 'a'.repeat(64))
    let mode = 'read-only', warnings = 0
    try {
      const fiber = await ctx.plugin(inner => mountResultLifecycle(inner))
      // The storage layer registers the root before the first caller receives it; this is the
      // same order, so the failure below must find an existing record.
      registerCleanupRoot(root, { sessionHeading: 'session-heading', workspaceRoot: dir })
      registerResultCleanup(ctx, session, 'cache', async () => {
        done.resolve()
        if (mode !== 'workspace-write') throw new Error('Cleanup authority unavailable')
      }, root)
      ctx.emit('session/disposed', session)
      await done.promise
      await waitFor(() => deferredCleanupCount() === 1, { what: 'the deferred cleanup registration' })
      assert.throws(() => resultSessionNonce(ctx, session), /expired/)
      // The only path to the root was the in-memory cleanup; the ledger now owns it.
      const pending = listPendingCleanup()
      assert.equal(pending.length, 1)
      assert.equal(pending[0].root, root)
      assert.equal(pending[0].attempts, 1)
      assert.equal(pending[0].lastReason, 'read-only')
      // A retry while the host is still read-only must not delete anything or drop the record.
      const blocked = await retryDeferredResultCleanup(ctx, Date.now() + 60_000)
      assert.equal(blocked.completed, 0)
      assert.equal(blocked.pending, 1)
      assert.equal(listPendingCleanup()[0].attempts, 2)
      // Regaining workspace-write authority is what lets the recorded cleanup complete.
      mode = 'workspace-write'
      const retried = await retryDeferredResultCleanup(ctx, Date.now() + 120_000)
      assert.equal(retried.completed, 1)
      assert.equal(deferredCleanupCount(), 0)
      assert.deepEqual(listPendingCleanup(), [])
      await fiber.dispose()
    } finally {
      setCleanupRegistryDir(undefined); resetCleanupHostBoot(); await shutdown(ctx)
    }
    // A cleanup without a known root can only be reported; it is still contained.
    const direct = { logger: { warn() { warnings++ } } }, other = { id: 'no-root' }
    registerResultCleanup(direct, other, 'cache', async () => { throw new Error('read-only') })
    await expireResultSession(direct, other)
    assert.equal(warnings, 1)
  })
})
await test('synchronous abort listeners cannot start a reopened session before the old purge', async () => {
  const ctx = {}, old = { id: 'reentrant' }, next = { id: 'reentrant' }, settled = deferred(), events = []
  let reopened
  registerResultCleanup(ctx, old, 'cache', async () => { events.push('purged') })
  const work = withResultSession(ctx, old, undefined, async signal => {
    signal.addEventListener('abort', () => {
      events.push('aborted')
      reopened = withResultSession(ctx, next, undefined, async () => { events.push('reopened') })
    }, { once: true })
    await settled.promise; events.push('settled')
  })
  await setImmediate()
  const closing = expireResultSession(ctx, old)
  await setImmediate(); assert.deepEqual(events, ['aborted'])
  settled.resolve(); await Promise.all([work, closing, reopened])
  assert.deepEqual(events, ['aborted', 'settled', 'purged', 'reopened'])
  await expireResultSession(ctx, next)
})

await test('permission changes cancel the owning Native session while sibling work continues', async () => {
  await withTempDir('lifecycle-mode', async root => {
    const { ctx } = await bootHost(), siblingGate = deferred(), entered = deferred()
    const one = { id: 'one', header: { cwd: root } }, two = { id: 'two', header: { cwd: root } }
    let mode = 'workspace-write', spawned = 0
    try {
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.id === 'one' ? mode : 'workspace-write', workspaceRoot: root }) }))
      await ctx.plugin(inner => inner.provide('subprocess', { spawn(spec) {
        const sessionId = JSON.parse(spec.stdio.stdin.data).request.scope
        const done = sessionId === 'one' ? new Promise(resolve => spec.signal.addEventListener('abort', () => resolve({ exitCode: 0 }), { once: true })) : siblingGate.promise
        if (++spawned === 2) entered.resolve()
        return { done, collected: { stdout: { readFrom: () => ({ text: '{"status":"completed"}' }) }, stderr: { readFrom: () => ({ text: '' }) } } }
      } }))
      await mountExchangeResident(ctx, { cwd: root })
      await ctx.plugin(inner => mountResultLifecycle(inner))
      const work = fileCall(ctx, 'unused', 'edit_file', { path: 'file' }, { agent: { session: one } })
      const sibling = fileCall(ctx, 'unused', 'stat', { path: 'file' }, { agent: { session: two } })
      await entered.promise
      mode = 'read-only'; ctx.emit('session/event', one, { type: 'sandbox/mode' })
      const stopped = await work
      assert.equal(stopped.error.code, 'RESULT_UNKNOWN'); assert.equal(stopped.error.effectState, 'unknown')
      siblingGate.resolve({ exitCode: 0 }); assert.equal((await sibling).status, 'completed')
      assert.throws(() => resultSessionNonce(ctx, { ...one }), /Another live session/)
    } finally { siblingGate.resolve({ exitCode: 0 }); await shutdown(ctx) }
  })
})
report('result-lifecycle')
