/** Actual public ownership/policy/Jobs over scripted native task heads; no process-launch claim. */
import path from 'node:path'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { createFreshTaskHost } from '../lib/execution/resident/fresh-host.js'
import { createResidentTaskJobs } from './lib/resident-task-jobs.mjs'
import { taskTransport, completedTask, outputTask, turn } from './lib/resident-task-transport.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

let identity = 0
const snapshot = policy => ({ ...policy, additionalWritableRoots: [...policy.additionalWritableRoots ?? []] })
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 5000)
  })]) } finally { clearTimeout(timer) }
}

async function fixture(run, { mode = 'danger-full-access' } = {}) {
  await withTempDir('resident-fresh-host', async directory => {
    const publicHost = await createResidentTaskJobs({ cwd: directory, initialAgents: 2 })
    const { ctx, agents } = publicHost, wire = taskTransport({ autoRead: false })
    const requests = new Map(), terminals = new Map(), starts = new Set(), closed = new Set(), calls = []
    const preparations = [], confinements = [], collections = [], observed = [], watchers = new Set()
    const state = { autoClose: true, environment: {}, runtimeEnvironment: {}, runtime: undefined, confine: undefined,
      output: { stdout: '', stderr: '' } }
    let host, plugin
    const policy = (agent = agents[0]) => snapshot(ctx.get('sandboxPolicy').resolve({ session: agent.session }))
    const finish = (request, changes = {}) => {
      const requestId = typeof request === 'string' ? request : request.requestId
      if (terminals.has(requestId)) return
      const terminal = completedTask(requestId, { stdoutTotal: Buffer.byteLength(state.output.stdout),
        stderrTotal: Buffer.byteLength(state.output.stderr), ...changes })
      terminals.set(requestId, terminal); wire.emit(terminal)
    }
    const cancel = request => finish(request, { status: 'cancelled', exitCode: null,
      effectState: starts.has(request.requestId) ? 'unknown' : 'none', error: { code: 'CANCELLED', message: 'Scripted native cancellation joined.' } })
    const acknowledge = frame => {
      if (closed.has(frame.requestId)) return
      closed.add(frame.requestId)
      for (const request of requests.values()) if (request.ownerKey === frame.ownerKey && !terminals.has(request.requestId)) cancel(request)
      wire.emit({ type: 'task.ownerClosed', requestId: frame.requestId, cleanupConfirmed: true })
    }
    wire.onFrame(frame => {
      if (frame.type === 'task.execute') requests.set(frame.requestId, frame)
      if (frame.type === 'task.read') queueMicrotask(() => wire.emit(outputTask(frame,
        Buffer.from(state.output[frame.stream]).subarray(frame.offset), { eof: terminals.has(frame.requestId) })))
      if (frame.type === 'task.closeOwner' && state.autoClose) queueMicrotask(() => acknowledge(frame))
      for (const watcher of [...watchers]) watcher()
    })
    const message = async (type, after = 0, predicate = () => true) => {
      const find = () => wire.frames.slice(after).find(frame => frame.type === type && predicate(frame))
      if (find()) return find()
      let check
      try { return await bounded(new Promise(resolve => {
        check = () => { const frame = find(); if (frame) resolve(frame) }
        watchers.add(check); check()
      }), `native ${type}`) } finally { watchers.delete(check) }
    }
    try {
      await ctx.plugin(Policy, { mode, workspaceRoot: directory })
      await ctx.plugin(inner => {
        inner.provide('shellEnv', { collect(call) { collections.push(call); return { ...state.environment } } })
        inner.provide('sandbox', { async confine(argv, effective, signal) {
          confinements.push({ argv: [...argv], policy: snapshot(effective), signal })
          if (state.confine) return state.confine(argv, effective, signal)
          return { argv: [process.execPath, 'fixture-public-confinement', ...argv], enforcement: 'full' }
        } })
      })
      plugin = await ctx.plugin({ name: 'resident-fresh-host-fixture', inject: ['agents', 'sessions', 'sandboxPolicy', 'sandbox', 'shellEnv'], apply(inner) {
        host = createFreshTaskHost(inner, { transport: wire.transport, async runtime(...args) {
          preparations.push(args)
          return state.runtime ? state.runtime(...args) : { file: process.execPath, env: { ...state.runtimeEnvironment } }
        } })
      } })
      const prepared = (overrides = {}) => {
        const standing = policy(overrides.call?.agent), spec = { command: 'printf fixture', workdir: directory,
          timeoutMs: 120000, graceMs: 0.5, includeDiagnostics: false, ...overrides.spec }
        return { args: { description: 'Run controlled fresh task', ...overrides.args }, spec,
          call: { agent: agents[0], callId: `fresh-${++identity}`, signal: new AbortController().signal, ...overrides.call },
          standing, policy: snapshot(standing), env: {}, background: false,
          observe: execution => observed.push(execution), bash: { file: process.execPath, source: 'fixture-runtime' },
          active: () => true, ...overrides, spec }
      }
      const invoke = (input = prepared(), jobs) => {
        const result = host.run(input, jobs)
        calls.push(result); void result.catch(() => {})
        return result
      }
      const submit = async (input = prepared(), jobs) => {
        const after = wire.frames.length, result = invoke(input, jobs)
        const request = await message('task.execute', after)
        return { input, result, request }
      }
      const admit = async call => {
        const after = wire.frames.length
        wire.emit({ type: 'task.admit', requestId: call.request.requestId })
        return message('task.admission', after, frame => frame.requestId === call.request.requestId)
      }
      const success = async call => {
        starts.add(call.request.requestId)
        wire.emit({ type: 'task.started', requestId: call.request.requestId })
        finish(call.request)
        return bounded(call.result, 'fresh result')
      }
      const rejected = async (call, reply) => {
        finish(call.request, { status: 'rejected', exitCode: null, effectState: 'none', error: reply.error })
        return bounded(call.result, 'rejected fresh result')
      }
      await run({ ...publicHost, directory, wire, state, host, plugin, policy, prepared, invoke, submit,
        admit, success, rejected, finish, cancel, acknowledge, message, requests, preparations, confinements, collections, observed, starts })
      publicHost.assertObservers()
      assert.deepEqual(wire.failures, [], 'Scripted protocol must remain valid')
    } finally {
      // Rescue unfinished scripted requests on assertion failure, without claiming successful execution.
      state.autoClose = true
      for (const request of requests.values()) if (!terminals.has(request.requestId)) cancel(request)
      for (const frame of wire.frames) if (frame.type === 'task.closeOwner') acknowledge(frame)
      try { await bounded(Promise.allSettled(calls), 'remaining fresh calls') }
      finally {
        try { if (plugin) await bounded(plugin.dispose(), 'fresh host disposal') }
        finally { await bounded(publicHost.dispose(), 'actual Agent/Jobs disposal') }
      }
    }
  })
}

