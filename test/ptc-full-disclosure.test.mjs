/** The D3 publication slice: an explicit full tier actually publishes the pool.
 *
 * #979 splits the two-tier OPS-PTC work into slices; this suite locks the D3
 * slice (#987) end to end through the shipped merged row: with
 * `disclosurePolicy: 'full'` the first round carries the whole permitted
 * `allowedTools` pool plus `result` (the D1 sign-off item 1 decision, taken
 * conservatively per #979 §3 so refs spilled this step stay consumable, and
 * forced by the unified acceptance rule: on-demand can always load `result`,
 * so the loaded set equals the full first round only if full publishes it)
 * with no `ops_load_sdk`. Every check runs the real worker through the real
 * PTC executor, and the dual verification the card requires: the settled
 * first-round name set plus an actual run_code binding call.
 */
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import fs from 'node:fs'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { BASH_TOOL, publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, executeCall, selectExecutor } from './lib/executor.mjs'
import { assert, test, report, wait, waitFor, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

requireWorker('ptc-full-disclosure')

let sequence = 0
// The integration diagnostics row (ops_status, #753) and the Windows Bash tool
// are published beside the PTC tier and have their own suites; this enumeration
// is the PTC disclosure surface.
const names = (ctx, agent) => ctx.get('tools').definitions(agent, agent.prepared?.toolSet).map(tool => tool.name)
  .filter(name => name !== 'ops_status' && name !== BASH_TOOL).sort()
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
async function setup(cwd, switches, global = {}, sandboxMode = 'danger-full-access') {
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? sandboxMode, workspaceRoot: cwd, sessionId: session?.id }) })
  const presets = new Map(), agents = []
  ctx.provide('agents', { list: () => [...agents] })
  ctx.provide('agentPresets', { composedPreset: inner => presets.get(scopeParentOf(scopeOf(inner))) })
  const config = { global, discovery: { binaryPath: WORKER, required: true } }
  for (const id of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) config[id] = { enabled: id === 'ops-ptc',
    binaryPath: WORKER, required: true, ...(id === 'ops-ptc' ? switches : {}) }
  await ctx.plugin({ name: 'full-disclosure-fixture', apply: inner => apply(inner, config) })
  const id = 'full-' + ++sequence, preset = await scoped(ctx, { preset: id })
  presets.set(scopeOf(preset), 'ops-ptc')
  for (const name of ['read', 'glob', 'grep']) preset.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
  const agent = { id, session: { id, mode: sandboxMode, header: { cwd }, append() {}, read() { return [] } } }
  agent.ctx = await scoped(preset, agent, scopeOf(preset))
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: inner => { selectExecutor(inner, 'ptc') } })
  agents.push(agent)
  await ctx.serial('agent/created', { agent })
  await step(ctx, agent)
  return { ctx, agent }
}

/** Boot one ops-ptc row, wait for its anchor, return the settled first-round set. */
async function firstRound(switches, anchor, global = {}, sandboxMode = 'danger-full-access') {
  return withTempDir('full-' + ++sequence, async cwd => {
    fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle in haystack\nplain second line\n')
    const { ctx, agent } = await setup(cwd, switches, global, sandboxMode)
    try {
      await waitFor(() => opsNames(ctx, agent).includes(anchor), { what: anchor + ' published' })
      await wait(100)
      return opsNames(ctx, agent)
    } finally { await shutdown(ctx) }
  })
}

/** One real run_code program through the prepared step, as the loop issues it. */
async function program(ctx, agent, code, label) {
  const result = await executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name: 'run_code',
    arguments: { description: label, code }, callId: 'full-' + ++sequence, signal: new AbortController().signal })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value.result
}

/** D1 truth-table row T: the explicit full selection, first round, no loader. */
const ROW_T = ['ops_grep', 'ops_inspect_local_file', 'ops_result', 'ops_stat']

