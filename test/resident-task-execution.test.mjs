/** Native boundary is scripted; ownership uses real public Agents and Cordis disposal. */
import { createTaskExecutionHost } from '../lib/execution/resident/task-owner.js'
import { TaskOutputView } from '../lib/execution/resident/task-output.js'
import { createResidentTaskJobs } from './lib/resident-task-jobs.mjs'
import { taskTransport, completedTask, outputTask, turn } from './lib/resident-task-transport.mjs'
import { assert, report, test } from './lib/harness.mjs'

const spec = { command: 'fixture', timeoutMs: 1000, graceMs: 0.5, includeDiagnostics: true }
const launch = { argv: ['/exact-public-wrapper', 'argument with spaces'], cwd: '/cwd', env: { ONLY: 'explicit' } }
async function fixture(options = {}) {
  const host = await createResidentTaskJobs({ initialAgents: 2 }), wire = taskTransport(options)
  let adapter
  const plugin = await host.ctx.plugin({ name: 'task-execution-fixture', inject: ['agents'], apply(ctx) { adapter = createTaskExecutionHost(ctx, wire.transport) } })
  wire.onFrame(value => {
    if (value.type === 'task.closeOwner') queueMicrotask(() => wire.emit({ type: 'task.ownerClosed', requestId: value.requestId, cleanupConfirmed: true }))
  })
  return { host, wire, adapter, plugin,
    start(admit = async () => launch, call = {}, overrides = {}) {
      const execution = adapter.start({ agent: host.agent, ...call }, { lifetime: 'foreground', source: 'fixture', spec, admit, ...overrides })
      return { execution, requestId: wire.frames.findLast(value => value.type === 'task.execute')?.requestId }
    },
    async begin(requestId) {
      wire.emit({ type: 'task.admit', requestId }); await turn()
      wire.emit({ type: 'task.started', requestId }); await turn()
    },
    async dispose() { await plugin.dispose(); await host.dispose() },
  }
}

await test('head admission forwards exact launch and returns final streams before release', async () => {
  const f = await fixture({ autoRead: false }); let admitted = 0
  try {
    const { execution, requestId } = f.start(async () => { admitted++; return launch })
    assert.equal(admitted, 0); assert.equal(execution.started, false); assert.equal(execution.effectState, 'unknown')
    await f.begin(requestId)
    assert.deepEqual(f.wire.frames.find(value => value.type === 'task.admission').launch, launch)
    const live = f.wire.frames.filter(value => value.type === 'task.read')
    for (const read of live) f.wire.emit(outputTask(read, Buffer.alloc(0), { eof: false }))
    await turn()
    f.wire.emit(completedTask(requestId, { stdoutTotal: 4, stderrTotal: 3 }))
    await turn()
    const reads = f.wire.frames.filter(value => value.type === 'task.read').slice(-2)
    let settled = false; void execution.done.then(() => { settled = true })
    f.wire.emit(outputTask(reads.find(v => v.stream === 'stdout'), Buffer.from('tail')))
    await turn(); assert.equal(settled, false)
    f.wire.emit(outputTask(reads.find(v => v.stream === 'stderr'), Buffer.from('err')))
    const value = await execution.result()
    assert.equal(value.stdout.text, 'tail'); assert.equal(value.stderr.text, 'err')
    assert.equal(execution.cleanupConfirmed, true); assert.equal(f.wire.frames.at(-1).type, 'task.release')
  } finally { await f.dispose() }
})

await test('cancelled admission ignores its late answer and physical start is never fabricated', async () => {
  const f = await fixture(), delayed = Promise.withResolvers(), cancellation = new AbortController()
  try {
    const { execution, requestId } = f.start(() => delayed.promise, { signal: cancellation.signal })
    f.wire.emit({ type: 'task.admit', requestId }); cancellation.abort()
    assert.equal(f.wire.frames.at(-1).type, 'cancel'); assert.equal(execution.started, false)
    f.wire.emit(completedTask(requestId, { status: 'cancelled', effectState: 'none', error: { code: 'CANCELLED', message: 'cancelled while admitting' } }))
    delayed.resolve(launch); await execution.done
    assert.equal(f.wire.frames.some(value => value.type === 'task.admission'), false)
    assert.equal(execution.effectState, 'none'); assert.equal((await execution.result()).cancelled, true)
  } finally { await f.dispose() }
})

