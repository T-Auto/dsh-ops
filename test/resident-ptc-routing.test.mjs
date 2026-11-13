/** Actual public policy/confinement and resident transport; no shell or model API. */
import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { residentKernel } from '../lib/integration/index.js'
import { invoke } from '../lib/execution/jobs.js'
import { NativeFileTools } from '../lib/projections/native/runtime.js'
import { workerEnvelope } from '../lib/execution/protocol.js'
import { confinedWorkerLaunch } from '../lib/execution/resident/worker-launch.js'
import { createResidentTaskJobs } from './lib/resident-task-jobs.mjs'
import { assert, test, report, withTempDir, waitFor } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

requireWorker('resident-ptc-routing')
async function fixture(root, mode = 'workspace-write', sandboxConfig = {}) {
  const host = await createResidentTaskJobs({ cwd: root }), starts = []
  class Observed extends Subprocess {
    spawn(spec) { const handle = super.spawn(spec); starts.push({ argv: [...spec.argv], handle }); return handle }
  }
  await host.ctx.plugin(Policy, { mode, workspaceRoot: root })
  await host.ctx.plugin(Observed); await host.ctx.plugin(Sandbox, sandboxConfig)
  const provider = await host.ctx.plugin(residentKernel({ binaryPath: WORKER }))
  const kernel = host.ctx.get('opsKernel'), native = new NativeFileTools({ ctx: host.ctx, config: { workerPath: WORKER, required: true } })
  const confined = [], launches = [], sandbox = host.ctx.get('sandbox'), wrap = sandbox.confine.bind(sandbox)
  sandbox.confine = async (...args) => {
    const value = await wrap(...args); confined.push({ argv: [...value.argv], enforcement: value.enforcement }); return value
  }
  if (typeof kernel.invokeConfined === 'function') {
    const invokeConfined = kernel.invokeConfined.bind(kernel)
    kernel.invokeConfined = (envelope, launch, signal, started) => {
      launches.push(structuredClone(launch)); return invokeConfined(envelope, launch, signal, started)
    }
  }
  await native.start([])
  const call = (tool, args, signal = new AbortController().signal, agent = host.agent) =>
    invoke(host.ctx, WORKER, tool, args, { agent }, signal, { denyCredentialReads: true })
  return { ...host, starts, kernel, provider, native, call, confined, launches,
    async close() { await native.stop(); await host.dispose() },
    assertResidentOnly() {
      assert.deepEqual(starts.map(value => value.argv), [[WORKER, '--serve']], 'calls and disposal must not start a public one-shot worker')
    } }
}

await test('full-access batch plan/run/resume and audit paging reuse the kernel', () => withTempDir('resident-ptc-full', async root => {
  fs.writeFileSync(path.join(root, 'one.txt'), 'one'); fs.writeFileSync(path.join(root, 'two.txt'), 'two')
  const host = await fixture(root, 'danger-full-access')
  try {
    const planned = await host.call('batch', { action: 'plan', operations: [{ op: 'copy', path: 'one.txt', to: 'copy.txt' }] })
    assert.equal(planned.status, 'planned', JSON.stringify(planned)); assert.equal(fs.existsSync(path.join(root, 'copy.txt')), false)
    const resumed = await host.call('batch', { action: 'resume', id: planned.detailsRef })
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed)); assert.equal(fs.readFileSync(path.join(root, 'copy.txt'), 'utf8'), 'one')
    const ran = await host.call('batch', { action: 'run', operations: [{ op: 'move', path: 'two.txt', to: 'moved.txt' }] })
    assert.equal(ran.status, 'completed', JSON.stringify(ran)); assert.equal(fs.existsSync(path.join(root, 'two.txt')), false)
    const audit = await host.call('result', { action: 'page', id: ran.detailsRef })
    assert.equal(audit.items[0].state, 'completed', JSON.stringify(audit))
    host.assertResidentOnly()
    await host.provider.dispose()
    const unavailable = await host.call('result', { action: 'page', id: ran.detailsRef })
    assert.equal(unavailable.error.code, 'EXECUTOR_UNAVAILABLE'); assert.equal(unavailable.error.effectState, 'none')
    host.assertResidentOnly()
  } finally { await host.close() }
  host.assertResidentOnly(); assert.equal(await host.starts[0].handle.waitForExit(), true)
}))

