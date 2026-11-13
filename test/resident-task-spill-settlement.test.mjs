/** Real task ownership and JSONL ledger, scripted native capture facts; no physical-spill claim. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createTaskExecutionHost } from '../lib/execution/resident/task-owner.js'
import { getSpillLedger, SpillLedger, spillLedgerFile } from '../lib/shells/spill-ledger.js'
import { mountSpillRetention } from '../lib/shells/spill-retention-runtime.js'
import { DEFAULT_SPILL_RETENTION } from '../lib/shells/spill-retention.js'
import { createResidentTaskJobs } from './lib/resident-task-jobs.mjs'
import { taskTransport, completedTask, outputTask, turn } from './lib/resident-task-transport.mjs'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'

const kernelPid = 123 // The existing boundary fixture validates receipts against this kernel PID.
const nonce = () => randomBytes(16).toString('hex')
const spill = (stream = 'stdout', changes = {}) => ({
  spillPath: path.join(os.tmpdir(), `dsh-ops-native-${kernelPid}-${nonce()}`, `${stream}-${nonce()}.log`),
  spillOrigin: 'ops-native-v1', spillPid: kernelPid, spillSealed: false, ...changes,
})
const lines = () => fs.existsSync(spillLedgerFile())
  ? fs.readFileSync(spillLedgerFile(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const recorded = file => lines().filter(entry => entry.path === file)
const memory = file => getSpillLedger().entries().filter(entry => entry.path === file)
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 5000)
  })]) } finally { clearTimeout(timer) }
}

async function fixture({ cleanup = true } = {}) {
  const host = await createResidentTaskJobs(), wire = taskTransport({ autoRead: false, cleanup })
  const outputs = { stdout: { bytes: Buffer.from('tail'), total: 64004, eof: false, ...spill() },
    stderr: { bytes: Buffer.alloc(0), total: 0, eof: false } }
  let adapter, execution, requestId, released = 0
  const plugin = await host.ctx.plugin({ name: 'task-spill-settlement-fixture', inject: ['agents', 'sessions'], apply(ctx) {
    adapter = createTaskExecutionHost(ctx, wire.transport)
  } })
  wire.onFrame(frame => {
    if (frame.type === 'task.read') {
      const { bytes, total, ...metadata } = outputs[frame.stream]
      queueMicrotask(() => wire.emit(outputTask(frame, bytes, { ...metadata, nextOffset: total,
        retainedOffset: total - bytes.length, lossy: total > bytes.length })))
    }
    if (frame.type === 'task.release') released++
    if (frame.type === 'task.closeOwner') queueMicrotask(() => wire.emit({ type: 'task.ownerClosed', requestId: frame.requestId, cleanupConfirmed: true }))
  })
  return { host, wire, outputs,
    get execution() { return execution }, get requestId() { return requestId }, get released() { return released },
    async begin() {
      execution = adapter.start({ agent: host.agent }, { lifetime: 'foreground', source: 'spill-fixture', sessionId: 'forged-caller-session',
        spec: { command: 'fixture', workdir: TEST_HOME, timeoutMs: 10000, graceMs: 0.5, includeDiagnostics: true },
        admit: async () => ({ argv: [process.execPath], cwd: TEST_HOME, env: {} }) })
      requestId = wire.frames.findLast(frame => frame.type === 'task.execute').requestId
      wire.emit({ type: 'task.admit', requestId }); await turn()
      wire.emit({ type: 'task.started', requestId }); await turn()
    },
    async finish(changes = {}) {
      outputs.stdout.eof = !outputs.stdout.error; outputs.stderr.eof = !outputs.stderr.error
      wire.emit(completedTask(requestId, { stdoutTotal: outputs.stdout.total, stderrTotal: outputs.stderr.total, ...changes }))
      return bounded(execution.result(), 'task settlement')
    },
    async close() {
      if (execution?.status === 'running') wire.transport.abort(new Error('Fixture cleanup'))
      wire.finishCleanup(true)
      if (execution) await bounded(execution.done, 'fixture execution cleanup')
      await Promise.allSettled([adapter.dispose(), plugin.dispose()])
      await host.dispose()
    },
  }
}

await test('live unsealed output never enters the ledger; sealed joined settlement records kernel origin exactly once', async () => {
  const f = await fixture(), file = f.outputs.stdout.spillPath
  try {
    await f.begin()
    assert.equal(f.execution.observed.stdout.readFrom(0).spillPath, file, 'live recovery may expose the intact native path')
    assert.deepEqual(recorded(file), []); assert.deepEqual(memory(file), [])
    f.outputs.stdout.spillSealed = true
    const value = await f.finish()
    assert.equal(value.error, undefined); assert.equal(value.stdout.spillPath, file)
    const entries = recorded(file)
    assert.equal(entries.length, 1, 'removing the task settlement hook must fail this assertion')
    assert.equal(entries[0].origin, 'ops-native-v1'); assert.equal(entries[0].pid, kernelPid)
    assert.equal(entries[0].sessionId, f.host.agent.session.id, 'exact owner overrides untrusted start options')
    assert.equal(entries[0].bytes, 64004, 'ledger records observed bytes, not the four-byte retained tail')
    assert.ok(Number.isSafeInteger(entries[0].recordedAt))
    await Promise.all([f.execution.result(), f.execution.result(), f.execution.done]); await turn()
    assert.equal(recorded(file).length, 1); assert.equal(f.released, 1)
  } finally { await f.close() }
})

await test('terminal unsealed metadata fails closed and is never recorded', async () => {
  const f = await fixture(), file = f.outputs.stdout.spillPath
  try {
    await f.begin()
    const value = await f.finish()
    assert.match(value.error, /spill was not sealed|unavailable/i)
    assert.equal(value.stdout.spillPath, undefined)
    assert.deepEqual(recorded(file), []); assert.deepEqual(memory(file), [])
  } finally { await f.close() }
})

for (const [name, mutate] of [
  ['mismatched kernel PID', output => { output.spillPid = kernelPid + 1 }],
  ['unsupported origin', output => { output.spillOrigin = 'host-subprocess' }],
  ['malformed native file name', output => { output.spillPath = path.join(path.dirname(output.spillPath), 'foreign.log') }],
  ['PID in the directory differs from receipt', output => { output.spillPath = output.spillPath.replace(`native-${kernelPid}-`, `native-${kernelPid + 1}-`) }],
  ['byte total above native spill cap', output => { output.total = 64 * 1024 * 1024 + 1 }],
]) await test(`${name} cannot become a native ledger entry`, async () => {
  const f = await fixture()
  try {
    await f.begin()
    f.outputs.stdout.spillSealed = true; mutate(f.outputs.stdout)
    const file = f.outputs.stdout.spillPath
    await f.finish()
    assert.deepEqual(recorded(file), []); assert.deepEqual(memory(file), [])
  } finally { await f.close() }
})

await test('unconfirmed process cleanup excludes otherwise sealed complete streams', async () => {
  const f = await fixture(), file = f.outputs.stdout.spillPath
  try {
    await f.begin(); f.outputs.stdout.spillSealed = true
    const value = await f.finish({ status: 'failed', exitCode: null, cleanupConfirmed: false,
      error: { code: 'CLEANUP_UNKNOWN', message: 'Owned process cleanup was not confirmed.' } })
    assert.equal(f.execution.cleanupConfirmed, false); assert.match(value.error, /CLEANUP_UNKNOWN/)
    assert.deepEqual(recorded(file), []); assert.deepEqual(memory(file), [])
  } finally { await f.close() }
})

await test('a raw stream error excludes that path while a healthy sealed sibling keeps its own ownership', async () => {
  const f = await fixture(), bad = f.outputs.stdout.spillPath
  Object.assign(f.outputs.stderr, { bytes: Buffer.from('full'), total: 4, ...spill('stderr', { spillSealed: true }) })
  const good = f.outputs.stderr.spillPath
  try {
    await f.begin(); f.outputs.stdout.spillSealed = true
    f.outputs.stdout.error = { code: 'CAPTURE_FAILED', message: 'Raw reader failed before EOF.' }
    const value = await f.finish({ status: 'failed', exitCode: null, error: f.outputs.stdout.error })
    assert.match(value.error, /CAPTURE_FAILED/); assert.equal(value.stdout.spillPath, undefined)
    assert.deepEqual(recorded(bad), []); assert.deepEqual(memory(bad), [])
    assert.equal(recorded(good).length, 1); assert.equal(recorded(good)[0].bytes, 4)
  } finally { await f.close() }
})

await test('shared retention notification failure cannot change a successfully executed task', async () => {
  const ledger = new SpillLedger(path.join(TEST_HOME, `notification-${nonce()}.jsonl`))
  const options = { ledger, tmpdir: TEST_HOME, settlementsPerSweep: 1, intervalMs: 3600000 }
  const first = mountSpillRetention(DEFAULT_SPILL_RETENTION, options)
  const second = mountSpillRetention(DEFAULT_SPILL_RETENTION, options)
  const f = await fixture(), original = globalThis.setImmediate
  let notifications = 0
  try {
    await turn() // The separate activation pass finishes before the injected settlement fault.
    first() // The second owner must keep the shared runtime active.
    await f.begin(); f.outputs.stdout.spillSealed = true
    f.wire.onFrame(frame => {
      if (frame.type !== 'task.release') return
      // setImmediate is reached synchronously by noteSettled(), after the final native read/release.
      globalThis.setImmediate = () => { globalThis.setImmediate = original; notifications++; throw new Error('Fixture retention scheduler failure') }
    })
    const value = await f.finish()
    assert.equal(value.exitCode, 0); assert.equal(value.error, undefined)
    assert.equal(notifications, 1, 'settlement notifies the shared runtime exactly once')
    assert.equal(recorded(f.outputs.stdout.spillPath).length, 1, 'notification failure does not discard ownership')
  } finally { globalThis.setImmediate = original; first(); second(); await f.close() }
})

report('resident-task-spill-settlement')