await test('capture error keeps EOF false yet settles failed after joining the other stream', async () => {
  const f = await fixture({ autoRead: false })
  try {
    const { execution, requestId } = f.start()
    f.wire.emit(completedTask(requestId, { status: 'failed', error: { code: 'CAPTURE_FAILED', message: 'reader failed' }, stdoutTotal: 3, stderrTotal: 4 }))
    await turn()
    const reads = f.wire.frames.filter(value => value.type === 'task.read')
    f.wire.emit(outputTask(reads.find(v => v.stream === 'stdout'), Buffer.from('pre'), { eof: false, error: { code: 'CAPTURE_FAILED', message: 'reader failed' } }))
    let settled = false; void execution.done.then(() => { settled = true })
    await turn(); assert.equal(settled, false)
    f.wire.emit(outputTask(reads.find(v => v.stream === 'stderr'), Buffer.from('tail')))
    const value = await execution.result()
    assert.equal(value.stdout.text, 'pre'); assert.equal(value.stdout.truncated, true)
    assert.equal(value.stderr.text, 'tail'); assert.match(value.error, /CAPTURE_FAILED/)
    assert.equal(execution.observed.stdout.eof, false); assert.equal(f.wire.failures.length, 0)
  } finally { await f.dispose() }
})

await test('contradictory output aborts before joining a pending sibling and retains cleanup uncertainty', async () => {
  const f = await fixture({ autoRead: false, cleanup: false })
  try {
    const { execution, requestId } = f.start()
    f.wire.emit(completedTask(requestId, { status: 'failed', error: { code: 'BROKEN', message: 'failed' }, stdoutTotal: 1 }))
    await turn()
    const read = f.wire.frames.find(value => value.type === 'task.read' && value.stream === 'stdout')
    f.wire.emit(outputTask(read, Buffer.alloc(0)))
    await turn(); assert.equal(f.wire.failures.length, 1)
    let settled = false; void execution.done.then(() => { settled = true })
    await turn(); assert.equal(settled, false)
    f.wire.finishCleanup(false)
    await execution.done; assert.equal(execution.cleanupConfirmed, false)
    assert.throws(() => f.start(), /provider is no longer available/)
    assert.equal((await execution.result()).stdout.bytesTotal, 1)
    await assert.rejects(f.adapter.dispose(), /output disagrees/)
    await f.plugin.dispose()
  } finally { await f.host.dispose().catch(() => {}) }
})

await test('exact owner disposal waits cleanup and does not cancel a sibling task', async () => {
  const f = await fixture()
  try {
    const first = f.start(), second = f.start(undefined, { agent: f.host.agents[1] })
    assert.throws(() => f.start(undefined, { agent: { ...f.host.agent } }), /belongs|active/)
    let disposed = false
    const closing = f.host.handles[0].dispose().then(() => { disposed = true })
    await turn(); assert.equal(disposed, false)
    assert.deepEqual(f.wire.frames.filter(value => value.type === 'cancel').map(value => value.requestId), [first.requestId])
    f.wire.emit(completedTask(first.requestId, { status: 'cancelled', effectState: 'none', error: { code: 'CANCELLED', message: 'owner closed' } }))
    await closing; assert.equal(second.execution.status, 'running')
    f.wire.emit(completedTask(second.requestId, { status: 'rejected', effectState: 'none', error: { code: 'NO', message: 'fixture finish' } }))
    await second.execution.done
  } finally { await f.dispose() }
})

await test('already-resolved contradictory final reads still wait the outer cleanup receipt', async () => {
  const f = await fixture({ autoRead: false, cleanup: false })
  try {
    const { execution, requestId } = f.start()
    f.wire.emit(completedTask(requestId, { status: 'failed', error: { code: 'BROKEN', message: 'failed' }, stdoutTotal: 1 }))
    await turn()
    const reads = f.wire.frames.filter(value => value.type === 'task.read')
    for (const read of reads) f.wire.emit(outputTask(read, Buffer.alloc(0)))
    let settled = false; void execution.done.then(() => { settled = true })
    await turn(); assert.equal(f.wire.failures.length, 1); assert.equal(settled, false)
    f.wire.finishCleanup(false)
    await execution.done; assert.equal(execution.cleanupConfirmed, false)
    await assert.rejects(f.adapter.dispose(), /output disagrees/); await f.plugin.dispose()
  } finally { await f.host.dispose().catch(() => {}) }
})