await test('restricted results and batches retain public confinement, owner checks and read-only paging', () => withTempDir('resident-ptc-restricted', async root => {
  fs.writeFileSync(path.join(root, 'source.txt'), 'source')
  const host = await fixture(root)
  try {
    const stored = await host.call('result', { action: 'put', items: [{ n: 1, text: 'x'.repeat(4000) }, { n: 2 }] })
    assert.match(stored.id, /^ref:\/\//, JSON.stringify(stored))
    const page = await host.native.call('result', { action: 'page', id: stored.id, fields: ['n'] }, { agent: host.agent, signal: new AbortController().signal })
    assert.deepEqual(page.items, [{ n: 1 }, { n: 2 }])
    const sibling = await host.createAgent()
    const foreign = await host.call('result', { action: 'page', id: stored.id }, undefined, sibling.agent)
    assert.ok(foreign.error, 'a reference never transfers session authority')
    const planned = await host.call('batch', { action: 'plan', operations: [{ op: 'copy', path: 'source.txt', to: 'copy.txt' }] })
    assert.equal(planned.status, 'planned', JSON.stringify(planned))
    const resumed = await host.call('batch', { action: 'resume', id: planned.detailsRef })
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed))
    const ran = await host.call('batch', { action: 'run', operations: [{ op: 'remove', path: 'copy.txt' }] })
    assert.equal(ran.status, 'completed', JSON.stringify(ran))
    setSandboxMode(host.agent.session, 'read-only')
    const readonly = await host.call('result', { action: 'page', id: planned.detailsRef })
    assert.equal(readonly.items[0].state, 'completed', JSON.stringify(readonly))
    assert.ok((await host.call('result', { action: 'page', id: stored.id })).error, 'cache authority includes the permission mode')
    for (const [tool, args] of [['result', { action: 'put', items: [] }], ['result', { action: 'release', id: stored.id }],
      ['batch', { action: 'run', operations: [{ op: 'remove', path: 'source.txt' }] }]]) {
      assert.equal((await host.call(tool, args)).error.code, 'POLICY_DENIED')
    }
    setSandboxMode(host.agent.session, 'workspace-write')
    assert.equal((await host.call('result', { action: 'release', id: stored.id })).status, 'released')
    assert.ok((await host.call('result', { action: 'page', id: stored.id })).error)
    assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'source')
    if (process.platform === 'win32') {
      host.assertResidentOnly(); assert.ok(host.launches.length >= 8)
      for (const launch of host.launches) {
        assert.ok(host.confined.some(value => JSON.stringify(value.argv) === JSON.stringify(launch.argv)), 'preserve exact public confinement argv')
        assert.equal(launch.cwd, root); assert.equal(Object.keys(launch.env).some(key => key.toUpperCase() === 'DSH_SUBPROCESS_CONTROL'), false)
      }
      assert.equal(stored.sandbox.enforcement, host.confined[0].enforcement)
    }
  } finally { await host.close() }
  if (process.platform === 'win32') host.assertResidentOnly()
}))

for (const mode of ['danger-full-access', ...(process.platform === 'win32' ? ['workspace-write'] : [])])
await test(`${mode} cancellation after resident start keeps unknown batch effects without public-worker replay`, () => withTempDir('resident-ptc-cancel', async root => {
  fs.writeFileSync(path.join(root, 'source.txt'), 'safe')
  const host = await fixture(root, mode), controller = new AbortController()
  const original = host.kernel.invoke.bind(host.kernel), confined = host.kernel.invokeConfined?.bind(host.kernel)
  const start = (envelope, started) => () => { started?.(); if (envelope.request.tool === 'batch') controller.abort(new Error('cancel admitted batch')) }
  host.kernel.invoke = (envelope, signal, started) => original(envelope, signal, start(envelope, started))
  if (confined) host.kernel.invokeConfined = (envelope, launch, signal, started) => confined(envelope, launch, signal, start(envelope, started))
  try {
    const value = await host.call('batch', { action: 'run', operations: [{ op: 'copy', path: 'source.txt', to: 'copy.txt' }] }, controller.signal)
    assert.equal(value.error?.code, 'RESULT_UNKNOWN', JSON.stringify(value)); assert.equal(value.error.effectState, 'unknown')
    assert.match(value.detailsRef, /^j-/)
    const fresh = await host.call('batch', { action: 'plan', operations: [{ op: 'copy', path: 'source.txt', to: 'later.txt' }] })
    assert.equal(fresh.status, 'planned', JSON.stringify(fresh)); host.assertResidentOnly()
  } finally { await host.close() }
}))

