/** Real resident client multiplexing over a scripted public fd7 duplex handle. */
import { Duplex, PassThrough, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { startResident } from '../lib/execution/resident/client.js'
import { workerEnvelope } from '../lib/execution/protocol.js'
import { assert, report, test } from './lib/harness.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))
const exchange = { exitCode: 0, interrupted: false, readers: true, lossy: false, stderr: '', value: { status: 'completed' } }
const file = requestId => ({ ...workerEnvelope('file', { tool: 'stat', args: {}, read_only: true }), requestId })
const execute = requestId => ({ type: 'shell.execute', requestId, sessionKey: 'fixture-session', command: 'printf fixture',
  timeoutMs: 1000, stdoutBytes: 1024, stderrBytes: 1024 })
const completed = (requestId, overrides = {}) => ({ type: 'shell.completed', requestId, status: 'completed', exitCode: 0,
  effectState: 'unknown', shellState: 'preserved', cleanupConfirmed: true, stdoutTotal: 0, stderrTotal: 0, ...overrides })
const output = (requestId, stream, offset, bytes, overrides = {}) => ({ type: 'shell.output', requestId, stream,
  offset, nextOffset: offset + bytes.length, bytesBase64: bytes.toString('base64'), lossy: false, eof: false, ...overrides })
async function bounded(work, label) {
  let timer
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 5000)
    })])
  } finally { clearTimeout(timer) }
}

async function fixture({ capabilities = ['shell-v1'], omitCapabilities = false, ready = true, holdWrites = false, holdExit = false } = {}) {
  const ctx = new Context(); ctx.logger.level = 0
  const input = new PassThrough(), frames = [], writes = [], events = [], watchers = new Set()
  const ended = Promise.withResolvers(), empty = Promise.withResolvers()
  let client, owner, spec, spawns = 0, terminated = 0, waits = 0, finished = false, holdAll = false
  const send = frame => input.write(`${JSON.stringify(frame)}\n`)
  const finish = () => {
    if (!finished) { finished = true; ended.resolve({ exitCode: 0, signal: null }); control.destroy() }
    if (!holdExit) empty.resolve(true)
  }
  const writable = new Writable({ write(bytes, _encoding, callback) {
    const frame = JSON.parse(bytes.toString('utf8'))
    frames.push(frame)
    if (holdAll || holdWrites && (frame.type === 'execute' || frame.type === 'shell.execute')) writes.push(callback)
    else callback()
    if (frame.type === 'shutdown') queueMicrotask(finish)
  } })
  const control = Duplex.from({ readable: input, writable })
  const handle = {
    control, done: ended.promise,
    collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } },
    terminate() { terminated++; finish() },
    waitForExit(signal) {
      waits++
      if (!signal) return empty.promise
      return Promise.race([empty.promise, new Promise(resolve => {
        if (signal.aborted) resolve(false)
        else signal.addEventListener('abort', () => resolve(false), { once: true })
      })])
    },
  }
  await ctx.plugin(inner => inner.provide('subprocess', { spawn(value) {
    spawns++; spec = value
    if (ready) queueMicrotask(() => send({ type: 'ready', version: 1, pid: 123,
      ...omitCapabilities ? {} : { capabilities } }))
    return handle
  } }))
  const starting = ctx.plugin({ name: 'fixture-resident-shell-channel', inject: ['subprocess'], async apply(inner) {
    client = await startResident(inner, '/fixture-worker', '/fixture-workspace')
    client.shell.subscribe(event => { events.push(event); for (const watcher of [...watchers]) watcher() })
  } }).then(value => { owner = value; return client })
  void starting.catch(() => {})
  const event = async (type, requestId) => {
    const find = () => events.find(value => value.type === type && (requestId === undefined || value.requestId === requestId))
    if (find()) return find()
    let check
    try {
      return await bounded(new Promise(resolve => {
        check = () => { const found = find(); if (found) resolve(found) }
        watchers.add(check); check()
      }), `shell event ${type} ${requestId ?? ''}`)
    } finally { watchers.delete(check) }
  }
  return { starting, send, input, frames, writes, events, event, handle, finish,
    holdAllWrites: () => { holdAll = true },
    releaseWrites: () => { holdAll = false; holdWrites = false; while (writes.length) writes.shift()() },
    releaseExit: value => empty.resolve(value ?? true),
    get spec() { return spec }, get spawns() { return spawns }, get terminated() { return terminated }, get waits() { return waits },
    async dispose() {
      empty.resolve(true)
      holdAll = false; holdWrites = false
      while (writes.length) writes.shift()()
      if (owner) await bounded(owner.dispose(), 'resident owner disposal')
      else { finish(); await starting.catch(() => {}) }
      await bounded(ctx.fiber.dispose(), 'Cordis disposal')
    },
  }
}

