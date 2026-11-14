/** Paired production-driver records: node record-driver.mjs BEFORE AFTER NIU REPORT. */
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
const [before, after, niu, reportPath] = process.argv.slice(2).map(value => path.resolve(value))
const hash = data => createHash('sha256').update(data).digest('hex')
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-872-record-')))
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-872-record-home-')))
const prepared = await prepareNiubash(niu, process.env.PATH ?? process.env.Path,
  AbortSignal.timeout(30000), { workspaceRoot: workspace, env: { ...process.env, DSH_HOME: home } })
const env = {}
for (const [key, value] of Object.entries({ ...scrubbedParentEnv(), ...prepared.env, HOME: workspace, USERPROFILE: workspace })) {
  for (const old of Object.keys(env)) if (old.toUpperCase() === key.toUpperCase()) delete env[old]
  env[key] = value
}
const cases = {
  empty: { command: ':', expected: '', samples: 300, warmup: 30 },
  printf: { command: "printf 'x'", expected: 'x', samples: 100, warmup: 10 },
  ascii4096: { command: `: '${'x'.repeat(4096)}'`, expected: '', samples: 30, warmup: 3 },
  ascii16384: { command: `: '${'x'.repeat(16384)}'`, expected: '', samples: 20, warmup: 3 },
}
const report = {
  kind: 'paired-shell-records', startedAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0].model, node: process.version },
  binaries: Object.fromEntries(Object.entries({ before, after, niu }).map(([name, file]) => [name, { file, sha256: hash(fs.readFileSync(file)) }])),
  workspace, cases: Object.fromEntries(Object.entries(cases).map(([name, item]) => [name, {
    inputBytes: Buffer.byteLength(item.command), commandSha256: hash(item.command), samples: item.samples, warmup: item.warmup,
  }])),
  limitations: [
    'Direct production driver and private control transport; excludes full host admission, model rendering and cold startup.',
    'ASCII payload cases isolate command-record processing; they are not the 106-operation scenario or file-operation acceptance.',
    'One shared workspace and runtime, alternating arm order, nearest-rank percentiles; no profiling instrumentation.',
  ], rows: [], summary: {}, ok: false,
}
const ctx = new Context(); ctx.logger.level = 0
await ctx.plugin(Subprocess)
const arms = {}
try {
  for (const [name, file] of Object.entries({ before, after })) {
    const handle = ctx.get('subprocess').spawn({ argv: [file], cwd: workspace, graceMs: 100,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 32768 }, control: 'pipe' } })
    handle.done.catch(() => {})
    const wire = channel(handle.control)
    const ask = async (op, extra = {}) => {
      await wire.send({ op, id: name, ...extra })
      const response = await within(wire.next(), 15000, `${name}:${op}`)
      assert.equal(response.ok, true, JSON.stringify(response))
      return response.result
    }
    arms[name] = { handle, ask }
    assert.equal((await within(wire.next(), 10000, `${name}:ready`)).type, 'ready')
    const endpoints = await ask('prepare')
    await ask('launch', { argv: [niu, ...residentShellBootstrap(endpoints)], cwd: workspace, env })
  }
  for (const [caseName, item] of Object.entries(cases)) {
    for (let pair = -item.warmup; pair < item.samples; pair++) {
      for (const arm of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        const started = performance.now()
        const result = await arms[arm].ask('call', { requestId: `${caseName}-${pair}`, command: item.command, timeoutMs: 10000 })
        const ms = performance.now() - started
        assert.equal(result.exitCode, 0, JSON.stringify(result))
        assert.equal(result.error, null); assert.equal(result.reset, false); assert.equal(result.cleanupError, null)
        assert.equal(result.outputs.length, 2)
        for (const stream of result.outputs) {
          assert.equal(stream.ready, true); assert.equal(stream.eof, true)
          assert.equal(stream.truncated, false); assert.deepEqual(stream.errors, [])
        }
        assert.equal(result.outputs[0].text, item.expected)
        assert.equal(result.outputs[0].observed, Buffer.byteLength(item.expected))
        assert.equal(result.outputs[1].text, ''); assert.equal(result.outputs[1].observed, 0)
        report.rows.push({ case: caseName, arm, pair, warmup: pair < 0, ms })
      }
    }
    const summary = {}
    for (const arm of ['before', 'after']) {
      const values = report.rows.filter(row => row.case === caseName && row.arm === arm && !row.warmup).map(row => row.ms).sort((a, b) => a - b)
      summary[arm] = { n: values.length, p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1] }
    }
    report.summary[caseName] = summary
    console.error(caseName, JSON.stringify(summary))
  }
  for (const { ask, handle } of Object.values(arms)) {
    await ask('stop'); handle.control.end(); await within(handle.done, 10000, 'driver exit')
  }
  report.ok = true
} catch (error) {
  report.error = String(error.stack ?? error)
  process.exitCode = 1
} finally {
  for (const { handle } of Object.values(arms)) handle.control.end()
  await ctx.fiber.dispose()
  report.finishedAt = new Date().toISOString()
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
}
assert.equal(report.ok, true, report.error)
