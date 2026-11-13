import { assert, report, test } from './lib/harness.mjs'
import { taskTransport, executeTask, completedTask, outputTask, turn } from './lib/resident-task-transport.mjs'

await test('task negotiation and finite fractional durations preserve existing fresh limits', () => {
  const f = taskTransport(); f.subscribe()
  f.transport.capabilities = []
  assert.throws(() => f.transport.send(executeTask('no-capability')), /unavailable/)
  f.transport.capabilities = ['task-v1']
  f.transport.send(executeTask('fractional'))
  assert.equal(f.frames[0].graceMs, 0.5); assert.equal(f.frames[0].timeoutMs, 1.25)
  for (const value of [0, -1, Infinity, NaN, 2147483648]) {
    assert.throws(() => f.transport.send({ ...executeTask('invalid'), graceMs: value }), /limits/)
    assert.throws(() => f.transport.send({ ...executeTask('invalid'), timeoutMs: value }), /limits/)
  }
  f.transport.send({ ...executeTask('unbounded-job'), lifetime: 'job', timeoutMs: undefined })
})

await test('correlation requires admission, exact physical start, and one terminal receipt', () => {
  const f = taskTransport(); f.subscribe(); f.transport.send(executeTask('task'))
  f.emit({ type: 'task.admit', requestId: 'task' })
  f.transport.send({ type: 'task.admission', requestId: 'task', decision: 'launch', launch: { argv: ['/shell'], cwd: '/', env: {} } })
  f.emit({ type: 'task.started', requestId: 'task' }); f.emit(completedTask('task'))
  assert.deepEqual(f.events.map(v => v.type), ['task.admit', 'task.started', 'task.completed'])
  assert.throws(() => f.transport.send({ type: 'task.promote', requestId: 'task' }), /eligible/)
  f.emit(completedTask('task')); assert.match(f.failures[0].message, /completed/)
})

await test('unsent cancellation is local; sent failure waits cleanup and preserves unknown effects', async () => {
  const f = taskTransport({ held: true, cleanup: false }); f.subscribe()
  f.transport.send(executeTask('unsent')); f.transport.send({ type: 'cancel', requestId: 'unsent' })
  assert.equal(f.events[0].effectState, 'none'); assert.equal(f.frames.length, 0)
  f.transport.send({ type: 'task.release', requestId: 'unsent' })
  f.transport.send(executeTask('sent')); f.release(); f.transport.abort(new Error('lost'))
  assert.equal(f.events.length, 1)
  f.finishCleanup(false)
  assert.equal(f.events[1].effectState, 'unknown'); assert.equal(f.events[1].cleanupConfirmed, false)
  assert.equal(f.events.at(-1).type, 'task.unavailable')
})

await test('owner budgets survive record release and free only after confirmed close', () => {
  const f = taskTransport(); f.subscribe()
  for (let i = 0; i < 32; i++) {
    f.transport.send(executeTask(`r${i}`, `o${i}`))
    f.emit(completedTask(`r${i}`, { status: 'rejected', effectState: 'none', error: { code: 'NO', message: 'refused' } }))
    f.transport.send({ type: 'task.release', requestId: `r${i}` })
  }
  assert.throws(() => f.transport.send(executeTask('overflow', 'new-owner')), /owner capacity/)
  f.transport.send({ type: 'task.closeOwner', requestId: 'close', ownerKey: 'o0', reason: 'disposed' })
  f.emit({ type: 'task.ownerClosed', requestId: 'close', cleanupConfirmed: true })
  f.transport.send(executeTask('replacement', 'new-owner'))
})

await test('bounded raw snapshots keep independent stream cursors and explicit capture failure', async () => {
  const f = taskTransport({ autoRead: false }); f.subscribe(); f.transport.send(executeTask('read'))
  const stdout = f.transport.read('read', 'stdout', 0, 8), stderr = f.transport.read('read', 'stderr', 0, 8)
  await assert.rejects(f.transport.read('read', 'stdout', 0, 8), /concurrent/)
  f.emit(outputTask(f.frames[1], Buffer.from([0, 255]), { retainedOffset: 10, nextOffset: 12, lossy: true, eof: false,
    spillPath: '/private/full', spillOrigin: 'ops-native-v1', spillPid: 123, spillSealed: false }))
  f.emit(outputTask(f.frames[2], Buffer.from('bad'), { eof: false, error: { code: 'CAPTURE_FAILED', message: 'reader failed' } }))
  assert.equal((await stdout).spillPath, '/private/full'); assert.equal((await stderr).eof, false)
  const next = f.transport.read('read', 'stdout', 12, 8)
  f.emit(outputTask(f.frames.at(-1), Buffer.alloc(0), { eof: false }))
  assert.equal((await next).spillPath, undefined); assert.equal(f.failures.length, 0)
})

await test('promotion racing completion retains its request until the native decision arrives', () => {
  const f = taskTransport(); f.subscribe(); f.transport.send(executeTask('promote'))
  f.emit({ type: 'task.admit', requestId: 'promote' })
  f.transport.send({ type: 'task.admission', requestId: 'promote', decision: 'launch', launch: { argv: ['/shell'], cwd: '/', env: {} } })
  f.emit({ type: 'task.started', requestId: 'promote' }); f.transport.send({ type: 'task.promote', requestId: 'promote' })
  f.emit(completedTask('promote'))
  assert.throws(() => f.transport.send({ type: 'task.release', requestId: 'promote' }), /promotion/)
  f.emit({ type: 'task.promoted', requestId: 'promote', accepted: false })
  f.transport.send({ type: 'task.release', requestId: 'promote' })
  assert.equal(f.failures.length, 0)
})

await test('malformed raw snapshots fail the connection and join before rejecting readers', async () => {
  const f = taskTransport({ autoRead: false, cleanup: false }); f.subscribe(); f.transport.send(executeTask('bad'))
  const read = f.transport.read('bad', 'stdout', 0, 2)
  let rejected = false; void read.catch(() => { rejected = true })
  f.emit(outputTask(f.frames.at(-1), Buffer.from('abc')))
  await turn(); assert.equal(rejected, false)
  f.finishCleanup(true); await assert.rejects(read, /bytes/)
})

await test('spill metadata must name this kernel and completed errors must retain their typed shape', async () => {
  for (const spill of [{ spillOrigin: 'host' }, { spillPid: 999 }, { spillSealed: undefined }]) {
    const f = taskTransport({ autoRead: false }); f.subscribe(); f.transport.send(executeTask('spill'))
    const reading = f.transport.read('spill', 'stdout', 0, 8)
    f.emit(outputTask(f.frames.at(-1), Buffer.from('full'), { spillPath: '/private/full', spillOrigin: 'ops-native-v1', spillPid: 123, spillSealed: true, ...spill }))
    await assert.rejects(reading, /output receipt/)
  }
  const f = taskTransport(); f.subscribe(); f.transport.send(executeTask('terminal-error'))
  f.emit({ type: 'task.admit', requestId: 'terminal-error' })
  f.transport.send({ type: 'task.admission', requestId: 'terminal-error', decision: 'launch', launch: { argv: ['/shell'], cwd: '/', env: {} } })
  f.emit({ type: 'task.started', requestId: 'terminal-error' })
  f.emit(completedTask('terminal-error', { error: 42 }))
  assert.match(f.failures[0].message, /completion receipt/)
})

report('resident-task-channel')