await test('optional shell negotiation preserves file-only kernels and uses the existing control pipe', async () => {
  for (const options of [{ omitCapabilities: true }, { capabilities: [] }, { capabilities: ['future-capability'] }]) {
    const host = await fixture(options), client = await host.starting
    try {
      assert.equal(client.available, true)
      assert.throws(() => client.shell.send(execute('disabled-shell')), /capability is unavailable/)
      await assert.rejects(client.shell.read('disabled-shell', 'stdout', 0, 8), /unavailable/)
      const call = client.invoke(file('file-only'))
      host.send({ type: 'completed', requestId: 'file-only', exchange })
      assert.deepEqual(await call, exchange)
      assert.deepEqual(host.spec.argv, ['/fixture-worker', '--serve'])
      assert.equal(host.spec.stdio.control, 'pipe')
      assert.equal(host.spawns, 1)
      assert.equal(host.terminated, 0)
    } finally { await host.dispose() }
  }
})

await test('malformed optional capabilities fail the handshake through owned cleanup', async () => {
  for (const capabilities of [null, 'shell-v1', Array(17).fill('shell-v1'), ['x'.repeat(65)]]) {
    const host = await fixture({ capabilities })
    try {
      await assert.rejects(bounded(host.starting, 'invalid capabilities'), /capabilities/)
      assert.ok(host.terminated > 0)
      assert.ok(host.waits > 0)
    } finally { await host.dispose() }
  }
})

await test('file and shell responses interleave without crossing their correlations', async () => {
  const host = await fixture(), client = await host.starting
  try {
    let fileStarted = 0
    const call = client.invoke(file('file-call'), undefined, () => { fileStarted++ })
    client.shell.send(execute('shell-first')); client.shell.send(execute('shell-second'))
    await turn()
    host.send({ type: 'started', requestId: 'file-call' })
    host.send({ type: 'shell.admit', requestId: 'shell-second', hasShell: true })
    await host.event('shell.admit', 'shell-second')
    client.shell.send({ type: 'shell.admission', requestId: 'shell-second', decision: 'reuse' })
    host.send({ type: 'shell.started', requestId: 'shell-second' })
    host.send({ type: 'completed', requestId: 'file-call', exchange })
    host.send({ type: 'shell.admit', requestId: 'shell-first', hasShell: false,
      bootstrap: { commandPipe: 'fixture-command', receiptPipe: 'fixture-receipt' } })
    await host.event('shell.admit', 'shell-first')
    client.shell.send({ type: 'shell.admission', requestId: 'shell-first', decision: 'launch', closeAfter: false,
      launch: { argv: ['/fixture-shell', 'fixed-bootstrap'], cwd: '/fixture-workspace', env: {} } })
    host.send({ type: 'shell.started', requestId: 'shell-first' })
    host.send(completed('shell-second')); host.send(completed('shell-first'))
    assert.deepEqual(await call, exchange)
    await host.event('shell.completed', 'shell-first')
    assert.equal(fileStarted, 1)
    assert.deepEqual(host.events.map(value => `${value.type}:${value.requestId}`), [
      'shell.admit:shell-second', 'shell.started:shell-second', 'shell.admit:shell-first',
      'shell.started:shell-first', 'shell.completed:shell-second', 'shell.completed:shell-first',
    ])
    client.shell.send({ type: 'shell.release', requestId: 'shell-first' })
    client.shell.send({ type: 'shell.release', requestId: 'shell-second' })
    assert.equal(client.available, true)
    assert.equal(host.spawns, 1)
    assert.equal(host.terminated, 0)
  } finally { await host.dispose() }
})

