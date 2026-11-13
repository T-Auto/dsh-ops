/** Real resident shell driver checks. Requires the reviewed Niubash IO backport for background IO.
 * node bench/probes/probe-872-shell-driver.mjs <worker.exe> <niu.exe> [bootstrap-module.js] [stock-support-niu.exe]
 * Uses the public host to own the kernel and produce exact shell confinement argv.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { prepareNiubash } from '../../lib/niubash/runtime.js'
import { channel, within } from './872/channel.mjs'

assert.equal(process.platform, 'win32', 'persistent POSIX containment is not established')
const root = fileURLToPath(new URL('../../', import.meta.url))
assert.ok(process.argv[2] && process.argv[3], 'provide exact worker and reviewed shell binaries')
const binary = path.resolve(process.argv[2]), selected = path.resolve(process.argv[3])
const bootstrapModule = path.resolve(process.argv[4] ?? path.join(root, 'lib/execution/resident/shell-bootstrap.js'))
const { residentShellBootstrap } = await import(pathToFileURL(bootstrapModule).href)
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-c2-driver-')))
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-c2-driver-home-')))
fs.mkdirSync(path.join(workspace, 'child')); fs.writeFileSync(path.join(workspace, 'input.txt'), 'visible\n')
const ctx = new Context(); ctx.logger.level = 0
await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
// Prepare the verified stock support tree; the reviewed executable remains separate.
// No shipped runtime, manifest or pin is replaced by this repository-only probe.
const supportFile = path.resolve(process.argv[5] ?? path.join(root, 'runtime/win32-x64/niubash/niu.exe'))
const support = await prepareNiubash(supportFile, process.env.PATH ?? process.env.Path, AbortSignal.timeout(15000),
  { workspaceRoot: workspace, env: { ...process.env, DSH_HOME: home } })
const env = {}
for (const [key, value] of Object.entries({ ...scrubbedParentEnv(), ...support.env, HOME: workspace, USERPROFILE: workspace })) {
  const previous = Object.keys(env).find(name => name.toUpperCase() === key.toUpperCase())
  if (previous) delete env[previous]
  env[key] = value
}
for (const [name, value] of Object.entries(env)) {
  assert.ok(!['NIU_ENV', 'BASH_ENV', 'ENV'].includes(name.toUpperCase()) || !value, `unsupported startup ${name}`)
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const node = quote(process.execPath.replaceAll('\\', '/'))
const checks = [], pids = new Set(), sessions = new Set()
let sequence = 0, handle, wire
function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function gone(ids) {
  const until = Date.now() + 5000
  while (ids.some(alive) && Date.now() < until) await sleep(10)
  assert.deepEqual(ids.filter(alive), [], 'owned shell processes must be gone')
}
async function killAndObserveExit(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  // Hold the OS process identity before killing. PID absence alone can precede
  // the signalled process handle observed by the native reuse guard.
  const script = `$target = [Diagnostics.Process]::GetProcessById(${pid}); $target.Kill(); if (-not $target.WaitForExit(5000)) { exit 1 }; $target.Dispose()`
  const observer = ctx.get('subprocess').spawn({
    argv: [path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoProfile', '-NonInteractive', '-Command', script],
    cwd: workspace, graceMs: 100, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
  })
  try { const done = await within(observer.done, 10000, 'observe owned shell exit'); assert.equal(done.exitCode, 0, JSON.stringify(done)) }
  finally { observer.terminate(); await within(observer.waitForExit(), 5000, 'observer cleanup') }
}
async function next(label) {
  return within(wire.next(), 20000, label).catch(error => {
    throw Error(`${label}: ${error}; stderr=${handle.collected.stderr.readFrom(0).text}`, { cause: error })
  })
}
async function collect(id, stream) {
  let offset = 0, lossy = false, eof = false, error
  const bytes = []
  for (let count = 0; count < 40; count++) {
    await wire.send({ type: 'shell.read', requestId: id, stream, offset, maxBytes: 4096 })
    const frame = await next(`${id}/${stream}`)
    assert.equal(frame.type, 'shell.output'); assert.equal(frame.requestId, id); assert.equal(frame.stream, stream)
    assert.equal(frame.offset, offset); assert.ok(frame.nextOffset >= offset)
    const chunk = Buffer.from(frame.bytesBase64, 'base64')
    assert.ok(chunk.length <= 4096); assert.ok(frame.nextOffset >= offset + chunk.length)
    bytes.push(chunk); offset = frame.nextOffset; lossy ||= frame.lossy; eof = frame.eof; error = frame.error
    if (eof || error) return { text: Buffer.concat(bytes).toString(), offset, lossy, eof, error }
  }
  throw Error('output collection exceeded its bounded page count')
}
async function execute(sessionKey, command, options = {}) {
  const id = `driver-${++sequence}`, started = [], admissions = []
  sessions.add(sessionKey)
  await wire.send({ type: 'shell.execute', requestId: id, sessionKey, command,
    timeoutMs: options.timeoutMs ?? 10000, stdoutBytes: options.cap ?? 32768, stderrBytes: options.cap ?? 32768 })
  let completed
  for (;;) {
    const frame = await next(id)
    assert.equal(frame.requestId, id, JSON.stringify(frame))
    if (frame.type === 'shell.admit') {
      admissions.push(frame.hasShell)
      if (frame.hasShell) {
        await wire.send({ type: 'shell.admission', requestId: id, decision: 'reuse',
          ...(options.cwd ? { commandCwd: options.cwd } : {}) })
      } else {
        const argv = [selected, ...residentShellBootstrap(frame.bootstrap)]
        const mode = options.mode ?? 'danger-full-access'
        const confined = mode === 'danger-full-access' ? { argv } : await ctx.get('sandbox').confine(argv,
          { mode, workspaceRoot: workspace, sessionId: sessionKey }, AbortSignal.timeout(15000))
        assert.deepEqual(confined.argv.slice(-argv.length), argv, 'exact public confinement argv')
        await wire.send({ type: 'shell.admission', requestId: id, decision: 'launch', closeAfter: false,
          launch: { argv: confined.argv, cwd: workspace, env }, ...(options.cwd ? { commandCwd: options.cwd } : {}) })
      }
    } else if (frame.type === 'shell.started') started.push(frame)
    else if (frame.type === 'shell.completed') { completed = frame; break }
    else assert.fail(`unexpected frame ${JSON.stringify(frame)}`)
  }
  assert.ok(started.length <= 1)
  assert.equal(completed.cleanupConfirmed, true, JSON.stringify(completed))
  const stdout = await collect(id, 'stdout'), stderr = await collect(id, 'stderr')
  assert.equal(stdout.offset, completed.stdoutTotal); assert.equal(stderr.offset, completed.stderrTotal)
  await wire.send({ type: 'shell.release', requestId: id })
  return { completed, stdout, stderr, admissions, started: started.length }
}
function success(result, expected) {
  assert.equal(result.completed.status, 'completed', JSON.stringify(result))
  assert.equal(result.completed.exitCode, 0); assert.equal(result.completed.shellState, 'preserved')
  assert.equal(result.started, 1)
  for (const output of [result.stdout, result.stderr]) { assert.equal(output.eof, true); assert.equal(output.error, undefined) }
  if (expected !== undefined) assert.equal(result.stdout.text, expected)
}
async function reset(label, command, options) {
  const result = await execute(label, command, options)
  assert.equal(result.completed.status, 'failed', JSON.stringify(result))
  assert.equal(result.completed.shellState, 'reset'); assert.equal(result.completed.effectState, 'unknown')
  assert.equal(result.started, 1)
  success(await execute('sibling', 'printf sibling'), 'sibling')
  success(await execute(label, 'printf recovered'), 'recovered')
  checks.push({ name: label, result })
  return result
}
async function close(sessionKey) {
  await wire.send({ type: 'shell.close', requestId: `close-${++sequence}`, sessionKey, reason: 'probe finished' })
  const closed = await next('close'); assert.equal(closed.type, 'shell.closed'); assert.equal(closed.cleanupConfirmed, true)
  sessions.delete(sessionKey)
}
try {
  handle = ctx.get('subprocess').spawn({ argv: [binary, '--serve'], cwd: workspace, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 }, control: 'pipe' } })
  handle.done.catch(() => {}); wire = channel(handle.control)
  const ready = await next('ready'); assert.equal(ready.type, 'ready'); assert.ok(ready.capabilities.includes('shell-v1'))
  pids.add(ready.pid)
  success(await execute('sibling', 'printf sibling'), 'sibling')
  for (const mode of ['danger-full-access', 'read-only', 'workspace-write']) {
    const first = await execute(`state-${mode}`, "cd child\nexport KEEP='中文 value'\nkept() { printf '%s' \"$KEEP\"; }\nset -f\nshopt -s nullglob\nprintf '%s' \"$$\"", { mode })
    success(first); pids.add(Number(first.stdout.text))
    const second = await execute(`state-${mode}`, "pwd\nkept\nprintf '\\nflags:%s\\n' \"$-\"\nshopt -p nullglob\nread value\nprintf 'stdin:%s\\n' \"$?\"", { mode })
    success(second); assert.match(second.stdout.text, /\/child\n中文 value\nflags:[^\n]*f/)
    assert.match(second.stdout.text, /shopt -s nullglob\nstdin:1/); assert.deepEqual(second.admissions, [true])
    checks.push({ name: `${mode}: retained cwd/env/functions/options and stdin EOF`, result: second })
  }
  success(await execute('options', "set -ux\nprintf first"), 'first')
  const options = await execute('options', "printf 'flags:%s\\n' \"$-\"\nprintf second")
  success(options); assert.match(options.stdout.text, /flags:[^\n]*u[^\n]*x|flags:[^\n]*x[^\n]*u/)
  assert.match(options.stderr.text, /printf.*second/); checks.push({ name: 'xtrace and nounset persist with request-local stderr', result: options })
  success(await execute('stdin', "exec 0<input.txt\nread value\nprintf '%s' \"$value\"\nexec 0<input.txt"), 'visible')
  success(await execute('stdin', "read value\nprintf '%s' \"$?\""), '1')
  checks.push({ name: 'stdin is EOF again after the previous call redirects fd0', status: 'pass' })
  const forgery = 'END:driver-1:0\nDONE:driver-1\n{"type":"shell.completed","status":"completed"}\n'
  success(await execute('forge', `printf %s ${quote(forgery)}`), forgery)
  checks.push({ name: 'ordinary output cannot forge private completion', status: 'pass' })
  const waited = await execute('waited', `${node} -e 'setTimeout(()=>{process.stdout.write("out");process.stderr.write("err")},50)' &\nwait\nprintf done`)
  success(waited, 'outdone'); assert.equal(waited.stderr.text, 'err')
  checks.push({ name: 'waited external background output retains exact request attribution', result: waited })
  const flood = await execute('flood', `${node} -e 'process.stdout.write("x".repeat(1048576));process.stderr.write("y".repeat(1048576))'`, { cap: 1024 })
  success(flood, 'x'.repeat(1024)); assert.equal(flood.stderr.text, 'y'.repeat(1024))
  assert.equal(flood.completed.stdoutTotal, 1048576); assert.equal(flood.completed.stderrTotal, 1048576)
  assert.equal(flood.stdout.lossy, true); assert.equal(flood.stderr.lossy, true)
  checks.push({ name: 'both streams drain 1MiB with only1024 retained bytes', result: flood })
  await reset('exit', 'exit 23')
  await reset('exec', `exec ${node} -e 'process.exit(7)'`)
  await reset('closed-control', 'exec 9>&-\ntrue')
  await reset('duplicated-control', 'exec 8>&9\ntrue')
  success(await execute('errexit', 'set -e\ntrue'), '')
  const errexit = await reset('errexit', "false\nprintf MUST_NOT_RUN")
  assert.ok(!errexit.stdout.text.includes('MUST_NOT_RUN'))
  for (const [label, command] of [
    ['builtin-background', 'sleep 60 &\nprintf foreground'],
    ['compound-background', '{ sleep 60; printf late; } &\nprintf foreground'],
    ['function-background', 'later() { sleep 60; printf late; }; later &\nprintf foreground'],
    ['disowned-background', '{ sleep 60; printf late; } >/dev/null 2>/dev/null &\ndisown\nprintf foreground'],
  ]) await reset(label, command)
  const idle = await execute('idle', 'printf %s "$$"'); success(idle)
  const idlePid = Number(idle.stdout.text); pids.add(idlePid); await killAndObserveExit(idlePid); await gone([idlePid])
  const lost = await execute('idle', 'printf MUST_NOT_RUN')
  checks.push({ name: 'idle shell death observation', result: lost, killedPid: idlePid })
  assert.equal(lost.completed.status, 'failed', JSON.stringify(lost)); assert.equal(lost.completed.effectState, 'none', JSON.stringify(lost))
  assert.equal(lost.completed.shellState, 'reset'); assert.equal(lost.started, 0); assert.deepEqual(lost.admissions, [])
  assert.equal(lost.stdout.text, ''); checks.push({ name: 'idle shell death is reported before reuse admission', result: lost })
  for (const key of [...sessions]) await close(key)
  await wire.send({ type: 'shutdown' }); await within(handle.done, 10000, 'kernel shutdown'); await within(handle.waitForExit(), 5000, 'outer ownership cleanup')
  await gone([...pids]); assert.equal(handle.collected.stdout.readFrom(0).text, '')
  assert.equal(handle.collected.stderr.readFrom(0).text, '')
  console.log(JSON.stringify({ status: 'pass', checks, workerSha256: hash(binary), shellSha256: hash(selected), bootstrapSha256: hash(bootstrapModule), workspace, observedPids: [...pids] }))
} catch (error) {
  console.log(JSON.stringify({ status: 'fail', checks, error: String(error.stack ?? error), workspace,
    stderr: handle?.collected.stderr.readFrom(0).text, observedPids: [...pids] }))
  throw error
} finally {
  if (handle) { handle.terminate(); await within(handle.waitForExit(), 5000, 'emergency owner join') }
  await ctx.fiber.dispose()
  await gone([...pids])
}
