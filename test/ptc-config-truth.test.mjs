/** The D1 truth table: five legacy config inputs and their first-round OPS names.
 *
 * This suite locks current publication behaviour, letter by letter, for the five
 * inputs the OPS-PTC two-tier contract (#979/#985) must stay compatible with:
 * defaults, global dynamicTools:false, row dynamicTools:false, that row plus
 * alwaysLoaded:[stat], and residentTools:false. Every row asserts the exact
 * first-round ops_* set, so reinterpreting one input as another tier's
 * semantics cannot pass silently. The table itself lives in
 * docs/design-decisions-20261119.md (中文：docs/设计决策-20261119.md).
 */
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { apply } from '../lib/index.js'
import { resolveMergedConfig, effectiveMode, dynamicForMode } from '../lib/settings/merged.js'
import { resolveModeConfig } from '../lib/modes/config.js'
import { PTC_LOADABLE_TOOLS, PTC_RESIDENT_TOOLS, parsePtcConfig } from '../lib/ptc/config.js'
import { requestedApis } from '../lib/projections/ptc/loader.js'
import { integration, diagnose } from '../lib/integration/index.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, executeCall, selectExecutor } from './lib/executor.mjs'
import { assert, test, report, wait, waitFor, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

/** The truth table's right-hand columns, as this suite locks them. */
const ROW_DEFAULT = ['ops_inspect_local_file', 'ops_load_sdk']
const ROW_GLOBAL_OFF = ['ops_inspect_local_file']
const ROW_ROW_OFF = ['ops_inspect_local_file']
const ROW_ROW_OFF_ALWAYS = ['ops_inspect_local_file', 'ops_stat']
const ROW_RESIDENT_OFF = ['ops_load_sdk']

await test('resolver: the five legacy inputs land where the truth table claims', () => {
  const base = resolveMergedConfig()
  assert.equal(base['ops-ptc'].enabled, true)
  assert.equal(base['ops-ptc'].config.dynamicTools, true)
  assert.equal(base['ops-ptc'].config.residentTools, true)
  assert.deepEqual(base['ops-ptc'].config.allowedTools, PTC_LOADABLE_TOOLS)
  assert.deepEqual(base['ops-ptc'].config.alwaysLoaded, [])
  // Row 2: the global switch gates every mode and preserves saved intent.
  const global = resolveMergedConfig({ global: { dynamicTools: false } })
  assert.equal(global.global.dynamicTools, false)
  for (const mode of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) {
    assert.equal(dynamicForMode(global[mode], global.global), false, mode)
    assert.equal(effectiveMode(global[mode], global.global).dynamicTools, false, mode)
  }
  assert.equal('dynamicTools' in (global['ops-ptc'].raw ?? {}), false, 'an absent row key still means on')
  // Row 3: a row-level off gates that row only.
  const row = resolveMergedConfig({ 'ops-ptc': { dynamicTools: false } })
  assert.equal(effectiveMode(row['ops-ptc'], row.global).dynamicTools, false)
  assert.equal(dynamicForMode(row['ops-ptc'], row.global), false)
  assert.equal(dynamicForMode(row.standard, row.global), true, 'row-level off leaves other rows on')
  // Row 4: alwaysLoaded rides the resident set while the loader is off.
  const always = resolveMergedConfig({ 'ops-ptc': { dynamicTools: false, alwaysLoaded: ['stat'] } })
  assert.deepEqual(always['ops-ptc'].config.alwaysLoaded, ['stat'])
  assert.deepEqual(always['ops-ptc'].config.allowedTools, PTC_LOADABLE_TOOLS, 'the cap is untouched')
  assert.equal(always['ops-ptc'].config.dynamicTools, false)
  // Row 5: residentTools is row-local; there is no global resident switch.
  const resident = resolveMergedConfig({ 'ops-ptc': { residentTools: false } })
  assert.equal(resident['ops-ptc'].config.residentTools, false)
  assert.equal(resident.global.dynamicTools, true)
})

await test('the default loadable pool is exactly the sixteen non-resident raw APIs', () => {
  assert.deepEqual(PTC_LOADABLE_TOOLS, ['grep', 'glob', 'replace', 'write_file', 'edit_file', 'diff', 'stat', 'copy',
    'move', 'remove', 'read_files', 'read_table', 'read_docx', 'read_pdf', 'batch', 'result'])
  assert.deepEqual(PTC_RESIDENT_TOOLS, ['inspect_local_file'])
})

await test('today alwaysLoaded escapes the allowedTools cap with no diagnostic (decision item)', () => {
  // Current behaviour, locked so a future diagnostic cannot land silently: the
  // startup list is validated against the loadable pool only, never against
  // allowedTools, and a residentTools:false row keeps the list in config while
  // publication drops it. Whether to diagnose is a maintainer decision (#985).
  const escaped = resolveModeConfig({ allowedTools: ['grep'], alwaysLoaded: ['stat'] }, 'ops-ptc')
  assert.deepEqual(escaped.allowedTools, ['grep'])
  assert.deepEqual(escaped.alwaysLoaded, ['stat'], 'stat stays resident though the cap omits it')
  const suppressed = resolveModeConfig({ residentTools: false, alwaysLoaded: ['stat'] }, 'ops-ptc')
  assert.equal(suppressed.residentTools, false)
  assert.deepEqual(suppressed.alwaysLoaded, ['stat'], 'kept in config; publication drops the resident set')
})

requireWorker('ptc-config-truth')
let sequence = 0
const names = (ctx, agent) => ctx.get('tools').definitions(agent, agent.prepared?.toolSet).map(tool => tool.name).sort()
const opsNames = (ctx, agent) => names(ctx, agent).filter(name => name.startsWith('ops_'))
async function step(ctx, agent) {
  ctx.emit('session/event', agent.session, { type: 'step/end', turn: 1, step: ++sequence })
  agent.prepared?.dispose(); agent.prepared = await prepareStep(ctx, agent)
}
async function scoped(parent, key, parentKey) {
  let result
  await parent.plugin({ inject: ['tools'], apply(inner) {
    result = createScope(inner, key, parentKey ? { parent: parentKey } : undefined).ctx
  } })
  return result
}
async function setup(cwd, mode, switches, global = {}) {
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'danger-full-access', workspaceRoot: cwd, sessionId: session?.id }) })
  const presets = new Map(), agents = []
  ctx.provide('agents', { list: () => [...agents] })
  ctx.provide('agentPresets', { composedPreset: inner => presets.get(scopeParentOf(scopeOf(inner))) })
  const config = { global, discovery: { binaryPath: WORKER, required: true } }
  for (const id of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) config[id] = { enabled: id === mode,
    binaryPath: WORKER, required: true, ...(id === mode ? switches : {}) }
  await ctx.plugin({ name: 'ptc-config-truth-fixture', apply: inner => apply(inner, config) })
  const id = 'truth-' + ++sequence, preset = await scoped(ctx, { preset: id })
  presets.set(scopeOf(preset), mode)
  for (const name of ['read', 'glob', 'grep']) preset.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
  const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd }, append() {}, read() { return [] } } }
  agent.ctx = await scoped(preset, agent, scopeOf(preset))
  if (mode === 'ptc' || mode === 'ops-ptc') await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: inner => { selectExecutor(inner, 'ptc') } })
  agents.push(agent)
  await ctx.serial('agent/created', { agent })
  await step(ctx, agent)
  return { ctx, agent }
}

