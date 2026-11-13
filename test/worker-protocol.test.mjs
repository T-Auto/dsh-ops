/** Real one-shot transport checks plus trusted host bridge metadata. */
import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker, request, callWorker, envelopeOf } from './lib/boundary.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountResident, mountExchangeResident } from './lib/resident.mjs'
import { workerEnvelope, WORKER_OUTPUT_BYTES, WORKER_TIMEOUT_MS } from '../lib/worker-protocol.js'
import { invoke as fileCall } from '../lib/file/worker.js'
import { invoke as ptcCall } from '../lib/ptc/worker.js'

requireWorker('worker-protocol')
const signal = () => new AbortController().signal
const execution = root => ({ agent: { session: { id: 'protocol-session', header: { cwd: root } } } })
const send = input => callWorker(JSON.stringify(input))

await test('bridge budgets keep existing null and fractional timer semantics', () => {
  assert.equal(workerEnvelope('file', {}, null).budget.timeoutMs, WORKER_TIMEOUT_MS)
  assert.equal(workerEnvelope('file', {}, 0.5).budget.timeoutMs, 1)
  assert.equal(workerEnvelope('ptc', {}, 12.9).budget.timeoutMs, 12)
  assert.equal(workerEnvelope('file', {}, 60000).budget.timeoutMs, 30000)
  for (const timeout of [0, -1, NaN, Infinity, 2147483648, '100']) {
    assert.throws(() => workerEnvelope('file', {}, timeout), TypeError)
  }
  assert.throws(() => workerEnvelope('shell', {}), TypeError)
})

await test('versioned and explicit legacy requests produce the same canonical result', async () => {
  await withTempDir('protocol-formats', async root => {
    const file = path.join(root, 'notes.txt'); fs.writeFileSync(file, 'one\ntwo\n')
    const input = request('inspect_local_file', { path: file }, { root, readOnly: true })
    const legacy = envelopeOf(await send(input), assert)
    const versioned = envelopeOf(await send(workerEnvelope('file', input)), assert)
    assert.deepEqual(versioned, legacy)
    assert.equal(fs.existsSync(path.join(root, '.dsh-ops')), false)
  })
})

await test('unsupported and incomplete envelopes fail before creating business or audit files', async () => {
  await withTempDir('protocol-invalid', async root => {
    const file = path.join(root, 'new.txt')
    const base = workerEnvelope('file', request('write_file', { path: file, content: 'new', expectedRevision: 'absent' }, { root }))
    const cases = [
      { ...base, version: 2 }, { ...base, version: null }, { ...base, budget: { timeoutMs: 1, maxBytes: 1023 } },
      { ...base, requestId: '' }, { ...base, component: 'shell' }, { ...base, extra: true },
    ]
    for (const key of ['version', 'requestId', 'component', 'budget', 'request']) {
      const partial = { ...base }; delete partial[key]; cases.push(partial)
    }
    for (const input of cases) {
      const value = envelopeOf(await send(input), assert)
      assert.equal(value.status, 'error')
      assert.equal(value.error.effectState, 'none')
      assert.equal(fs.existsSync(file), false)
      assert.equal(fs.existsSync(path.join(root, '.dsh-ops')), false)
    }
  })
})

await test('serialized output budgets include the error receipt and never hide possible writes', async () => {
  await withTempDir('protocol-output', async root => {
    const inputFile = path.join(root, 'large.txt'); fs.writeFileSync(inputFile, '\0'.repeat(10000))
    const read = workerEnvelope('file', request('inspect_local_file', { path: inputFile }, { root, readOnly: true }))
    read.budget.maxBytes = 1024
    const observed = await send(read)
    const refusal = envelopeOf(observed, assert)
    assert.ok(Buffer.byteLength(observed.stdout) <= 1024)
    assert.equal(refusal.error.code, 'OUTPUT_LIMIT'); assert.equal(refusal.error.effectState, 'none')
    fs.unlinkSync(inputFile)
    const files = Array.from({ length: 12 }, (_, index) => path.join(root, `file-${index}.txt`))
    for (const file of files) fs.writeFileSync(file, 'TOKEN')
    const write = workerEnvelope('file', request('replace', { path: root, pattern: 'TOKEN', replacement: 'DONE' }, { root }))
    write.budget.maxBytes = 1024
    const changed = await send(write)
    const outcome = envelopeOf(changed, assert)
    assert.ok(Buffer.byteLength(changed.stdout) <= 1024)
    assert.equal(outcome.error.code, 'OUTPUT_LIMIT'); assert.equal(outcome.error.effectState, 'unknown')
    assert.equal(outcome.error.retryable, false)
    for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'DONE')
  })
})

