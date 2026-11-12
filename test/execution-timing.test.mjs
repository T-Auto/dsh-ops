import { ExecutionTiming } from '../lib/execution/timing.js'
import { bashToolDefinition } from '../lib/shells.js'
import { hostBashDefinition } from '../lib/shells/host-tool.js'
import { sampleExecution } from '../bench/probes/execution-timing.mjs'
import { assert, report, test } from './lib/harness.mjs'

await test('phase snapshots preserve fractional monotonic intervals and unknown events', () => {
  let now = 100
  const trace = new ExecutionTiming('tool-call', () => now)
  trace.begin('admission')
  now += 0.25
  trace.end('admission')
  trace.begin('queue')
  const first = trace.snapshot()
  now += 4
  trace.end('queue')
  trace.observeHostDone()
  const last = trace.snapshot()
  assert.equal(first.phases.admission.durationMs, 0.25)
  assert.equal(first.phases.queue.status, 'running')
  assert.equal(last.phases.queue.durationMs, 4)
  assert.equal(last.phases.prepare.durationMs, null)
  assert.equal(last.hostDoneMs, 4.25)
  assert.equal(last.unavailable.treeSettle, 'not-observed-without-changing-lifecycle')
  first.phases.admission.durationMs = 999
  assert.equal(trace.snapshot().phases.admission.durationMs, 0.25)
})

await test('executor diagnostics do not observe or wait for a process tree', async () => {
  let spawns = 0
  const definition = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: {
    spawn() {
      spawns++
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {},
        waitForExit() { throw new Error('instrumentation must not alter tree semantics') } }
    },
  } })
  const plain = await definition.execute({ command: 'true' })
  assert.equal(plain.diagnostics, undefined)
  const traced = await definition.execute({ command: 'true', includeDiagnostics: true })
  const timing = traced.diagnostics.timing
  assert.equal(timing.scope, 'executor')
  for (const phase of ['prepare', 'launch', 'hostWait', 'outputFinalize']) {
    assert.equal(timing.phases[phase].status, 'completed')
    assert.ok(timing.phases[phase].durationMs >= 0)
  }
  assert.equal(timing.phases.admission.status, 'not-observed')
  assert.equal(spawns, 2)
})

await test('host rejection carries optional admission timing without launching', async () => {
  const base = bashToolDefinition({ file: process.execPath, source: 'config' })
  const host = hostBashDefinition({ get() { return undefined } }, base,
    () => { throw new Error('must not launch') }, () => undefined)
  const traced = await host.execute({ command: 'true', description: 'Check rejected execution timing', includeDiagnostics: true })
  assert.equal(traced.kind, 'foreground')
  assert.equal(traced.executionTiming.scope, 'tool-call')
  assert.equal(traced.executionTiming.phases.policy.status, 'completed')
  assert.equal(traced.executionTiming.phases.launch.status, 'not-observed')
  const plain = await host.execute({ command: 'true', description: 'Check rejected execution timing' })
  assert.equal(plain.executionTiming, undefined)
})

await test('sampler retains warmup and failure rows without command output', async () => {
  let calls = 0
  const metadata = Object.fromEntries(['system', 'host', 'plugin', 'runtime', 'permission', 'projection', 'workload', 'storage', 'cache'].map(key => [key, 'fixture']))
  const result = await sampleExecution({ samples: 2, warmup: 1, metadata,
    invoke: async () => { if (++calls === 3) throw new Error('secret message'); return { output: 'not retained' } },
    validate: () => true })
  assert.equal(calls, 4)
  assert.equal(result.rows.length, 4)
  assert.equal(result.hot.failures, 1)
  assert.equal(result.hot.wallMs.count, 2)
  assert.equal(result.resources.childRss, null)
  assert.ok(!JSON.stringify(result).includes('secret message'))
  assert.ok(!JSON.stringify(result).includes('not retained'))
})

await test('preparation cancellation closes its timing without claiming launch', async () => {
  const pending = Promise.withResolvers()
  const definition = bashToolDefinition({ file: process.execPath, source: 'config',
    prepareArgv: () => pending.promise,
    subprocess: { spawn() { throw new Error('must not spawn') } },
  })
  const execution = definition.start({ command: 'true', includeDiagnostics: true }, {}, { onExpiry: 'none' })
  execution.kill('cancel preparation')
  const value = await execution.result()
  assert.equal(value.cancelled, true)
  assert.equal(value.diagnostics.timing.phases.prepare.status, 'completed')
  assert.equal(value.diagnostics.timing.phases.launch.status, 'not-observed')
  assert.equal(value.diagnostics.timing.hostDoneMs, null)
  pending.resolve([process.execPath])
})

await test('host and executor share one invocation trace through result projection', async () => {
  const base = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: {
    spawn() { return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {} } },
  } })
  const standing = { mode: 'danger-full-access' }
  const host = hostBashDefinition({ get(name) {
    if (name === 'sandboxPolicy') return { resolve: () => standing }
  } }, base, (args, exec, _standing, _policy, _env, options) => base.start(args, exec, options), () => undefined)
  const result = await host.execute({ command: 'true', description: 'Observe full invocation timing', includeDiagnostics: true },
    { agent: { id: 'timing-agent', session: { id: 'timing-session' } } })
  assert.equal(result.exitCode, 0)
  assert.equal(result.executionTiming.scope, 'tool-call')
  assert.equal(result.executionTiming.phases.resultReturn.status, 'completed')
  assert.equal(result.executionTiming.phases.prepare.status, 'completed')
  assert.equal(result.diagnostics.timing.phases.resultReturn.status, 'not-observed')
  assert.ok(result.executionTiming.wallMs >= result.diagnostics.timing.wallMs)
})

report('execution-timing')
