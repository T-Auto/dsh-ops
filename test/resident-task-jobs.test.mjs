/** Real Jobs registration and ownership with an instrumented TaskExecution, not a native-process proof. */
import { runTaskJob } from '../lib/execution/resident/task-jobs.js'
import { createResidentTaskJobs } from './lib/resident-task-jobs.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))
async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 5000)
    })])
  } finally { clearTimeout(timer) }
}

function taskProducer({ started = true, stdout = '', stderr = '' } = {}) {
  const terminal = Promise.withResolvers(), entered = Promise.withResolvers()
  const killed = Promise.withResolvers(), promoting = Promise.withResolvers(), promotion = Promise.withResolvers()
  const starts = [], kills = [], streams = { stdout, stderr }, reads = []
  let settled = false, cancelled = false, promotionCalls = 0
  const read = stream => offset => {
    const bytes = Buffer.from(streams[stream])
    reads.push({ stream, offset })
    return { text: bytes.subarray(offset).toString('utf8'), nextOffset: bytes.length, lossy: false }
  }
  const execution = {
    status: 'running', started, effectState: started ? 'unknown' : 'none', cleanupConfirmed: false,
    observed: { stdout: { readFrom: read('stdout') }, stderr: { readFrom: read('stderr') } },
    done: terminal.promise.then(() => undefined), result: () => terminal.promise,
    kill(reason) {
      if (settled || cancelled) return
      cancelled = true; kills.push(reason); killed.resolve(reason)
    },
    promote() { promotionCalls++; promoting.resolve(); return promotion.promise },
  }
  function complete(overrides = {}) {
    if (settled) return
    settled = true
    execution.cleanupConfirmed = true
    execution.status = overrides.cancelled ? 'killed' : 'completed'
    execution.exitCode = overrides.exitCode ?? (overrides.cancelled ? null : 0)
    terminal.resolve({ exitCode: execution.exitCode, signal: null, timedOut: false, timeoutMs: 50,
      stdout: { text: streams.stdout, truncated: false, bytesTotal: Buffer.byteLength(streams.stdout) },
      stderr: { text: streams.stderr, truncated: false, bytesTotal: Buffer.byteLength(streams.stderr) }, ...overrides })
    // Native terminal completion loses a pending promotion race; no replacement is created.
    promotion.resolve(false)
  }
  return {
    execution, starts, kills, reads, entered: entered.promise, killed: killed.promise, promoting: promoting.promise,
    promotion, complete, append(stream, text) { streams[stream] += text },
    get promotionCalls() { return promotionCalls },
    start(call, lifetime) {
      starts.push({ call, lifetime }); entered.resolve()
      call.signal?.addEventListener('abort', () => execution.kill('producer signal aborted'), { once: true })
      if (call.signal?.aborted) execution.kill('producer signal aborted')
      return execution
    },
  }
}

async function fixture(run, options = {}) {
  await withTempDir('resident-task-jobs', async cwd => {
    const f = await createResidentTaskJobs({ cwd, initialAgents: 2, ...options })
    const producers = [], calls = []
    const producer = options => { const value = taskProducer(options); producers.push(value); return value }
    const submit = (p, options = {}, call = {}, jobs = f.jobs) => {
      const state = { settled: false, value: undefined, error: undefined }
      const result = runTaskJob(jobs, { label: 'Controlled native task', background: false, timeoutMs: 50, ...options },
        { agent: f.agent, callId: 'resident-task-call', signal: new AbortController().signal, ...call }, p.start)
      result.then(value => { state.settled = true; state.value = value }, error => { state.settled = true; state.error = error })
      calls.push(result)
      return { result, state }
    }
    try { await run({ ...f, producer, submit }); f.assertObservers() }
    finally {
      // Rescue held test producers after an assertion failure; never simulate successful native cleanup in the assertion path.
      for (const p of producers) p.complete({ cancelled: true })
      try { await bounded(Promise.allSettled(calls), 'pending adapter calls during fixture teardown') }
      finally { await bounded(f.dispose(), 'actual Agent and Jobs teardown') }
    }
  })
}

