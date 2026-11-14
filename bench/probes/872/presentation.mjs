/** Public host presentation cost; no worker, model, or 106-operation scenario. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'

const root = path.resolve(process.argv[2])
const samples = Number(process.env.SAMPLES ?? 300), warmup = Number(process.env.WARMUP ?? 30)
assert.ok(Number.isInteger(samples) && samples > 0 && Number.isInteger(warmup) && warmup >= 0)
process.env.DSH_HOME = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-presentation-bench-')))
const load = file => import(pathToFileURL(path.join(root, file)).href)
const require = createRequire(path.join(root, 'package.json'))
const { createScope } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')).href)
const { mountPtc } = await load('lib/publication/ptc.js')
const { isPresentationProbe } = await load('lib/publication/presentation.js')
const { mountFakeResident } = await load('test/lib/resident.mjs')
const { bootHost, shutdown } = await load('test/lib/host.mjs')
const { selectExecutor, prepareStep } = await load('test/lib/executor.mjs')
const { ctx, tools, prompt } = await bootHost()
const raw = [], warm = []
const report = {
  kind: 'public-presentation-loader', startedAt: new Date().toISOString(),
  root, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
  host: { platform: process.platform, release: os.release(), cpu: os.cpus()[0].model, node: process.version },
  samples, warmup, callsPerStep: 10,
  boundary: 'Real public host prepareStep and admitted ops_load_sdk callbacks; publication-only resident rejects worker execution. Excludes run_code compilation, model, worker execution, shell, cold start, and the 106-operation scenario.',
}
try {
  await mountFakeResident(ctx, { file: process.execPath })
  ctx.provide('subprocess', { spawn() { throw new Error('benchmark must not spawn a worker') } })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.env.DSH_HOME }) })
  ctx.provide('ptcRuntime', { language: 'typescript' })
  await ctx.plugin({ apply(inner) { mountPtc(inner, { binaryPath: process.execPath, required: true, alwaysLoaded: ['result'] }, { allows: () => true }) } })
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
  const agent = { id: 'presentation-bench', session: { id: 'presentation-bench', header: { cwd: process.env.DSH_HOME } } }
  agent.ctx = createScope(ctx, agent).ctx
  await ctx.serial('agent/created', { agent })
  const executor = await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'ptc') } })
  let probes = 0, assemblies = 0
  const assemble = prompt.assemble.bind(prompt)
  prompt.assemble = context => { assemblies++; if (isPresentationProbe(context)) probes++; return assemble(context) }
  for (let i = -warmup; i < samples; i++) {
    const start = performance.now(), priorProbes = probes, priorAssemblies = assemblies
    const step = await prepareStep(ctx, agent)
    const prepared = performance.now()
    try {
      const definition = tools.executable('ops_load_sdk', agent, step.toolSet)
      assert.ok(definition)
      const exec = { agent, signal: new AbortController().signal, toolSet: step.toolSet }
      const callsMs = []
      for (let n = 0; n < 10; n++) {
        const began = performance.now()
        const result = await definition.execute({ tools: ['result'] }, exec)
        callsMs.push(performance.now() - began)
        assert.deepEqual(result, { status: 'completed', data: { status: 'completed', tools: ['result'], nextTurn: true } })
      }
      const row = { prepareMs: prepared - start, totalMs: performance.now() - start, callsMs,
        probes: probes - priorProbes, assemblies: assemblies - priorAssemblies }
      ;(i < 0 ? warm : raw).push(row)
    } finally { step.dispose() }
  }
  // Retained callbacks must refuse a same-step presentation switch in both arms.
  const step = await prepareStep(ctx, agent)
  try {
    const definition = tools.executable('ops_load_sdk', agent, step.toolSet)
    await executor.dispose()
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'native') } })
    const refusal = await definition.execute({ tools: ['result'] }, { agent, signal: new AbortController().signal, toolSet: step.toolSet })
    assert.equal(refusal.error.code, 'POLICY_DENIED')
    report.changedExecutorRefused = true
  } finally { step.dispose() }
} finally { await shutdown(ctx) }
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = p => sorted[Math.ceil(sorted.length * p) - 1]
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted.at(-1) }
}
report.summary = { prepareMs: stats(raw.map(row => row.prepareMs)), totalMs: stats(raw.map(row => row.totalMs)),
  callMs: stats(raw.flatMap(row => row.callsMs)), probes: [...new Set(raw.map(row => row.probes))],
  assemblies: [...new Set(raw.map(row => row.assemblies))] }
report.warmupRows = warm
report.rows = raw
report.finishedAt = new Date().toISOString()
console.log(JSON.stringify(report, null, 2))
