/** Actual AgentLoop and Session with a scripted provider; no network model requests. */
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Loop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import * as file from '../../lib/components/file/index.js'
import * as discovery from '../../lib/components/discovery/index.js'
import * as ptc from '../../lib/components/ptc/index.js'
import { assert } from './harness.mjs'
import { WORKER } from './boundary.mjs'
import { legacyComponent } from './legacy-component.mjs'
import { workingDirectoryOver } from './host.mjs'
let identity = 0
export async function bootLoop(root, { ptcMode = false, discoveryConfig = {} } = {}) {
  const ctx = new Context(); ctx.logger.level = 0
  // rc.5 asks the host for the directory a run_code call executes in.
  ctx.provide('workingDirectory', workingDirectoryOver(root))
  const queues = new Map(), requests = [], results = [], errors = []
  for (const plugin of [Agents, Sessions, Projections, Prompt]) await ctx.plugin(plugin, {})
  await ctx.plugin(Tools, { mode: ptcMode ? 'ptc' : 'native' })
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem, { cwd: root })
  if (ptcMode) await ctx.plugin(NodePtc, {})
  await ctx.plugin(inner => {
    inner.provide('llm', { async prepareCall(config) { return { config, adapterDefaults: {}, stream: async function* (request) {
      assert.equal(request.purpose, undefined)
      const queue = queues.get(request.sessionId)
      assert.ok(queue?.length, 'unscripted provider request is forbidden')
      const script = queue.shift(), calls = typeof script === 'function' ? await script(request) : script
      requests.push({ sessionId: request.sessionId, tools: request.tools, messages: request.messages, toolCalls: calls.length })
      for (const [index, call] of calls.entries()) yield { type: 'tool-call-delta', index, id: 'loop-call-' + ++identity, name: call.name, argumentsDelta: JSON.stringify(call.args) }
      if (!calls.length) yield { type: 'text-delta', index: 0, text: 'Fixture complete.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } } })
    inner.on('tools/execute', async (exec, next) => { const result = await next(); results.push({ exec, result }); return result })
    inner.on('agent/error', ({ error }) => errors.push(String(error?.stack ?? error)))
  })
  await ctx.plugin(legacyComponent(file), { binaryPath: WORKER, required: true })
  await ctx.plugin(legacyComponent(discovery), { binaryPath: WORKER, required: true, ...discoveryConfig })
  const ptcFiber = ptcMode ? await ctx.plugin(legacyComponent(ptc), { binaryPath: WORKER, required: true }) : undefined
  await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 3 })
  async function agent(parentAgent) {
    const { agent } = await ctx.get('agents').create({ sessionId: 'real-loop-' + ++identity, meta: { cwd: root }, parentAgent,
      agentOptions: { provider: 'fixture', model: 'scripted' } })
    // Exercise a real committed mode event immediately before the first assembly.
    setSandboxMode(agent.session, 'workspace-write')
    return agent
  }
  async function run(agent, scripts) {
    const start = { requests: requests.length, results: results.length, errors: errors.length }
    queues.set(agent.session.id, [...scripts])
    // rc.5 requires every message to carry its producer's source.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the deterministic fixture.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    assert.deepEqual(errors.slice(start.errors), [])
    assert.equal(queues.get(agent.session.id).length, 0)
    return { requests: requests.slice(start.requests), results: results.slice(start.results) }
  }
  return { ctx, agent, run, ptcFiber, close: () => ctx.fiber.dispose() }
}
