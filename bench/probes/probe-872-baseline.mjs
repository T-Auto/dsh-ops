/**
 * Current complete-call baseline for #872; no model requests or improvement claim.
 * Build JS and the worker first. Supply --bash for a complete Windows payload;
 * use an explicit short TMP/TEMP directory if the host's sandbox temp path is too long.
 * --samples 2 --warmup 1 is a smoke check; the default records 200 hot calls/item.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { loadArms } from '../calls/arms.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const flags = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1]
  if (!['--samples', '--warmup', '--output', '--worker', '--bash', '--sandbox-mode'].includes(key) || !value || flags.has(key)) {
    throw Error('Usage: node bench/probes/probe-872-baseline.mjs [--samples 200] [--warmup 5] [--output report.json] [--worker absolute-path] [--bash absolute-path] [--sandbox-mode danger-full-access|workspace-write|read-only]')
  }
  flags.set(key, value)
}
const count = (flag, fallback, minimum) => {
  const value = Number(flags.get(flag) ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum) throw Error(`${flag} must be an integer >= ${minimum}`)
  return value
}
const samples = count('--samples', 200, 1), warmup = count('--warmup', 5, 0)
const mode = flags.get('--sandbox-mode') ?? 'danger-full-access'
assert.ok(['danger-full-access', 'workspace-write', 'read-only'].includes(mode), 'invalid sandbox mode')
const worker = path.resolve(flags.get('--worker') ?? process.env.DSH_OPS_WORKER_BIN
  ?? path.join(root, 'runtime', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker'))
const output = path.resolve(flags.get('--output') ?? path.join(root, 'bench/runs', `probe-872-baseline-${Date.now()}.json`))
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-872-')))
process.env.DSH_HOME = path.join(directory, 'dsh-home')
fs.mkdirSync(process.env.DSH_HOME)
const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace)
const payload = 'probe-872-file-payload'
fs.writeFileSync(path.join(workspace, 'note.txt'), payload + '\n')
const hash = value => createHash('sha256').update(value).digest('hex')
const command = (file, argv) => execFileSync(file, argv, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim()
const report = {
  issue: 872, kind: 'current-baseline', startedAt: new Date().toISOString(), samplesPerItem: samples, warmupPerItem: warmup,
  meetsHotSampleMinimum: samples >= 200, percentileMethod: 'nearest rank',
  measurement: 'prepareStep (admission and prompt/SDK assembly) through tools.execute, canonical validation and model-facing rendering',
  composition: 'Real Cordis, Agents/Sessions/Loop, policy, subprocess/sandbox, jobs, Native/Node PTC executors; NativeFileTools and mountSessionBash. A probe-owned jobs controller admits foreground jobs; no Desktop, model or UI service.',
  limitations: [
    'No comparison arm and no resident kernel; this report cannot establish an improvement.',
    'Cold means the first call for each item after host setup, in listed order; shared services may already be warm. It is not OS-cache-cold or full application startup.',
    'CPU/RSS/OS handle counts describe this Node host only; child CPU, child peak RSS and whole process-tree handle counts are not measured.',
    'The probe retains sample records and completed Session events; host memory includes that instrumentation.',
    'Subprocess counts and unsettled handles cover calls through the public host spawn seam; they do not count internal provider descendants or prove process-tree quiescence.',
    'Timings include failures; successful-only percentiles are also supplied. No failed sample is retried or removed.',
  ],
  environment: { platform: process.platform, arch: process.arch, node: process.version, osRelease: os.release(), cpu: os.cpus()[0]?.model,
    sandboxMode: mode, workspace, dshHome: process.env.DSH_HOME, childResources: null },
  calls: [],
}
const cpuMs = usage => ({ user: usage.user / 1000, system: usage.system / 1000 })
function resources() {
  const result = { rssBytes: process.memoryUsage().rss, cpuMs: cpuMs(process.cpuUsage()),
    peakRssBytes: process.resourceUsage().maxRSS * 1024, osHandles: null }
  try {
    if (process.platform === 'win32') {
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
      result.osHandles = { kind: 'Windows process Handles', count: Number(command(powershell,
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).Handles`])) }
    } else if (process.platform === 'linux') result.osHandles = { kind: 'Linux /proc/self/fd entries', count: fs.readdirSync('/proc/self/fd').length }
    else result.osHandlesUnavailable = 'No portable process handle counter is available.'
  } catch (error) { result.osHandlesUnavailable = String(error.message) }
  return result
}
const percentiles = values => {
  const ordered = [...values].sort((a, b) => a - b)
  return Object.fromEntries([50, 95, 99].map(p => [`p${p}`, ordered.length ? ordered[Math.ceil(p / 100 * ordered.length) - 1] : null]))
}
let ctx, runtime
const handles = [], active = new Set()
try {
  const [arm] = await loadArms([{ id: 'current', projection: 'candidate', pluginRoot: root, worker }])
  report.build = { ...arm.evidence, revision: command('git', ['rev-parse', 'HEAD']),
    trackedChanges: command('git', ['status', '--short', '--untracked-files=no']),
    sourceDiffSha256: hash(command('git', ['diff', 'HEAD', '--', 'src', 'native'])),
    lockSha256: hash(fs.readFileSync(path.join(root, 'package-lock.json'))) }
  const packages = ['dsh-subprocess-local', 'dsh-sandbox-local', 'dsh-tool-executor-native', 'dsh-tool-executor-ptc', 'dsh-ptc-runtime-node', 'dsh-jobs-local']
  report.build.hostPackages = Object.fromEntries(packages.map(name => [name,
    JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version]))
  const [{ bootHost, shutdown }, { selectExecutor, executeCall }, { NativeFileTools }, { mountSessionBash }, { resolveShells }, { publicToolName },
    { default: Agents }, { default: Sessions }, { default: Projections }, { default: Loop }, { default: Subprocess },
    { default: Sandbox }, { default: FileSystem }, { default: NodePtc }, { default: Jobs }, { default: Policy, setSandboxMode }] = await Promise.all([
    import('../../test/lib/host.mjs'), import('../../test/lib/executor.mjs'), import('../../lib/projections/native/runtime.js'),
    import('../../lib/session-shells.js'), import('../../lib/shells.js'), import('../../lib/policy.js'),
    import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'),
    import('@deepseek-ai/dsh-agent-loop'), import('@deepseek-ai/dsh-subprocess-local'), import('@deepseek-ai/dsh-sandbox-local'),
    import('@deepseek-ai/dsh-fs-local'), import('@deepseek-ai/dsh-ptc-runtime-node'), import('@deepseek-ai/dsh-jobs-local'), import('@deepseek-ai/dsh-sandbox-policy'),
  ])
  const bashPath = flags.get('--bash') ?? process.env.DSH_OPS_TEST_BASH
  const bash = resolveShells(bashPath ? { bashPath: path.resolve(bashPath) } : {}).bash
  if (!bash.available) throw Error(`Bash unavailable; supply --bash: ${bash.detail}`)
  report.build.bash = { path: bash.file, sha256: hash(fs.readFileSync(bash.file)) }
  const setupStarted = performance.now()
  ;({ ctx } = await bootHost())
  for (const plugin of [Agents, Sessions, Projections, Subprocess, Sandbox, FileSystem, NodePtc, Jobs]) await ctx.plugin(plugin, {})
  await ctx.plugin(Policy, { mode, workspaceRoot: workspace })
  ctx.provide('llm', { prepareCall() { throw Error('The baseline must never call a model.') } })
  ctx.get('jobs').attachController('probe-872-foreground-controller')
  const subprocess = ctx.get('subprocess'), spawn = subprocess.spawn.bind(subprocess)
  subprocess.spawn = spec => {
    const record = { argv0: spec.argv[0], startedAtMs: performance.now(), elapsedMs: null }
    handles.push(record); active.add(record)
    try {
      const handle = spawn(spec)
      Promise.resolve(handle.done).then(outcome => { record.exitCode = outcome.exitCode; record.signal = outcome.signal },
        error => { record.error = String(error) }).finally(() => { record.elapsedMs = performance.now() - record.startedAtMs; active.delete(record) })
      return handle
    } catch (error) { record.error = String(error); active.delete(record); throw error }
  }
  runtime = new NativeFileTools({ ctx, config: { workerPath: worker, required: true } })
  await runtime.start(['inspect_local_file'])
  await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { mountSessionBash(inner, { publishBashTool: true }, { bash }) } })
  await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 })
  const agents = {}
  for (const presentation of ['native', 'ptc']) {
    const owned = await ctx.get('agents').create({ sessionId: `probe-872-${presentation}`, meta: { cwd: workspace },
      agentOptions: { provider: 'forbidden', model: 'no-model' }, setup: async agentCtx => {
        await agentCtx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, presentation) } })
      } })
    agents[presentation] = owned.agent; setSandboxMode(owned.agent.session, mode)
  }
  const fileName = publicToolName('inspect_local_file'), shellName = publicToolName('bash')
  for (const agent of Object.values(agents)) {
    for (const name of [fileName, shellName]) {
      const deadline = Date.now() + 10_000
      while (!ctx.tools.get(name, agent)) {
        if (Date.now() > deadline) throw Error(`Tool not published: ${name}`)
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
  }
  report.hostSetupMs = performance.now() - setupStarted
  const items = ['native', 'ptc'].flatMap(presentation => ['file', 'fresh-command'].map(operation => ({
    id: `${presentation}/${operation}`, presentation, operation,
    tool: operation === 'file' ? fileName : shellName,
    args: operation === 'file' ? { path: 'note.txt' } : { command: "printf 'probe-872-command-ok\\n'", description: 'Print the baseline command receipt' },
  })))
  report.items = items
  async function measure(item, phase, round) {
    const before = handles.length, cpu = process.cpuUsage(), started = performance.now()
    const sample = { item: item.id, phase, round, ok: false }
    let result
    try {
      const call = { agent: agents[item.presentation], callId: `probe-${report.calls.length}`, signal: AbortSignal.timeout(60_000) }
      result = await executeCall(ctx, item.presentation === 'native'
        ? { ...call, name: item.tool, arguments: item.args }
        : { ...call, name: 'run_code', arguments: { description: 'Run one complete baseline operation', code: `return await tools.${item.tool}(${JSON.stringify(item.args)});` } })
      sample.elapsedMs = performance.now() - started
      sample.hostCpuMs = cpuMs(process.cpuUsage(cpu))
      const value = item.presentation === 'native' ? result.value : result.value?.result
      sample.status = value?.status ?? null
      sample.outputBytes = Buffer.byteLength(JSON.stringify(result.content ?? []))
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.equal(value?.status, 'completed', JSON.stringify(value))
      if (item.operation === 'file') assert.equal(value.data.items[0].text, payload)
      else { assert.equal(value.exitCode, 0); assert.equal(value.stdout.text.trim(), 'probe-872-command-ok') }
      sample.ok = true
    } catch (error) {
      sample.elapsedMs ??= performance.now() - started; sample.hostCpuMs ??= cpuMs(process.cpuUsage(cpu))
      sample.error = String(error.stack ?? error); sample.failureResult = result ?? null
    }
    sample.hostRssBytes = process.memoryUsage().rss
    sample.spawns = handles.slice(before).map(({ startedAtMs, ...record }) => ({ ...record }))
    sample.unsettledTopLevelHandles = active.size
    report.calls.push(sample)
  }
  report.resourcesBeforeCalls = resources()
  for (const item of items) await measure(item, 'cold', 0)
  for (const [phase, rounds] of [['warmup', warmup], ['hot', samples]]) {
    for (let round = 0; round < rounds; round++) {
      // Rotate the first item every round; every operation has exactly one sample per round.
      for (let index = 0; index < items.length; index++) await measure(items[(round + index) % items.length], phase, round)
      if (phase === 'hot' && (round + 1) % 25 === 0) console.error(`probe-872: ${round + 1}/${samples} rounds; ${report.calls.filter(call => !call.ok).length} failures retained`)
    }
  }
  report.resourcesAfterCalls = resources()
  report.summary = items.map(item => {
    const hot = report.calls.filter(call => call.item === item.id && call.phase === 'hot')
    return { item: item.id, count: hot.length, failures: hot.filter(call => !call.ok).length,
      allLatencyMs: percentiles(hot.map(call => call.elapsedMs)), successfulLatencyMs: percentiles(hot.filter(call => call.ok).map(call => call.elapsedMs)),
      hostUserCpuMs: hot.reduce((total, call) => total + call.hostCpuMs.user, 0),
      hostSystemCpuMs: hot.reduce((total, call) => total + call.hostCpuMs.system, 0),
      maxSampledHostRssBytes: Math.max(...hot.map(call => call.hostRssBytes)), spawnCalls: hot.reduce((total, call) => total + call.spawns.length, 0) }
  })
  await runtime.stop(); runtime = undefined
  await shutdown(ctx); ctx = undefined
  report.resourcesAfterTeardown = resources()
  report.unsettledTopLevelHandlesAfterTeardown = active.size
  report.failureCount = report.calls.filter(call => !call.ok).length
  if (report.failureCount || active.size) process.exitCode = 1
} catch (error) {
  report.fatalError = String(error.stack ?? error); process.exitCode = 1
} finally {
  try { await runtime?.stop(); await ctx?.fiber.dispose() } catch (error) { report.teardownError = String(error); process.exitCode = 1 }
  report.finishedAt = new Date().toISOString()
  try { fs.rmSync(directory, { recursive: true, force: true }) } catch (error) { report.cleanupError = String(error); process.exitCode = 1 }
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ output, summary: report.summary, failureCount: report.failureCount, fatalError: report.fatalError }))
}
