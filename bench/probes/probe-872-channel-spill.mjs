/** Shared-store persistent-channel vertical. Stock mode proves foreground IO only. */
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
import { SpillLedger } from '../../lib/shells/spill-ledger.js'
import { sweepSpills } from '../../lib/shells/spill-retention.js'
import { channel, within } from './872/channel.mjs'

assert.equal(process.platform, 'win32', 'native channel spill ownership requires Windows')
const [binary, shell, support] = process.argv.slice(2, 5).map(value => path.resolve(value))
const stock = process.argv.includes('--stock-foreground')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
if (stock) assert.equal(hash(fs.readFileSync(shell)), hash(fs.readFileSync(support)))
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-channel-spill-')))
process.env.DSH_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-channel-spill-home-')))
fs.mkdirSync(path.join(workspace, 'child'))
const ctx = new Context(); ctx.logger.level = 0
await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
const prepared = await prepareNiubash(support, process.env.PATH ?? process.env.Path, AbortSignal.timeout(15000),
  { workspaceRoot: workspace, env: process.env })
const env = {}
for (const [key, value] of Object.entries({ ...scrubbedParentEnv(), ...prepared.env, HOME: workspace, USERPROFILE: workspace })) {
  for (const old of Object.keys(env)) if (old.toUpperCase() === key.toUpperCase()) delete env[old]
  env[key] = value
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const node = quote(process.execPath.replaceAll('\\', '/'))
const ledger = new SpillLedger(path.join(process.env.DSH_HOME, 'native-spill-ledger.jsonl'))
const checks = [], pids = new Set(), paths = new Set()
let handle, wire, sequence = 0, kernelPid, failure
async function ask(op, id, extra = {}) {
  await wire.send({ op, id, ...extra })
  const response = await within(wire.next(), 25000, `${op}/${id}`)
  assert.equal(response.ok, true, JSON.stringify(response)); return response.result
}
async function launch(id, mode) {
  const endpoints = await ask('prepare', id), argv = [shell, ...residentShellBootstrap(endpoints)]
  const confined = mode === 'danger-full-access' ? { argv } : await ctx.get('sandbox').confine(argv,
    { mode, workspaceRoot: workspace, sessionId: `channel-${id}` }, AbortSignal.timeout(15000))
  assert.deepEqual(confined.argv.slice(-argv.length), argv)
  assert.equal((await ask('launch', id, { argv: confined.argv, cwd: workspace, env })).ready, true)
  const result = await call(id, 'printf %s "$$"'); pids.add(Number(result.outputs[0].text))
}
async function call(id, command, timeoutMs = 10000) {
  return ask('call', id, { requestId: `spill-${++sequence}`, command, timeoutMs })
}
function success(result) {
  assert.equal(result.error, null, JSON.stringify(result)); assert.equal(result.cleanupError, null)
  assert.equal(result.exitCode, 0); assert.equal(result.reset, false)
  for (const stream of result.outputs) { assert.equal(stream.eof, true); assert.deepEqual(stream.errors, []) }
}
function recover(stream, expected) {
  assert.equal(stream.observed, expected.length); assert.equal(stream.truncated, true)
  assert.equal(stream.spillOrigin, 'ops-native-v1'); assert.equal(stream.spillPid, kernelPid)
  assert.equal(stream.spillSealed, true); assert.equal(stream.spillError, undefined)
  assert.deepEqual(fs.readFileSync(stream.spillPath), expected)
  ledger.record({ path: stream.spillPath, origin: stream.spillOrigin, pid: stream.spillPid,
    bytes: stream.observed, sessionId: 'channel-spill' })
  paths.add(stream.spillPath)
}
function gone() {
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH', `owned pid ${pid} survived`)
}
try {
  handle = ctx.get('subprocess').spawn({ argv: [binary, '--spill'], cwd: workspace, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' } })
  handle.done.catch(() => {}); wire = channel(handle.control)
  const ready = await within(wire.next(), 10000, 'ready'); kernelPid = ready.pid; pids.add(kernelPid)
  await launch('sibling', 'danger-full-access')
  for (const mode of ['danger-full-access', 'read-only', 'workspace-write']) {
    await launch('main', mode)
    const first = await call('main', 'cd child\nexport KEEP=retained\nkept() { printf %s "$KEEP"; }\nset -f')
    success(first)
    const boundary = await call('main', `${node} -e 'require("fs").writeSync(1,Buffer.alloc(1024,120))'`)
    success(boundary); assert.equal(boundary.outputs[0].observed, 1024); assert.equal(boundary.outputs[0].spillPath, undefined)
    const stdout = Buffer.alloc(1024 * 1024, 120), stderr = Buffer.alloc(1024 * 1024, 121)
    stdout.set([0, 255, 195, 40]); stderr.set([0, 254, 240, 159])
    const code = 'const fs=require("fs");const a=Buffer.alloc(1048576,120),b=Buffer.alloc(1048576,121);a.set([0,255,195,40]);b.set([0,254,240,159]);fs.writeSync(1,a);fs.writeSync(2,b)'
    const result = await call('main', `${node} -e ${quote(code)}${stock ? '' : ' &\nwait'}`)
    success(result); recover(result.outputs[0], stdout); recover(result.outputs[1], stderr)
    const retained = await call('main', 'pwd\nkept\nprintf "\\nflags:%s" "$-"')
    success(retained); assert.match(retained.outputs[0].text, /\/child\nretained\nflags:[^\n]*f/)
    success(await call('sibling', 'printf sibling'))
    await ask('stop', 'main')
    checks.push({ name: `${mode}: ${stock ? 'foreground' : 'waited background'} raw streams, exact memory boundary, retained state`, stdoutSha256: hash(stdout), stderrSha256: hash(stderr) })
  }
  assert.equal(new Set([...paths].map(file => path.dirname(file))).size, 1, 'all streams and shells share the same native Store')
  assert.equal(ledger.entries().length, 6)
  const swept = sweepSpills({ ledger, now: Date.now() + 40 * 86400000 })
  assert.equal(swept.deleted.length, 6); for (const file of paths) assert.equal(fs.existsSync(file), false)
  success(await call('sibling', 'printf after-retention')); await ask('stop', 'sibling')
  checks.push({ name: 'one shared store and existing settled ledger, shell remains usable after retention' })
  handle.control.end(); await within(handle.done, 10000, 'kernel exit')
  assert.equal(await within(handle.waitForExit(), 5000, 'range join'), true); gone()
  assert.equal(handle.collected.stdout.readFrom(0).text, ''); assert.equal(handle.collected.stderr.readFrom(0).text, '')
  checks.push({ name: 'no framing or user bytes escape onto original kernel diagnostics; no owned survivors' })
} catch (error) { failure = String(error.stack ?? error); throw error }
finally {
  const report = { status: failure ? 'fail' : 'pass', scope: stock ? 'stock foreground subset; async runtime remains ineligible' : 'candidate waited-background and shared-spill proof',
    checks, failure, binarySha256: hash(fs.readFileSync(binary)), shellSha256: hash(fs.readFileSync(shell)), observedPids: [...pids], workspace }
  fs.writeFileSync(path.join(workspace, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
  if (handle) { handle.terminate(); await within(handle.waitForExit(), 10000, 'emergency join') }
  await ctx.fiber.dispose(); gone()
}