/** Boot one input, wait for its first-round anchor, return the settled OPS set. */
async function firstRoundOps(mode, switches, global, anchor) {
  return withTempDir('truth-' + ++sequence, async cwd => {
    const { ctx, agent } = await setup(cwd, mode, switches, global)
    try {
      await waitFor(() => opsNames(ctx, agent).includes(anchor), { what: anchor + ' published' })
      await wait(100)
      return opsNames(ctx, agent)
    } finally { await shutdown(ctx) }
  })
}

const rowSets = {}

await test('row 1 (defaults): first round is inspect + loader; grep loads for the next step', () => withTempDir('truth-row1', async cwd => {
  const { ctx, agent } = await setup(cwd, 'ops-ptc', {})
  try {
    await waitFor(() => opsNames(ctx, agent).includes('ops_inspect_local_file'), { what: 'ops_inspect_local_file published' })
    await wait(100)
    rowSets.r1 = opsNames(ctx, agent)
    assert.deepEqual(rowSets.r1, ROW_DEFAULT)
    const run = await executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name: 'run_code',
      arguments: { description: 'Load grep', code: "const picked = await tools.ops_load_sdk({ tools: ['grep'] })\nreturn { picked }" },
      callId: 'truth-r1-' + ++sequence, signal: new AbortController().signal })
    assert.equal(run.isError, false, JSON.stringify(run))
    assert.equal(run.value.result.picked.status, 'completed', JSON.stringify(run))
    assert.equal(opsNames(ctx, agent).includes('ops_grep'), false, 'loadable-not-loaded: activation is next-step only')
    await step(ctx, agent)
    assert.ok(opsNames(ctx, agent).includes('ops_grep'), 'grep is callable after the next step')
  } finally { await shutdown(ctx) }
}))