await test('native head owns preparation and preserves fractional budgets and fresh environment', () => fixture(async f => {
  f.state.environment = { FRESH_VALUE: 'head value', DSH_SUBPROCESS_CONTROL: 'must-not-forward',
    LC_ALL: 'zh_CN.UTF-8', LC_CTYPE: '' }
  const call = await f.submit(f.prepared({ spec: { command: 'printf "a b"', timeoutMs: 1.25, graceMs: 0.5 } }))
  assert.equal(f.preparations.length, 0); assert.equal(f.collections.length, 0)
  assert.equal(call.request.timeoutMs, 1.25); assert.equal(call.request.graceMs, 0.5)
  const reply = await f.admit(call)
  assert.equal(reply.decision, 'launch'); assert.deepEqual(reply.launch.argv, [process.execPath, '-c', 'printf "a b"'])
  assert.equal(reply.launch.cwd, f.directory); assert.equal(reply.launch.env.FRESH_VALUE, 'head value')
  assert.equal(reply.launch.env.DSH_SUBPROCESS_CONTROL, undefined)
  assert.equal(reply.launch.env.NO_COLOR, '1'); assert.equal(reply.launch.env.TERM, 'dumb')
  assert.equal(reply.launch.env.LC_MESSAGES, 'C'); assert.equal(reply.launch.env.LC_ALL, '')
  assert.equal(reply.launch.env.LC_CTYPE, 'zh_CN.UTF-8')
  const value = await f.success(call)
  assert.equal(value.kind, 'foreground'); assert.equal(value.status, 'completed')
  assert.equal(value.stdout.spillPath, undefined); assert.equal(value.diagnostics, undefined)
}))

