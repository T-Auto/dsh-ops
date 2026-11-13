/** C3 public-host regression: shutdown remains observable while shell replies cannot drain.
 * node bench/probes/probe-872-shell-backpressure.mjs <worker> <niu> <bootstrap.js> <stock-support-niu>
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { prepareNiubash } from '../../lib/niubash/runtime.js'
import { channel, within } from './872/channel.mjs'

assert.equal(process.platform, 'win32', 'shell ownership is Windows-only')
const [worker, shell, bootstrapFile, supportFile] = process.argv.slice(2).map(file => path.resolve(file))
assert.ok(worker && shell && bootstrapFile && supportFile, 'four explicit paths are required')
const { residentShellBootstrap } = await import(pathToFileURL(bootstrapFile).href)
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-shell-backpressure-')))
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-shell-backpressure-home-')))
const pidFile = path.join(directory, 'quiet-child.pid')
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const report = { started: new Date().toISOString(), scope: 'Actual Windows kernel/public host; stalled reader and explicit shutdown. Windows named pipes do not expose independent write-half EOF. Local reviewed shell candidate; not a published tool or full application acceptance.',
  worker, workerSha256: hash(worker), shell, shellSha256: hash(shell), directory, checks: [] }
const ctx = new Context(); ctx.logger.level = 0
await ctx.plugin(Subprocess)
const handles = [], pids = new Set()
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function until(predicate, label, limit = 15000) {
  const deadline = Date.now() + limit
  while (!predicate()) { if (Date.now() >= deadline) throw Error(`${label} exceeded ${limit}ms`); await sleep(10) }
}
try {
  const support = await prepareNiubash(supportFile, process.env.PATH ?? process.env.Path, AbortSignal.timeout(15000),
    { workspaceRoot: directory, env: { ...process.env, DSH_HOME: home } })
  const env = {}
  for (const [key, value] of Object.entries({ ...scrubbedParentEnv(), ...support.env, HOME: directory, USERPROFILE: directory })) {
    const prior = Object.keys(env).find(name => name.toUpperCase() === key.toUpperCase())
    if (prior) delete env[prior]
    env[key] = value
  }
  for (const [key, value] of Object.entries(env)) assert.ok(!['BASH_ENV', 'NIU_ENV', 'ENV'].includes(key.toUpperCase()) || !value)
  async function host() {
    const handle = ctx.get('subprocess').spawn({ argv: [worker, '--serve'], cwd: directory, graceMs: 100,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' } })
    handles.push(handle); handle.done.catch(() => {})
    const wire = channel(handle.control)
    const ready = await within(wire.next(), 10000, 'kernel handshake')
    assert.equal(ready.type, 'ready'); assert.ok(ready.capabilities.includes('shell-v1'))
    pids.add(ready.pid)
    return { handle, wire, pid: ready.pid }
  }
  async function start(host, id, command, sessionKey, wait = true) {
    await host.wire.send({ type: 'shell.execute', requestId: id, sessionKey, command,
      timeoutMs: 300000, stdoutBytes: 131072, stderrBytes: 131072 })
    let started = false
    for (;;) {
      const frame = await within(host.wire.next(), 15000, id)
      assert.equal(frame.requestId, id)
      if (frame.type === 'shell.admit') {
        await host.wire.send(frame.hasShell ? { type: 'shell.admission', requestId: id, decision: 'reuse' }
          : { type: 'shell.admission', requestId: id, decision: 'launch', closeAfter: false,
            launch: { argv: [shell, ...residentShellBootstrap(frame.bootstrap)], cwd: directory, env } })
      } else if (frame.type === 'shell.started') { started = true; if (!wait) return }
      else {
        assert.equal(frame.type, 'shell.completed'); assert.equal(started, true)
        assert.equal(frame.status, 'completed', JSON.stringify(frame)); assert.equal(frame.cleanupConfirmed, true)
        return frame
      }
    }
  }
  const hostOne = await host(), sibling = await host()
  await start(sibling, 'sibling-before', 'printf sibling', 'sibling')
  await sibling.wire.send({ type: 'shell.release', requestId: 'sibling-before' })
  // 31 retained records and one running request fit the native 32-record window.
  // Each stream gets exactly one pending read, as the production host requires.
  for (let index = 0; index < 31; index++) {
    const done = await start(hostOne, `filled-${index}`, "printf '%131072s' ''; printf '%131072s' '' >&2", 'output')
    assert.equal(done.stdoutTotal, 131072); assert.equal(done.stderrTotal, 131072)
  }
  const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},240000)`
  await start(hostOne, 'quiet', `${quote(process.execPath.replaceAll('\\', '/'))} -e ${quote(script)}`, 'quiet', false)
  await until(() => fs.existsSync(pidFile), 'quiet task startup')
  const child = Number(fs.readFileSync(pidFile, 'utf8')); assert.ok(child > 0 && alive(child)); pids.add(child)
  hostOne.handle.control.pause()
  for (let index = 0; index < 31; index++) for (const stream of ['stdout', 'stderr']) {
    await within(hostOne.wire.send({ type: 'shell.read', requestId: `filled-${index}`, stream, offset: 0, maxBytes: 65536 }), 10000, 'bounded output read submission')
  }
  report.submittedOutputBytes = 31 * 2 * 65536
  report.pausedReadSide = true
  const began = Date.now()
  await within(hostOne.wire.send({ type: 'shutdown' }), 10000, 'shutdown submission')
  // No read resume, connection destroy, terminate or host disposal is allowed
  // before the assertion: native dispatch must initiate process-tree teardown.
  await until(() => !alive(hostOne.pid) && !alive(child), 'shutdown cleanup under output backpressure')
  report.checks.push({ name: 'shutdown joins kernel and quiet child while replies stay unread', status: 'pass', ms: Date.now() - began,
    kernelPid: hostOne.pid, childPid: child })
  await start(sibling, 'sibling-after', 'printf still-running', 'sibling')
  await sibling.wire.send({ type: 'shell.release', requestId: 'sibling-after' })
  report.checks.push({ name: 'another host kernel and shell remain usable', status: 'pass', kernelPid: sibling.pid })
  hostOne.handle.control.destroy()
  await sibling.wire.send({ type: 'shutdown' })
  await until(() => !alive(sibling.pid), 'sibling normal shutdown')
} catch (error) { report.failure = String(error.stack ?? error) }
finally {
  report.survivorsBeforeEmergencyCleanup = [...pids].filter(alive)
  for (const handle of handles) { handle.control?.destroy(); handle.terminate() }
  const cleanup = await Promise.allSettled(handles.map(handle => within(handle.waitForExit(), 15000, 'public range cleanup')))
  report.cleanupFailures = cleanup.filter(value => value.status === 'rejected' || value.value !== true).map(value => String(value.reason ?? value.value))
  await ctx.fiber.dispose()
  report.status = !report.failure && report.checks.length === 2 && !report.survivorsBeforeEmergencyCleanup.length && !report.cleanupFailures.length ? 'pass' : 'fail'
  const file = path.join(directory, 'report.json')
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ file, ...report }))
  if (report.status !== 'pass') process.exitCode = 1
}