await test('an exact public session disposal notification closes only that session owner', async () => {
  const f = await fixture()
  try {
    const first = f.start(), sibling = f.start(undefined, { agent: f.host.agents[1] })
    f.host.ctx.emit('session/disposed', f.host.agent.session)
    await turn()
    assert.deepEqual(f.wire.frames.filter(value => value.type === 'cancel').map(value => value.requestId), [first.requestId])
    assert.throws(() => f.start(), /OWNER_DISPOSED/)
    f.wire.emit(completedTask(first.requestId, { status: 'cancelled', effectState: 'none', error: { code: 'CANCELLED', message: 'session disposed' } }))
    f.wire.emit(completedTask(sibling.requestId, { status: 'rejected', effectState: 'none', error: { code: 'NO', message: 'fixture finish' } }))
    await Promise.all([first.execution.done, sibling.execution.done])
  } finally { await f.dispose() }
})

await test('live UTF-8 suffix waits for its remaining bytes and final invalid bytes flush honestly', async () => {
  const host = await createResidentTaskJobs(), view = new TaskOutputView(), terminal = Promise.withResolvers()
  try {
    const frame = bytes => outputTask({ requestId: 'utf8', stream: 'stdout', offset: 0 }, bytes, { eof: false })
    view.update(frame(Buffer.from([0xf0, 0x9f])))
    assert.deepEqual(view.readFrom(0), { text: '', nextOffset: 0, lossy: false })
    const id = host.jobs.start({ kind: 'bash', label: 'split UTF-8', owner: host.agent.id,
      output: [{ channel: 'stdout', read: offset => view.readFrom(offset) }], run: () => ({ done: terminal.promise, cancel() {} }) })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(host.jobs.readAt(id, 0, host.agent.id).chunks.length, 0)
    view.update(frame(Buffer.from('😀中')))
    view.update({ ...frame(Buffer.concat([Buffer.from('😀中'), Buffer.from([0xe2])])), eof: true })
    terminal.resolve({ status: 'completed' }); await host.jobs.wait(id, 1000, host.agent.id)
    assert.equal(host.jobs.readAt(id, 0, host.agent.id).chunks.map(chunk => chunk.text).join(''), '😀中�')
    assert.equal(view.readFrom(0).nextOffset, 8)
  } finally { terminal.resolve({ status: 'killed' }); await host.dispose() }
})

await test('a terminal spill must be sealed before it can reach a settled result', async () => {
  const f = await fixture({ autoRead: false })
  try {
    const { execution, requestId } = f.start()
    f.wire.emit(completedTask(requestId, { status: 'failed', error: { code: 'FIXTURE', message: 'terminal' }, stdoutTotal: 4 }))
    await turn()
    for (const read of f.wire.frames.filter(value => value.type === 'task.read')) {
      f.wire.emit(read.stream === 'stdout' ? outputTask(read, Buffer.from('full'), { spillPath: '/private/full',
        spillOrigin: 'ops-native-v1', spillPid: 123, spillSealed: false }) : outputTask(read))
    }
    const value = await execution.result()
    assert.match(f.wire.failures[0].message, /spill was not sealed/)
    assert.equal(value.stdout.spillPath, undefined)
  } finally { await f.dispose() }
})

await test('bounded synchronous tails expose independent raw cursors and withdraw invalidated spill', () => {
  const view = new TaskOutputView(), bytes = Buffer.alloc(64000, 97)
  view.update(outputTask({ requestId: 'view', stream: 'stdout', offset: 0 }, bytes,
    { retainedOffset: 100, nextOffset: 64100, lossy: true, eof: false, spillPath: '/private/full' }))
  assert.equal(view.readFrom(0).text.length, 64000); assert.equal(view.readFrom(0).lossy, true)
  assert.equal(view.readFrom(64098).text, 'aa'); assert.equal(view.readFrom(64100).text, '')
  assert.equal(view.readFrom(0).spillPath, '/private/full')
  view.update(outputTask({ requestId: 'view', stream: 'stdout', offset: 0 }, bytes,
    { retainedOffset: 100, nextOffset: 64100, lossy: true, eof: true }))
  assert.equal(view.readFrom(0).spillPath, undefined)
  view.update(outputTask({ requestId: 'view', stream: 'stdout', offset: 0 }, bytes,
    { retainedOffset: 100, nextOffset: 64100, lossy: true, eof: false, error: { code: 'CAPTURE_FAILED', message: 'lost stream' } }))
  view.update(outputTask({ requestId: 'view', stream: 'stdout', offset: 0 }, bytes,
    { retainedOffset: 100, nextOffset: 64100, lossy: true, eof: true, spillPath: '/unexpected-restored' }))
  assert.equal(view.error.code, 'CAPTURE_FAILED'); assert.equal(view.readFrom(0).spillPath, undefined)
})

report('resident-task-execution')
