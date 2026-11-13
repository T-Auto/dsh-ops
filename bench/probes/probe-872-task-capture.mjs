/** Internal task/capture vertical; no public jobs or spill contract is enabled.
 * cargo build --locked --manifest-path native/Cargo.toml --example task_capture
 * node bench/probes/probe-872-task-capture.mjs <example.exe>
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { channel, within } from './872/channel.mjs'

assert.equal(process.platform, 'win32', 'native tasks do not establish POSIX containment')
const binary = path.resolve(process.argv[2])
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-task-capture-')))
const ctx = new Context(); ctx.logger.level = 0
await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
const checks = [], pids = new Set()
let handle, wire
const env = scrubbedParentEnv()
async function ask(op, id, extra = {}) {
  await wire.send({ op, id, ...extra })
  const response = await within(wire.next(), 10000, `${op}/${id}`)
  assert.equal(response.ok, true, JSON.stringify(response))
  return response.result
}
async function until(fn, description, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`${description} timed out`)
}
async function launch(id, source, options = {}) {
  const argv = options.argv ?? [process.execPath, '-e', source]
  const confined = options.mode && options.mode !== 'danger-full-access'
    ? await ctx.get('sandbox').confine(argv, { mode: options.mode, workspaceRoot: workspace, sessionId: `capture-${id}` }, AbortSignal.timeout(15000))
    : { argv }
  assert.deepEqual(confined.argv.slice(-argv.length), argv)
  const state = await ask('launch', id, { argv: confined.argv, cwd: workspace, env, cap: options.cap ?? 64000, background: options.background ?? false })
  pids.add(state.pid)
  return state
}
async function settled(id) {
  const state = await until(async () => { const v = await ask('state', id); return v.terminal && v }, `${id} terminal`)
  assert.equal(state.error, null, JSON.stringify(state)); assert.equal(state.cleanupConfirmed, true)
  assert.equal(typeof state.rootExit, 'number', 'terminal receipt requires the held root HANDLE to signal')
  assert.equal(state.active, 0)
  for (const stream of [0, 1]) { const output = await ask('read', id, { stream }); assert.equal(output.eof, true); assert.equal(output.error, null) }
  return state
}
function gone() { for (const pid of pids) assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH', `owned pid ${pid} survived`) }
const report = result => {
  const value = { ...result, checks, workspace, observedPids: [...pids], binarySha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex') }
  fs.writeFileSync(path.join(workspace, 'report.json'), JSON.stringify(value, null, 2)); console.log(JSON.stringify(value))
}
try {
  handle = ctx.get('subprocess').spawn({ argv: [binary], cwd: workspace, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' } })
  handle.done.catch(() => {}); wire = channel(handle.control)
  const ready = await within(wire.next(), 10000, 'ready'); assert.equal(ready.type, 'ready'); pids.add(ready.pid)

  for (const mode of ['danger-full-access', 'read-only', 'workspace-write']) {
    await launch('natural', 'const fs=require("fs");if(fs.readSync(0,Buffer.alloc(1),0,1,null)!==0)process.exit(99);process.stdout.write("out");process.stderr.write("err")', { mode })
    const state = await settled('natural'); assert.equal(state.rootExit, 0, JSON.stringify(await ask('read', 'natural', { stream: 1 })))
    assert.equal((await ask('read', 'natural')).text, 'out')
    assert.equal((await ask('read', 'natural', { stream: 1 })).text, 'err')
    await ask('remove', 'natural'); checks.push({ name: `${mode}: exact public-confined argv, stdin EOF, joined output`, state })
  }
  await launch('259', 'process.exit(259)')
  const code = await settled('259'); assert.equal(code.rootExit, 259)
  await ask('remove', '259'); checks.push({ name: 'held process handle distinguishes terminal exit259 from running', state: code })

  const gate = path.join(workspace, 'release-live')
  await launch('live', `const fs=require('fs');fs.writeSync(1,'abc');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);fs.writeSync(1,'def');}},5)`, { cap: 4 })
  await until(async () => (await ask('read', 'live')).nextOffset === 3, 'initial live output')
  assert.equal((await ask('state', 'live')).rootExit, null)
  assert.deepEqual(await ask('read', 'live', { offset: 1 }), { text: 'bc', offset: 1, nextOffset: 3, lossy: false, eof: false, error: null })
  const empty = await ask('read', 'live', { offset: 3 }); assert.equal(empty.text, ''); assert.equal(empty.eof, false)
  fs.writeFileSync(gate, '')
  await settled('live')
  const tail = await ask('read', 'live'); assert.equal(tail.text, 'cdef'); assert.equal(tail.offset, 2); assert.equal(tail.nextOffset, 6); assert.equal(tail.lossy, true)
  const reader2 = await ask('read', 'live', { offset: 3 }); assert.equal(reader2.text, 'def'); assert.equal(reader2.lossy, false)
  assert.deepEqual(await ask('read', 'live'), tail)
  await ask('remove', 'live'); checks.push({ name: 'independent live byte cursors, bounded tail, actual EOF', tail, reader2 })

  await launch('flood', 'const fs=require("fs");fs.writeSync(1,"x".repeat(1048576)+"OUT");fs.writeSync(2,"y".repeat(1048576)+"ERR")', { cap: 64 })
  await settled('flood')
  for (const stream of [0, 1]) {
    const output = await ask('read', 'flood', { stream }); assert.equal(output.text.length, 64)
    assert.equal(output.nextOffset, 1048579); assert.equal(output.offset, 1048515); assert.equal(output.lossy, true)
    assert.ok(output.text.endsWith(stream ? 'ERR' : 'OUT'))
  }
  await ask('remove', 'flood'); checks.push({ name: 'both 1MiB streams keep draining within 64-byte retention', status: 'pass' })

  await launch('sibling', 'process.stdout.write("sibling");setInterval(()=>{},1000)', { background: true })
  for (const background of [false, true]) {
    const pidFile = path.join(workspace, `child-${background}.pid`)
    await launch('descendant', '', { background, argv: [binary, '--fixture-parent', pidFile] })
    const pid = await until(() => {
      if (!fs.existsSync(pidFile)) return false
      const value = Number(fs.readFileSync(pidFile, 'utf8'))
      return Number.isInteger(value) && value > 0 && value
    }, 'complete descendant pid')
    pids.add(pid)
    if (background) {
      const state = await until(async () => { const value = await ask('state', 'descendant'); return value.rootExit !== null && value }, 'root exit with surviving registered descendant')
      assert.equal(state.rootExit, 23); assert.equal(state.terminal, false); assert.ok(state.active > 0)
      await until(async () => (await ask('read', 'descendant')).text.includes('child'), 'live descendant output')
      assert.equal((await ask('read', 'descendant')).eof, false)
      await ask('stop', 'descendant')
    }
    const state = await settled('descendant'); assert.equal(state.rootExit, 23); assert.equal(state.reset, true)
    assert.equal((await ask('state', 'sibling')).terminal, false)
    await ask('remove', 'descendant'); checks.push({ name: background ? 'explicit task owns live descendants until cancelled' : 'fresh root exit retires surviving descendants before completion', state })
  }
  const stopped = await ask('stop', 'sibling'); assert.equal(stopped.cleanupConfirmed, true)
  assert.ok(stopped.signalAttempt, 'running root cancellation attempts the owned console signal')
  await settled('sibling'); await ask('remove', 'sibling')
  checks.push({ name: 'per-task cancellation leaves sibling usable, then joins both output readers', state: stopped })

  await launch('eof', 'setInterval(()=>{},1000)', { background: true })
  handle.control.end(); await within(handle.done, 10000, 'owner EOF'); await within(handle.waitForExit(), 5000, 'owned range empty')
  assert.equal(handle.collected.stderr.readFrom(0).text, '')
  gone(); checks.push({ name: 'control EOF closes registered tasks before owner exit', status: 'pass' })
  report({ status: 'pass' })
} catch (error) {
  report({ status: 'fail', error: String(error.stack ?? error), stderr: handle?.collected.stderr.readFrom(0).text }); throw error
} finally {
  if (handle) { handle.terminate(); await within(handle.waitForExit(), 5000, 'emergency owner join') }
  await ctx.fiber.dispose(); gone()
}
