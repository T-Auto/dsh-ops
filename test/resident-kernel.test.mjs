/** Resident public-host client admission, correlation and owned cleanup. */
import fs from 'node:fs'
import path from 'node:path'
import { Duplex, PassThrough, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { startResident, ResidentNotStarted } from '../lib/execution/resident/client.js'
import { FRAME_BYTES } from '../lib/execution/resident/frames.js'
import { workerEnvelope } from '../lib/execution/protocol.js'

const receipt = { exitCode: 0, interrupted: false, readers: true, lossy: false, stderr: '', value: { status: 'completed', changed: 0 } }
const envelope = id => ({ ...workerEnvelope('file', { tool: 'stat', args: {}, read_only: true }), requestId: id })
const flush = () => new Promise(resolve => setImmediate(resolve))
async function within(work, ms = 10_000, label = 'resident check') {
  let timer
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}
function fixture({ hold = false, ready = true, holdExit = false } = {}) {
  const input = new PassThrough(), frames = [], writes = [], effects = []
  let done, exit, terminated = 0, spawns = 0, active = true
  const finished = new Promise(resolve => { done = resolve }), empty = new Promise(resolve => { exit = resolve })
  const output = new Writable({ write(bytes, _encoding, callback) {
    const frame = JSON.parse(bytes.toString()); frames.push(frame)
    if (hold && frame.type === 'execute') writes.push(callback)
    else callback()
    if (frame.type === 'shutdown') queueMicrotask(() => finish())
  } })
  const control = Duplex.from({ readable: input, writable: output })
  const finish = () => { done({ exitCode: 0, signal: null }); if (!holdExit) exit(true); control.destroy() }
  const handle = { control, done: finished, collected: { stdout: { readFrom: () => ({ text: 'stdout diagnostic', lossy: false }) },
    stderr: { readFrom: () => ({ text: 'stderr diagnostic', lossy: false }) } },
    terminate() { ++terminated; finish() },
    waitForExit(signal) {
      if (!signal) return empty
      return Promise.race([empty, new Promise(resolve => {
        if (signal.aborted) resolve(false)
        else signal.addEventListener('abort', () => resolve(false), { once: true })
      })])
    },
  }
  let spec
  const ctx = { root: { effect() { throw new Error('root effects are forbidden') } },
    get: () => ({ spawn(value) { ++spawns; spec = value; return handle } }),
    fiber: { assertActive() { if (!active) throw new Error('activation is disposed') } },
    effect(body) { effects.push(body()) },
  }
  const starting = startResident(ctx, '/worker', '/workspace')
  const send = value => input.write(`${JSON.stringify(value)}\n`)
  if (ready) send({ type: 'ready', version: 1, pid: 123 })
  return { starting, send, input, frames, writes, handle, finish, releaseExit: () => exit(true),
    get spawns() { return spawns }, get terminated() { return terminated }, get spec() { return spec },
    async dispose() { active = false; await Promise.all(effects.map(effect => effect())) },
  }
}

await test('one scoped handle waits for handshake and correlates repeated exchanges', async () => {
  const host = fixture({ ready: false })
  let published = false
  void host.starting.then(() => { published = true })
  await flush(); assert.equal(published, false)
  host.send({ type: 'ready', version: 1, pid: 123 })
  const client = await host.starting
  try {
    assert.equal(client.pid, 123); assert.equal(client.available, true)
    assert.equal(host.spawns, 1); assert.deepEqual(host.spec.argv, ['/worker', '--serve'])
    assert.equal(host.spec.stdio.control, 'pipe'); assert.equal(host.spec.signal, undefined)
    assert.equal(host.spec.stdio.stdout.maxBytes, 4096); assert.equal(host.spec.stdio.stderr.maxBytes, 4096)
    for (let index = 0; index < 3; index++) {
      let started = 0
      const call = client.invoke(envelope(`read-${index}`), undefined, () => { ++started })
      assert.equal(started, 0)
      host.send({ type: 'started', requestId: `read-${index}` })
      host.send({ type: 'completed', requestId: `read-${index}`, exchange: receipt })
      assert.deepEqual(await call, receipt); assert.equal(started, 1)
    }
    assert.equal(host.spawns, 1)
  } finally { await host.dispose() }
  assert.equal(client.available, false)
})

await test('32-request window refuses excess before admission and cancellation is request-local', async () => {
  const host = fixture(), client = await host.starting
  try {
    const controllers = Array.from({ length: 32 }, () => new AbortController())
    const calls = controllers.map((controller, index) => client.invoke(envelope(`call-${index}`), controller.signal))
    await assert.rejects(client.invoke(envelope('overflow')), ResidentNotStarted)
    await assert.rejects(client.invoke(envelope('call-0')), ResidentNotStarted)
    await flush()
    assert.equal(host.frames.filter(frame => frame.type === 'execute').length, 32)
    let settled = false; void calls[0].then(() => { settled = true })
    controllers[0].abort(); controllers[0].abort(); await flush()
    assert.deepEqual(host.frames.filter(frame => frame.type === 'cancel'), [{ type: 'cancel', requestId: 'call-0' }])
    assert.equal(host.terminated, 0); assert.equal(settled, false)
    for (let index = 0; index < 32; index++) host.send({ type: 'completed', requestId: `call-${index}`, exchange: receipt })
    assert.equal((await Promise.all(calls)).length, 32)
    assert.equal(client.available, true)
  } finally { await host.dispose() }
})

await test('abort before writable admission discards the queued execution under backpressure', async () => {
  const host = fixture({ hold: true }), client = await host.starting
  try {
    const first = client.invoke(envelope('first'))
    const controller = new AbortController()
    const queued = client.invoke(envelope('queued'), controller.signal)
    controller.abort()
    await assert.rejects(queued, /before execution/)
    assert.equal(host.frames.filter(frame => frame.type === 'execute').length, 1)
    host.writes.shift()(); await flush()
    assert.equal(host.frames.some(frame => frame.envelope?.requestId === 'queued'), false)
    host.send({ type: 'completed', requestId: 'first', exchange: receipt })
    await first
  } finally { await host.dispose() }
})

await test('already-aborted and oversized requests never reach the kernel', async () => {
  const host = fixture(), client = await host.starting
  try {
    const controller = new AbortController(); controller.abort()
    await assert.rejects(client.invoke(envelope('aborted'), controller.signal), /before execution/)
    const large = envelope('large'); large.request.args = { text: 'x'.repeat(2 * 1024 * 1024) }
    await assert.rejects(client.invoke(large), /2 MiB/)
    for (const id of ['', 'contains space', 'x'.repeat(129)]) await assert.rejects(client.invoke(envelope(id)), /identity/)
    assert.equal(host.frames.length, 0)
  } finally { await host.dispose() }
})

await test('kernel loss settles every admitted call as interrupted and never reconnects', async () => {
  const host = fixture(), client = await host.starting
  const calls = [client.invoke(envelope('a')), client.invoke(envelope('b'))]
  await flush()
  assert.equal(host.frames.filter(frame => frame.type === 'execute').length, 2)
  host.finish()
  for (const result of await Promise.all(calls)) {
    assert.equal(result.interrupted, true); assert.equal(result.exitCode, null)
    assert.equal(result.value, undefined)
  }
  await assert.rejects(client.invoke(envelope('after')), ResidentNotStarted)
  assert.equal(host.spawns, 1)
  await host.dispose()
})

await test('fatal loss withdraws admission immediately but waits for the whole owned range', async () => {
  const host = fixture({ holdExit: true }), client = await host.starting
  let settled = false
  const call = client.invoke(envelope('possibly-mutating'))
  void call.then(() => { settled = true })
  host.finish(); await flush()
  assert.equal(client.available, false); assert.equal(settled, false)
  await assert.rejects(client.invoke(envelope('after')), ResidentNotStarted)
  host.releaseExit()
  assert.equal((await call).interrupted, true)
  await host.dispose()
})

await test('unobservable fatal cleanup keeps an explicit unknown outcome', async () => {
  const host = fixture(), client = await host.starting
  const wait = host.handle.waitForExit
  host.handle.waitForExit = async () => { throw new Error('range cannot be observed') }
  const call = client.invoke(envelope('unobservable'))
  host.finish()
  const result = await call
  assert.equal(result.interrupted, true); assert.equal(result.value, undefined)
  assert.match(result.stderr, /cleanup is unknown.*range cannot be observed/)
  host.handle.waitForExit = wait
  await host.dispose()
})

await test('fatal loss refuses an unsent queued request without implying possible effects', async () => {
  const host = fixture({ hold: true, holdExit: true }), client = await host.starting
  const admitted = client.invoke(envelope('admitted'))
  const queued = client.invoke(envelope('unsent'))
  const refused = assert.rejects(queued, ResidentNotStarted)
  let admittedSettled = false
  void admitted.then(() => { admittedSettled = true })
  host.finish()
  await refused
  assert.equal(host.frames.filter(frame => frame.type === 'execute').length, 1)
  assert.equal(admittedSettled, false, 'sent work still waits for owned-range cleanup')
  host.releaseExit()
  assert.equal((await admitted).interrupted, true)
  await host.dispose()
})

await test('malformed, uncorrelated and oversized control responses terminate the owned range', async () => {
  for (const write of [
    host => host.input.write('not-json\n'),
    host => host.send({ type: 'completed', requestId: 'other', exchange: receipt }),
    host => host.send({ type: 'completed', requestId: 'pending', exchange: { ...receipt, interrupted: 'false' } }),
    host => host.input.write(Buffer.alloc(FRAME_BYTES + 1, 32)),
  ]) {
    const host = fixture(), client = await host.starting
    try {
      const pending = client.invoke(envelope('pending')); write(host)
      assert.equal((await pending).interrupted, true)
      assert.equal(client.available, false); assert.ok(host.terminated > 0)
    } finally { await host.dispose() }
  }
})

await test('invalid handshake and unload during handshake cannot publish a live client', async () => {
  const bad = fixture({ ready: false })
  bad.send({ type: 'ready', version: 2, pid: 123 })
  await assert.rejects(bad.starting, /handshake/)
  assert.ok(bad.terminated > 0); await bad.dispose()
  const pending = fixture({ ready: false })
  const rejected = assert.rejects(pending.starting)
  await pending.dispose(); await rejected
})

await test('startup has its own ten-second handshake budget and reaps an unready kernel', async () => {
  const host = fixture({ ready: false })
  await assert.rejects(host.starting, /handshake exceeded 10000ms/)
  assert.ok(host.terminated > 0)
  await host.dispose()
})

await test('three activation clients isolate admission and one unload preserves the others', async () => {
  const hosts = [fixture(), fixture(), fixture()]
  const clients = await Promise.all(hosts.map(host => host.starting))
  try {
    const calls = clients.map(client => client.invoke(envelope('same-request-id')))
    await hosts[0].dispose()
    assert.equal((await calls[0]).interrupted, true)
    for (const index of [1, 2]) {
      assert.equal(clients[index].available, true); assert.equal(hosts[index].terminated, 0)
      hosts[index].send({ type: 'completed', requestId: 'same-request-id', exchange: receipt })
      assert.deepEqual(await calls[index], receipt)
    }
    assert.deepEqual(hosts.map(host => host.spawns), [1, 1, 1])
  } finally { await Promise.all(hosts.map(host => host.dispose())) }
})

requireWorker('resident-kernel')
await test('real public host serves repeated existing read dispatch and scoped unload', async () => {
  await withTempDir('resident-real', async root => {
    fs.writeFileSync(path.join(root, 'note.txt'), 'resident fixture\n')
    const ctx = new Context(); ctx.logger.level = 0
    await ctx.plugin(Subprocess)
    let client
    const owner = await ctx.plugin({ inject: ['subprocess'], async apply(inner) { client = await startResident(inner, WORKER, root) } })
    try {
      const pid = client.pid
      for (let index = 0; index < 5; index++) {
        const call = workerEnvelope('file', { root, scope: 'resident-test', tool: 'inspect_local_file', read_only: true,
          deny_roots: [], deny_credential_names: false, args: { path: path.join(root, 'note.txt'), view: 'text' } })
        let started = 0
        const result = await client.invoke(call, new AbortController().signal, () => { ++started })
        assert.equal(result.exitCode, 0, JSON.stringify(result))
        assert.equal(result.interrupted, false, JSON.stringify(result))
        assert.equal(result.value.status, 'completed', JSON.stringify(result))
        assert.match(JSON.stringify(result.value), /resident fixture/)
        assert.equal(started, 1); assert.equal(client.pid, pid)
      }
      await owner.dispose()
      assert.equal(client.available, false)
      await assert.rejects(client.invoke(envelope('retained')), ResidentNotStarted)
    } finally { await ctx.fiber.dispose() }
  })
})

await test('three real Context roots share cwd/home while cancellation and unload stay isolated', async () => {
  await withTempDir('resident-three-roots', async root => {
    const file = path.join(root, 'note.txt'); fs.writeFileSync(file, 'three roots\n')
    const contexts = [], owners = [], clients = []
    const request = () => workerEnvelope('file', { root, scope: 'same-session-label', tool: 'inspect_local_file', read_only: true,
      deny_roots: [], deny_credential_names: false, args: { path: file, view: 'text' } })
    try {
      for (let index = 0; index < 3; index++) {
        const ctx = new Context(); ctx.logger.level = 0; contexts.push(ctx)
        await ctx.plugin(Subprocess)
        owners.push(await ctx.plugin({ inject: ['subprocess'], async apply(inner) {
          clients[index] = await startResident(inner, WORKER, root)
        } }))
      }
      assert.equal(new Set(clients.map(client => client.pid)).size, 3)
      const results = await Promise.all(clients.flatMap(client => Array.from({ length: 3 }, () => client.invoke(request()))))
      for (const result of results) assert.equal(result.value?.status, 'completed', JSON.stringify(result))
      const controller = new AbortController()
      const cancelled = clients[1].invoke(request(), controller.signal, () => controller.abort())
      const concurrent = clients[2].invoke(request())
      const [cancelResult, otherResult] = await Promise.all([cancelled, concurrent])
      assert.equal(otherResult.value?.status, 'completed', JSON.stringify(otherResult))
      // Completion may beat the cancellation; report only the actual terminal receipt.
      if (!cancelResult.interrupted) assert.equal(cancelResult.value?.status, 'completed', JSON.stringify(cancelResult))
      assert.equal(clients[1].available, true)
      await owners[0].dispose()
      assert.equal(clients[0].available, false)
      for (const client of clients.slice(1)) assert.equal((await client.invoke(request())).value?.status, 'completed')
    } finally { await Promise.all(contexts.map(ctx => ctx.fiber.dispose())) }
  })
})

await test('real native control EOF joins an admitted file leaf without a host terminate callback', async () => {
  await withTempDir('resident-eof', async root => {
    const file = path.join(root, 'note.txt'); fs.writeFileSync(file, 'EOF fixture\n')
    const ctx = new Context(); ctx.logger.level = 0
    await ctx.plugin(Subprocess)
    const handle = ctx.get('subprocess').spawn({ argv: [WORKER, '--serve'], cwd: root, graceMs: 100,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' } })
    const lines = createInterface({ input: handle.control })
    const messages = lines[Symbol.asyncIterator]()
    const next = async () => JSON.parse((await within(messages.next())).value)
    try {
      assert.equal((await next()).type, 'ready')
      const call = workerEnvelope('file', { root, scope: 'eof', tool: 'inspect_local_file', read_only: true,
        deny_roots: [], deny_credential_names: false, args: { path: file, view: 'text' } })
      handle.control.write(`${JSON.stringify({ type: 'execute', envelope: call })}\n`)
      const started = await next()
      assert.equal(started.type, 'started'); assert.equal(started.requestId, call.requestId)
      // Half-close the host writer. No client fail()/terminate() callback exists:
      // only the native EOF path can finish before the assertions below.
      handle.control.end()
      const outcome = await within(handle.done)
      assert.equal(outcome.exitCode, 0, handle.collected.stderr.readFrom(0).text)
      assert.equal(await handle.waitForExit(AbortSignal.timeout(10_000)), true)
    } finally {
      lines.close(); handle.terminate(); await handle.waitForExit()
      handle.control.destroy(); await ctx.fiber.dispose()
    }
  })
})

// Windows duplex named pipes cannot half-close independently of the reader:
// libuv 1.52.1 src/win/pipe.c:uv__process_pipe_shutdown_req waits for a pending
// read before its EOF timer closes the pipe. An actual disconnect uses destroy.
// POSIX additionally proves that a genuine write-side EOF interrupts writers.
const stalledActions = ['disconnect', 'shutdown', ...(process.platform === 'win32' ? [] : ['half-close'])]
for (const action of stalledActions) await test(`real native ${action} exits with response readers deliberately stalled`, async () => {
  await withTempDir('resident-stalled-reader', async root => {
    const file = path.join(root, 'many.txt'); fs.writeFileSync(file, `${'x'.repeat(80)}\n`.repeat(10_000))
      const ctx = new Context(); ctx.logger.level = 0
      await ctx.plugin(Subprocess)
      const handle = ctx.get('subprocess').spawn({ argv: [WORKER, '--serve'], cwd: root, graceMs: 100,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' } })
      const control = handle.control
      let halfCloseFinished = false
      try {
        const hello = await within(new Promise((resolve, reject) => {
          let text = ''
          const error = failure => { control.off('data', read); reject(failure) }
          const read = bytes => {
            text += bytes.toString()
            if (!text.includes('\n')) return
            control.off('data', read); control.off('error', error)
            control.pause()
            resolve(JSON.parse(text.trim()))
          }
          control.on('data', read); control.once('error', error)
        }), 10_000, `${action} handshake`)
        assert.equal(hello.type, 'ready')
        const frames = Array.from({ length: 32 }, () => {
          const call = workerEnvelope('file', { root, scope: 'stalled-reader', tool: 'inspect_local_file', read_only: true,
            deny_roots: [], deny_credential_names: false, args: { path: file, view: 'text', limit: 10_000 } })
          return `${JSON.stringify({ type: 'execute', envelope: call })}\n`
        }).join('')
        await within(new Promise((resolve, reject) => control.write(frames, error => error ? reject(error) : resolve())),
          10_000, `${action} request writes`)
        const deadline = Date.now() + 10_000
        while (control.readableLength < control.readableHighWaterMark && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.ok(control.readableLength >= control.readableHighWaterMark, 'the undrained response buffer must reach backpressure')
        assert.equal(control.listenerCount('data'), 0, 'no test/client callback drains responses')
        if (action === 'disconnect') control.destroy()
        else if (action === 'half-close') control.end(() => { halfCloseFinished = true })
        else control.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
        // A blocked native output writer must be released before thread joins.
        // Shutdown/half-close retain undrained output; disconnect closes only
        // the transport. Neither action terminates the managed process range.
        const outcome = await within(handle.done, 10_000, `${action} natural exit with stalled reader`)
        const diagnostic = handle.collected.stderr.readFrom(0).text
        if (action === 'disconnect' && process.platform !== 'win32' && outcome.exitCode === 1) {
          // Closing a socket with unread output can reset the peer. The server
          // reports that transport error after joining leaves; it is not a kill.
          assert.match(diagnostic.trim(), /^OPS kernel stopped: Connection reset by peer \(os error (54|104)\)$/)
        } else assert.equal(outcome.exitCode, 0, `${action}: ${diagnostic}`)
        assert.equal(await handle.waitForExit(AbortSignal.timeout(10_000)), true)
      } catch (error) {
        throw new Error(`${error.message}; ${action} halfCloseFinished=${halfCloseFinished} writableFinished=${control.writableFinished} writableLength=${control.writableLength} destroyed=${control.destroyed}; stderr: ${handle.collected.stderr.readFrom(0).text}`, { cause: error })
      } finally {
        handle.terminate(); await handle.waitForExit(); control.destroy(); await ctx.fiber.dispose()
      }
  })
})

await test('real kernel hard crash interrupts an admitted call and reaps the owned range', async () => {
  await withTempDir('resident-crash', async root => {
    const file = path.join(root, 'note.txt')
    fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 120))
    class ObservedSubprocess extends Subprocess {
      handles = []
      spawn(spec) { const handle = super.spawn(spec); this.handles.push(handle); return handle }
    }
    const ctx = new Context(); ctx.logger.level = 0
    await ctx.plugin(ObservedSubprocess)
    let client
    await ctx.plugin({ inject: ['subprocess'], async apply(inner) { client = await startResident(inner, WORKER, root) } })
    try {
      const call = workerEnvelope('file', { root, scope: 'crash', tool: 'stat', read_only: true,
        deny_roots: [], deny_credential_names: false, args: { path: file } })
      let killed = false
      const pending = client.invoke(call, undefined, () => {
        killed = true
        process.kill(client.pid, 'SIGKILL')
      })
      const result = await within(pending)
      assert.equal(killed, true, 'the real kernel acknowledged its leaf before the forced crash')
      assert.equal(result.interrupted, true, JSON.stringify(result))
      assert.equal(result.value, undefined)
      assert.equal(client.available, false)
      assert.equal(ctx.get('subprocess').handles.length, 1, 'no replacement kernel was spawned')
      assert.equal(await ctx.get('subprocess').handles[0].waitForExit(AbortSignal.timeout(10_000)), true)
      await assert.rejects(client.invoke(envelope('after-crash')), ResidentNotStarted)
    } finally { await ctx.fiber.dispose() }
  })
})

report('resident-kernel')