if (process.platform === 'win32') await test('exact OS confinement refuses a root junction swapped after host preparation', () => withTempDir('resident-ptc-root-race', async base => {
  const root = path.join(base, 'workspace'), inside = path.join(root, 'inside'), outside = path.join(base, 'outside')
  fs.mkdirSync(inside, { recursive: true }); fs.mkdirSync(outside)
  fs.writeFileSync(path.join(inside, 'source.txt'), 'inside'); fs.writeFileSync(path.join(outside, 'source.txt'), 'outside')
  const alias = path.join(root, 'selected'); fs.symlinkSync(inside, alias, 'junction')
  const host = await fixture(root), original = host.kernel.invokeConfined.bind(host.kernel)
  let swapped = false
  host.kernel.invokeConfined = (envelope, launch, signal, started) => {
    if (envelope.request.tool === 'batch' && envelope.request.root === alias) {
      fs.unlinkSync(alias); fs.symlinkSync(outside, alias, 'junction'); swapped = true
    }
    return original(envelope, launch, signal, started)
  }
  try {
    const value = await host.call('batch', { root: alias, action: 'run', operations: [{ op: 'copy', path: 'source.txt', to: 'escaped.txt' }] })
    assert.equal(swapped, true, 'swap occurs only after the host admitted the original inside root')
    assert.notEqual(value.status, 'completed', JSON.stringify(value))
    assert.equal(fs.existsSync(path.join(outside, 'escaped.txt')), false)
    assert.equal(fs.existsSync(path.join(outside, '.dsh-ops')), false)
    assert.equal(fs.readFileSync(path.join(outside, 'source.txt'), 'utf8'), 'outside')
    assert.equal(host.kernel.available, true); host.assertResidentOnly()
  } finally { await host.close() }
}))

if (process.platform === 'win32') await test('confined stdin starvation expires the native budget and joins descendants without relying on caller timeout', () => withTempDir('resident-ptc-input-budget', async root => {
  const host = await fixture(root), marker = path.join(root, 'owned-pids.json'), controller = new AbortController()
  const script = `const fs=require('node:fs'),{spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000)`
  const policy = host.ctx.get('sandboxPolicy').resolve({ session: host.agent.session })
  const confined = await host.ctx.get('sandbox').confine([process.execPath, '-e', script], policy)
  const launch = await confinedWorkerLaunch(confined.argv, root)
  const envelope = workerEnvelope('ptc', { root, scope: host.agent.session.id, tool: 'result',
    args: { action: 'put', items: [{ value: 'x'.repeat(1800000) }] }, read_only: false }, 1500)
  let watchdog = false, pending, timer
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  try {
    timer = setTimeout(() => { watchdog = true; controller.abort(new Error('external cleanup watchdog')) }, 6000)
    pending = host.kernel.invokeConfined(envelope, launch, controller.signal)
    await waitFor(() => fs.existsSync(marker), { timeoutMs: 5000, what: 'owned stdin-stalled process and descendant' })
    const pids = JSON.parse(fs.readFileSync(marker, 'utf8'))
    assert.equal(pids.length, 2); assert.ok(pids.every(alive))
    const value = await pending
    clearTimeout(timer)
    await waitFor(() => pids.every(pid => !alive(pid)), { timeoutMs: 2000, what: 'stdin-stalled owned descendants to exit' })
    assert.equal(watchdog, false, 'native envelope deadline must settle before the external cleanup watchdog')
    assert.equal(value.interrupted, true); assert.equal(value.value, undefined)
    fs.writeFileSync(path.join(root, 'source.txt'), 'safe')
    assert.equal((await host.call('batch', { action: 'plan', operations: [{ op: 'copy', path: 'source.txt', to: 'after.txt' }] })).status, 'planned')
    host.assertResidentOnly()
  } finally { clearTimeout(timer); controller.abort(); try { await pending } finally { await host.close() } }
}))
if (process.platform === 'win32') for (const [signature, code, effect] of [
  ['fixture runner failed', 'EXECUTOR_UNAVAILABLE', 'none'],
  ['permission denied', 'EXECUTION_RESTRICTED', 'unknown'],
]) await test(`early runner refusal preserves ${code} despite undelivered large stdin`, () => withTempDir('resident-ptc-refusal', async root => {
  // A real operator-configured public runner exits before reading any request bytes.
  // The fixture produces diagnostics only; it never invokes the worker or applies effects.
  const runner = path.join(root, 'refusing-runner.cjs')
  fs.writeFileSync(runner, `require('node:fs').writeSync(2,${JSON.stringify(signature + '\n')}); process.exit(23)`)
  const host = await fixture(root, 'workspace-write', {
    runnerCommand: [process.execPath, runner], runnerFailureSignatures: ['fixture runner failed'],
  })
  const original = host.kernel.invokeConfined.bind(host.kernel), receipts = []
  host.kernel.invokeConfined = async (...args) => { const value = await original(...args); receipts.push(value); return value }
  try {
    const value = await host.call('batch', { action: 'plan', operations: [{ op: 'remove', path: 'x'.repeat(1800000) }] })
    assert.equal(value.error?.code, code, JSON.stringify(value)); assert.equal(value.error.effectState, effect)
    assert.equal(receipts.length, 1); assert.equal(receipts[0].exitCode, 23)
    assert.equal(receipts[0].interrupted, false); assert.equal(receipts[0].stderr.trim(), signature)
    assert.equal(fs.existsSync(path.join(root, '.dsh-ops')), false)
    assert.equal(host.kernel.available, true); host.assertResidentOnly()
  } finally { await host.close() }
}))
report('resident-ptc-routing')