await test('controller preflight rejection never invokes the task producer', () => fixture(async f => {
  await f.controller.dispose()
  const p = f.producer(), call = f.submit(p, { background: true })
  await assert.rejects(call.result, error => error.name === 'BashJobAdmissionError' && error.runInvoked === false && /no job controller/.test(error.message))
  assert.equal(p.starts.length, 0)
  assert.deepEqual(f.jobs.list(f.agent.id), [])
  assert.equal(f.events.filter(event => event.type === 'registered').length, 0)
}))

await test('a pre-aborted caller creates neither a Jobs record nor a task', () => fixture(async f => {
  const cancellation = new AbortController(); cancellation.abort(new Error('caller already aborted'))
  const p = f.producer(), call = f.submit(p, { background: true }, { signal: cancellation.signal })
  await assert.rejects(call.result, /caller already aborted/)
  assert.equal(p.starts.length, 0)
  assert.equal(f.events.filter(event => event.type === 'registered').length, 0)
}))

await test('registered-event caller cancellation preserves an explicit background handoff', () => fixture(async f => {
  const cancellation = new AbortController(), p = f.producer()
  let registration
  f.onRegistered(event => { registration = event.job; cancellation.abort(new Error('caller disappeared at commit')) })
  const call = f.submit(p, { background: true }, { signal: cancellation.signal })
  const value = await bounded(call.result, 'background handoff')
  await bounded(p.entered, 'background producer')
  assert.equal(value.kind, 'background')
  assert.equal(value.jobId, registration.id)
  assert.equal(registration.owner, f.agent.id)
  assert.equal(p.starts.length, 1)
  assert.equal(p.starts[0].lifetime, 'job')
  assert.equal(p.starts[0].call.signal.aborted, false)
  assert.deepEqual(p.kills, [])
  p.complete()
  assert.equal((await f.jobs.wait(value.jobId, 1000, f.agent.id)).status, 'completed')
  assert.equal(f.jobs.get(value.jobId, f.agent.id).id, value.jobId)
}))

await test('registered-event job kill prevents producer start before jobs.start returns', () => fixture(async f => {
  const p = f.producer()
  let registeredId
  f.onRegistered((event, jobs) => { registeredId = event.job.id; jobs.kill(event.job.id, f.agent.id, 'kill at registration') })
  const call = f.submit(p, { background: true })
  await assert.rejects(call.result, /task|kill|abort/i)
  assert.ok(registeredId)
  assert.equal(p.starts.length, 0)
  assert.deepEqual(f.jobs.list(f.agent.id), [])
  assert.equal(f.events.filter(event => event.type === 'registered').length, 1)
  assert.equal(f.events.filter(event => event.type === 'settled').length, 1)
}))

await test('registration reentrancy cannot redirect the captured Agent, call identity or background lifetime', () => fixture(async f => {
  const p = f.producer(), originalSignal = new AbortController().signal
  const call = { agent: f.agent, callId: 'original-task-call', signal: originalSignal }
  const options = { label: 'Original task owner', background: true, timeoutMs: 50 }
  f.onRegistered(() => {
    call.agent = f.agents[1]
    call.callId = 'replacement-task-call'
    call.signal = AbortSignal.abort(new Error('replacement caller'))
    options.background = false
    options.label = 'Replacement task label'
    options.timeoutMs = 1
  })
  const result = runTaskJob(f.jobs, options, call, p.start)
  void result.catch(() => {})
  const value = await bounded(result, 'snapshotted background registration')
  await bounded(p.entered, 'original owner producer')
  assert.equal(value.kind, 'background')
  assert.equal(value.label, 'Original task owner')
  assert.equal(f.jobs.get(value.jobId, f.agent.id).owner, f.agent.id)
  assert.throws(() => f.jobs.get(value.jobId, f.agents[1].id), /another session/)
  assert.equal(p.starts.length, 1)
  assert.equal(p.starts[0].call.agent, f.agent)
  assert.equal(p.starts[0].call.callId, 'original-task-call')
  assert.equal(p.starts[0].call.signal.aborted, false)
  assert.equal(p.starts[0].lifetime, 'job')
  assert.deepEqual(p.kills, [])
  p.complete()
  await f.jobs.wait(value.jobId, 1000, f.agent.id)
}))

