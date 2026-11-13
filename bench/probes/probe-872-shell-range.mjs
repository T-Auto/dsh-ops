/** Windows C1 ownership/channel probe; not a session tool or persistent-shell claim.
 * cargo build --locked --manifest-path native/Cargo.toml --example shell_range --example shell_signal_fault
 * cargo build --locked --manifest-path native/Cargo.toml -p ops-process --example shell_signal_cooperative
 * npm run build
 * node bench/probes/probe-872-shell-range.mjs <example.exe> <pinned niu.exe>
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { prepareNiubash } from '../../lib/niubash/runtime.js'
import { channel, within } from './872/channel.mjs'

assert.equal(process.platform, 'win32', 'C1 does not establish POSIX containment')
const root = fileURLToPath(new URL('../../', import.meta.url))
const binary = path.resolve(process.argv[2] ?? path.join(root, 'native/target/debug/examples/shell_range.exe'))
const selected = path.resolve(process.argv[3] ?? path.join(root, 'runtime/win32-x64/niubash/niu.exe'))
const child = path.join(root, 'bench/probes/872/shell-child.mjs')
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-c1-work-')))
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-c1-home-')))
const ctx = new Context(); ctx.logger.level = 0
await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
const support = await prepareNiubash(selected, process.env.PATH ?? process.env.Path, AbortSignal.timeout(15000),
  { workspaceRoot: workspace, env: { ...process.env, DSH_HOME: home } })
const env = {}
// A complete public-provider base, not the resident kernel's ambient environment.
for (const [key, value] of Object.entries({ ...scrubbedParentEnv(), ...support.env, HOME: workspace, USERPROFILE: workspace })) {
  const previous = Object.keys(env).find(name => name.toUpperCase() === key.toUpperCase())
  if (previous) delete env[previous]
  env[key] = value
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const shellPath = value => value.replaceAll('\\', '/')
const checks = [], handles = [], pids = new Set()
function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function gone(ids) {
  const deadline = Date.now() + 5000
  while (ids.some(alive) && Date.now() < deadline) await sleep(10)
  assert.deepEqual(ids.filter(alive), [], 'owned processes must be gone')
}
async function launchKernel() {
  const handle = ctx.get('subprocess').spawn({ argv: [binary], cwd: workspace, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' } })
  handles.push(handle); handle.done.catch(() => {})
  const wire = channel(handle.control)
  const ready = await within(wire.next(), 15000, 'kernel ready')
  assert.equal(ready.type, 'ready'); pids.add(ready.pid)
  return { handle, pid: ready.pid, async ask(op, id, extra = {}) {
    await wire.send({ op, id, ...extra })
    const response = await within(wire.next(), 10000, op).catch(async error => {
      const outcome = await within(handle.done, 500, 'exit facts').catch(() => undefined)
      throw Error(`${op}/${id}: ${error}; outcome=${JSON.stringify(outcome)}; stderr=${handle.collected.stderr.readFrom(0).text}`, { cause: error })
    })
    if (extra.expectFailure) { assert.equal(response.ok, false); return response }
    assert.equal(response.ok, true, `${op}: ${response.error}; stderr=${handle.collected.stderr.readFrom(0).text}`)
    return response.result
  } }
}
async function waitSnapshot(kernel, id, predicate) {
  const deadline = Date.now() + 10000
  for (;;) {
    const result = await kernel.ask('snapshot', id)
    if (predicate(result)) return result
    if (Date.now() >= deadline) throw Error(`snapshot deadline ${id}: ${JSON.stringify(result)}`)
    await sleep(10)
  }
}
async function spawn(kernel, id, mode, shape, args = [], prepared) {
  const { names } = prepared ?? await kernel.ask('prepare', id)
  const script = shape === 'builtin'
    ? `exec 3<>${quote(names[0])} 4<>${quote(names[1])} 5<>${quote(names[2])}; printf 'builtin-out' >&3; printf 'builtin-err' >&4; printf 'builtin-control' >&5`
    : shape === 'trap' ? `exec 3<>${quote(names[2])}; trap 'printf "caught-INT\\n" >&3; exit 42' INT; printf 'ready\\n' >&3; while :; do :; done`
    : [shellPath(process.execPath), shellPath(child), shape, ...names, ...args].map(quote).join(' ')
  const shellArgv = [support.file, '--noprofile', '--norc', '-c', script]
  // A cooperative target explicitly enables Ctrl+C; a Git Bash/CI parent may
  // otherwise pass an ignore flag through the unchanged production launcher.
  const argv = shape === 'trap'
    ? [path.join(path.dirname(binary), 'shell_signal_cooperative.exe'), '--cooperative-shell-fixture', ...shellArgv]
    : shellArgv
  const confined = mode === 'danger-full-access' ? { argv, enforcement: 'none' }
    : await ctx.get('sandbox').confine(argv, { mode, workspaceRoot: workspace, sessionId: `ops-c1-${mode}` }, AbortSignal.timeout(15000))
  assert.deepEqual(confined.argv.slice(-argv.length), argv, 'public host argv is passed unchanged')
  if (mode !== 'danger-full-access') assert.ok(['full', 'partial'].includes(confined.enforcement))
  const result = await kernel.ask('spawn', id, { argv: confined.argv, cwd: workspace, env })
  pids.add(result.pid)
  return { ...result, names, enforcement: confined.enforcement }
}
function cleanChannels(result) {
  assert.equal(result.active, 0)
  for (const value of result.channels) {
    assert.deepEqual(value.errors, [])
    assert.ok(value.accepted.length > 0)
    assert.equal(value.eof, value.accepted.length)
  }
}
try {
  const kernel = await launchKernel()
  assert.equal((await kernel.ask('ping', 'startup')).pong, true)
  for (const mode of ['danger-full-access', 'read-only', 'workspace-write']) {
    const id = `once-${mode}`, expected = ['', 'with space', 'quoted"value', "single'value", 'tail\\', 'Unicode-中文']
    const launched = await spawn(kernel, id, mode, 'once', expected)
    const result = await kernel.ask('finish', id); cleanChannels(result)
    assert.deepEqual(JSON.parse(result.channels[0].text), expected)
    assert.equal(result.channels[1].text, 'private-stderr\n')
    assert.equal(JSON.parse(result.channels[2].text).type, 'ready')
    assert.deepEqual(result.outputs.map(value => value.text), ['', ''])
    checks.push({ name: `${mode}: public confined argv, three private channels and quoting`, status: 'pass', enforcement: launched.enforcement })
    await spawn(kernel, `builtin-${mode}`, mode, 'builtin')
    const builtins = await kernel.ask('finish', `builtin-${mode}`); cleanChannels(builtins)
    assert.deepEqual(builtins.channels.map(value => value.text), ['builtin-out', 'builtin-err', 'builtin-control'], JSON.stringify(builtins))
    checks.push({ name: `${mode}: Niubash public <> redirection`, status: 'pass' })
  }
  const prepared = await kernel.ask('prepare', 'foreign')
  await within(new Promise(resolve => {
    const socket = net.createConnection(prepared.names[0]); socket.once('error', () => {})
    socket.once('connect', () => socket.write('foreign bytes'))
    socket.once('close', resolve)
  }), 3000, 'rejected peer receives server disconnect')
  await waitSnapshot(kernel, 'foreign', value => value.channels[0].rejected === 1)
  await spawn(kernel, 'foreign', 'danger-full-access', 'once', ['owner'], prepared)
  const foreign = await kernel.ask('finish', 'foreign'); cleanChannels(foreign)
  assert.equal(foreign.channels[0].rejected, 1); assert.equal(foreign.channels[0].text, '["owner"]\n')
  checks.push({ name: 'non-Job pipe peer rejected before bytes admitted', status: 'pass' })
  await spawn(kernel, 'flood', 'workspace-write', 'flood')
  const flood = await kernel.ask('finish', 'flood'); cleanChannels(flood)
  for (const output of [...flood.channels.slice(0, 2), ...flood.outputs]) {
    assert.equal(output.observed, 1048576); assert.equal(output.text.length, 1024); assert.equal(output.truncated, true)
  }
  checks.push({ name: 'four streams drain 1MiB each with 1024-byte retention', status: 'pass' })
  const retained = []
  for (const id of ['first', 'sibling']) {
    const started = await spawn(kernel, id, 'workspace-write', 'hold')
    const snapshot = await waitSnapshot(kernel, id, value => value.channels[2].text.includes('leafPid'))
    const control = JSON.parse(snapshot.channels[2].text)
    assert.ok(snapshot.active >= 4, 'wrapper, shell, fixture and immediate detached descendant belong to Job')
    const ids = [started.pid, control.pid, control.leafPid]; ids.forEach(pid => pids.add(pid)); retained.push(ids)
  }
  const interruption = await kernel.ask('interrupt', 'first'); assert.equal(interruption.attempted, true)
  assert.equal((await kernel.ask('ping', 'kernel')).pong, true, 'control survives console attach/detach')
  assert.match(kernel.handle.collected.stdout.readFrom(0).text, /shell-range stdout diagnostic/)
  assert.match(kernel.handle.collected.stderr.readFrom(0).text, /shell-range stderr diagnostic/)
  retained[1].forEach(pid => assert.equal(alive(pid), true, 'sibling private console unaffected'))
  for (const kind of ['stall', 'crash']) {
    const controller = path.join(workspace, `signal-${kind}.exe`)
    fs.copyFileSync(path.join(path.dirname(binary), 'shell_signal_fault.exe'), controller)
    const failed = await kernel.ask('interrupt-fault', 'first', { controller, expectFailure: true })
    const helperPid = Number(/fixture-controller-pid:(\d+)/.exec(failed.error)?.[1])
    assert.ok(helperPid, failed.error); pids.add(helperPid); await gone([helperPid])
    assert.equal((await kernel.ask('ping', 'kernel')).pong, true)
    retained.flat().forEach(pid => assert.equal(alive(pid), true, 'fault helper must not stop another range'))
  }
  checks.push({ name: 'signal helper timeout and crash are joined; target, sibling and control survive', status: 'pass' })
  const stopped = await kernel.ask('stop', 'first'); assert.equal(stopped.active, 0); await gone(retained[0])
  retained[1].forEach(pid => assert.equal(alive(pid), true))
  await spawn(kernel, 'after-interrupt', 'danger-full-access', 'once', ['after'])
  cleanChannels(await kernel.ask('finish', 'after-interrupt'))
  assert.equal((await kernel.ask('interrupt', 'sibling')).attempted, true)
  assert.equal((await kernel.ask('ping', 'kernel')).pong, true)
  for (let index = 0; index < 2; index++) {
    const id = `cooperative-${index}`
    await spawn(kernel, id, 'danger-full-access', 'trap')
    await waitSnapshot(kernel, id, value => value.channels[2].text.includes('ready\n'))
    assert.equal((await kernel.ask('interrupt', id)).attempted, true)
    const completed = await kernel.ask('finish', id)
    assert.equal(completed.exitCode, 42); assert.equal(completed.channels[2].text, 'ready\ncaught-INT\n')
    assert.equal((await kernel.ask('ping', 'kernel')).pong, true)
    retained[1].forEach(pid => assert.equal(alive(pid), true))
  }
  checks.push({ name: 'two cooperative fixture shells catch INT and exit42 without kernel or sibling console changes', status: 'pass' })
  assert.equal((await kernel.ask('stop', 'sibling')).active, 0); await gone(retained[1])
  checks.push({ name: 'soft attempt then bounded stop joins early detached descendant; sibling and later launch survive', status: 'pass' })
  const owned = await spawn(kernel, 'crash', 'workspace-write', 'hold')
  const snap = await waitSnapshot(kernel, 'crash', value => value.channels[2].text.includes('leafPid'))
  const receipt = JSON.parse(snap.channels[2].text), crashPids = [owned.pid, receipt.pid, receipt.leafPid]
  crashPids.forEach(pid => pids.add(pid))
  process.kill(kernel.pid, 'SIGKILL')
  await within(kernel.handle.done, 10000, 'hard kernel crash'); await gone(crashPids)
  checks.push({ name: 'hard kernel crash closes inner Job and removes descendants', status: 'pass' })
  const eofKernel = await launchKernel()
  const eofOwned = await spawn(eofKernel, 'eof', 'read-only', 'hold')
  const eofSnap = await waitSnapshot(eofKernel, 'eof', value => value.channels[2].text.includes('leafPid'))
  const eofReceipt = JSON.parse(eofSnap.channels[2].text), eofPids = [eofOwned.pid, eofReceipt.pid, eofReceipt.leafPid]
  eofPids.forEach(pid => pids.add(pid)); eofKernel.handle.control.end()
  await within(eofKernel.handle.done, 10000, 'kernel control EOF'); await gone(eofPids)
  checks.push({ name: 'control EOF tears down blocked readers and all shell descendants', status: 'pass' })
  console.log(JSON.stringify({ status: 'pass', platform: process.platform, checks,
    scope: 'C1 Windows ownership/channel substrate only; no persistent-session completion, jobs, default activation or POSIX ownership claim.' }, null, 2))
} finally {
  for (const handle of handles) { handle.terminate(); await handle.waitForExit(AbortSignal.timeout(10000)) }
  await ctx.fiber.dispose()
  const survivors = [...pids].filter(alive)
  if (survivors.length) throw Error(`cleanup failed: ${survivors.join(',')}`)
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
}
