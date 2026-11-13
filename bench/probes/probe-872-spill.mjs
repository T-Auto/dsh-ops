/** Real native raw-spill vertical; public task/job tools remain unpublished. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { residentKernel } from '../../lib/execution/resident/provider.js'
import { invoke as fileCall } from '../../lib/execution/files.js'
import { SpillLedger } from '../../lib/shells/spill-ledger.js'
import { sweepSpills } from '../../lib/shells/spill-retention.js'
import { channel, within } from './872/channel.mjs'

assert.equal(process.platform, 'win32', 'owned native spill integration requires Windows')
const binary = path.resolve(process.argv[2]), worker = path.resolve(process.argv[3])
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-spill-proof-')))
process.env.DSH_HOME = path.join(workspace, 'home'); fs.mkdirSync(process.env.DSH_HOME)
const ctx = new Context(); ctx.logger.level = 0
await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
let mode = 'read-only'
await ctx.plugin(inner => {
  inner.provide('workingDirectory', { ensure: async () => workspace, get: () => workspace })
  inner.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: workspace }) })
})
const exec = { agent: { id: 'spill-read', session: { id: 'spill-read', header: { cwd: workspace } } }, signal: AbortSignal.timeout(20000) }
const ledger = new SpillLedger(path.join(process.env.DSH_HOME, 'ops-spill-ledger.jsonl'))
const checks = [], pids = new Set(), sealed = new Set()
let handle, wire, directory, kernelPid
async function ask(op, id, extra = {}) {
  await wire.send({ op, id, ...extra }); const result = await within(wire.next(), 15000, `${op}/${id}`)
  assert.equal(result.ok, true, JSON.stringify(result)); return result.result
}
async function until(fn, description, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 5)) }
  throw new Error(`${description} timed out`)
}
async function launch(id, source) {
  const argv = [process.execPath, '-e', source]
  const confined = await ctx.get('sandbox').confine(argv, { mode: 'read-only', workspaceRoot: workspace, sessionId: `spill-${id}` }, AbortSignal.timeout(10000))
  assert.deepEqual(confined.argv.slice(-argv.length), argv)
  const value = await ask('launch', id, { argv: confined.argv, cwd: workspace, env: scrubbedParentEnv(), cap: 64000 })
  pids.add(value.pid)
}
async function finished(id) {
  const result = await until(async () => { const value = await ask('state', id); return value.terminal && value }, `${id} completion`, 25000)
  assert.equal(result.error, null, JSON.stringify(result)); assert.equal(result.cleanupConfirmed, true)
  assert.equal(result.active, 0); assert.equal(typeof result.rootExit, 'number')
  return result
}
function record(value) {
  assert.equal(value.spillSealed, true); assert.equal(value.spillOrigin, 'ops-native-v1')
  assert.equal(value.spillPid, kernelPid)
  ledger.record({ origin: value.spillOrigin, path: value.spillPath, pid: value.spillPid, bytes: value.nextOffset, sessionId: 'spill-read' })
  sealed.add(value.spillPath)
}
function gone() { for (const pid of pids) assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH', `owned pid ${pid} survived`) }
try {
  await ctx.plugin(residentKernel({ binaryPath: worker }))
  handle = ctx.get('subprocess').spawn({ argv: [binary, '--spill'], cwd: workspace, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' } })
  handle.done.catch(() => {}); wire = channel(handle.control)
  const ready = await within(wire.next(), 10000, 'spill kernel ready'); pids.add(ready.pid); kernelPid = ready.pid

  await launch('boundary', 'require("fs").writeSync(1,Buffer.alloc(64000,120))')
  await finished('boundary')
  const boundary = await ask('read', 'boundary'); assert.equal(boundary.nextOffset, 64000); assert.equal(boundary.spillPath, undefined)
  await ask('remove', 'boundary'); checks.push({ name: 'exact64,000 bytes stays memory-only', status: 'pass' })

  const gate = path.join(workspace, 'release-live'), expected = 'HEADER_RECOVERY\n' + 'x'.repeat(64000) + '\nTAIL\n'
  await launch('live', `const fs=require('fs');fs.writeSync(1,'HEADER_RECOVERY\\n'+'x'.repeat(64000)+'\\nTAIL\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(timer)},5)`)
  const live = await until(async () => { const value = await ask('read', 'live'); return value.spillPath && value }, 'live complete-prefix spill')
  directory = path.dirname(live.spillPath)
  assert.equal(live.eof, false); assert.equal(live.spillSealed, false); assert.equal(live.nextOffset, Buffer.byteLength(expected))
  assert.equal(live.text.includes('HEADER_RECOVERY'), false); assert.equal(fs.readFileSync(live.spillPath, 'utf8'), expected)
  assert.equal(ledger.entries().length, 0, 'live metadata is not settled ledger ownership')
  fs.writeFileSync(gate, ''); await finished('live')
  const complete = await ask('read', 'live'); record(complete)
  const recovery = await fileCall(ctx, worker, 'inspect_local_file', { path: complete.spillPath }, exec, exec.signal)
  assert.equal(recovery.status, 'completed', JSON.stringify(recovery)); assert.ok(JSON.stringify(recovery).includes('HEADER_RECOVERY'))
  mode = 'workspace-write'
  const refusal = await fileCall(ctx, worker, 'write_file', { path: complete.spillPath, content: 'unauthorized' }, exec, exec.signal)
  assert.equal(refusal.status, 'rejected'); assert.equal(fs.readFileSync(complete.spillPath, 'utf8'), expected)
  mode = 'read-only'
  await ask('remove', 'live'); checks.push({ name: 'live full prefix, sealed public-file recovery, no widened writes', path: complete.spillPath })

  const before = fs.readdirSync(directory).sort()
  const capGate = path.join(workspace, 'release-cap')
  await launch('oversized', `const fs=require('fs');const chunk=Buffer.alloc(65536,120);for(let i=0;i<1024;i++)fs.writeSync(1,chunk);const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(capGate)})){clearInterval(timer);fs.writeSync(1,'!')}},5)`)
  const atLimit = await until(async () => { const value = await ask('read', 'oversized'); return value.nextOffset === 64 * 1024 * 1024 && value }, 'exact64MiB live file')
  assert.equal(fs.statSync(atLimit.spillPath).size, 64 * 1024 * 1024)
  assert.equal(atLimit.spillSealed, false)
  fs.writeFileSync(capGate, '')
  await finished('oversized')
  const oversized = await ask('read', 'oversized')
  assert.equal(oversized.nextOffset, 64 * 1024 * 1024 + 1); assert.equal(oversized.spillPath, undefined)
  assert.match(oversized.spillError, /cap exceeded/); assert.equal(oversized.text.length, 64000)
  assert.deepEqual(fs.readdirSync(directory).sort(), before)
  await ask('remove', 'oversized'); checks.push({ name: '64MiB cap withdraws and deletes full file while tail keeps draining', status: 'pass' })

  await launch('cancel', 'const fs=require("fs");fs.writeSync(2,Buffer.alloc(64001,121));setInterval(()=>{},1000)')
  const pending = await until(async () => { const value = await ask('read', 'cancel', { stream: 1 }); return value.spillPath && value }, 'cancel live spill')
  await ask('stop', 'cancel'); await finished('cancel')
  const cancelled = await ask('read', 'cancel', { stream: 1 })
  assert.equal(cancelled.eof, true); assert.equal(cancelled.error, null)
  assert.equal(cancelled.spillPath, pending.spillPath); assert.equal(cancelled.spillSealed, true)
  assert.equal(fs.statSync(cancelled.spillPath).size, 64001); record(cancelled)
  await ask('remove', 'cancel'); checks.push({ name: 'cancel joins output and seals already complete observed bytes', status: 'pass' })

  const expired = sweepSpills({ ledger, now: Date.now() + 40 * 86400000 })
  assert.deepEqual(new Set(expired.deleted), sealed); assert.deepEqual(expired.unknown, [])
  assert.equal(fs.existsSync(directory), true)
  checks.push({ name: 'same settled ledger retires actual native-origin files individually', count: expired.deleted.length })
  await launch('crash', 'require("fs").writeSync(1,Buffer.alloc(64001,122));setInterval(()=>{},1000)')
  const unfinished = await until(async () => { const value = await ask('read', 'crash'); return value.spillPath && value }, 'unsealed crash spill')
  assert.equal(unfinished.spillSealed, false)
  process.kill(kernelPid, 'SIGKILL')
  await within(handle.done, 10000, 'kernel crash'); await within(handle.waitForExit(), 5000, 'owner join'); gone()
  assert.equal(fs.existsSync(unfinished.spillPath), false, 'kernel crash closes and deletes the unsealed file')
  checks.push({ name: 'kernel crash deletes unfinished spill and retires child before fallback cleanup', status: 'pass' })
  assert.equal(handle.collected.stderr.readFrom(0).text, '')
  const result = { status: 'pass', checks, workspace, observedPids: [...pids] }
  fs.writeFileSync(path.join(workspace, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
} catch (error) {
  const result = { status: 'fail', checks, workspace, error: String(error.stack ?? error), stderr: handle?.collected.stderr.readFrom(0).text }
  fs.writeFileSync(path.join(workspace, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); throw error
} finally {
  if (handle) { handle.terminate(); await within(handle.waitForExit(), 5000, 'emergency range join') }
  await ctx.fiber.dispose(); gone()
}