await test('a queued one-call grant rejects changed standing authority before runtime preparation', () => fixture(async f => {
  const input = f.prepared(); input.policy = { ...input.policy, mode: 'danger-full-access' }
  const call = await f.submit(input)
  setSandboxMode(f.agent.session, 'danger-full-access')
  const reply = await f.admit(call)
  assert.equal(reply.decision, 'reject'); assert.equal(reply.error.code, 'AUTHORITY_CHANGED')
  assert.equal(f.preparations.length, 0)
  const value = await f.rejected(call, reply)
  assert.equal(value.failure.effectState, 'none')
}, { mode: 'read-only' }))

await test('plain queued calls re-admit using current policy and current environment', () => fixture(async f => {
  const call = await f.submit()
  setSandboxMode(f.agent.session, 'read-only'); f.state.environment = { FRESH_VALUE: 'collected-at-head' }
  const reply = await f.admit(call)
  assert.equal(reply.decision, 'launch')
  assert.equal(f.confinements[0].policy.mode, 'read-only')
  assert.deepEqual(reply.launch.argv, [process.execPath, 'fixture-public-confinement', process.execPath, '-c', 'printf fixture'])
  assert.equal(reply.launch.env.FRESH_VALUE, 'collected-at-head')
  const value = await f.success(call)
  assert.equal(value.sandbox.mode, 'read-only'); assert.equal(value.sandbox.enforcement, 'full')
}))

await test('an unchanged one-call grant never widens the next request of the same Agent', () => fixture(async f => {
  const input = f.prepared(); input.policy = { ...input.policy, mode: 'danger-full-access' }
  const first = await f.submit(input), second = await f.submit()
  assert.equal((await f.admit(first)).decision, 'launch'); assert.equal(f.confinements.length, 0)
  await f.success(first)
  assert.equal((await f.admit(second)).decision, 'launch')
  assert.equal(f.confinements.length, 1); assert.equal(f.confinements[0].policy.mode, 'read-only')
  await f.success(second)
}, { mode: 'read-only' }))

await test('a policy change during runtime preparation cancels the head and suppresses its late launch', () => fixture(async f => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  f.state.runtime = async () => { entered.resolve(); await release.promise; return { file: process.execPath, env: {} } }
  const call = await f.submit()
  f.wire.emit({ type: 'task.admit', requestId: call.request.requestId })
  await bounded(entered.promise, 'runtime entry')
  setSandboxMode(f.agent.session, 'read-only')
  await f.message('cancel', 0, frame => frame.requestId === call.request.requestId)
  release.resolve(); await turn(); await turn()
  assert.equal(f.wire.frames.some(frame => frame.type === 'task.admission'), false)
  f.cancel(call.request)
  assert.equal((await call.result).failure.effectState, 'none')
}))

await test('publication revocation during public confinement rejects the prepared wrapper', () => fixture(async f => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let active = true
  f.state.confine = async argv => { entered.resolve(); await release.promise; return { argv: [...argv], enforcement: 'full' } }
  const call = await f.submit(f.prepared({ active: () => active }))
  const pending = f.admit(call)
  await bounded(entered.promise, 'confinement entry'); active = false; release.resolve()
  const reply = await pending
  assert.equal(reply.decision, 'reject'); assert.equal(reply.error.code, 'OWNER_DISPOSED')
  assert.equal((await f.rejected(call, reply)).failure.effectState, 'none')
}, { mode: 'read-only' }))