await test('shell ownership and the retained correlation window stay bounded until release', async () => {
  const host = await fixture(), client = await host.starting
  try {
    assert.throws(() => client.shell.subscribe(() => {}), /admission owner/)
    for (let index = 0; index < 32; index++) {
      const id = `retained-${index}`
      client.shell.send(execute(id)); await turn()
      host.send({ type: 'shell.started', requestId: id }); host.send(completed(id))
    }
    await host.event('shell.completed', 'retained-31')
    assert.throws(() => client.shell.send(execute('overflow')), /full/)
    assert.throws(() => client.shell.send(execute('retained-0')), /duplicated|full/)
    const independent = client.invoke(file('independent-file'))
    host.send({ type: 'completed', requestId: 'independent-file', exchange })
    assert.deepEqual(await independent, exchange)
    client.shell.send({ type: 'shell.release', requestId: 'retained-0' })
    client.shell.send(execute('released-capacity'))
    await turn()
    assert.equal(host.frames.some(frame => frame.type === 'shell.execute' && frame.requestId === 'released-capacity'), true)
    assert.equal(client.available, true)
  } finally { await host.dispose() }
})

await test('unsent cancellation is local, has no effects, and retains only empty output until release', async () => {
  const host = await fixture({ holdWrites: true }), client = await host.starting
  try {
    client.shell.send(execute('blocking-write'))
    client.shell.send(execute('unsent'))
    client.shell.send({ type: 'cancel', requestId: 'unsent' })
    const cancelled = await host.event('shell.completed', 'unsent')
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.effectState, 'none')
    assert.equal(cancelled.cleanupConfirmed, true)
    assert.equal(host.frames.length, 1)
    const empty = await client.shell.read('unsent', 'stdout', 0, 64)
    assert.deepEqual(empty, output('unsent', 'stdout', 0, Buffer.alloc(0), { eof: true }))
    client.shell.send({ type: 'shell.release', requestId: 'unsent' })
    host.writes.shift()(); await turn()
    assert.equal(host.frames.some(frame => frame.requestId === 'unsent'), false)
    host.send({ type: 'shell.started', requestId: 'blocking-write' }); host.send(completed('blocking-write'))
    await host.event('shell.completed', 'blocking-write')
    assert.equal(client.available, true)
    assert.equal(host.terminated, 0)
  } finally { await host.dispose() }
})

await test('sent failures remain unknown and unsent failures remain none until the outer range joins', async () => {
  const host = await fixture({ holdWrites: true, holdExit: true }), client = await host.starting
  try {
    client.shell.send(execute('sent')); client.shell.send(execute('unsent'))
    host.finish(); await turn()
    assert.equal(client.available, false)
    assert.equal(client.shell.available, false)
    assert.equal(host.events.length, 0)
    assert.ok(host.terminated > 0)
    assert.ok(host.waits > 0)
    assert.throws(() => client.shell.send(execute('after-loss')), /unavailable/)
    host.releaseExit()
    const sent = await host.event('shell.completed', 'sent')
    const unsent = await host.event('shell.completed', 'unsent')
    assert.equal(sent.status, 'failed'); assert.equal(sent.effectState, 'unknown')
    assert.equal(unsent.status, 'rejected'); assert.equal(unsent.effectState, 'none')
    assert.equal((await host.event('shell.unavailable')).cleanupConfirmed, true)
    assert.equal(host.spawns, 1)
  } finally { await host.dispose() }
})