await test('row 2 (global dynamicTools:false): first round is inspect only, no loader', async () => {
  rowSets.r2 = await firstRoundOps('ops-ptc', {}, { dynamicTools: false }, 'ops_inspect_local_file')
  assert.deepEqual(rowSets.r2, ROW_GLOBAL_OFF)
  assert.equal(rowSets.r2.includes('ops_load_sdk'), false)
})

await test('row 3 (row dynamicTools:false): the same PTC set as the global switch, row-scoped', async () => {
  rowSets.r3 = await firstRoundOps('ops-ptc', { dynamicTools: false }, {}, 'ops_inspect_local_file')
  assert.deepEqual(rowSets.r3, ROW_ROW_OFF)
  assert.equal(rowSets.r3.includes('ops_load_sdk'), false)
  assert.deepEqual(rowSets.r3, rowSets.r2, 'global and row off coincide at the PTC surface; only their scope differs')
})

await test('row 4 (row off + alwaysLoaded:[stat]): first round is inspect + stat, no loader', async () => {
  rowSets.r4 = await firstRoundOps('ops-ptc', { dynamicTools: false, alwaysLoaded: ['stat'] }, {}, 'ops_inspect_local_file')
  assert.deepEqual(rowSets.r4, ROW_ROW_OFF_ALWAYS)
  assert.equal(rowSets.r4.includes('ops_load_sdk'), false)
})

await test('row 5 (residentTools:false): first round is the loader only; inspect is unloadable', () => withTempDir('truth-row5', async cwd => {
  const { ctx, agent } = await setup(cwd, 'ops-ptc', { residentTools: false })
  try {
    await waitFor(() => opsNames(ctx, agent).includes('ops_load_sdk'), { what: 'ops_load_sdk published' })
    await wait(100)
    rowSets.r5 = opsNames(ctx, agent)
    assert.deepEqual(rowSets.r5, ROW_RESIDENT_OFF)
    assert.equal(rowSets.r5.includes('ops_inspect_local_file'), false)
    const run = await executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name: 'run_code',
      arguments: { description: 'Probe inspect', code: "const blocked = await tools.ops_load_sdk({ tools: ['inspect_local_file'] })\nreturn { blocked }" },
      callId: 'truth-r5-' + ++sequence, signal: new AbortController().signal })
    assert.equal(run.isError, false, JSON.stringify(run))
    assert.equal(run.value.result.blocked.error.code, 'INVALID_ARGUMENT', 'the resident API is not loadable while residentTools is off')
  } finally { await shutdown(ctx) }
}))

await test('the five recorded sets differ exactly where their one-line inputs differ', () => {
  assert.notDeepEqual(rowSets.r1, rowSets.r2, 'the global switch removes the loader')
  assert.notDeepEqual(rowSets.r1, rowSets.r3, 'the row switch removes the loader')
  assert.notDeepEqual(rowSets.r3, rowSets.r4, 'alwaysLoaded adds stat to the resident set')
  assert.notDeepEqual(rowSets.r1, rowSets.r5, 'residentTools:false removes the resident surface')
  assert.notDeepEqual(rowSets.r4, rowSets.r5)
})