await test('authority change cancels only admitted work while queued and sibling requests progress', () => fixture(async f => {
  const head = await f.submit(), queued = await f.submit(), sibling = await f.submit(f.prepared({ call: { agent: f.agents[1] } }))
  await f.admit(head); await f.admit(sibling)
  for (const call of [head, sibling]) { f.starts.add(call.request.requestId); f.wire.emit({ type: 'task.started', requestId: call.request.requestId }) }
  setSandboxMode(f.agent.session, 'read-only')
  await f.message('cancel', 0, frame => frame.requestId === head.request.requestId)
  assert.deepEqual(f.wire.frames.filter(frame => frame.type === 'cancel').map(frame => frame.requestId), [head.request.requestId])
  f.cancel(head.request); assert.equal((await head.result).failure.effectState, 'unknown')
  assert.equal((await f.admit(queued)).decision, 'launch'); assert.equal(f.confinements.at(-1).policy.mode, 'read-only')
  await f.success(queued)
  f.finish(sibling.request); assert.equal((await sibling.result).status, 'completed')
}))

await test('prepared arguments, runtime selection and exact Agent are snapshotted before queueing', () => fixture(async f => {
  const script = path.join('scripts', '脚本 with spaces.sh')
  const input = f.prepared({ spec: { command: undefined, scriptPath: script, includeDiagnostics: true } })
  const callId = input.call.callId, call = await f.submit(input)
  input.spec.scriptPath = 'other.sh'; input.spec.command = 'wrong'; input.spec.workdir = 'wrong'
  input.call.agent = f.agents[1]; input.call.callId = 'wrong'; input.bash.file = 'relative'; input.bash.source = 'wrong'
  input.args.description = 'wrong'; input.policy.mode = 'read-only'
  const reply = await f.admit(call)
  assert.deepEqual(reply.launch.argv, [process.execPath, script]); assert.equal(reply.launch.cwd, f.directory)
  assert.equal(f.collections[0].agent, f.agent); assert.equal(f.collections[0].callId, callId)
  assert.equal(f.preparations[0][0].source, 'fixture-runtime'); assert.equal(f.preparations[0][2].mode, 'danger-full-access')
  const value = await f.success(call)
  assert.equal(value.diagnostics.executor.kind, 'resident-task'); assert.equal(value.diagnostics.executor.source, 'fixture-runtime')
}))

await test('actual Agent disposal awaits native owner cleanup and preserves a sibling request', () => fixture(async f => {
  f.state.autoClose = false
  const first = await f.submit(), sibling = await f.submit(f.prepared({ call: { agent: f.agents[1] } }))
  let disposed = false
  const closing = f.handles[0].dispose().then(() => { disposed = true })
  const close = await f.message('task.closeOwner')
  await turn(); assert.equal(disposed, false)
  assert.deepEqual(f.wire.frames.filter(frame => frame.type === 'cancel').map(frame => frame.requestId), [first.request.requestId])
  assert.equal((await f.admit(sibling)).decision, 'launch'); await f.success(sibling)
  f.acknowledge(close); await bounded(closing, 'Agent disposal')
  assert.equal(disposed, true); assert.equal((await first.result).failure.effectState, 'none')
}))

await test('actual Jobs registration owns background lifetime despite reentrant caller abort', () => fixture(async f => {
  const cancellation = new AbortController()
  f.onRegistered(() => cancellation.abort(new Error('caller returned during registration')))
  const call = await f.submit(f.prepared({ background: true, call: { agent: f.agent, signal: cancellation.signal, callId: 'durable-job' } }), f.jobs)
  const background = await call.result
  assert.equal(background.kind, 'background'); assert.equal(f.events.filter(event => event.type === 'registered').length, 1)
  assert.equal(call.request.lifetime, 'job'); assert.equal(call.request.timeoutMs, undefined)
  assert.equal(f.jobs.get(background.jobId, f.agent.id).owner, f.agent.id)
  assert.throws(() => f.jobs.get(background.jobId, f.agents[1].id))
  assert.equal((await f.admit(call)).decision, 'launch')
  assert.equal(f.wire.frames.filter(frame => frame.type === 'cancel').length, 0)
  await f.success(call)
  const settled = await f.jobs.wait(background.jobId, 5000, f.agent.id)
  assert.equal(settled.status, 'completed'); assert.equal(f.wire.frames.filter(frame => frame.type === 'task.execute').length, 1)
}))

