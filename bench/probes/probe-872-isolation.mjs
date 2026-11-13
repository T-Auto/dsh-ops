/** Actual resident server/client + public ownership, deterministic fixture leaves.
 * Not a complete DSH application or a production filesystem/deadline test. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { startResident } from '../../lib/execution/resident/client.js'
import { workerEnvelope } from '../../lib/execution/protocol.js'
const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = path.join(plugin, 'bench/runs')
const file = path.join(plugin, 'native/target/debug/examples', process.platform === 'win32' ? 'resident_blocked.exe' : 'resident_blocked')
fs.mkdirSync(fixture, { recursive: true })
const directory = fs.mkdtempSync(path.join(fixture, 'blocked-resident-'))
const report = { startedAt: new Date().toISOString(), platform: process.platform, node: process.version,
  scope: 'Production resident.rs, ResidentClient and public Subprocess; controlled one-shot test leaves. Not actual file dispatch, actual deadline or full host acceptance.',
  fixtureSha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  serverSourceSha256: createHash('sha256').update(fs.readFileSync(path.join(plugin, 'native/src/resident.rs'))).digest('hex'), findings: [] }
const hosts = [], pids = new Set()
let sequence = 0
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function until(condition, label) {
  const end = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > end) throw Error(`${label}: exceeded 10 seconds`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('operation exceeded 10 seconds')), 10_000) })]) }
  finally { clearTimeout(timer) }
}
async function host() {
  const ctx = new Context(); ctx.logger.level = 0
  const handles = []
  class Observer extends Subprocess { spawn(spec) { const handle = super.spawn(spec); handles.push(handle); return handle } }
  await ctx.plugin(Observer)
  let client
  const owner = await ctx.plugin({ inject: ['subprocess'], async apply(inner) { client = await startResident(inner, file, directory) } })
  const result = { ctx, owner, client, handles }; hosts.push(result); pids.add(client.pid)
  return result
}
function envelope(args) {
  return workerEnvelope('file', { root: directory, scope: 'blocked-proof', tool: 'stat', read_only: true,
    deny_roots: [], deny_credential_names: false, args })
}
async function block(host) {
  const ready = path.join(directory, `ready-${++sequence}`), controller = new AbortController()
  const promise = host.client.invoke(envelope({ ready }), controller.signal)
  let settled = false; void promise.then(() => { settled = true }, () => { settled = true })
  await until(() => fs.existsSync(ready), 'fixture leaf entered its fixed block')
  const pid = Number(fs.readFileSync(ready, 'utf8')); assert.ok(pid > 0 && alive(pid)); pids.add(pid)
  assert.equal(settled, false)
  return { controller, promise, pid, get settled() { return settled } }
}
async function fast(host, receipt) {
  const result = await bounded(host.client.invoke(envelope({ receipt })))
  assert.equal(result.value?.status, 'completed', JSON.stringify(result))
  assert.equal(result.value.data.receipt, receipt)
  assert.equal(host.handles.length, 1)
}
async function stopped(call) {
  const result = await bounded(call.promise)
  assert.equal(result.interrupted, true, JSON.stringify(result)); assert.equal(result.value, undefined)
  await until(() => !alive(call.pid), 'cancelled leaf exit')
}
async function check(name, body) {
  const started = performance.now()
  try { const details = await body(); report.findings.push({ name, status: 'pass', elapsedMs: performance.now() - started, ...details }) }
  catch (error) { report.findings.push({ name, status: 'fail', elapsedMs: performance.now() - started, error: String(error.stack) }) }
  console.log(JSON.stringify(report.findings.at(-1)))
}
try {
  const first = await host(), second = await host()
  assert.notEqual(first.client.pid, second.client.pid)
  await check('cancel one blocked request; sibling and other kernel continue', async () => {
    const one = await block(first), two = await block(first)
    await fast(first, 'while-two-blocked'); await fast(second, 'separate-kernel')
    one.controller.abort(); await stopped(one)
    assert.equal(two.settled, false); assert.equal(alive(two.pid), true)
    await fast(first, 'after-one-cancel'); await fast(second, 'other-still-works')
    assert.equal(first.client.available, true)
    two.controller.abort(); await stopped(two)
    return { kernelPid: first.client.pid, cancelledPids: [one.pid, two.pid], otherKernelPid: second.client.pid }
  })
  await check('control disconnect kills blocked leaves without touching other kernel', async () => {
    const call = await block(first)
    first.handles[0].control.destroy()
    await stopped(call); await until(() => !alive(first.client.pid), 'kernel exit')
    assert.equal(first.client.available, false); assert.equal(first.handles.length, 1)
    await fast(second, 'after-other-disconnect')
    return { kernelPid: first.client.pid, leafPid: call.pid }
  })
  const third = await host()
  await check('kernel hard crash joins its blocked leaf without replay', async () => {
    const call = await block(third)
    process.kill(third.client.pid, 'SIGKILL')
    await stopped(call); assert.equal(third.client.available, false)
    await assert.rejects(third.client.invoke(envelope({ receipt: 'must-not-replay' })), /unavailable/)
    assert.equal(third.handles.length, 1); await fast(second, 'after-other-crash')
    return { kernelPid: third.client.pid, leafPid: call.pid }
  })
  await check('provider unload cancels and joins blocked leaves', async () => {
    const call = await block(second)
    await bounded(second.owner.dispose()); await stopped(call)
    await until(() => !alive(second.client.pid), 'unloaded kernel exit')
    assert.equal(second.client.available, false)
    return { kernelPid: second.client.pid, leafPid: call.pid }
  })
} catch (error) { report.fatalError = String(error.stack) }
finally {
  const cleanup = await Promise.allSettled(hosts.map(host => bounded(host.ctx.fiber.dispose())))
  report.cleanupFailures = cleanup.filter(item => item.status === 'rejected').map(item => String(item.reason))
  report.survivingPids = [...pids].filter(alive)
  // Retire only recorded public ownership ranges; a PID alone may be reused.
  // Emergency cleanup is never counted as successful owned teardown.
  for (const host of hosts) for (const handle of host.handles) handle.terminate()
  report.finishedAt = new Date().toISOString()
  report.status = !report.fatalError && !report.cleanupFailures.length && report.findings.length === 4 && report.findings.every(item => item.status === 'pass') && !report.survivingPids.length ? 'pass' : 'fail'
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: path.join(directory, 'report.json'), status: report.status, survivingPids: report.survivingPids }))
  if (report.status !== 'pass') process.exitCode = 1
}