await test('malformed or duplicate shell terminals fail the outer client and await joined cleanup', async () => {
  const cases = [
    ['unknown identity', host => host.send(completed('unknown'))],
    ['success without started', host => host.send(completed('shell-pending'))],
    ['negative output count', host => { host.send({ type: 'shell.started', requestId: 'shell-pending' }); host.send(completed('shell-pending', { stdoutTotal: -1 })) }],
    ['duplicate started', host => { host.send({ type: 'shell.started', requestId: 'shell-pending' }); host.send({ type: 'shell.started', requestId: 'shell-pending' }) }],
    ['duplicate terminal', host => { host.send({ type: 'shell.started', requestId: 'shell-pending' }); host.send(completed('shell-pending')); host.send(completed('shell-pending')) }],
    ['uncorrelated cleanup', host => host.send({ type: 'shell.closed', requestId: 'missing-close', cleanupConfirmed: true })],
  ]
  for (const [label, corrupt] of cases) {
    const host = await fixture({ holdExit: true }), client = await host.starting
    try {
      let settled = false
      const fileCall = client.invoke(file('file-pending'))
      void fileCall.then(() => { settled = true })
      client.shell.send(execute('shell-pending')); await turn()
      corrupt(host); await turn()
      assert.equal(client.available, false, label)
      assert.equal(settled, false, label)
      assert.equal(host.events.some(event => event.type === 'shell.unavailable'), false, label)
      assert.ok(host.terminated > 0, label)
      host.releaseExit()
      assert.equal((await fileCall).interrupted, true, label)
      assert.equal((await host.event('shell.unavailable')).cleanupConfirmed, true, label)
      assert.equal(host.events.filter(event => event.type === 'shell.completed' && event.requestId === 'shell-pending').length, 1, label)
      assert.equal(host.spawns, 1, label)
    } finally { await host.dispose() }
  }
})

await test('bounded stream reads preserve binary bytes, stream separation and live empty output', async () => {
  const host = await fixture(), client = await host.starting
  try {
    client.shell.send(execute('reading')); await turn()
    const stdout = client.shell.read('reading', 'stdout', 0, 65536)
    const stderr = client.shell.read('reading', 'stderr', 0, 8)
    await assert.rejects(client.shell.read('reading', 'stdout', 0, 1), /concurrent/)
    host.send(output('reading', 'stderr', 0, Buffer.from('warn')))
    host.send(output('reading', 'stdout', 0, Buffer.alloc(0)))
    assert.deepEqual(await stdout, output('reading', 'stdout', 0, Buffer.alloc(0)))
    assert.deepEqual(await stderr, output('reading', 'stderr', 0, Buffer.from('warn')))
    const bytes = Buffer.alloc(65536, 255); bytes[0] = 0
    const maximum = client.shell.read('reading', 'stdout', 0, 65536)
    host.send(output('reading', 'stdout', 0, bytes))
    assert.deepEqual(Buffer.from((await maximum).bytesBase64, 'base64'), bytes)
    await turn()
    const written = host.frames.length
    for (const args of [['stdout', -1, 1], ['stdout', 0.5, 1], ['stdout', 0, 0], ['stdout', 0, 65537], ['stdin', 0, 1]]) {
      await assert.rejects(client.shell.read('reading', ...args), /Invalid/)
    }
    await turn()
    assert.equal(host.frames.length, written)
    assert.equal(client.available, true)
  } finally { await host.dispose() }
})

await test('completed output supports explicit cursor reads and cannot release an active read', async () => {
  const host = await fixture(), client = await host.starting
  try {
    client.shell.send(execute('completed-output')); await turn()
    host.send({ type: 'shell.started', requestId: 'completed-output' })
    host.send(completed('completed-output', { stdoutTotal: 20 }))
    await host.event('shell.completed', 'completed-output')
    const read = client.shell.read('completed-output', 'stdout', 5, 8)
    assert.throws(() => client.shell.send({ type: 'shell.release', requestId: 'completed-output' }), /active/)
    const gap = output('completed-output', 'stdout', 5, Buffer.from('ok'), { nextOffset: 20, lossy: true, eof: true })
    host.send(gap)
    assert.deepEqual(await read, gap)
    const end = client.shell.read('completed-output', 'stdout', 20, 8)
    host.send(output('completed-output', 'stdout', 20, Buffer.alloc(0), { eof: true }))
    assert.equal((await end).eof, true)
    client.shell.send({ type: 'shell.release', requestId: 'completed-output' }); await turn()
    assert.equal(host.frames.filter(frame => frame.type === 'shell.release' && frame.requestId === 'completed-output').length, 1)
    await assert.rejects(client.shell.read('completed-output', 'stdout', 20, 8), /Unknown/)
    assert.throws(() => client.shell.send({ type: 'shell.release', requestId: 'completed-output' }), /Unknown/)
    assert.equal(client.available, true)
  } finally { await host.dispose() }
})