await test('foreground preparation timeout cancels and joins without promoting an unstarted task', () => fixture(async f => {
  const p = f.producer({ started: false }), call = f.submit(p)
  await bounded(p.killed, 'preparation timeout cancellation')
  assert.equal(p.promotionCalls, 0)
  assert.equal(call.state.settled, false)
  assert.equal(p.execution.cleanupConfirmed, false)
  p.complete({ cancelled: true })
  const value = await bounded(call.result, 'joined preparation timeout')
  assert.equal(value.kind, 'foreground')
  assert.equal(value.timedOut, true)
  assert.equal(value.failure.effectState, 'none')
  assert.equal(p.execution.cleanupConfirmed, true)
  assert.deepEqual(f.jobs.list(f.agent.id), [])
}))

await test('accepted promotion retains one producer and the original Jobs record', () => fixture(async f => {
  const p = f.producer({ stdout: 'before promotion' }), cancellation = new AbortController()
  const call = f.submit(p, {}, { signal: cancellation.signal })
  await bounded(p.promoting, 'promotion request')
  const registered = f.events.find(event => event.type === 'registered').job
  p.promotion.resolve(true)
  const value = await bounded(call.result, 'accepted promotion')
  assert.equal(value.kind, 'promoted')
  assert.equal(value.jobId, registered.id)
  assert.equal(p.starts.length, 1)
  assert.equal(p.starts[0].lifetime, 'foreground')
  assert.equal(p.promotionCalls, 1)
  assert.match(value.output, /before promotion/)
  assert.equal(f.jobs.get(value.jobId, f.agent.id).status, 'running')
  cancellation.abort(new Error('caller ended after handoff'))
  await turn()
  assert.deepEqual(p.kills, [])
  p.append('stdout', ' final tail'); p.complete()
  await f.jobs.wait(value.jobId, 1000, f.agent.id)
  assert.equal(f.jobs.read(value.jobId, f.agent.id).chunks.map(chunk => chunk.text).join(''), ' final tail')
  assert.equal(f.events.filter(event => event.type === 'registered').length, 1)
}))

await test('caller abort during held promotion kills and awaits producer cleanup', () => fixture(async f => {
  const cancellation = new AbortController(), p = f.producer()
  const call = f.submit(p, {}, { signal: cancellation.signal })
  await bounded(p.promoting, 'held promotion')
  cancellation.abort(new Error('abort while promotion is pending'))
  await bounded(p.killed, 'held-promotion cancellation')
  assert.equal(call.state.settled, false)
  assert.equal(p.execution.cleanupConfirmed, false)
  p.complete({ cancelled: true })
  await assert.rejects(call.result, /abort|cancel/i)
  assert.equal(p.execution.cleanupConfirmed, true)
  assert.equal(p.starts.length, 1)
  assert.deepEqual(f.jobs.list(f.agent.id), [])
}))

await test('root completion winning promotion returns the same foreground result without retry', () => fixture(async f => {
  const p = f.producer({ stdout: 'root result' }), call = f.submit(p)
  await bounded(p.promoting, 'promotion arbitration')
  const registered = f.events.find(event => event.type === 'registered').job.id
  p.complete({ exitCode: 7 })
  const value = await bounded(call.result, 'foreground completion winning promotion')
  assert.equal(value.kind, 'foreground')
  assert.equal(value.exitCode, 7)
  assert.equal(value.stdout.text, 'root result')
  assert.equal(value.failure.effectState, 'unknown')
  assert.equal(p.starts.length, 1)
  assert.equal(p.promotionCalls, 1)
  assert.deepEqual(p.kills, [])
  assert.equal(f.events.filter(event => event.type === 'registered').length, 1)
  assert.equal(f.events.find(event => event.type === 'settled').job.id, registered)
  assert.deepEqual(f.jobs.list(f.agent.id), [])
}))

