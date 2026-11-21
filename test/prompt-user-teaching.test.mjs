/**
 * The batching lesson and the corrective notices ride the pre-step batch as plain
 * user text.
 *
 * The lesson is one user-role message on the first accepted batch, before the
 * model's first request; a violation queues one short notice that the next
 * pre-step appends the same way. Neither carries a plugin envelope or a
 * tool-result context, so the model reads them exactly as the user's own
 * instructions.
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

requireWorker('prompt-user-teaching')
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
async function setup(cwd, { batchingGuidance = true } = {}) {
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'danger-full-access', workspaceRoot: cwd, sessionId: session?.id }) })
  const presets = new Map(), agents = []
  ctx.provide('agents', { list: () => [...agents] })
  ctx.provide('agentPresets', { composedPreset: inner => presets.get(scopeParentOf(scopeOf(inner))) })
  const config = { global: {}, discovery: { binaryPath: WORKER, required: true } }
  for (const id of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) config[id] = { enabled: id === 'ops-ptc',
    binaryPath: WORKER, required: true, ...(id === 'ops-ptc' ? { residentTools: true, dynamicTools: true, batchingGuidance, alwaysLoaded: ['stat'], allowedTools: ['stat'] } : {}) }
  await ctx.plugin({ name: 'prompt-user-teaching-fixture', apply: inner => apply(inner, config) })
  const id = 'user-teaching-' + ++sequence, preset = await scoped(ctx, { preset: id })
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
  const decision = await agent.ctx.waterfall('agent/pre-step', {
    agent, messages: [accepted], turn, step: 1, signal: new AbortController().signal,
    modelSelection: { provider: 'fixture', model: 'capture' },
  }, async () => ({ kind: 'enter', messages: [accepted] }))
  return { accepted, decision }
}
/** Guidance appended to the accepted batch as plain user text; never the accepted message itself. */
const guidanceOf = ({ accepted, decision }) => decision.messages.filter(message => message.id !== accepted.id && message.source?.kind === 'user')
const textsOf = messages => messages.map(message => message.content.map(part => part.text ?? '').join('')).join('\n')

/** A compliant root program: plan line, two dispatches under Promise.all, no bypass. */
const compliantProgram = '// plan: two checks\nconst [a, b] = await Promise.all([tools.ops_stat({ path: "x" }), tools.ops_stat({ path: "y" })])\nreturn [a.status, b.status]'
const thinProgram = 'const r = await tools.ops_stat({ path: "x" })\nreturn r.status'
const rootCall = (ctx, agent, callId, code = compliantProgram) => executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name: 'run_code',
  arguments: { description: 'Fixture program', code }, callId, signal: new AbortController().signal })

await test('the opening lesson rides the first accepted pre-step as plain user text', () => withTempDir('user-teach-open', async cwd => {
  const { ctx, agent } = await setup(cwd)
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName('stat')))
    const first = await drivePreStep(agent, 1)
    const taught = guidanceOf(first)
    assert.equal(taught.length, 1, JSON.stringify(first.decision.messages))
    assert.equal(taught[0].source.kind, 'user', 'the guidance carries the user source, not a plugin context')
    const text = textsOf(taught)
    assert.match(text, /^# Batch tool calls/, 'the lesson opens the message, with no envelope')
    assert.equal(text.includes('not a user instruction'), false, 'no plugin self-narration')
    // The lesson states the mode the policy reports, so a full-access program is
    // never primed with an escalation request (#963).
    assert.match(text, /current mode: danger-full-access/)
    assert.equal(text.includes('current mode: read-only'), false)
    // It follows the user's own message in the same accepted batch.
    assert.equal(first.decision.messages.at(-1).id, taught[0].id)
  } finally { await shutdown(ctx) }
}))

await test('the lesson is spent only after its durable commit, and a thin program queues one notice', () => withTempDir('user-teach-once', async cwd => {
  const { ctx, agent } = await setup(cwd)
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName('stat')))
    assert.equal(guidanceOf(await drivePreStep(agent, 1)).length, 1)
    // No commit yet: the next pre-step teaches again instead of going silent.
    const second = await drivePreStep(agent, 2)
    assert.equal(guidanceOf(second).length, 1, 'an uncommitted delivery re-teaches')
    // Commit the delivered message exactly as the host does, then the lesson is spent.
    for (const message of guidanceOf(second)) ctx.emit('session/event', agent.session, { type: 'user/message', data: message })
    assert.equal(guidanceOf(await drivePreStep(agent, 3)).length, 0, 'the durable commit spends the lesson')
    // A thin program earns one notice on the next pre-step; the tool result stays clean.
    const run = await rootCall(ctx, agent, 'user-teach-thin', thinProgram)
    assert.equal(run.isError, false, JSON.stringify(run))
    assert.equal((run.additionalContexts ?? []).length, 0, 'guidance never rides the tool result')
    const notice = guidanceOf(await drivePreStep(agent, 3))
    assert.equal(notice.length, 1, JSON.stringify(notice))
    assert.match(textsOf(notice), /did not open with a plan line/)
    // A compliant program earns nothing.
    const good = await rootCall(ctx, agent, 'user-teach-good')
    assert.equal(good.isError, false, JSON.stringify(good))
    assert.equal(guidanceOf(await drivePreStep(agent, 3)).length, 0)
  } finally { await shutdown(ctx) }
}))

await test('a disabled switch delivers no lesson and no notice', () => withTempDir('user-teach-off', async cwd => {
  const { ctx, agent } = await setup(cwd, { batchingGuidance: false })
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName('stat')))
    assert.equal(guidanceOf(await drivePreStep(agent, 1)).length, 0)
    await rootCall(ctx, agent, 'user-teach-off-thin', thinProgram)
    assert.equal(guidanceOf(await drivePreStep(agent, 1)).length, 0)
  } finally { await shutdown(ctx) }
}))

report('prompt-user-teaching')
