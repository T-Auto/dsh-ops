/** Deterministic unresponsive-I/O fixture; the managed process always uses the public host. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { channel, within } from './872/channel.mjs'

assert.equal(process.platform, 'win32', 'this probe requires Windows owned ranges')
const artifacts = execFileSync('cargo', ['test', '--locked', '--manifest-path', 'native/Cargo.toml',
  '-p', 'ops-process', '--no-run', '--message-format=json'], { encoding: 'utf8', timeout: 120000 })
  .split('\n').filter(Boolean).map(line => JSON.parse(line))
const binary = artifacts.find(value => value.reason === 'compiler-artifact'
  && value.target.name === 'ops_process' && value.profile.test && value.executable)?.executable
assert.ok(binary, 'Cargo must identify the exact current test executable')
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-spill-fatal-')))
process.env.DSH_HOME = path.join(workspace, 'home'); fs.mkdirSync(process.env.DSH_HOME)
const ctx = new Context(); ctx.logger.level = 0; await ctx.plugin(Subprocess)
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { if (e.code === 'ESRCH') return false; throw e } }
let handle, ready, poisoned, completed = false
const checks = []
try {
  handle = ctx.get('subprocess').spawn({ argv: [binary, '--ignored', '--exact',
    'shell::windows::launch::tests::fatal_spill_child', '--nocapture'], cwd: workspace, graceMs: 1,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' } })
  handle.done.catch(() => {}); const wire = channel(handle.control)
  ready = await within(wire.next(), 10000, 'fixture ready'); assert.equal(ready.type, 'ready')
  poisoned = await within(wire.next(), 10000, 'poisoned owner'); assert.equal(poisoned.type, 'poisoned')
  assert.equal(poisoned.cleanupConfirmed, false)
  await assert.rejects(within(wire.next(), 5000, 'fatal control EOF'), /control EOF|control closed/)
  assert.equal(alive(ready.childPid), false, 'inner range is already empty')
  assert.equal(alive(ready.pid), true, 'poisoned owner must retain the unacknowledged reader')
  checks.push({ name: 'unacknowledged write retains owner and reports cleanup uncertainty', status: 'pass' })
  // Required fatal boundary, not fallback cleanup: public host termination releases
  // the managed kernel and every retained handle after native joining was unconfirmed.
  handle.terminate()
  assert.equal(await within(handle.waitForExit(), 10000, 'fatal owned range join'), true)
  await within(handle.done, 5000, 'fatal stream join')
  assert.equal(alive(ready.pid), false); assert.equal(alive(ready.childPid), false)
  assert.deepEqual(fs.readdirSync(poisoned.directory), [], 'unfinished file must remain delete-on-close')
  checks.push({ name: 'public host tears down poisoned owner without a surviving process or raw file', status: 'pass' })
  const sibling = ctx.get('subprocess').spawn({ argv: [process.execPath, '-e', 'process.stdout.write("still-usable")'],
    cwd: workspace, graceMs: 100, stdio: { stdin: 'ignore', stdout: { maxBytes: 128 }, stderr: { maxBytes: 128 } } })
  await within(sibling.done, 5000, 'next owned process')
  assert.equal(await sibling.waitForExit(), true)
  assert.equal(sibling.collected.stdout.readFrom(0).text, 'still-usable')
  checks.push({ name: 'host can still own a distinct process after fatal kernel teardown', status: 'pass' })
  completed = true
} finally {
  const report = { binary, checks, ready, poisoned, completed,
    survivorsBeforeEmergencyCleanup: ready ? [ready.pid, ready.childPid].filter(alive) : [],
    stderr: handle?.collected.stderr.readFrom(0).text }
  fs.writeFileSync(path.join(workspace, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, report: path.join(workspace, 'report.json') }, null, 2))
  if (handle) { handle.terminate(); await within(handle.waitForExit(), 10000, 'emergency join') }
  await ctx.fiber.dispose()
}
