/**
 * The batching lesson rides a tool result, never the user batch (#929).
 *
 * The step-tail channel appends UserMessages to an accepted user batch, which
 * the host logs as durable history: a lesson that arrives there reads as fresh
 * user input, and the model answers the lesson instead of the task, looping on
 * its own guidance. These checks pin the replacement contract: the user batch
 * carries no guidance at all, the first accepted root `run_code` result carries
 * the full lesson exactly once through the same-step ephemeral inbox
 * (`additionalContexts`), and nothing re-enters the user batch afterwards.
 */
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply } from '../lib/index.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, executeCall, selectExecutor } from './lib/executor.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

requireWorker('prompt-ephemeral-teaching')
let sequence = 0

const names = (ctx, agent) => ctx.get('tools').definitions(agent, agent.prepared?.toolSet).map(tool => tool.name).sort()

async function scoped(parent, key, parentKey) {
  let result
  await parent.plugin({ inject: ['tools'], apply: inner => {
    result = createScope(inner, key, parentKey ? { parent: parentKey } : undefined).ctx
  } })
  return result
}

/** The same merged-row fixture resident-switch uses, restricted to the ops-ptc row. */
async function setup(cwd) {
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'danger-full-access', workspaceRoot: cwd, sessionId: session?.id }) })
  const presets = new Map(), agents = []
  ctx.provide('agents', { list: () => [...agents] })
  ctx.provide('agentPresets', { composedPreset: inner => presets.get(scopeParentOf(scopeOf(inner))) })
  const config = { global: {}, discovery: { binaryPath: WORKER, required: true } }
  for (const id of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) config[id] = { enabled: id === 'ops-ptc',
    binaryPath: WORKER, required: true, ...(id === 'ops-ptc' ? { residentTools: true, dynamicTools: true, batchingGuidance: true, alwaysLoaded: ['stat'], allowedTools: ['stat'] } : {}) }
  await ctx.plugin({ name: 'prompt-ephemeral-teaching-fixture', apply: inner => apply(inner, config) })
  const id = 'ephemeral-' + ++sequence, preset = await scoped(ctx, { preset: id })
  presets.set(scopeOf(preset), 'ops-ptc')
  const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd }, append() {}, read() { return [] } } }
  agent.ctx = await scoped(preset, agent, scopeOf(preset))
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: inner => { selectExecutor(inner, 'ptc') } })
  agents.push(agent)
  await ctx.serial('agent/created', { agent })
  agent.prepared = await prepareStep(ctx, agent)
  return { ctx, agent }
}

/** Drive the real agent pre-step waterfall once, exactly as the host loop does. */
const drivePreStep = async (agent, turn) => {
  const accepted = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Start the task.' }] })
  return agent.ctx.waterfall('agent/pre-step', {
    agent, messages: [accepted], turn, step: 1, signal: new AbortController().signal,
    modelSelection: { provider: 'fixture', model: 'capture' },
  }, async () => ({ kind: 'enter', messages: [accepted] }))
}

/** The one-time full lesson the first accepted root result carries. */
const guidedContexts = result => (result.additionalContexts ?? []).filter(context => context.source?.kind === 'dsh-ops:step-tail' && context.source?.contributor === 'batching-guidance:lesson')

/** A compliant root program: plan line, two dispatches under Promise.all, no bypass. */
const compliantProgram = '// plan: two checks\nconst [a, b] = await Promise.all([tools.ops_stat({ path: "x" }), tools.ops_stat({ path: "y" })])\nreturn [a.status, b.status]'

const rootCall = (ctx, agent, callId) => executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name: 'run_code',
  arguments: { description: 'Compliant fixture', code: compliantProgram }, callId, signal: new AbortController().signal })

await test('the user batch carries no batching guidance, before or after the lesson', () => withTempDir('ephemeral-pre', async cwd => {
  const { ctx, agent } = await setup(cwd)
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName('stat')))
    const first = await drivePreStep(agent, 1)
    const before = first.messages.filter(message => message.source?.kind === 'dsh-ops:step-tail')
    assert.equal(before.length, 0, 'a user-role lesson reads as fresh user input and the model answers it (#929)')
    const run = await rootCall(ctx, agent, 'ephemeral-teach-1')
    assert.equal(run.isError, false, JSON.stringify(run))
    const after = (await drivePreStep(agent, 2)).messages.filter(message => message.source?.kind === 'dsh-ops:step-tail')
    assert.equal(after.length, 0, 'nothing re-enters the user batch once the lesson is delivered')
  } finally { await shutdown(ctx) }
}))

await test('the first accepted root run_code result carries the full lesson exactly once', () => withTempDir('ephemeral-once', async cwd => {
  const { ctx, agent } = await setup(cwd)
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName('stat')))
    const first = await rootCall(ctx, agent, 'ephemeral-teach-2')
    assert.equal(first.isError, false, JSON.stringify(first))
    const taught = guidedContexts(first)
    assert.equal(taught.length, 1, JSON.stringify(first.additionalContexts))
    assert.match(JSON.stringify(taught), /Batch tool calls/)
    assert.match(JSON.stringify(taught), /not a user instruction or authorization/)
    // The lesson states the mode the policy reports, so a full-access program is
    // never primed with an escalation request (#963).
    assert.match(JSON.stringify(taught), /current mode: danger-full-access/)
    assert.equal(JSON.stringify(taught).includes('current mode: read-only'), false)
    const second = await rootCall(ctx, agent, 'ephemeral-teach-3')
    assert.equal(second.isError, false, JSON.stringify(second))
    assert.equal(guidedContexts(second).length, 0, 'the lesson is spent after its one delivery')
  } finally { await shutdown(ctx) }
}))

report('prompt-ephemeral-teaching')
