import { setImmediate } from 'node:timers/promises'
import { CallBudget, MAX_ACTIVE_CALLS, MAX_WAITING_CALLS } from '../lib/kernel/call-budget.js'
import { WORKER_TIMEOUT_MS } from '../lib/worker-protocol.js'
import { invoke as fileCall } from '../lib/file/worker.js'
import { invoke as ptcCall } from '../lib/ptc/worker.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountFakeResident } from './lib/resident.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

await test('one resident/session has bounded FIFO admission and an explicit overflow result', async () => {
  const owner = new CallBudget(), gate = deferred(), entered = []
  assert.equal(MAX_ACTIVE_CALLS, 2); assert.equal(MAX_WAITING_CALLS, 8)
  const jobs = Array.from({ length: MAX_ACTIVE_CALLS + MAX_WAITING_CALLS }, (_, index) =>
    owner.run('same', undefined, async () => { entered.push(index); await gate.promise; return index }))
  await setImmediate()
  assert.deepEqual(entered, [0, 1])
  await assert.rejects(owner.run('same', undefined, async () => assert.fail('overflow must not run')),
    error => error.code === 'CALL_LIMIT' && /no effects/.test(error.message))
  gate.resolve()
  assert.deepEqual(await Promise.all(jobs), Array.from({ length: 10 }, (_, index) => index))
  assert.deepEqual(entered, Array.from({ length: 10 }, (_, index) => index))
  assert.equal(await owner.run('same', undefined, async () => 'released'), 'released')
})

await test('queued cancellation never runs; thrown work releases its permit; sessions and residents stay independent', async () => {
  const owner = new CallBudget(), gate = deferred()
  const running = Array.from({ length: MAX_ACTIVE_CALLS }, () => owner.run('one', undefined, () => gate.promise))
  await setImmediate()
  const controller = new AbortController()
  const waiting = owner.run('one', controller.signal, async () => assert.fail('cancelled ticket ran'))
  controller.abort()
  await assert.rejects(waiting, error => error.code === 'CANCELLED')
  assert.equal(await owner.run('two', undefined, async () => 'other session'), 'other session')
  assert.equal(await new CallBudget().run('one', undefined, async () => 'other resident'), 'other resident')
  await assert.rejects(owner.run('two', undefined, async () => { throw new Error('work failed') }), /work failed/)
  assert.equal(await owner.run('two', undefined, async () => 'after error'), 'after error')
  gate.resolve(); await Promise.all(running)
})

await test('Native and PTC bridges share admission and recheck authority after waiting', async () => {
  await withTempDir('call-budget', async root => {
    const { ctx } = await bootHost()
    const gate = deferred(); let active = 0, peak = 0, mode = 'danger-full-access'
    const policies = []
    const exec = { agent: { session: { id: 'bounded', header: { cwd: root } } } }
    try {
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve() { policies.push(mode); return { mode, workspaceRoot: root } } }))
      await ctx.plugin(inner => inner.provide('subprocess', { spawn() {
        active++; peak = Math.max(peak, active)
        return { done: gate.promise.then(() => { active--; return { exitCode: 0 } }), collected: {
          stdout: { readFrom: () => ({ text: '{"status":"completed","items":[]}', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        } }
      } }))
      await mountFakeResident(ctx, { file: 'unused', invoke: async (_envelope, _signal, started) => {
        active++; peak = Math.max(peak, active); started?.()
        await gate.promise; active--
        return { exitCode: 0, interrupted: false, readers: true, lossy: false, stderr: '', value: { status: 'completed', items: [] } }
      } })
      const jobs = [fileCall(ctx, 'unused', 'stat', { path: 'a' }, exec), ptcCall(ctx, 'unused', 'batch', { action: 'plan', operations: [] }, exec)]
      await setImmediate()
      assert.equal(active, 2)
      const policyReads = policies.length
      const queuedWrite = fileCall(ctx, 'unused', 'edit_file', { path: 'a' }, exec)
      const queuedRead = fileCall(ctx, 'unused', 'stat', { path: 'b' }, exec)
      await setImmediate(); assert.equal(active, 2)
      assert.equal(policies.length, policyReads, 'queued callbacks must not resolve authority before admission')
      mode = 'read-only'; gate.resolve()
      const [write, read] = await Promise.all([queuedWrite, queuedRead])
      await Promise.all(jobs)
      assert.equal(peak, 2)
      assert.equal(write.error.code, 'POLICY_DENIED')
      assert.equal(write.error.effectState, 'none')
      assert.equal(read.status, 'completed')
      assert.equal(read.sandbox.mode, 'read-only')
      assert.ok(policies.includes('read-only'))
    } finally { gate.resolve(); await shutdown(ctx) }
  })
  assert.equal(WORKER_TIMEOUT_MS, 30000)
})
report('call-budget')