await test('actual sibling Agents cannot inspect, consume, cancel, wait on or remove another task job', () => fixture(async f => {
  const p = f.producer(), value = await f.submit(p, { background: true }).result
  await p.entered
  const foreign = f.agents[1].id
  assert.deepEqual(f.jobs.list(foreign), [])
  for (const access of [() => f.jobs.get(value.jobId, foreign), () => f.jobs.read(value.jobId, foreign),
    () => f.jobs.readAt(value.jobId, 0, foreign), () => f.jobs.kill(value.jobId, foreign), () => f.jobs.remove(value.jobId, foreign)]) {
    assert.throws(access, /another session/)
  }
  await assert.rejects(f.jobs.wait(value.jobId, 1000, foreign), /another session/)
  assert.deepEqual(p.kills, [])
  assert.equal(f.jobs.get(value.jobId, f.agent.id).status, 'running')
  p.complete(); await f.jobs.wait(value.jobId, 1000, f.agent.id)
}))

await test('background jobs outlive the caller fiber and drain final streams before terminal reads', () => fixture(async f => {
  let scopedJobs
  const caller = await f.ctx.plugin({ inject: ['jobs'], apply(inner) { scopedJobs = inner.jobs } })
  const cancellation = new AbortController(), p = f.producer({ stdout: 'head' })
  const value = await f.submit(p, { background: true }, { signal: cancellation.signal }, scopedJobs).result
  await p.entered
  await caller.dispose(); cancellation.abort(new Error('caller fiber removed'))
  assert.deepEqual(p.kills, [])
  assert.equal(f.jobs.get(value.jobId, f.agent.id).status, 'running')
  p.append('stdout', ' tail'); p.append('stderr', 'final stderr'); p.complete()
  await f.jobs.wait(value.jobId, 1000, f.agent.id)
  const observed = f.jobs.readAt(value.jobId, 0, f.agent.id)
  assert.equal(observed.lossy, false)
  const read = f.jobs.read(value.jobId, f.agent.id)
  assert.equal(read.chunks.filter(chunk => chunk.channel === 'stdout').map(chunk => chunk.text).join(''), 'head tail')
  assert.equal(read.chunks.filter(chunk => chunk.channel === 'stderr').map(chunk => chunk.text).join(''), 'final stderr')
  assert.equal(read.job.status, 'completed')
  assert.equal(read.job.output.spillPaths, undefined)
  assert.equal(f.jobs.read(value.jobId, f.agent.id).chunks.length, 0)
  assert.deepEqual(f.jobs.readAt(value.jobId, 0, f.agent.id), observed)
  assert.equal(p.execution.cleanupConfirmed, true)
}))

await test('a promotion adapter rejection cancels and joins live work before returning its error', () => fixture(async f => {
  const p = f.producer(), call = f.submit(p)
  await bounded(p.promoting, 'promotion before adapter failure')
  p.promotion.reject(new Error('promotion adapter failed'))
  await bounded(p.killed, 'adapter failure cancellation')
  assert.equal(call.state.settled, false)
  assert.equal(p.execution.cleanupConfirmed, false)
  p.complete({ cancelled: true })
  await assert.rejects(call.result, /promotion adapter failed/)
  assert.equal(p.execution.cleanupConfirmed, true)
  assert.equal(p.starts.length, 1)
  assert.deepEqual(f.jobs.list(f.agent.id), [])
}))

report('resident-task-jobs')
