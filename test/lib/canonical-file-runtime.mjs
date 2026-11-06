/** Real worker with official Native and Node PTC executors. */
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost } from './host.mjs'
import { selectExecutor, prepareStep } from './executor.mjs'
import { TEST_HOME } from './harness.mjs'
import { publicToolName } from '../../lib/policy.js'
import { NativeFileTools } from '../../lib/projections/native/runtime.js'
import { WORKER } from './boundary.mjs'

export async function canonicalFixture() {
  const { ctx, tools } = await bootHost()
  const steps = []
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: TEST_HOME }) })
  await ctx.plugin(NodePtc, {})
  const runtime = new NativeFileTools({ ctx, config: { workerPath: WORKER, required: true } })
  await runtime.start(['inspect_local_file', 'glob', 'result'])
  const definition = runtime.definition('inspect_local_file')
  async function agent(id, mode, parent) {
    const value = { id, session: { id, header: { cwd: TEST_HOME }, append() {}, read() { return [] } } }
    value.ctx = createScope(parent?.ctx ?? ctx, value, parent ? { parent } : undefined).ctx
    await value.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
    await ctx.serial('agent/created', { agent: value })
    return value
  }
  async function step(agent) { const value = await prepareStep(ctx, agent); steps.push(value); return value }
  return { ctx, tools, runtime, definition, agent, step,
    dispose: async () => { for (const step of steps) step.dispose(); await runtime.stop(); await ctx.fiber.dispose() } }
}
