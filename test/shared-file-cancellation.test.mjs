/** Public subprocess provider gates real worker completion, never registry dispatch. */
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
requireWorker('shared-file-cancellation')
const pending = [], waiters = []
class ControlledSubprocess extends Subprocess {
  spawn(spec) {
    const handle = super.spawn(spec)
    if (path.resolve(spec.argv[0]) !== path.resolve(WORKER)) return handle
    let release
    const gate = new Promise(resolve => { release = resolve })
    const abort = () => release()
    spec.signal.addEventListener('abort', abort, { once: true })
    if (spec.signal.aborted) abort()
    const call = { signal: spec.signal, release }
    const waiter = waiters.shift()
    if (waiter) waiter(call)
    else pending.push(call)
    const done = Promise.all([handle.done, gate]).then(([outcome]) => outcome)
      .finally(() => spec.signal.removeEventListener('abort', abort))
    return { ...handle, done }
  }
}
const next = () => pending.length ? Promise.resolve(pending.shift()) : new Promise(resolve => waiters.push(resolve))
await test('discovery lifetime, independent PTC, caller abort and source disposal reach real worker signals', () => withTempDir('file-cancellation', async root => {
  fs.writeFileSync(path.join(root, 'note'), 'fixture')
  const { ctx } = await bootHost(), steps = [], agents = []
  try {
    for (const plugin of [ControlledSubprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin)
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
    const nativeWork = call(a), native = await next()
    const ptcWork = call(b), independent = await next()
    await discovery.dispose()
    assert.equal(native.signal.aborted, true, 'discovery-only work must lose its lifetime')
    assert.equal(independent.signal.aborted, false, 'different agent PTC must not be cancelled')
    const cancelled = await nativeWork
    assert.equal(cancelled.value.error.code, 'RESULT_UNKNOWN', JSON.stringify(cancelled))
    assert.equal(cancelled.value.error.effectState, 'unknown')
    independent.release()
    assert.equal((await ptcWork).value.result.status, 'completed')
    const caller = new AbortController(), callerWork = call(b, caller.signal), parent = await next()
    caller.abort(new Error('Parent cancelled'))
    assert.equal(parent.signal.aborted, true)
    await callerWork
    const lastWork = call(b), last = await next()
    await b.scope.dispose()
    assert.equal(last.signal.aborted, true, 'source disposal cancels remaining work')
    await lastWork
    await ptc.dispose()
  } finally { for (const call of pending) call.release(); steps.forEach(step => step.dispose()); await shutdown(ctx) }
}))
report('shared-file-cancellation')
