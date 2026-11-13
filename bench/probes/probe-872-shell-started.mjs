/** Actual Manager: cancellation/close/deadline must interrupt a blocked physical-start acknowledgement.
 * node bench/probes/probe-872-shell-started.mjs <shell_started_blocked.exe> <candidate-niu.exe> <stock-support-niu.exe>
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { prepareNiubash } from '../../lib/niubash/runtime.js'
import { residentShellBootstrap } from '../../lib/execution/resident/shell-bootstrap.js'
import { channel, within } from './872/channel.mjs'

assert.equal(process.platform, 'win32')
const [binary, shell, stock] = process.argv.slice(2).map(value => path.resolve(value))
assert.ok(binary && shell && stock)
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-started-')))
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-started-home-')))
const ctx = new Context(); ctx.logger.level = 0
await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
const support = await prepareNiubash(stock, process.env.PATH ?? process.env.Path, AbortSignal.timeout(15000),
  { workspaceRoot: workspace, env: { ...process.env, DSH_HOME: home } })
const env = {}
for (const [key, value] of Object.entries({ ...scrubbedParentEnv(), ...support.env, HOME: workspace, USERPROFILE: workspace })) {
  for (const old of Object.keys(env)) if (old.toUpperCase() === key.toUpperCase()) delete env[old]
  env[key] = value
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const checks = [], pids = new Set(), owners = new Set()
let handle, wire, count = 0
function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function until(test, label, ms = 10000) {
  const end = Date.now() + ms
  for (;;) { const value = test(); if (value) return value; if (Date.now() >= end) throw Error(`${label} timed out`); await sleep(5) }
}
async function next() { return within(wire.next(), 15000, 'fixture response') }
async function admit(frame, mode) {
  if (frame.hasShell) return wire.send({ type: 'shell.admission', requestId: frame.requestId, decision: 'reuse' })
  const argv = [shell, ...residentShellBootstrap(frame.bootstrap)]
  const confined = mode === 'danger-full-access' ? { argv } : await ctx.get('sandbox').confine(argv,
    { mode, workspaceRoot: workspace, sessionId: `started-${frame.requestId}` }, AbortSignal.timeout(15000))
  assert.deepEqual(confined.argv.slice(-argv.length), argv)
  return wire.send({ type: 'shell.admission', requestId: frame.requestId, decision: 'launch', closeAfter: false,
    launch: { argv: confined.argv, cwd: workspace, env } })
}
async function send(key, command, timeoutMs = 10000) {
  const requestId = `started-${++count}`; owners.add(key)
  await wire.send({ type: 'shell.execute', requestId, sessionKey: key, command, timeoutMs, stdoutBytes: 4096, stderrBytes: 4096 })
  return requestId
}
async function output(id) {
  const streams = []
  for (const stream of ['stdout', 'stderr']) {
    await wire.send({ type: 'shell.read', requestId: id, stream, offset: 0, maxBytes: 4096 })
    const value = await next(); assert.equal(value.type, 'shell.output'); assert.equal(value.requestId, id)
    assert.equal(value.eof, true, JSON.stringify(value)); assert.equal(value.error, undefined)
    streams.push(Buffer.from(value.bytesBase64, 'base64').toString())
  }
  await wire.send({ type: 'shell.release', requestId: id })
  return streams
}
async function warm(key, mode, command = 'printf %s "$$"') {
  const id = await send(key, command)
  for (;;) {
    const value = await next(); assert.equal(value.requestId, id)
    if (value.type === 'shell.admit') await admit(value, mode)
    else if (value.type === 'shell.completed') {
      assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(value.exitCode, 0); assert.equal(value.cleanupConfirmed, true)
      return output(id)
    } else assert.equal(value.type, 'shell.started')
  }
}
async function close(key) {
  const id = `close-${++count}`
  await wire.send({ type: 'shell.close', requestId: id, sessionKey: key, reason: 'fixture finished' })
  const value = await next(); assert.equal(value.type, 'shell.closed'); assert.equal(value.requestId, id); assert.equal(value.cleanupConfirmed, true)
  owners.delete(key)
}
try {
  handle = ctx.get('subprocess').spawn({ argv: [binary], cwd: workspace, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' } })
  handle.done.catch(() => {}); wire = channel(handle.control)
  const ready = await next(); assert.equal(ready.type, 'ready'); pids.add(ready.pid)
  const sibling = Number((await warm('sibling', 'danger-full-access', 'export KEEP=alive; printf %s "$$"'))[0]); pids.add(sibling)
  for (const [action, mode] of [['cancel', 'workspace-write'], ['close', 'read-only'], ['deadline', 'danger-full-access']]) {
    const key = `target-${action}`, target = Number((await warm(key, mode))[0]); pids.add(target)
    const marker = path.join(workspace, `${action}.must-not-run`), armed = path.join(workspace, `${action}.armed`)
    await wire.send({ type: 'fixture.arm', ready: armed })
    const id = await send(key, `printf MUST_NOT_RUN >${quote(marker.replaceAll('\\', '/'))}`, action === 'deadline' ? 1000 : 10000)
    const admission = await next(); assert.equal(admission.type, 'shell.admit'); assert.equal(admission.hasShell, true)
    await admit(admission, mode)
    await until(() => fs.existsSync(armed) && fs.readFileSync(armed, 'utf8') === id, 'physical start writer blocked')
    const startedAt = Date.now(), closeId = `close-held-${++count}`
    if (action === 'cancel') await wire.send({ type: 'cancel', requestId: id })
    else if (action === 'close') await wire.send({ type: 'shell.close', requestId: closeId, sessionKey: key, reason: 'held start' })
    // The gate remains held throughout this observation. A waiter blocked on
    // recv() cannot reach owned shell termination and deterministically fails.
    await until(() => !alive(target), `${action} stops its shell before start acknowledgement`, 6000)
    const stoppedBeforeReleaseMs = Date.now() - startedAt
    assert.equal(alive(sibling), true); assert.equal(fs.existsSync(marker), false)
    await wire.send({ type: 'fixture.release' })
    let completed, closed, started = 0
    while (!completed || (action === 'close' && !closed)) {
      const value = await next()
      if (value.type === 'shell.started') { assert.equal(value.requestId, id); started++ }
      else if (value.type === 'shell.completed') { assert.equal(value.requestId, id); completed = value }
      else { assert.equal(value.type, 'shell.closed'); assert.equal(value.requestId, closeId); closed = value; owners.delete(key) }
    }
    assert.equal(completed.status, 'cancelled'); assert.equal(completed.effectState, 'none'); assert.equal(completed.shellState, 'reset')
    assert.equal(completed.cleanupConfirmed, true); assert.ok(started <= 1); if (closed) assert.equal(closed.cleanupConfirmed, true)
    assert.equal(fs.existsSync(marker), false); const streams = await output(id); assert.deepEqual(streams, ['', ''])
    assert.deepEqual(await warm('sibling', 'danger-full-access', 'printf %s "$KEEP"'), ['alive', ''])
    checks.push({ action, mode, target, sibling, stoppedBeforeReleaseMs, completed, closed })
  }
  for (const key of [...owners]) await close(key)
  await wire.send({ type: 'shutdown' }); await within(handle.done, 10000, 'fixture shutdown'); await within(handle.waitForExit(), 5000, 'fixture owner join')
  assert.deepEqual([...pids].filter(alive), [])
  console.log(JSON.stringify({ status: 'pass', checks, workspace, workerSha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex') }))
} catch (error) {
  console.log(JSON.stringify({ status: 'fail', checks, error: String(error.stack ?? error), workspace, stderr: handle?.collected.stderr.readFrom(0).text }))
  throw error
} finally {
  if (wire) await wire.send({ type: 'fixture.release' }).catch(() => {})
  if (handle) { handle.terminate(); await within(handle.waitForExit(), 5000, 'emergency fixture join') }
  await ctx.fiber.dispose(); assert.deepEqual([...pids].filter(alive), [])
}
