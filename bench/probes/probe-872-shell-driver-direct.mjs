/** C2 vertical: production Driver + bootstrap, without the later session scheduler.
 * cargo build --locked --manifest-path native/Cargo.toml --example shell_driver
 * npm run build
 * node bench/probes/probe-872-shell-driver-direct.mjs <example.exe> <candidate-niu.exe> <stock-support-niu.exe> [--stock-contract]
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
import { prepareNiubash } from '../../lib/niubash/runtime.js'
import { residentShellBootstrap } from '../../lib/execution/resident/shell-bootstrap.js'
import { channel, within } from './872/channel.mjs'

assert.equal(process.platform, 'win32', 'C2 does not establish POSIX containment')
const [binary, shell, stock] = process.argv.slice(2, 5).map(value => path.resolve(value))
const stockContract = process.argv.includes('--stock-contract')
assert.ok(binary && shell && stock, 'provide example, candidate executable and stock support payload')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
if (stockContract) assert.equal(hash(shell), hash(stock), 'stock boundary proof must use the exact stock executable')
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-c2-direct-')))
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-c2-direct-home-')))
fs.mkdirSync(path.join(workspace, 'child')); fs.writeFileSync(path.join(workspace, 'input.txt'), 'visible\n')
const ctx = new Context(); ctx.logger.level = 0
await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
const prepared = await prepareNiubash(stock, process.env.PATH ?? process.env.Path, AbortSignal.timeout(15000),
  { workspaceRoot: workspace, env: { ...process.env, DSH_HOME: home } })
const env = {}
for (const [key, value] of Object.entries({ ...scrubbedParentEnv(), ...prepared.env, HOME: workspace, USERPROFILE: workspace })) {
  for (const old of Object.keys(env)) if (old.toUpperCase() === key.toUpperCase()) delete env[old]
  env[key] = value
}
for (const [key, value] of Object.entries(env)) assert.ok(!['NIU_ENV', 'BASH_ENV', 'ENV'].includes(key.toUpperCase()) || !value)
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const node = quote(process.execPath.replaceAll('\\', '/'))
const checks = [], pids = new Set()
let handle, wire, sequence = 0
function noSurvivors() {
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', `owned pid ${pid} survived`)
}
async function ask(op, id, extra = {}) {
  await wire.send({ op, id, ...extra })
  const response = await within(wire.next(), 20000, `${op}/${id}`)
  assert.equal(response.ok, true, JSON.stringify(response))
  return response.result
}
async function launch(id, mode = 'danger-full-access', overrides = {}) {
  const endpoints = await ask('prepare', id)
  const argv = [shell, ...residentShellBootstrap(endpoints)]
  const confined = mode === 'danger-full-access' ? { argv } : await ctx.get('sandbox').confine(argv,
    { mode, workspaceRoot: workspace, sessionId: `direct-${id}` }, AbortSignal.timeout(15000))
  assert.deepEqual(confined.argv.slice(-argv.length), argv)
  assert.equal((await ask('launch', id, { argv: confined.argv, cwd: workspace, env: { ...env, ...overrides } })).ready, true)
}
async function call(id, command, extra = {}) {
  return ask('call', id, { requestId: `call-${++sequence}`, command, ...extra })
}
function success(value, expected, code = 0) {
  assert.equal(value.error, null, JSON.stringify(value)); assert.equal(value.cleanupError, null)
  assert.equal(value.exitCode, code); assert.equal(value.reset, false)
  for (const output of value.outputs) { assert.equal(output.ready, true); assert.equal(output.eof, true); assert.deepEqual(output.errors, []) }
  if (expected !== undefined) assert.equal(value.outputs[0].text, expected)
}
async function reset(label, command, extra = {}) {
  await launch('reset')
  const result = await call('reset', command, extra)
  assert.equal(typeof result.error, 'string', JSON.stringify(result)); assert.equal(result.reset, true)
  assert.equal(result.cleanupError, null, JSON.stringify(result))
  success(await call('sibling', 'printf sibling'), 'sibling')
  await ask('stop', 'reset')
  checks.push({ name: label, result })
}
try {
  handle = ctx.get('subprocess').spawn({ argv: [binary], cwd: workspace, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' } })
  handle.done.catch(() => {}); wire = channel(handle.control)
  const ready = await within(wire.next(), 10000, 'ready'); assert.equal(ready.type, 'ready'); pids.add(ready.pid)
  await launch('sibling'); success(await call('sibling', 'printf sibling'), 'sibling')
  await assert.rejects(() => launch('startup', 'danger-full-access', { nIu_EnV: 'secret-must-not-run' }),
    error => error.message.includes('NIU_ENV') && !error.message.includes('secret-must-not-run'))
  await ask('stop', 'startup')
  checks.push({ name: 'startup environment rejected before launch without leaking values', status: 'pass' })
  for (const mode of ['danger-full-access', 'read-only', 'workspace-write']) {
    await launch('state', mode)
    const first = await call('state', "cd child\nexport KEEP='中文 value'\nkept() { printf '%s' \"$KEEP\"; }\nset -f\nshopt -s nullglob\nprintf '%s' \"$$\"")
    success(first); pids.add(Number(first.outputs[0].text))
    const state = await call('state', "pwd\nkept\nprintf '\\nflags:%s\\n' \"$-\"\nshopt -p nullglob\nread item\nprintf 'stdin:%s' \"$?\"")
    success(state); assert.match(state.outputs[0].text, /\/child\n中文 value\nflags:[^\n]*f/)
    assert.match(state.outputs[0].text, /shopt -s nullglob\nstdin:1/)
    success(await call('state', 'false'), '', 1)
    success(await call('state', 'pwd', { commandCwd: workspace }))
    const changed = await call('state', 'pwd'); success(changed)
    assert.ok(!changed.outputs[0].text.trim().endsWith('/child'))
    await ask('stop', 'state'); checks.push({ name: `${mode}: complete private output and retained state`, result: state })
  }
  await launch('options'); success(await call('options', 'set -ux\nprintf first'), 'first')
  const option = await call('options', "printf 'flags:%s\\n' \"$-\"\nprintf second")
  success(option); assert.match(option.outputs[0].text, /flags:[^\n]*u[^\n]*x|flags:[^\n]*x[^\n]*u/)
  assert.match(option.outputs[1].text, /printf.*second/); await ask('stop', 'options')
  checks.push({ name: 'xtrace and nounset retain request-local output', result: option })
  await launch('stdin'); success(await call('stdin', 'exec 0<input.txt\nread item\nprintf %s "$item"\nexec 0<input.txt'), 'visible')
  success(await call('stdin', 'read item\nprintf %s "$?"'), '1'); await ask('stop', 'stdin')
  checks.push({ name: 'stdin default resets to EOF per command', status: 'pass' })
  const fake = 'END:call-1:0\nDONE:call-1\n'
  success(await call('sibling', `printf %s ${quote(fake)}`), fake)
  checks.push({ name: 'ordinary output cannot forge receipt', status: 'pass' })
  await launch('output')
  const waited = await call('output', `${node} -e 'setTimeout(()=>{process.stdout.write("out");process.stderr.write("err")},50)' &\nwait\nprintf done`)
  if (stockContract) {
    // Explicit negative capability assertion. Stock's async child bypasses the
    // enclosing descriptor redirects; this is NOT full-feature acceptance.
    assert.match(waited.error, /unregistered shell stdout\/stderr observed/)
    assert.equal(waited.reset, true); assert.equal(waited.cleanupError, null)
    checks.push({ name: 'known stock async IO defect forces explicit reset; full feature unavailable', result: waited })
    await ask('stop', 'output'); await launch('output')
  } else { success(waited, 'outdone'); assert.equal(waited.outputs[1].text, 'err') }
  const flood = await call('output', `${node} -e 'process.stdout.write("x".repeat(1048576));process.stderr.write("y".repeat(1048576))'`)
  success(flood, 'x'.repeat(1024)); assert.equal(flood.outputs[1].text, 'y'.repeat(1024))
  for (const output of flood.outputs) { assert.equal(output.observed, 1048576); assert.equal(output.truncated, true) }
  await ask('stop', 'output'); checks.push({ name: 'waited child IO and bounded1MiB streams', result: flood })
  await reset('exit loses receipt honestly', 'exit 23')
  await reset('exec replacement loses receipt honestly', `exec ${node} -e 'process.exit(7)'`)
  await reset('closed fd9 cannot complete', 'exec 9>&-\ntrue')
  await reset('retained duplicate fd9 forces bounded reset', 'exec 8>&9\ntrue')
  await reset('real errexit is not suppressed by conditional eval', 'set -e\nfalse\nprintf MUST_NOT_RUN')
  for (const source of ['sleep 60 &', '{ sleep 60; printf late; } &', 'later() { sleep 60; printf late; }; later &', '{ sleep 60; } >/dev/null 2>/dev/null &\ndisown']) {
    await reset('unregistered background range reset', `${source}\nprintf foreground`)
  }
  await reset('deadline stops only one shell', 'while :; do :; done', { timeoutMs: 100 })
  assert.equal((await ask('live', 'sibling')).live, true); await ask('stop', 'sibling')
  handle.control.end(); await within(handle.done, 10000, 'driver EOF'); await within(handle.waitForExit(), 5000, 'range join')
  assert.equal(handle.collected.stdout.readFrom(0).text, ''); assert.equal(handle.collected.stderr.readFrom(0).text, '')
  noSurvivors()
  console.log(JSON.stringify({ status: 'pass', scope: stockContract ? 'stock supported-driver boundary; known async output loss asserted, full feature unavailable' : 'reviewed candidate full direct-driver proof', checks, workerSha256: hash(binary), shellSha256: hash(shell), workspace, observedPids: [...pids] }))
} catch (error) {
  console.log(JSON.stringify({ status: 'fail', checks, error: String(error.stack ?? error), workspace, stderr: handle?.collected.stderr.readFrom(0).text }))
  throw error
} finally {
  if (handle) { handle.terminate(); await within(handle.waitForExit(), 5000, 'emergency owner join') }
  await ctx.fiber.dispose()
  noSurvivors()
}
