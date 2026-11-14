/** Production-driver adaptation of the supplied 106-operation scenario.
 * node bench/probes/872/scenario-driver.mjs BEFORE_DRIVER AFTER_DRIVER NIU REPORT
 * Uses one fresh, shared fixture; measures both ls -la (attached harness) and ls
 * (prose target). No result from the prototype or another machine is substituted.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { prepareNiubash } from '../../../lib/niubash/runtime.js'
import { residentShellBootstrap } from '../../../lib/execution/resident/shell-bootstrap.js'
import { channel, within } from './channel.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.argv.length, 6, 'provide before driver, after driver, Niubash and report path')
const [before, after, niu, reportFile] = process.argv.slice(2).map(value => path.resolve(value))
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-872-scenario-')))
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-872-scenario-home-')))
fs.mkdirSync(path.join(workspace, 'data'))
// Exactly 100 files match the attached harness's f1*.txt copy selector.
for (let i = 0; i < 2000; i++) {
  const name = i < 100 ? `f${100 + i}.txt` : `g${String(i).padStart(4, '0')}.txt`
  fs.writeFileSync(path.join(workspace, 'data', name), `needle ${i}\n`)
}
fs.writeFileSync(path.join(workspace, 'small.txt'), 'tiny\n')
const big = Buffer.alloc(65536, 120)
for (let i = 63; i < big.length; i += 64) big[i] = 10
fs.writeFileSync(path.join(workspace, 'big.txt'), big)
const prepared = await prepareNiubash(niu, process.env.PATH ?? process.env.Path,
  AbortSignal.timeout(30000), { workspaceRoot: workspace, env: { ...process.env, DSH_HOME: home } })
const env = {}
for (const [key, value] of Object.entries({ ...scrubbedParentEnv(), ...prepared.env, HOME: workspace, USERPROFILE: workspace })) {
  for (const old of Object.keys(env)) if (old.toUpperCase() === key.toUpperCase()) delete env[old]
  env[key] = value
}
const workloads = {
  rtt: [':', ''],
  readsmall: ['cat small.txt', 'tiny'],
  read64k: ['cat big.txt > /dev/null; wc -c < big.txt', '65536'],
  sedrange: ["sed -n '1,80p' big.txt | wc -l", '80'],
  lsdir: ['ls -la data | wc -l', '2003'],
  lsplain: ['ls data | wc -l', '2000'],
  grep: ['grep -rl needle data | wc -l', '2000'],
  scan: ['find data -type f | wc -l', '2000'],
  append: ['printf x >> edit.txt', ''],
  copy100: ['rm -rf tmpdir; mkdir -p tmpdir; cp data/f1*.txt tmpdir/; ls tmpdir | wc -l', '100'],
  rmrf: ['rm -rf tmpdir', ''],
  shortrun: ['sleep 0.03', ''],
  build2s: ['sleep 2', ''],
}
const weights = {
  review: { read64k: 20, grep: 10, sedrange: 5, lsdir: 5, readsmall: 5 },
  code: { read64k: 10, append: 10, shortrun: 10, lsdir: 5 },
  organize: { scan: 1, copy100: 5, rmrf: 10, rtt: 10 },
}
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { n: values.length, p50: sorted[Math.ceil(sorted.length * .5) - 1],
    p95: sorted[Math.ceil(sorted.length * .95) - 1], samplesMs: values }
}
const report = {
  kind: '872-production-driver-scenario', startedAt: new Date().toISOString(),
  host: { cpu: os.cpus()[0].model, os: os.release(), node: process.version },
  fixture: { workspace, files: 2000, copyFiles: 100, readBytes: big.length, bigSha256: sha(path.join(workspace, 'big.txt')) },
  artifacts: { before: sha(before), after: sha(after), niu: sha(niu), harness: sha(process.argv[1]) },
  limitations: [
    'Adapted from attached scenario.mjs: production driver replaces the prototype; same commands and 106-op weights.',
    'Original fixture is absent from the evidence ZIP. This fixture explicitly fixes 2000 matching grep files, 100 copy files and a 65536-byte read.',
    'ls -la and ls are measured separately; their scenario totals are never mixed.',
    'Three samples per operation match the attachment; p95 is the maximum of three, not a high-confidence tail estimate.',
    'Scenario totals are sums of measured medians, not an end-to-end 106-operation trace.',
    'The attached build formula adds both 60000 ms and two 2-second sleeps; both that formula and the 60000-ms-only model are reported.',
    'Windows only, before then after; excludes full host orchestration, model work and real compilation.',
  ], weights, arms: {}, ok: false,
}
async function measure(binary) {
  const ctx = new Context(); ctx.logger.level = 0
  await ctx.plugin(Subprocess)
  const handle = ctx.get('subprocess').spawn({ argv: [binary], cwd: workspace, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 }, control: 'pipe' } })
  handle.done.catch(() => {})
  const wire = channel(handle.control)
  let sequence = 0
  const ask = async (op, extra = {}) => {
    await wire.send({ op, id: 'scenario', ...extra })
    const reply = await within(wire.next(), 30000, op)
    assert.equal(reply.ok, true, JSON.stringify(reply))
    return reply.result
  }
  const call = async command => {
    const started = performance.now()
    const value = await ask('call', { requestId: `s${++sequence}`, command, timeoutMs: 10000 })
    const ms = performance.now() - started
    assert.equal(value.error, null, JSON.stringify(value)); assert.equal(value.cleanupError, null)
    assert.equal(value.exitCode, 0); assert.equal(value.reset, false)
    for (const output of value.outputs) {
      assert.equal(output.ready, true); assert.equal(output.eof, true)
      assert.deepEqual(output.errors, []); assert.equal(output.truncated, false)
    }
    assert.equal(value.outputs[1].text, '')
    return { ms, text: value.outputs[0].text.trim() }
  }
  try {
    assert.equal((await within(wire.next(), 10000, 'ready')).type, 'ready')
    const endpoints = await ask('prepare')
    await ask('launch', { argv: [niu, ...residentShellBootstrap(endpoints)], cwd: workspace, env })
    for (let i = 0; i < 30; i++) await call(':')
    const ops = {}
    for (const [name, [command, expected]] of Object.entries(workloads)) {
      const samples = []
      for (let round = 0; round < 3; round++) {
        if (name === 'append') await call('rm -f edit.txt')
        if (name === 'copy100') await call('rm -rf tmpdir')
        const result = await call(command)
        assert.equal(result.text, expected, name)
        samples.push(result.ms)
      }
      ops[name] = stats(samples)
    }
    const scenario = plain => {
      const activity = Object.fromEntries(Object.entries(weights).map(([name, mix]) => [name,
        Object.entries(mix).reduce((total, [op, count]) => total + ops[plain && op === 'lsdir' ? 'lsplain' : op].p50 * count, 0)]))
      const toolLayerMs = Object.values(activity).reduce((a, b) => a + b, 0)
      return { totalOps: 106, activity, toolLayerMs, withTwo30sBuildsMs: toolLayerMs + 60000,
        attachedBuildFormulaMs: toolLayerMs + 60000 + ops.build2s.p50 * 2 }
    }
    await ask('stop')
    handle.control.end(); await within(handle.done, 10000, 'driver exit')
    return { ops, attachedLsLong: scenario(false), proseLsPlain: scenario(true) }
  } finally {
    handle.control.end()
    await ctx.fiber.dispose()
  }
}
try {
  report.arms.before = await measure(before)
  report.arms.after = await measure(after)
  report.ok = true
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
report.finishedAt = new Date().toISOString()
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