await test('row T: full + allowedTools=[grep,stat] publishes the whole pool in the first round, loader-less', () => withTempDir('full-row-t', async cwd => {
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle in haystack\nplain second line\n')
  const { ctx, agent } = await setup(cwd, { disclosurePolicy: 'full', allowedTools: ['grep', 'stat'] })
  try {
    await waitFor(() => opsNames(ctx, agent).includes('ops_grep'), { what: 'ops_grep published' })
    await wait(100)
    assert.deepEqual(opsNames(ctx, agent), ROW_T)
    assert.equal(opsNames(ctx, agent).includes('ops_load_sdk'), false, 'the full tier publishes no loader (#979 §2)')
    // Dual verification: the binding works in the very first program, on a file
    // with known content; pool-outside and loader bindings stay absent.
    const value = await program(ctx, agent, "const stat = await tools.ops_stat({ path: 'fixture.txt' })\n"
      + "const grep = await tools.ops_grep({ pattern: 'needle', path: '.' })\n"
      + "return { statStatus: stat.status, grepStatus: grep.status, grepText: JSON.stringify(grep),\n"
      + "  loader: typeof tools.ops_load_sdk, glob: typeof tools.ops_glob }", 'Stat and grep the fixture')
    assert.equal(value.statStatus, 'completed', JSON.stringify(value))
    assert.equal(value.grepStatus, 'completed', JSON.stringify(value))
    assert.match(value.grepText, /needle/, 'the real worker answered the grep call')
    assert.match(value.grepText, /fixture\.txt/, 'the real worker answered the grep call')
    assert.equal(value.loader, 'undefined', 'no loader binding in the full first round')
    assert.equal(value.glob, 'undefined', 'a pool-outside business API is not callable')
  } finally { await shutdown(ctx) }
}))

await test('unified acceptance: on-demand after loading equals the full first round (loader excluded)', () => withTempDir('full-compare', async cwd => {
  const fullSet = await firstRound({ disclosurePolicy: 'full', allowedTools: ['grep', 'stat'] }, 'ops_grep')
  assert.deepEqual(fullSet, ROW_T)
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle in haystack\n')
  const { ctx, agent } = await setup(cwd, { allowedTools: ['grep', 'stat'] })
  try {
    await waitFor(() => opsNames(ctx, agent).includes('ops_load_sdk'), { what: 'ops_load_sdk published' })
    await wait(100)
    assert.deepEqual(opsNames(ctx, agent), ['ops_inspect_local_file', 'ops_load_sdk'], 'on-demand starts at inspect + loader before any load')
    const value = await program(ctx, agent, "const picked = await tools.ops_load_sdk({ tools: ['grep', 'stat', 'result'] })\n"
      + "return { picked: picked.status, earlyGrep: typeof tools.ops_grep }", 'Load the same business set')
    assert.equal(value.picked, 'completed', JSON.stringify(value))
    assert.equal(value.earlyGrep, 'undefined', 'a loaded API is callable only in the next program (#979 §1)')
    await step(ctx, agent)
    await wait(100)
    const loaded = opsNames(ctx, agent).filter(name => name !== 'ops_load_sdk')
    assert.deepEqual(loaded, ROW_T, 'on-demand loaded set = full first-round set, excluding the loader itself')
    assert.deepEqual(loaded, fullSet)
  } finally { await shutdown(ctx) }
}))

await test('read-only excludes write APIs from the full first round', () => withTempDir('full-readonly', async cwd => {
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle in haystack\n')
  const { ctx, agent } = await setup(cwd, { disclosurePolicy: 'full', allowedTools: ['write_file', 'stat'] }, {}, 'read-only')
  try {
    await waitFor(() => opsNames(ctx, agent).includes('ops_stat'), { what: 'ops_stat published' })
    await wait(100)
    assert.deepEqual(opsNames(ctx, agent), ['ops_inspect_local_file', 'ops_result', 'ops_stat'], 'the mutating member of the cap is never published')
    const value = await program(ctx, agent, "const stat = await tools.ops_stat({ path: 'fixture.txt' })\n"
      + "return { statStatus: stat.status, writer: typeof tools.ops_write_file }", 'Stat under read-only')
    assert.equal(value.statStatus, 'completed', JSON.stringify(value))
    assert.equal(value.writer, 'undefined', 'switching tiers never widens permissions (#979 §2)')
  } finally { await shutdown(ctx) }
}))