await test('invalid output receipts reject pending reads only after outer cleanup', async () => {
  const cases = [
    ['wrong request', { requestId: 'other' }], ['wrong stream', { stream: 'stderr' }],
    ['wrong requested offset', { offset: 3 }], ['backward cursor', { nextOffset: 3 }],
    ['noncanonical base64', { bytesBase64: 'YQ' }], ['invalid base64', { bytesBase64: '!!!!' }],
    ['oversized bytes', { bytesBase64: Buffer.from('abcd').toString('base64'), nextOffset: 8 }],
    ['lossless gap', { nextOffset: 9 }], ['lossy cursor before bytes', { lossy: true, nextOffset: 4 }],
    ['invalid loss marker', { lossy: 'false' }], ['invalid eof marker', { eof: 1 }],
    ['invalid capture error code', { error: { code: 1, message: 'bad' } }],
    ['missing capture error message', { error: { code: 'OUTPUT_FAILED' } }],
  ]
  for (const [label, overrides] of cases) {
    const host = await fixture({ holdExit: true }), client = await host.starting
    try {
      client.shell.send(execute('bad-output')); await turn()
      let settled = false
      const read = client.shell.read('bad-output', 'stdout', 4, 3)
      void read.then(() => { settled = true }, () => { settled = true })
      const rejection = assert.rejects(read, /shell output/)
      host.send(output('bad-output', 'stdout', 4, Buffer.from('a'), overrides)); await turn()
      assert.equal(client.available, false, label)
      assert.equal(settled, false, label)
      assert.equal(host.events.some(event => event.type === 'shell.unavailable'), false, label)
      host.releaseExit(); await rejection
      assert.equal((await host.event('shell.unavailable')).cleanupConfirmed, true, label)
      assert.ok(host.terminated > 0, label)
    } finally { await host.dispose() }
  }
})

await test('unconfirmed outer cleanup remains visible in shell failure receipts', async () => {
  const host = await fixture({ holdExit: true }), client = await host.starting
  try {
    client.shell.send(execute('uncertain')); await turn()
    host.finish(); await turn()
    assert.equal(host.events.length, 0)
    host.releaseExit(false)
    const failure = await host.event('shell.completed', 'uncertain')
    assert.equal(failure.effectState, 'unknown')
    assert.equal(failure.cleanupConfirmed, false)
    assert.equal((await host.event('shell.unavailable')).cleanupConfirmed, false)
    // Let fixture disposal observe a now-empty synthetic range without altering the recorded failure.
    host.handle.waitForExit = async () => true
  } finally { await host.dispose() }
})

await test('32 idle sessions keep their budget until a confirmed close frees one slot', async () => {
  const host = await fixture(), client = await host.starting
  try {
    for (let index = 0; index < 32; index++) {
      const id = `idle-${index}`
      client.shell.send({ ...execute(id), sessionKey: `session-${index}` }); await turn()
      host.send({ type: 'shell.started', requestId: id }); host.send(completed(id))
      await host.event('shell.completed', id)
      client.shell.send({ type: 'shell.release', requestId: id })
    }
    await turn()
    const extra = { ...execute('idle-overflow'), sessionKey: 'session-overflow' }, count = host.frames.length
    assert.throws(() => client.shell.send(extra), /owner capacity/)
    assert.equal(host.frames.length, count)
    client.shell.send({ type: 'shell.close', requestId: 'free-idle-owner', sessionKey: 'session-0', reason: 'Fixture release' })
    assert.throws(() => client.shell.send(extra), /owner capacity/)
    await turn()
    host.send({ type: 'shell.closed', requestId: 'free-idle-owner', cleanupConfirmed: true })
    await host.event('shell.closed', 'free-idle-owner')
    client.shell.send(extra); await turn()
    assert.equal(host.frames.filter(frame => frame.type === 'shell.execute' && frame.requestId === 'idle-overflow').length, 1)
    assert.equal(client.available, true)
    assert.equal(host.terminated, 0)
  } finally { await host.dispose() }
})