await test('legacy off with allowedTools=[grep,stat] is not a full-tier set', async () => {
  // The counterexample #985 requires: old-off and a full selection are different
  // inputs. Reading dynamicTools:false as "publish everything allowed" would
  // put ops_grep and ops_stat in this first round; today it publishes neither.
  const offSet = await firstRoundOps('ops-ptc', { dynamicTools: false, allowedTools: ['grep', 'stat'] }, {}, 'ops_inspect_local_file')
  assert.deepEqual(offSet, ROW_ROW_OFF)
  assert.equal(offSet.includes('ops_grep'), false)
  assert.equal(offSet.includes('ops_stat'), false)
  assert.equal(offSet.includes('ops_load_sdk'), false)
  const demandSet = await firstRoundOps('ops-ptc', { allowedTools: ['grep', 'stat'] }, {}, 'ops_inspect_local_file')
  assert.deepEqual(demandSet, ROW_DEFAULT, 'the same cap on-demand still starts from inspect + loader')
  assert.notDeepEqual(offSet, demandSet, 'one flipped line, different first-round set')
  assert.equal(demandSet.includes('ops_grep'), false, 'on-demand also keeps grep off the first round')
})

await test('the ptc row publishes the same first-round set as ops-ptc', async () => {
  const set = await firstRoundOps('ptc', {}, {}, 'ops_inspect_local_file')
  assert.deepEqual(set, ROW_DEFAULT)
})

await test('the loader batches 1-5 names per call; the resident startup list has no count cap', () => {
  // Current behaviour, locked so a silent cap change cannot pass: one load_sdk call
  // accepts 1-5 exact raw names, so the sixteen-name pool needs at least four calls,
  // while alwaysLoaded publishes any validated list with no length limit.
  const empty = requestedApis({ tools: [] }, PTC_LOADABLE_TOOLS)
  assert.equal(typeof empty, 'string', 'an empty request is rejected')
  assert.ok(String(empty).includes('1-5'), 'the rejection names the 1-5 contract')
  assert.equal(typeof requestedApis({ tools: PTC_LOADABLE_TOOLS.slice(0, 6) }, PTC_LOADABLE_TOOLS), 'string', 'a six-name request is rejected')
  assert.deepEqual(requestedApis({ tools: ['grep', 'grep', 'stat'] }, PTC_LOADABLE_TOOLS), ['grep', 'stat'], 'duplicates collapse; a legal pair loads')
  assert.equal(Math.ceil(PTC_LOADABLE_TOOLS.length / 5), 4, 'sixteen names need at least four loader calls')
  const full = parsePtcConfig({ allowedTools: PTC_LOADABLE_TOOLS, alwaysLoaded: PTC_LOADABLE_TOOLS })
  assert.deepEqual(full.alwaysLoaded, PTC_LOADABLE_TOOLS, 'no count cap on the startup list')
  assert.deepEqual(full.allowedTools, PTC_LOADABLE_TOOLS)
})

await test('a legal custom ptc-profile integration diagnoses ready after the D4 plan-derived expectations (decision item 4)', () => withTempDir('truth-diag-' + ++sequence, async cwd => {
  // D4 (#988) flipped this pin: diagnostics used to list ops_result among first-round
  // expected names, but result is selectable, not resident, so a legal custom PTC
  // integration read degraded while its only gap was an API the loader had not
  // selected yet. The expected set now comes from the same disclosure plan the
  // publication uses, so this row reports ready and no PUBLICATION_UNAVAILABLE.
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
    ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'danger-full-access', workspaceRoot: cwd, sessionId: session?.id }) })
    ctx.provide('agentPresets', { composedPreset: () => undefined })
    const agents = []
    ctx.provide('agents', { list: () => [...agents] })
    await ctx.plugin(integration({ preset: 'truth-diag-ptc', profile: 'ptc', binaryPath: WORKER, required: true }))
    const id = 'truth-diag-' + ++sequence
    const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd, agentPreset: 'truth-diag-ptc' } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: inner => { selectExecutor(inner, 'ptc') } })
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    agent.prepared = await prepareStep(ctx, agent)
    await waitFor(() => opsNames(ctx, agent).includes('ops_inspect_local_file'), { what: 'ops_inspect_local_file published' })
    await wait(100)
    const d = await diagnose(ctx, agent)
    assert.equal(d.state, 'ready', JSON.stringify(d.issues))
    assert.equal(d.issues.some(row => row.code === 'PUBLICATION_UNAVAILABLE'), false,
      'the selectable-but-not-resident result API is not a publication gap')
  } finally { await shutdown(ctx) }
}))

report('ptc-config-truth')