await test('an empty allowed pool keeps the full tier at the resident surface plus result', () => withTempDir('full-empty', async cwd => {
  const { ctx, agent } = await setup(cwd, { disclosurePolicy: 'full', allowedTools: [] })
  try {
    await waitFor(() => opsNames(ctx, agent).includes('ops_inspect_local_file'), { what: 'ops_inspect_local_file published' })
    await wait(100)
    assert.deepEqual(opsNames(ctx, agent), ['ops_inspect_local_file', 'ops_result'], 'nothing else to publish, and still no loader')
    const value = await program(ctx, agent, "return { result: typeof tools.ops_result, grep: typeof tools.ops_grep }", 'Probe the empty pool')
    assert.equal(value.result, 'function', 'result stays consumable so spilled refs never dead-end (#979 §3)')
    assert.equal(value.grep, 'undefined')
  } finally { await shutdown(ctx) }
}))

await test('residentTools:false drops the resident set but keeps the explicit full tier', () => withTempDir('full-resident-off', async cwd => {
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle in haystack\n')
  const { ctx, agent } = await setup(cwd, { disclosurePolicy: 'full', allowedTools: ['grep', 'stat'], residentTools: false })
  try {
    await waitFor(() => opsNames(ctx, agent).includes('ops_grep'), { what: 'ops_grep published' })
    await wait(100)
    assert.deepEqual(opsNames(ctx, agent), ['ops_grep', 'ops_result', 'ops_stat'], 'the resident conflict never silences the explicit tier')
    const value = await program(ctx, agent, "const stat = await tools.ops_stat({ path: 'fixture.txt' })\n"
      + "return { statStatus: stat.status, inspect: typeof tools.ops_inspect_local_file }", 'Stat with residents off')
    assert.equal(value.statStatus, 'completed', JSON.stringify(value))
    assert.equal(value.inspect, 'undefined', 'residentTools:false still drops the resident surface')
  } finally { await shutdown(ctx) }
}))

await test('duplicate allowed names collapse to one publication each', () => withTempDir('full-duplicates', async cwd => {
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle in haystack\n')
  const { ctx, agent } = await setup(cwd, { disclosurePolicy: 'full', allowedTools: ['stat', 'stat', 'grep'] })
  try {
    await waitFor(() => opsNames(ctx, agent).includes('ops_grep'), { what: 'ops_grep published' })
    await wait(100)
    assert.equal(opsNames(ctx, agent).filter(name => name === 'ops_stat').length, 1, 'a duplicated name registers exactly once')
    assert.deepEqual(opsNames(ctx, agent), ROW_T)
    const value = await program(ctx, agent, "const stat = await tools.ops_stat({ path: 'fixture.txt' })\nreturn { statStatus: stat.status }", 'Stat once')
    assert.equal(value.statStatus, 'completed', JSON.stringify(value))
  } finally { await shutdown(ctx) }
}))

await test('global dynamicTools:false presses an explicit full row back to the legacy surface', async () => {
  // Sign-off item 2, end to end through the shipped row: the bundle switch keeps
  // its veto, and the saved tier never overrides it (#979 §4).
  const set = await firstRound({ disclosurePolicy: 'full', allowedTools: ['grep', 'stat'] }, 'ops_inspect_local_file', { dynamicTools: false })
  assert.deepEqual(set, ['ops_inspect_local_file'], 'row 2 of the D1 table, letter for letter')
  assert.equal(set.includes('ops_grep'), false)
  assert.equal(set.includes('ops_stat'), false)
  assert.equal(set.includes('ops_load_sdk'), false)
})

await test('a full row that also turns its loader off keeps the explicit tier', () => withTempDir('full-loader-off', async cwd => {
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle in haystack\n')
  const { ctx, agent } = await setup(cwd, { disclosurePolicy: 'full', dynamicTools: false, allowedTools: ['grep', 'stat'] })
  try {
    await waitFor(() => opsNames(ctx, agent).includes('ops_grep'), { what: 'ops_grep published' })
    await wait(100)
    assert.deepEqual(opsNames(ctx, agent), ROW_T, 'row-level dynamicTools keeps its loader-only meaning')
    assert.equal(opsNames(ctx, agent).includes('ops_load_sdk'), false)
    const value = await program(ctx, agent, "const grep = await tools.ops_grep({ pattern: 'needle', path: '.' })\n"
      + "return { grepStatus: grep.status, grepText: JSON.stringify(grep) }", 'Grep without a loader')
    assert.equal(value.grepStatus, 'completed', JSON.stringify(value))
    assert.match(value.grepText, /needle/)
  } finally { await shutdown(ctx) }
}))

report('ptc-full-disclosure')