await test('explicit host disposal revokes availability before any new public Jobs registration', () => fixture(async f => {
  const call = await f.submit()
  await f.admit(call); await f.success(call)
  await f.host.dispose()
  assert.equal(f.host.available, false)
  await assert.rejects(f.invoke(f.prepared({ background: true }), f.jobs), /OWNER_DISPOSED/)
  assert.equal(f.events.filter(event => event.type === 'registered').length, 0)
  assert.equal(f.wire.frames.filter(frame => frame.type === 'task.execute').length, 1)
}))

await test('Jobs preflight refusal permits only one direct foreground attempt and no background enqueue', () => fixture(async f => {
  await f.controller.dispose()
  await assert.rejects(f.invoke(f.prepared({ background: true }), f.jobs), /no job controller/)
  assert.equal(f.wire.frames.filter(frame => frame.type === 'task.execute').length, 0)
  const call = await f.submit(f.prepared(), f.jobs)
  assert.equal(call.request.timeoutMs, 120000)
  await f.admit(call); await f.success(call)
  assert.equal(f.wire.frames.filter(frame => frame.type === 'task.execute').length, 1)
  assert.equal(f.events.filter(event => event.type === 'registered').length, 0)
}))

await test('accepted Jobs work never replays after runtime rejection and a pre-abort never enqueues', () => fixture(async f => {
  const cancellation = new AbortController(); cancellation.abort(new Error('already cancelled'))
  const aborted = await f.invoke(f.prepared({ call: { agent: f.agent, signal: cancellation.signal } }))
  assert.equal(aborted.failure.effectState, 'none'); assert.equal(f.wire.frames.filter(frame => frame.type === 'task.execute').length, 0)
  f.state.runtime = async () => { throw new Error('selected runtime missing') }
  const call = await f.submit(f.prepared(), f.jobs), reply = await f.admit(call)
  assert.equal(reply.decision, 'reject'); assert.equal(f.events.filter(event => event.type === 'registered').length, 1)
  const value = await f.rejected(call, reply)
  assert.equal(value.status, 'failed'); assert.equal(value.failure.effectState, 'none')
  assert.match(value.error, /selected runtime missing/)
  assert.equal(f.wire.frames.filter(frame => frame.type === 'task.execute').length, 1)
  assert.equal(f.jobs.list(f.agent.id).length, 0)
}))

await test('confinement observations preserve the native typed failure and exact effect facts', () => fixture(async f => {
  f.state.confine = async argv => ({ argv: [...argv], enforcement: 'full', denialSignatures: ['fixture permission denied'] })
  const call = await f.submit(); await f.admit(call)
  f.state.output.stderr = 'fixture permission denied\n'
  f.starts.add(call.request.requestId); f.wire.emit({ type: 'task.started', requestId: call.request.requestId })
  f.finish(call.request, { status: 'failed', exitCode: 1, effectState: 'unknown',
    error: { code: 'OUTPUT_INCOMPLETE', message: 'Native capture did not complete.' } })
  const value = await call.result
  assert.equal(value.failure.code, 'OUTPUT_INCOMPLETE'); assert.equal(value.failure.effectState, 'unknown')
  assert.equal(value.failure.retry, 'never'); assert.match(value.error, /^OUTPUT_INCOMPLETE:/)
  assert.equal(value.sandbox.denied, true); assert.equal(value.sandbox.denialObservation, 'detected')
  assert.ok(value.restriction); assert.equal(value.stderr.text, 'fixture permission denied\n')
}, { mode: 'read-only' }))

report('resident-fresh-host')