await test('each bridge emits fresh trusted metadata and collects the advertised byte budget', async () => {
  await withTempDir('protocol-bridges', async root => {
    const { ctx } = await bootHost(); const calls = []
    try {
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) }))
      await ctx.plugin(inner => inner.provide('subprocess', { spawn: spec => {
        calls.push(spec)
        return { done: Promise.resolve({ exitCode: 0 }), collected: {
          stdout: { readFrom: () => ({ text: '{"status":"completed"}', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) },
        } }
      } }))
      await mountExchangeResident(ctx, { file: 'worker', cwd: root })
      const exec = execution(root)
      for (const [call, tool, args, component, timeout] of [
        [fileCall, 'grep', { path: root, pattern: 'x', requestId: 'model-value' }, 'file', 1234],
        [ptcCall, 'batch', { action: 'plan', operations: [] }, 'ptc', WORKER_TIMEOUT_MS],
      ]) {
        const value = await call(ctx, 'worker', tool, args, exec, signal(), { toolCallTimeoutMs: timeout })
        assert.equal(value.status, 'completed', JSON.stringify(value))
        const spec = calls.at(-1), envelope = JSON.parse(spec.stdio.stdin.data)
        assert.equal(envelope.version, 1); assert.equal(envelope.component, component)
        assert.match(envelope.requestId, /^[a-f0-9-]{36}$/)
        assert.equal(envelope.budget.timeoutMs, timeout)
        assert.equal(envelope.budget.maxBytes, WORKER_OUTPUT_BYTES)
        assert.equal(spec.stdio.stdout.maxBytes, envelope.budget.maxBytes)
        assert.equal(envelope.request.scope, 'protocol-session')
        assert.equal(envelope.request.tool, tool)
      }
      assert.notEqual(JSON.parse(calls[0].stdio.stdin.data).requestId, JSON.parse(calls[1].stdio.stdin.data).requestId)
      assert.equal(JSON.parse(calls[0].stdio.stdin.data).request.args.requestId, 'model-value')
    } finally { await shutdown(ctx) }
  })
})

await test('a worker deadline interrupts the one-shot process and the write bridge reports unknown', async () => {
  await withTempDir('protocol-deadline', async root => {
    const file = path.join(root, 'large.txt')
    // Reading and counting every occurrence exceeds 1ms; the watchdog does not rely on host cancellation.
    fs.writeFileSync(file, Buffer.alloc(32 * 1024 * 1024, 120))
    const input = workerEnvelope('file', request('replace', { path: file, pattern: 'x', replacement: 'y', maxReplacements: 100000 }, { root }), 1)
    const raw = await send(input)
    assert.equal(raw.timedOut, false)
    assert.equal(raw.exitCode, 124)
    assert.equal(raw.stdout, '')
    const { ctx } = await bootHost()
    try {
      await ctx.plugin(Subprocess)
      await mountResident(ctx, { file: WORKER, cwd: root })
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) }))
      const value = await fileCall(ctx, WORKER, 'replace', input.request.args, execution(root), signal(), { toolCallTimeoutMs: 1 })
      assert.equal(value.status, 'error'); assert.equal(value.error.code, 'RESULT_UNKNOWN')
      assert.equal(value.error.effectState, 'unknown'); assert.equal(value.error.retryable, false)
    } finally { await shutdown(ctx) }
  })
})
report('worker-protocol')
