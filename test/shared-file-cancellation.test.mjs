/** Gate real resident request completion without stopping the shared kernel. */
import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountDiscovery } from '../lib/discovery/controller.js'
import { mountPtc } from '../lib/publication/ptc.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, prepareStep, executeCall } from './lib/executor.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { requireWorker, WORKER } from './lib/boundary.mjs'
import { mountResident } from './lib/resident.mjs'
requireWorker('shared-file-cancellation')
const pending = [], waiters = [], purges = [], gates = new Set()
let kernelStarts = 0
class ObservedSubprocess extends Subprocess {
  spawn(spec) {
    const handle = super.spawn(spec)
    if (path.resolve(spec.argv[0]) !== path.resolve(WORKER)) return handle
    assert.ok(spec.argv.includes('--serve'), 'file calls and cache cleanup must reuse the resident kernel')
    ++kernelStarts
    return handle
  }
}
function gateRequests(kernel) {
  const invoke = kernel.invoke.bind(kernel)
  const purge = kernel.purgeResults.bind(kernel)
  kernel.purgeResults = (...args) => {
    const work = purge(...args)
    purges.push(work)
    return work
  }
  kernel.invoke = (envelope, signal, onStarted) => {
    assert.equal(envelope.request.tool, 'stat', 'only the business operation is completion-gated')
    let release
    const gate = new Promise(resolve => { release = resolve })
    gates.add(release)
    const abort = () => release()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const work = invoke(envelope, signal, () => {
      onStarted?.()
      const call = { signal, release }
      const waiter = waiters.shift()
      if (waiter) waiter(call)
      else pending.push(call)
    })
    return Promise.all([work, gate]).then(([outcome]) => outcome)
      .finally(() => { signal.removeEventListener('abort', abort); gates.delete(release) })
  }
}
async function next(work, label) {
  let receive, timer
  const started = pending.length ? Promise.resolve(pending.shift()) : new Promise(resolve => { receive = resolve; waiters.push(receive) })
  try {
    return await Promise.race([started,
      work.then(result => { throw new Error(`${label} settled before real resident admission: ${JSON.stringify(result)}`) },
        error => { throw new Error(`${label} rejected before real resident admission`, { cause: error }) }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} was not admitted by the real resident within 10s`)), 10000) }),
    ])
  } finally {
    clearTimeout(timer)
    if (receive) { const index = waiters.indexOf(receive); if (index !== -1) waiters.splice(index, 1) }
  }
}
await test('discovery lifetime, independent PTC, caller abort and source disposal reach real resident request signals', () => withTempDir('file-cancellation', async root => {
  fs.writeFileSync(path.join(root, 'note'), 'fixture')
  const { ctx } = await bootHost(), steps = [], agents = []
  try {
    for (const plugin of [ObservedSubprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin)
    const kernel = await mountResident(ctx, { file: WORKER, cwd: root })
    gateRequests(kernel)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) })
    ctx.provide('agents', { list: () => agents })
    const discovery = ctx.plugin({ apply(inner) { mountDiscovery(inner, {
      binaryPath: WORKER, required: true, allowedTools: ['stat'], alwaysLoaded: ['stat'],
    }, { allows: agent => agent.id === 'native' }) } })
    const ptc = ctx.plugin({ apply(inner) { mountPtc(inner, {
      binaryPath: WORKER, required: true, alwaysLoaded: ['stat'],
    }, { allows: agent => agent.id === 'ptc' }) } })
    await discovery; await ptc
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve))
    const mint = async (id, mode) => {
      const agent = { id, session: { id, header: { cwd: root }, append() {}, read() { return [] } } }
      const scope = createScope(ctx, agent); agent.ctx = scope.ctx; agents.push(agent)
      await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
      await ctx.serial('agent/created', { agent })
      const step = await prepareStep(ctx, agent); steps.push(step)
      return { agent, scope, step }
    }
    const a = await mint('native', 'native'), b = await mint('ptc', 'ptc')
    let id = 0
    const call = (owner, signal) => executeCall(ctx, { agent: owner.agent, toolSet: owner.step.toolSet,
      name: owner === a ? 'ops_stat' : 'run_code', callId: `cancel-${++id}`, signal,
      arguments: owner === a ? { path: 'note' } : { description: 'Stat', code: "return await tools.ops_stat({path:'note'});" } })
    const nativeWork = call(a), native = await next(nativeWork, 'Native lifetime call')
    const ptcWork = call(b), independent = await next(ptcWork, 'independent PTC call')
    await discovery.dispose()
    assert.equal(native.signal.aborted, true, 'discovery-only work must lose its lifetime')
    assert.equal(independent.signal.aborted, false, 'different agent PTC must not be cancelled')
    const cancelled = await nativeWork
    assert.equal(cancelled.value.error.code, 'RESULT_UNKNOWN', JSON.stringify(cancelled))
    assert.equal(cancelled.value.error.effectState, 'unknown')
    independent.release()
    assert.equal((await ptcWork).value.result.status, 'completed')
    assert.equal(kernel.available, true, 'consumer cancellation preserves the shared kernel')
    const caller = new AbortController(), callerWork = call(b, caller.signal), parent = await next(callerWork, 'caller cancellation PTC call')
    caller.abort(new Error('Parent cancelled'))
    assert.equal(parent.signal.aborted, true)
    await callerWork
    const lastWork = call(b), last = await next(lastWork, 'source disposal PTC call')
    await b.scope.dispose()
    assert.equal(last.signal.aborted, true, 'source disposal cancels remaining work')
    await lastWork
    await ptc.dispose()
    assert.equal(kernel.available, true, 'consumer disposal leaves the provider owner active')
    assert.equal(kernelStarts, 1, 'Native and PTC requests share one resident startup')
    if (process.platform !== 'win32') assert.ok(purges.length > 0, 'POSIX session cache teardown reaches the real resident purge')
    for (const outcome of await Promise.all(purges)) {
      assert.equal(outcome.exitCode, 0, 'trusted cache purge completes without the business gate')
      assert.equal(outcome.value.status, 'completed')
    }
  } finally { for (const release of gates) release(); steps.forEach(step => step.dispose()); await shutdown(ctx) }
}))
report('shared-file-cancellation')
