import { bashToolDefinition } from '../lib/shells.js'
import { assert, report, test } from './lib/harness.mjs'

const empty = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }

await test('one execution handle shares settlement and independent output observers', async () => {
  const finished = Promise.withResolvers()
  let spawned = 0
  const definition = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: {
    spawn() {
      spawned++
      return { done: finished.promise, collected: {
        stdout: { readFrom: offset => ({ text: 'hello'.slice(offset), nextOffset: 5, lossy: false }) }, stderr: empty,
      } }
    },
  } })
  const execution = definition.start({ command: 'echo hello' })
  assert.equal(execution.observed.stdout.readFrom(0).text, 'hello')
  assert.equal(execution.observed.stdout.readFrom(2).text, 'llo')
  assert.equal(execution.observed.stdout.readFrom(0).text, 'hello')
  assert.equal(execution.result(), execution.result())
  finished.resolve({ exitCode: 0, signal: null })
  await execution.done
  assert.equal(execution.status, 'completed')
  assert.equal((await execution.result()).stdout.text, 'hello')
  assert.equal(spawned, 1)
})

await test('cancellation settles pending preparation and a late provider never spawns', async () => {
  const preparation = Promise.withResolvers()
  let spawned = 0
  const definition = bashToolDefinition({ file: process.execPath, source: 'config',
    prepareArgv: () => preparation.promise, subprocess: { spawn() { spawned++; throw new Error('unexpected spawn') } },
  })
  const execution = definition.start({ command: 'true' }, {}, { onExpiry: 'none' })
  execution.kill('job cancelled during preparation')
  const value = await execution.result()
  assert.equal(value.cancelled, true)
  assert.equal(value.timedOut, false)
  preparation.resolve([process.execPath, '-c', 'true'])
  await Promise.resolve()
  assert.equal(spawned, 0)
  assert.equal(execution.status, 'killed')
})

await test('job-owned execution has no deadline and retains its cancellation signal', async () => {
  const finished = Promise.withResolvers()
  const aborted = Promise.withResolvers()
  const definition = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: {
    spawn(spec) {
      spec.signal.addEventListener('abort', () => { aborted.resolve(); finished.resolve({ exitCode: null, signal: 'SIGTERM' }) })
      return { done: finished.promise, collected: { stdout: empty, stderr: empty } }
    },
  } })
  const execution = definition.start({ command: 'true', timeoutMs: 1 }, {}, { onExpiry: 'none' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(execution.status, 'running')
  execution.kill('stop job')
  await aborted.promise
  const value = await execution.result()
  assert.equal(value.timedOut, false)
  assert.equal(value.cancelled, true)
})

await test('the first stop cause wins when timeout and caller cancellation race', async () => {
  const finished = Promise.withResolvers()
  const caller = new AbortController()
  let stopped = 0, expire
  const definition = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: {
    spawn(spec) {
      spec.signal.addEventListener('abort', () => { stopped++ })
      return { done: finished.promise, collected: { stdout: empty, stderr: empty } }
    },
  } })
  const schedule = globalThis.setTimeout
  let execution
  try {
    // Capture the real deadline callback without assuming a 1 ms budget survives preparation.
    // This synchronous substitution is restored before any other test can schedule work.
    globalThis.setTimeout = (callback, ms, ...args) => {
      assert.equal(ms, 60000)
      expire = () => callback(...args)
      return schedule(callback, ms, ...args)
    }
    execution = definition.start({ command: 'true', timeoutMs: 60000 }, { signal: caller.signal })
  } finally { globalThis.setTimeout = schedule }
  assert.equal(execution.started, true)
  assert.equal(typeof expire, 'function')
  expire()
  caller.abort(new Error('later cancellation'))
  finished.resolve({ exitCode: null, signal: 'SIGTERM' })
  const value = await execution.result()
  assert.equal(stopped, 1)
  assert.equal(value.timedOut, true)
  assert.equal(value.cancelled, undefined)
})

await test('pre-spawn deadline expiry settles without waiting for a subprocess abort listener', async () => {
  let spawned = 0
  const definition = bashToolDefinition({ file: process.execPath, source: 'config',
    env: { get DSH_TEST_PREPARATION_DELAY() {
      const end = performance.now() + 15
      while (performance.now() < end) { /* Cross the 1 ms budget before the final pre-spawn check. */ }
      return ''
    } },
    subprocess: { spawn() { spawned++; throw new Error('expired preparation must not spawn') } },
  })
  const execution = definition.start({ command: 'true', timeoutMs: 1 })
  const value = await execution.result()
  assert.equal(spawned, 0); assert.equal(execution.started, false)
  assert.equal(value.timedOut, true); assert.equal(value.cancelled, undefined)
})

await test('an unavailable subprocess service settles without starting a command', async () => {
  const definition = bashToolDefinition({ file: process.execPath, source: 'config' })
  const execution = definition.start({ command: 'true' })
  const value = await execution.result()
  assert.equal(execution.started, false)
  assert.equal(value.status, 'failed')
  assert.match(value.error, /Host subprocess service is unavailable/)
})

report('shells-execution')
