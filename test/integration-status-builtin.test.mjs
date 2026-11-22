/**
 * Built-in preset sessions publish their own scope diagnosis (#753).
 *
 * The status tool used to exist only behind an external preset row: a built-in
 * mode row mounted its consumer and nothing else, so a session the host ran on
 * a built-in preset had no named answer about its own publication at all,
 * although the diagnosis itself already understood mode sessions. Pinned here:
 * the built-in mode loop mounts the diagnosis gate that admits exactly this
 * mode's sessions, the tool is visible and executable there, the diagnosis
 * recognises the mode as selected, and another built-in mode is not admitted.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { executeCall, prepareStep } from './lib/executor.mjs'
import { mountModeDiagnostics } from '../lib/integration/index.js'
import { applyResolvedMode } from '../lib/presets/builtin.js'
import { resolveModeConfig } from '../lib/presets/config.js'

const dispatch = async (ctx, request) => {
  const step = await prepareStep(ctx, request.agent)
  try { return await executeCall(ctx, { ...request, toolSet: step.toolSet }) }
  finally { step.dispose() }
}

/** The exact composition the built-in loop in src/index.ts runs for one mode. */
async function mountBuiltinMode(ctx, mode) {
  await ctx.plugin({ async apply(inner) {
    applyResolvedMode(inner, resolveModeConfig({}, mode), mode)
    await mountModeDiagnostics(inner, mode)
  } })
}

await test('a built-in preset session sees and executes its own status tool', () => withTempDir('status-builtin', async cwd => {
  const { ctx } = await bootHost()
  try {
    await mountBuiltinMode(ctx, 'minimal')
    const agent = { id: 'builtin', session: { id: 'builtin', mode: 'read-only', header: { cwd, agentPreset: 'minimal' } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await ctx.serial('agent/created', { agent })
    assert.notEqual(ctx.get('tools').get('ops_status', agent), undefined, 'the built-in row publishes the status tool to this agent')
    const result = await dispatch(ctx, { agent, name: 'ops_status', arguments: {}, callId: 'builtin', signal: new AbortController().signal })
    assert.equal(result.isError, false, 'the status tool answers, it does not refuse')
    assert.equal(result.value.state, 'ready', 'the diagnosis recognises the built-in mode as selected and sound')
    assert.equal(result.value.preset, 'minimal', 'the built-in preset identity is reported, not an external row')
  } finally { await shutdown(ctx) }
}))

await test('a session of another built-in mode is not admitted by this gate', () => withTempDir('status-other-mode', async cwd => {
  const { ctx } = await bootHost()
  try {
    await mountBuiltinMode(ctx, 'minimal')
    const agent = { id: 'other', session: { id: 'other', mode: 'read-only', header: { cwd, agentPreset: 'standard' } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await ctx.serial('agent/created', { agent })
    assert.equal(scopedToolNames(ctx, agent).includes('ops_status'), false, 'another mode\'s session gets no status tool from this row')
  } finally { await shutdown(ctx) }
}))

await test('the mode row alone admits a plain built-in session and keeps answering it', () => withTempDir('status-repeat', async cwd => {
  const { ctx } = await bootHost()
  try {
    await mountBuiltinMode(ctx, 'minimal')
    const agent = { id: 'again', session: { id: 'again', mode: 'read-only', header: { cwd, agentPreset: 'minimal' } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await ctx.serial('agent/created', { agent })
    assert.notEqual(ctx.get('tools').get('ops_status', agent), undefined, 'the mode row owns the plain built-in session')
    const answer = await dispatch(ctx, { agent, name: 'ops_status', arguments: {}, callId: 'again', signal: new AbortController().signal })
    assert.equal(answer.isError, false)
  } finally { await shutdown(ctx) }
}))

report('integration-status-builtin')