await test('accepted file and shell traffic retains its reserved control capacity under backpressure', async () => {
  const host = await fixture({ holdWrites: true }), client = await host.starting
  const files = [], controllers = [], reads = []
  try {
    for (let index = 0; index < 32; index++) client.shell.send({ ...execute(`pressure-shell-${index}`), sessionKey: `pressure-owner-${index}` })
    for (let index = 0; index < 32; index++) {
      const controller = new AbortController(); controllers.push(controller)
      const call = client.invoke(file(`pressure-file-${index}`), controller.signal)
      void call.catch(() => {}); files.push(call)
    }
    // Hand every accepted execution to the writable boundary, retaining the last callback.
    for (let index = 0; index < 63; index++) { assert.equal(host.writes.length, 1); host.writes.shift()(); await turn() }
    assert.equal(host.frames.length, 64)
    assert.equal(host.writes.length, 1)
    host.holdAllWrites()
    for (let index = 0; index < 32; index++) host.send({ type: 'shell.admit', requestId: `pressure-shell-${index}`, hasShell: true })
    await turn()
    for (let index = 0; index < 32; index++) client.shell.send({ type: 'shell.admission', requestId: `pressure-shell-${index}`, decision: 'reuse' })
    for (let index = 0; index < 32; index++) for (const stream of ['stdout', 'stderr']) {
      const read = client.shell.read(`pressure-shell-${index}`, stream, 0, 64)
      void read.catch(() => {}); reads.push(read)
    }
    for (let index = 0; index < 32; index++) { client.shell.send({ type: 'cancel', requestId: `pressure-shell-${index}` }); controllers[index].abort() }
    for (let index = 0; index < 32; index++) for (const type of ['shell.retire', 'shell.close']) {
      client.shell.send({ type, requestId: `${type === 'shell.close' ? 'close' : 'retire'}-${index}`,
        sessionKey: `pressure-owner-${index}`, reason: 'Fixture cleanup budget' })
    }
    assert.equal(host.frames.length, 64, 'No control callback may bypass the blocked execution write')
    assert.equal(client.available, true)
    assert.equal(host.terminated, 0)
    // Advance admissions and all 64 reads. Each output answers a physically written read.
    let answered = 0
    while (answered < 64) {
      assert.equal(host.writes.length, 1)
      host.writes.shift()(); await turn()
      const frame = host.frames.at(-1)
      if (frame.type === 'shell.read') {
        host.send(output(frame.requestId, frame.stream, frame.offset, Buffer.alloc(0)))
        answered++
      }
    }
    await Promise.all(reads)
    for (let index = 0; index < 32; index++) {
      host.send(completed(`pressure-shell-${index}`, { status: 'cancelled', exitCode: null, effectState: 'none',
        error: { code: 'CANCELLED', message: 'Kernel cancelled before command start.' } }))
      host.send({ type: 'completed', requestId: `pressure-file-${index}`, exchange })
    }
    await Promise.all(files)
    await host.event('shell.completed', 'pressure-shell-31')
    for (let index = 0; index < 32; index++) client.shell.send({ type: 'shell.release', requestId: `pressure-shell-${index}` })
    assert.equal(client.available, true)
    assert.equal(host.terminated, 0)
    host.releaseWrites(); await turn()
    const counts = Object.fromEntries(['execute', 'shell.execute', 'shell.admission', 'shell.read', 'cancel', 'shell.retire', 'shell.close', 'shell.release']
      .map(type => [type, host.frames.filter(frame => frame.type === type).length]))
    assert.deepEqual(counts, { execute: 32, 'shell.execute': 32, 'shell.admission': 32, 'shell.read': 64,
      cancel: 64, 'shell.retire': 32, 'shell.close': 32, 'shell.release': 32 })
    for (const frame of host.frames.filter(frame => frame.type === 'shell.close' || frame.type === 'shell.retire')) {
      host.send({ type: 'shell.closed', requestId: frame.requestId, cleanupConfirmed: true })
    }
    await host.event('shell.closed', 'close-31')
    assert.equal(client.available, true)
    assert.equal(host.spawns, 1)
    assert.equal(host.terminated, 0)
  } finally { await host.dispose(); await Promise.allSettled([...files, ...reads]) }
})

