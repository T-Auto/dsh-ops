import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import * as OfficialTools from '@deepseek-ai/dsh-tool-fs'
import * as OfficialSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as TimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import { REPO_ROOT } from '../lib/env.mjs'
// The shipped bundle mounts one `dsh-ops` row and retires the legacy per-component rows
// (`file`, `shell`, `ptc`). This harness mounts those rows directly, so it opts into the
// plugin's documented verification path; otherwise the candidate arm publishes no tools and
// every OPS call fails as `unknown tool "ops_<name>"`.
process.env.DSH_OPS_LEGACY_ROWS = process.env.DSH_OPS_LEGACY_ROWS ?? '1'
let identity = 0
const textOf = content => content.filter(block => block.type === 'text').map(block => block.text).join('\n')

/** Real AgentLoop, Session, tool dispatch and policy; only the model response is scripted. */
export async function boot({ root, worker, baselineSource, projection = 'candidate', alwaysLoaded = [], withShell = false, officialSearch = false, toolTimeout = false, pluginRoot = REPO_ROOT }) {
  // The plugin half is loaded from `pluginRoot`, not from this file's checkout: comparing two
  // versions means two builds, and one process can only hold both if each is imported by path.
  const fromPlugin = relative => import(pathToFileURL(join(pluginRoot, relative)).href)
  const shellFixture = withShell && process.env.DSH_OPS_TEST_BASH
    ? (await fromPlugin('lib/shells/pinned.js')).pinnedBashExecutable({ file: process.env.DSH_OPS_TEST_BASH })
    : undefined
  const ctx = new Context(); ctx.logger.level = 0
  const queues = new Map(), requests = [], results = [], events = [], errors = []
  for (const plugin of [Agents, Sessions, Projections, Prompt]) await ctx.plugin(plugin, {})
  await ctx.plugin(Tools, { mode: 'native' })
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: root })
  if (withShell) await ctx.plugin(Jobs, {})
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem, { cwd: root })
  // Both projections do their work in a child process (official: the packaged `rg`; candidate:
  // the native worker), so record each child's lifetime at the one seam they share. `durationMs`
  // is dispatch-to-result and includes it; `spawnMs` is the child alone.
  const spawns = []
  const seam = ctx.get('subprocess')
  const spawnOriginal = seam.spawn.bind(seam)
  seam.spawn = spec => {
    const record = { command: basename(String(spec?.argv?.[0] ?? '')), startedAt: Date.now(), endedAt: null }
    spawns.push(record)
    let handle
    try { handle = spawnOriginal(spec) } catch (error) { record.failed = String(error?.message ?? error); throw error }
    Promise.resolve(handle?.done).then(() => { record.endedAt = Date.now() }, () => { record.endedAt = Date.now() })
    return handle
  }
  await ctx.plugin(inner => {
    inner.provide('llm', { async prepareCall(config) { return { config, adapterDefaults: {}, stream: async function* (request) {
      assert.equal(request.purpose, undefined, 'auxiliary requests cannot spend a scripted ordinary round')
      const queue = queues.get(request.sessionId)
      assert.ok(queue?.length, 'unscripted provider request is forbidden')
      const script = queue.shift()
      const calls = typeof script === 'function' ? await script(request) : script
      requests.push({ sessionId: request.sessionId, tools: structuredClone(request.tools ?? []), messages: structuredClone(request.messages), toolCalls: calls.length })
      for (const [index, call] of calls.entries()) yield { type: 'tool-call-delta', index, id: call.id ?? 'bm-call-' + ++identity, name: call.name, argumentsDelta: JSON.stringify(call.args) }
      if (!calls.length) yield { type: 'text-delta', index: 0, text: 'Benchmark complete.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } } })
    inner.on('tools/execute', async (exec, next) => {
      // Timing is evidence only: it never decides a gate. `durationMs` is the dispatch-to-result
      // span, so a worker-spawning projection and an in-process one are measured at one boundary.
      const spawnStart = spawns.length
      const started = process.hrtime.bigint()
      const result = await next()
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6
      const children = spawns.slice(spawnStart).map(record => ({ command: record.command, ms: record.endedAt === null ? null : record.endedAt - record.startedAt }))
      results.push({ sessionId: exec.agent?.session.id, callId: exec.callId, name: exec.name, arguments: exec.arguments,
        durationMs, children, spawnMs: children.reduce((sum, child) => sum + (child.ms ?? 0), 0), result: structuredClone(result) })
      return result
    })
    inner.on('agent/error', ({ error }) => errors.push(String(error?.stack ?? error)))
    inner.on('session/event', (session, event) => {
      if (event.type === 'tool/result') events.push({ sessionId: session.id, event: structuredClone(event), text: textOf(event.data.message.content) })
    })
  })
  if (projection === 'official') {
    await ctx.plugin(OfficialTools, {})
    // `glob`/`grep` live in the sibling search package, not in `dsh-tool-fs`.
    // Every shipped bundle sets this to `false` (the deployment default we measure).
    if (officialSearch) await ctx.plugin(OfficialSearch, { sampleOverCapGlobResults: false })
  } else if (projection === 'baseline') {
    const { NativeFileTools } = await import(pathToFileURL(join(baselineSource, 'lib/file/runtime.js')).href)
    await ctx.plugin({ inject: ['tools'], async apply(inner) {
      const runtime = new NativeFileTools({ ctx: inner, config: { workerPath: worker, required: true, denyCredentialReads: true } })
      await runtime.start(); inner.effect(() => () => runtime.stop())
    } })
  } else {
    await ctx.plugin(await fromPlugin('lib/components/file/index.js'), { binaryPath: worker, required: true })
    if (withShell) await ctx.plugin(await fromPlugin('lib/components/shell/index.js'), shellFixture ? { bashPath: shellFixture } : {})
    await ctx.plugin(await fromPlugin('lib/components/discovery/index.js'), { binaryPath: worker, required: true, alwaysLoaded })
  }
  // The real bundles always mount this: a tool's declared `timeoutMs` becomes a cooperative
  // deadline on `exec.signal`. Mounted after our listener, so our span still contains the timeout.
  if (toolTimeout) await ctx.plugin({ inject: TimeoutPolicy.inject, apply: TimeoutPolicy.apply })
  await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 3 })
  async function agent(mode = 'workspace-write', parentAgent) {
    const { agent } = await ctx.get('agents').create({ sessionId: 'benchmark-' + ++identity, meta: { cwd: root }, parentAgent,
      agentOptions: { provider: 'fixture', model: 'scripted' } })
    setSandboxMode(agent.session, mode)
    return agent
  }
  async function run(agent, scripts) {
    assert.ok(scripts.length && scripts.at(-1).length === 0, 'scripts must end with a final response')
    const start = { requests: requests.length, results: results.length, events: events.length, errors: errors.length }
    queues.set(agent.session.id, [...scripts])
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Execute the deterministic benchmark task.' }] }))
    await agent.whenIdle()
    assert.deepEqual(errors.slice(start.errors), [])
    assert.equal(queues.get(agent.session.id).length, 0, 'every scripted provider response must be consumed')
    const calls = requests.slice(start.requests), committed = events.slice(start.events)
    return { providerRequests: calls.length, toolBearingRounds: calls.filter(value => value.toolCalls > 0).length,
      requests: calls, results: results.slice(start.results), committed, outputBytes: committed.reduce((sum, value) => sum + Buffer.byteLength(value.text), 0) }
  }
  return { ctx, agent, run, shellFixture, close: () => ctx.fiber.dispose() }
}
