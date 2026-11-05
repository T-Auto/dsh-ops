/** Host-mechanism fixture only: no OPS controller, worker, or filesystem effects. */
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost } from './host.mjs'
import { selectExecutor, prepareStep } from './executor.mjs'
import { TEST_HOME } from './harness.mjs'
import { publicToolName } from '../../lib/policy.js'
import { toOutcome } from '../../lib/projections/ptc/outcome.js'
import { outcomeSchema } from '../../lib/projections/ptc/schema.js'
import { definition as nativeDefinition } from '../../lib/projections/native/contract.js'

export async function canonicalFixture() {
  const { ctx, tools } = await bootHost()
  const steps = []
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: TEST_HOME }) })
  await ctx.plugin(NodePtc, {})
  let calls = 0
  const raw = { status: 'completed', complete: true,
    items: [{ path: 'fixture.txt', line: 1, text: 'canonical fixture' }] }
  const schema = outcomeSchema({ type: 'object', properties: {
    status: { type: 'string' }, complete: { type: 'boolean' },
    items: { type: 'array', items: { type: 'object', properties: {
      path: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' },
    }, required: ['path', 'line', 'text'], additionalProperties: false } },
  }, required: ['status', 'complete', 'items'], additionalProperties: false })
  const native = nativeDefinition('grep', async () => raw)
  const definition = { name: publicToolName('grep'), description: 'Canonical projection mechanism fixture.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema, render: (args, value) => native.output.render(args, value.data) },
    execute: async args => { calls++; return toOutcome('grep', args, raw) } }
  const source = await ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(definition) } })
  async function agent(id, mode, parent) {
    const value = { id, session: { id, header: { cwd: TEST_HOME }, append() {}, read() { return [] } } }
    value.ctx = createScope(parent?.ctx ?? ctx, value, parent ? { parent } : undefined).ctx
    await value.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
    await ctx.serial('agent/created', { agent: value })
    return value
  }
  async function step(agent) { const value = await prepareStep(ctx, agent); steps.push(value); return value }
  return { ctx, tools, source, definition, raw, schema, agent, step, calls: () => calls,
    dispose: async () => { for (const step of steps) step.dispose(); await ctx.fiber.dispose() } }
}