await test('a typed per-stream capture error preserves the channel and raw reads cannot bypass correlation', async () => {
  const host = await fixture(), client = await host.starting
  try {
    client.shell.send(execute('capture-failure')); client.shell.send(execute('healthy-sibling')); await turn()
    host.send({ type: 'shell.started', requestId: 'capture-failure' })
    host.send({ type: 'shell.started', requestId: 'healthy-sibling' })
    host.send(completed('capture-failure', { stdoutTotal: 10 }))
    await host.event('shell.completed', 'capture-failure')
    const raw = { type: 'shell.read', requestId: 'capture-failure', stream: 'stdout', offset: 0, maxBytes: 64 }
    assert.throws(() => client.shell.send(raw), /read\(\) method/)
    const read = client.shell.read('capture-failure', 'stdout', 0, 64)
    assert.throws(() => client.shell.send(raw), /read\(\) method/)
    const receipt = output('capture-failure', 'stdout', 0, Buffer.from('part'), {
      eof: false, error: { code: 'OUTPUT_FAILED', message: 'Capture failed after partial output.' },
    })
    host.send(receipt)
    assert.deepEqual(await read, receipt)
    client.shell.send({ type: 'shell.release', requestId: 'capture-failure' })
    host.send(completed('healthy-sibling'))
    assert.equal((await host.event('shell.completed', 'healthy-sibling')).status, 'completed')
    client.shell.send({ type: 'shell.release', requestId: 'healthy-sibling' }); await turn()
    assert.equal(host.frames.filter(frame => frame.type === 'shell.read').length, 1)
    assert.equal(host.events.some(event => event.type === 'shell.unavailable'), false)
    assert.equal(client.available, true)
    assert.equal(host.terminated, 0)
  } finally { await host.dispose() }
})

await test('session spill receipts bind to negotiated support and the ready kernel PID', async () => {
  const spill = { spillPath: '/fixture/dsh-ops-native-123-0123456789abcdef0123456789abcdef/stdout-0123456789abcdef0123456789abcdef.log',
    spillOrigin: 'ops-native-v1', spillPid: 123, spillSealed: true }
  const cases = [
    ['valid', spill, true, true],
    ['unnegotiated', spill, false, false],
    ['wrong kernel PID', { ...spill, spillPid: 124 }, true, false],
    ['wrong origin', { ...spill, spillOrigin: 'host' }, true, false],
    ['missing seal', { ...spill, spillSealed: undefined }, true, false],
    ['orphan metadata', { ...spill, spillPath: undefined }, true, false],
    ['invalid path', { ...spill, spillPath: 'a\0b' }, true, false],
    ['nontext degradation', { spillError: {} }, true, false],
    ['spill degradation', { spillError: 'file cap exceeded' }, true, true],
  ]
  for (const [label, fields, supported, valid] of cases) {
    const host = await fixture({ capabilities: ['shell-v1', ...supported ? ['shell-spill-v1'] : []] }), client = await host.starting
    try {
      client.shell.send(execute('spill')); await turn()
      const read = client.shell.read('spill', 'stdout', 0, 64)
      const settled = valid ? read : assert.rejects(read, /Invalid shell output/)
      host.send(output('spill', 'stdout', 0, Buffer.from('prefix'), { eof: true, ...fields }))
      await settled
      assert.equal(client.available, valid, label)
      if (!valid) assert.equal((await host.event('shell.unavailable')).cleanupConfirmed, true, label)
    } finally { await host.dispose() }
  }
})

report('resident-shell-channel')
