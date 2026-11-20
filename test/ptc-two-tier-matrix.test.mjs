/** The #992 data-driven acceptance matrix for the two-tier publication rule.
 *
 * One kernel, three projections, one comparison. Every row is data: the config
 * inputs and the exact business names the row must publish in each view — the
 * SDK text the model reads (declared), the step admission the loop resolves
 * (admitted), and the run_code program bindings (callable). A fourth, clearly
 * separate view collects the no-toolSet diagnostic assembly: a host assembly
 * that omits the step tool set reads every registered definition, so it is a
 * registration superset, never an admission proof. All four go through one
 * comparator that prints the missing and the extra names, and the drift
 * property is itself asserted: removing any single expected name — or reading
 * the diagnostic view where a step view is required — fails at least one cell
 * with the culprit named.
 *
 * Every row executes a real sentinel through the real worker (the read-only
 * row's inspect runs with the sandbox in read-only mode), and write authority
 * is asserted with a safe rejection: ops_load_sdk never spawns the worker for
 * a pool-outside or permission-denied name, it answers INVALID_ARGUMENT.
 *
 * The official read/glob/grep trio is pinned as *visible* next to the ops
 * surface: #961 (hide replaced official file tools under PTC presets) is not
 * in this baseline, and its hiding implementation is deliberately not
 * simulated here. The official-swap-off row records that the shipped
 * global.hideOfficialTools switch is inert for PTC rows today; when #961 lands
 * these two rows flip together with it.
 *
 * Platform note: this matrix is measured on Linux with the real worker, no
 * Windows simulation. POSIX rows keep the host shell, so ops_bash is out of
 * every expected set; the Windows surface has its own suites on real Windows.
 * Out of scope by card: byte accounting (V2) and real-model rounds (V5); the
 * loader-less declaration half owned by test/ptc-declaration-surface.test.mjs
 * belongs to P5 and is not touched here.
 */
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import fs from 'node:fs'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { integration } from '../lib/integration/index.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, executeCall, selectExecutor } from './lib/executor.mjs'
import { assert, test, report, wait, waitFor, withTempDir } from './lib/harness.mjs'
import { BASH_TOOL } from '../lib/policy.js'
import { WORKER, requireWorker } from './lib/boundary.mjs'

requireWorker('ptc-two-tier-matrix')

const OFFICIAL_TRIO = ['glob', 'grep', 'read']
/** run_code is the executor's own tool: it is not part of the registry views this matrix compares. */
const HOST_STEP_TOOLS = []
/** The trio stays admitted only when the row switches hiding off (#961 in baseline). */
const HOST_STEP_TOOLS_VISIBLE = [...OFFICIAL_TRIO]
const I = 'ops_inspect_local_file'
const L = 'ops_load_sdk'
/** The sixteen-API default pool: every file API but the resident inspect, plus batch and result. */
const POOL16 = ['ops_batch', 'ops_copy', 'ops_diff', 'ops_edit_file', 'ops_glob', 'ops_grep', 'ops_move',
  'ops_read_docx', 'ops_read_files', 'ops_read_pdf', 'ops_read_table', 'ops_remove', 'ops_replace',
  'ops_result', 'ops_stat', 'ops_write_file']

let sequence = 0

/** One comparison for every cell of the matrix: exact set equality, culprits named. */
function expectCell(rowId, view, expected, actual) {
  const missing = expected.filter(name => !actual.includes(name))
  const extra = actual.filter(name => !expected.includes(name))
  if (missing.length || extra.length)
    throw new Error(`matrix cell ${rowId}/${view} drifted: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`)
}

const sdkTextOf = assembly => assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
/** The ops_* names one assembly declares in tools:sdk (the ": {" shape). */
const declaredOps = assembly => [...new Set([...sdkTextOf(assembly).matchAll(/^ {2}(ops_[a-z_]+): \{/gm)].map(match => match[1]))].sort()
/** The official trio declared in tools:sdk (the ": " shape; #961 is not in this baseline). */
const declaredOfficial = assembly => OFFICIAL_TRIO.filter(name => new RegExp(`^ {2}${name}: `, 'm').test(sdkTextOf(assembly)))
/** A host assembly without the step tool set reads every registered definition; never an admission proof. */
const diagnosticOps = async (ctx, agent) => {
  const assembly = await ctx.get('systemPrompt').assemble({ scope: agent })
  return [...new Set([...sdkTextOf(assembly).matchAll(/^ {2}(ops_[a-z_]+): \{/gm)].map(match => match[1]))].sort()
}
// The Windows Bash tool is published beside the PTC row (shell suites cover it);
// the tier matrix enumerates the published PTC surface.
const admittedNames = (ctx, agent) => ctx.get('tools').definitions(agent, agent.prepared.toolSet).map(tool => tool.name)
  .filter(name => name !== BASH_TOOL)
/** The integration diagnostics row publishes ops_status beside every built-in preset (#753). */
const OPS_ADMITTED_EXTRA = ['ops_status']
const admittedOps = names => names.filter(name => name.startsWith('ops_')).sort()
const admittedHost = names => names.filter(name => !name.startsWith('ops_')).sort()

async function scoped(parent, key, parentKey) {
  let result
  await parent.plugin({ inject: ['tools'], apply(inner) {
    result = createScope(inner, key, parentKey ? { parent: parentKey } : undefined).ctx
  } })
  return result
}

/** Boot one ops-ptc preset row exactly as the shipped settings compose it. */
async function bootPresetRow(cwd, row) {
  const sandboxMode = row.sandboxMode ?? 'danger-full-access'
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? sandboxMode, workspaceRoot: cwd, sessionId: session?.id }) })
  const presets = new Map(), agents = []
  ctx.provide('agents', { list: () => [...agents] })
  ctx.provide('agentPresets', { composedPreset: inner => presets.get(scopeParentOf(scopeOf(inner))) })
  const config = { global: row.global ?? {}, discovery: { binaryPath: WORKER, required: true } }
  for (const id of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) config[id] = { enabled: id === 'ops-ptc',
    binaryPath: WORKER, required: true, ...(id === 'ops-ptc' ? row.switches : {}) }
  await ctx.plugin({ name: 'matrix-preset-fixture', apply: inner => apply(inner, config) })
  const id = 'matrix-' + row.id + '-' + ++sequence, preset = await scoped(ctx, { preset: id })
  presets.set(scopeOf(preset), 'ops-ptc')
  for (const name of OFFICIAL_TRIO) preset.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
  const agent = { id, session: { id, mode: sandboxMode, header: { cwd }, append() {}, read() { return [] } } }
  agent.ctx = await scoped(preset, agent, scopeOf(preset))
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: inner => { selectExecutor(inner, 'ptc') } })
  agents.push(agent)
  await ctx.serial('agent/created', { agent })
  await advanceStep(ctx, agent)
  return { ctx, agent }
}

/** Boot one custom integration row: the plan slice integrations compose themselves (#988 keeps it on-demand). */
async function bootIntegrationRow(cwd, row) {
  const sandboxMode = row.sandboxMode ?? 'danger-full-access'
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? sandboxMode, workspaceRoot: cwd, sessionId: session?.id }) })
  ctx.provide('agentPresets', { composedPreset: () => undefined })
  const agents = []
  ctx.provide('agents', { list: () => [...agents] })
  await ctx.plugin(integration({ preset: row.preset, profile: 'ptc', binaryPath: WORKER, required: true, ...row.switches }))
  const id = row.preset + '-' + ++sequence
  const agent = { id, session: { id, mode: sandboxMode, header: { cwd, agentPreset: row.preset }, append() {}, read() { return [] } } }
  await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: inner => { selectExecutor(inner, 'ptc') } })
  agents.push(agent)
  await ctx.serial('agent/created', { agent })
  await advanceStep(ctx, agent)
  return { ctx, agent }
}

async function advanceStep(ctx, agent) {
  ctx.emit('session/event', agent.session, { type: 'step/end', turn: ++sequence, step: ++sequence })
  agent.prepared?.dispose()
  agent.prepared = await prepareStep(ctx, agent)
}

/** One real run_code program through the prepared step, as the loop issues it. */
async function program(ctx, agent, code, label) {
  const result = await executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name: 'run_code',
    arguments: { description: label, code }, callId: 'matrix-' + ++sequence, signal: new AbortController().signal })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value.result
}

/** The no-side-effect sentinel each row really executes through the worker. */
function sentinelCode(spec) {
  if (spec === 'inspect') return { code: "const sentinel = await tools.ops_inspect_local_file({ path: 'fixture.txt', limit: 2 })",
    checks: value => { assert.equal(value.sentinelStatus, 'completed', JSON.stringify(value))
      assert.equal(value.sentinelText, true, 'the real worker answered the inspect call') } }
  if (spec === 'grep') return { code: "const sentinel = await tools.ops_grep({ pattern: 'needle', path: '.' })",
    checks: value => { assert.equal(value.sentinelStatus, 'completed', JSON.stringify(value))
      assert.equal(value.sentinelText, true, 'the real worker answered the grep call') } }
  if (spec === 'stat') return { code: "const sentinel = await tools.ops_stat({ path: 'fixture.txt' })",
    checks: value => { assert.equal(value.sentinelStatus, 'completed', JSON.stringify(value)) } }
  if (spec === 'none') return { code: 'const sentinel = null', checks: () => {} }
  throw new Error('unknown sentinel: ' + spec)
}

/** Collect the four views of one settled state and drive them all through expectCell. */
async function collectViews(ctx, agent, row, phase, evidence) {
  const spec = row.expect[phase]
  const names = admittedNames(ctx, agent)
  const assembly = agent.prepared.assembly
  expectCell(row.id + ':' + phase, 'declared(ops)', spec.ops, declaredOps(assembly))
  expectCell(row.id + ':' + phase, 'declared(official)', spec.official, declaredOfficial(assembly))
  expectCell(row.id + ':' + phase, 'admitted(ops)', [...spec.ops, ...OPS_ADMITTED_EXTRA, ...(spec.admittedExtra ?? [])], admittedOps(names))
  expectCell(row.id + ':' + phase, 'admitted(host)', spec.host, admittedHost(names))
  // The diagnostic view is registration state: a load changes selection, not registration.
  if (spec.diagnostic) expectCell(row.id + ':' + phase, 'diagnostic(ops)', spec.diagnostic, await diagnosticOps(ctx, agent))
  assert.equal(assembly.sections.some(section => section.text.includes('For on-demand APIs, use tools.ops_load_sdk')),
    spec.directory, `${row.id}:${phase} directory recommendation text`)
  if (spec.loaderDescription) {
    const loader = ctx.get('tools').definitions(agent, agent.prepared.toolSet).find(tool => tool.name === L)
    for (const word of spec.loaderDescription.includes) assert.ok(loader?.description.includes(word), `${row.id} loader description names ${word}`)
    for (const word of spec.loaderDescription.excludes) assert.equal(loader?.description.includes(word), false, `${row.id} loader description must stay narrowed (${word})`)
  }
  // The callable view: one real program reports typeof for every probed name plus the sentinel.
  const probed = [...new Set([...spec.callable, ...OPS_ADMITTED_EXTRA, ...spec.absent])]
  const sentinel = sentinelCode(row.sentinel[phase])
  const noSentinel = row.sentinel[phase] === 'none'
  const reject = row.reject && phase === 'first'
    ? `const rejection = await tools.ops_load_sdk({ tools: ${JSON.stringify([row.reject.tool])} })` : ''
  const value = await program(ctx, agent, sentinel.code + '\n' + reject + '\nreturn { '
    + probed.map(name => `${name}: typeof tools.${name}, `).join('')
    + (noSentinel ? '' : 'sentinelStatus: sentinel?.status, sentinelText: JSON.stringify(sentinel).includes(\'needle\'), ')
    + (reject ? 'rejectStatus: rejection?.status, rejectCode: rejection?.error?.code, '
      + 'rejectMessage: rejection?.error?.message, rejectEffect: rejection?.error?.effectState, ' : '')
    + ' }', 'Matrix probe ' + row.id + ':' + phase)
  const callable = probed.filter(name => value[name] === 'function').sort()
  expectCell(row.id + ':' + phase, 'callable', [...spec.callable, ...OPS_ADMITTED_EXTRA], callable)
  for (const name of spec.absent) assert.equal(value[name], 'undefined', `${row.id}:${phase} ${name} must not pretend to be executable`)
  if (!noSentinel) sentinel.checks(value)
  if (reject) {
    assert.equal(value.rejectStatus, row.reject.status ?? 'error', 'the safe rejection is a returned value, not a throw')
    assert.equal(value.rejectCode, row.reject.code, JSON.stringify(value))
    assert.ok(value.rejectMessage.includes(row.reject.tool), 'the rejection names the refused API: ' + value.rejectMessage)
    assert.equal(value.rejectEffect, 'none', 'a refused load has no effect')
  }
  evidence[row.id] = { ...(evidence[row.id] ?? {}), [phase]: { ops: admittedOps(names), diagnostic: await diagnosticOps(ctx, agent),
    official: declaredOfficial(assembly), callable } }
}

/** Run one matrix row end to end and stash its collected views for the synthesis checks. */
async function runRow(row, evidence) {
  return withTempDir('matrix-' + row.id, async cwd => {
    fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle in haystack\nplain second line\n')
    const { ctx, agent } = row.kind === 'integration' ? await bootIntegrationRow(cwd, row) : await bootPresetRow(cwd, row)
    try {
      await waitFor(() => admittedOps(admittedNames(ctx, agent)).includes(row.anchor), { what: row.anchor + ' admitted', timeoutMs: 20_000 })
      await wait(120)
      agent.prepared.dispose(); agent.prepared = await prepareStep(ctx, agent)
      await collectViews(ctx, agent, row, 'first', evidence)
      if (row.load) {
        const value = await program(ctx, agent, `const receipt = await tools.ops_load_sdk({ tools: ${JSON.stringify(row.load)} })\n`
          + `return { receiptStatus: receipt.status, early: typeof tools.ops_${row.load[0]} }`, 'Matrix load ' + row.id)
        assert.equal(value.receiptStatus, 'completed', JSON.stringify(value))
        assert.equal(value.early, 'undefined', row.id + ': a loaded API is callable only in the next program')
        await advanceStep(ctx, agent)
        await wait(120)
        await collectViews(ctx, agent, row, 'loaded', evidence)
      }
    } finally { await shutdown(ctx) }
  })
}

// ---- The matrix rows. Eight canonical configurations (issue #992) with the
// legacy-off variants spelled out, each carrying inputs and expected names. ----

const ON_DEMAND_CAP = { ops: [I, L], host: [...HOST_STEP_TOOLS], official: [],
  diagnostic: [I, L, 'ops_glob', 'ops_grep', 'ops_result'], callable: [I, L],
  absent: ['ops_glob', 'ops_grep', 'ops_result', 'ops_stat', 'ops_write_file', 'ops_batch'], directory: true }

const ON_DEMAND_CAP_VISIBLE_OFFICIAL = { ...ON_DEMAND_CAP,
  host: [...HOST_STEP_TOOLS_VISIBLE], official: [...OFFICIAL_TRIO] }

const ROWS = [
  { id: 'legacy-default', anchor: L, sentinel: { first: 'inspect' }, switches: {}, expect: { first: {
    ...ON_DEMAND_CAP, diagnostic: [I, L, ...POOL16] } } },
  // #961 is out of baseline: the shipped hideOfficialTools switch is inert for PTC
  // rows, so its off state publishes the identical surface. #961 flips this row.
  { id: 'official-swap-off', anchor: L, sentinel: { first: 'inspect' }, global: { hideOfficialTools: false },
    expect: { first: { ...ON_DEMAND_CAP_VISIBLE_OFFICIAL, diagnostic: [I, L, ...POOL16] } } },
  { id: 'global-off', anchor: I, sentinel: { first: 'inspect' }, global: { dynamicTools: false }, expect: { first: {
    ops: [I], host: ['glob', 'grep'], official: ['glob', 'grep'], diagnostic: [I], callable: [I],
    absent: [L, ...POOL16], directory: false } } },
  { id: 'row-off', anchor: I, sentinel: { first: 'inspect' }, switches: { dynamicTools: false }, expect: { first: {
    ops: [I], host: ['glob', 'grep'], official: ['glob', 'grep'], diagnostic: [I], callable: [I],
    absent: [L, ...POOL16], directory: false } } },
  { id: 'row-off-always', anchor: 'ops_stat', sentinel: { first: 'stat' }, switches: { dynamicTools: false, alwaysLoaded: ['stat'] }, expect: { first: {
    ops: [I, 'ops_stat'], host: ['glob', 'grep'], official: ['glob', 'grep'], diagnostic: [I, 'ops_stat'],
    callable: [I, 'ops_stat'], absent: [L, ...POOL16.filter(name => name !== 'ops_stat')], directory: false } } },
  { id: 'resident-off', anchor: L, load: ['grep'], reject: { tool: 'inspect_local_file', code: 'INVALID_ARGUMENT' },
    sentinel: { first: 'none', loaded: 'grep' }, switches: { residentTools: false }, expect: {
    first: { ops: [L], host: ['read'], official: ['read'], diagnostic: [L, ...POOL16],
      callable: [L], absent: [I, ...POOL16], directory: true },
    loaded: { ops: [L, 'ops_grep'], host: ['read'], official: ['read'],
      callable: [L, 'ops_grep'], absent: [I, 'ops_result', 'ops_stat', 'ops_glob'], directory: true } } },
  { id: 'on-demand-first', anchor: L, sentinel: { first: 'inspect' }, switches: { allowedTools: ['glob', 'grep'] },
    expect: { first: ON_DEMAND_CAP } },
  // The unified acceptance rule (#979 §3) forces result into the load set: the
  // full first round publishes it, so the loaded business set equals it only
  // when on-demand loads it explicitly, like any other pool member.
  { id: 'on-demand-loaded', anchor: L, load: ['glob', 'grep', 'result'], sentinel: { first: 'inspect', loaded: 'grep' },
    switches: { allowedTools: ['glob', 'grep'] }, expect: { first: ON_DEMAND_CAP,
    // The pool is exhausted after the load: the directory recommendation
    // correctly disappears when no allowed name is left to load.
    loaded: { ops: [I, L, 'ops_glob', 'ops_grep', 'ops_result'], host: [...HOST_STEP_TOOLS], official: [],
      callable: [I, L, 'ops_glob', 'ops_grep', 'ops_result'], absent: ['ops_stat', 'ops_write_file', 'ops_batch'], directory: false } } },
  { id: 'full-direct', anchor: 'ops_glob', sentinel: { first: 'grep' },
    switches: { disclosurePolicy: 'full', allowedTools: ['glob', 'grep'] }, expect: { first: {
    ops: [I, 'ops_glob', 'ops_grep', 'ops_result'], host: [...HOST_STEP_TOOLS], official: [],
    diagnostic: [I, 'ops_glob', 'ops_grep', 'ops_result'], callable: [I, 'ops_glob', 'ops_grep', 'ops_result'],
    absent: [L, 'ops_stat', 'ops_write_file', 'ops_batch'], directory: false } } },
  { id: 'read-only', anchor: L, sandboxMode: 'read-only', reject: { tool: 'write_file', code: 'POLICY_DENIED', status: 'rejected' },
    sentinel: { first: 'inspect' }, switches: { allowedTools: ['write_file', 'grep'] }, expect: { first: {
    ops: [I, L], host: ['glob'], official: ['glob'],
    diagnostic: [I, L, 'ops_grep', 'ops_result', 'ops_write_file'], callable: [I, L],
    absent: ['ops_write_file', 'ops_grep', 'ops_result', 'ops_stat'], directory: true,
    loaderDescription: { includes: ['write_file, grep, result'], excludes: [] } } } },
  { id: 'narrow-pool', anchor: L, reject: { tool: 'stat', code: 'INVALID_ARGUMENT' }, sentinel: { first: 'inspect' },
    switches: { allowedTools: ['grep'] }, expect: { first: { ...ON_DEMAND_CAP, host: ['glob'], official: ['glob'],
    diagnostic: [I, L, 'ops_grep', 'ops_result'],
    loaderDescription: { includes: ['grep, result'], excludes: ['stat', 'glob'] } } } },
  // The custom integration path also admits its own ops_status diagnostics reader,
  // which has no SDK projection: it is admitted and callable but never declared.
  { id: 'custom-preset', kind: 'integration', preset: 'matrix-custom', anchor: L, load: ['glob', 'grep', 'result'],
    sentinel: { first: 'inspect', loaded: 'grep' }, switches: { allowedTools: ['glob', 'grep'] }, expect: {
    first: { ops: [I, L], admittedExtra: ['ops_status'], host: [], official: [], diagnostic: [I, L, 'ops_glob', 'ops_grep', 'ops_result'],
      callable: [I, L, 'ops_status'], absent: ['ops_glob', 'ops_grep', 'ops_result', 'ops_stat'], directory: true },
    loaded: { ops: [I, L, 'ops_glob', 'ops_grep', 'ops_result'], admittedExtra: ['ops_status'], host: [], official: [],
      callable: [I, L, 'ops_glob', 'ops_grep', 'ops_result', 'ops_status'], absent: ['ops_stat', 'ops_write_file'], directory: false } } },
]

/** Collected views of every row, reused by the synthesis checks below. */
const evidence = {}

for (const row of ROWS) {
  await test('matrix row ' + row.id + ': three views and the diagnostic view agree with the row', () => runRow(row, evidence))
}

await test('unified acceptance: the on-demand loaded business set equals the full first round on both publication paths', () => {
  const kernel = name => name !== L && !OPS_ADMITTED_EXTRA.includes(name)
  const business = evidence['on-demand-loaded'].loaded.ops.filter(kernel)
  const full = evidence['full-direct'].first.ops.filter(kernel)
  // ops_status is the custom integration's own diagnostics reader, admitted
  // beside the pool; it is not a member of the two-tier publication kernel.
  const custom = evidence['custom-preset'].loaded.ops.filter(kernel)
  expectCell('unified-acceptance', 'preset-loaded-vs-full', full, business)
  expectCell('unified-acceptance', 'custom-loaded-vs-full', full, custom)
})

await test('drift property: removing any one expected name fails exactly its cell and prints the culprit', () => {
  const stepOps = evidence['on-demand-first'].first.ops
  for (const name of stepOps) {
    const corrupted = stepOps.filter(candidate => candidate !== name)
    assert.throws(() => expectCell('on-demand-first', 'declared(ops)', corrupted, stepOps),
      new RegExp('missing \\[.*' + name), name + ' removal must fail with the name printed')
  }
  assert.throws(() => expectCell('on-demand-first', 'declared(ops)', stepOps, [...stepOps, 'ops_nope']),
    /extra \[.*ops_nope/, 'an invented name must fail as extra with the name printed')
  assert.throws(() => expectCell('on-demand-first', 'declared(ops)', [...stepOps, 'ops_nope'], stepOps),
    /missing \[.*ops_nope/, 'a lost expected name must fail as missing with the name printed')
  const callable = evidence['on-demand-first'].first.callable
  assert.throws(() => expectCell('on-demand-first', 'callable', callable.filter(name => name !== L), callable),
    new RegExp('missing \\[.*' + L), 'deleting the loader admission fails the callable cell')
})

await test('drift property: reading the diagnostic registry view cannot satisfy a step cell', () => {
  // The diagnostic assembly registers the whole pool while the step admits
  // only inspect + loader, so a wrong-view read must fail with the pool named.
  const step = evidence['on-demand-first'].first.ops
  const diagnostic = evidence['legacy-default'].first.diagnostic
  assert.throws(() => expectCell('on-demand-first', 'declared(ops)', step, diagnostic),
    /extra \[.*ops_grep/, 'the pool registration must be reported as extra names')
  assert.throws(() => expectCell('legacy-default', 'diagnostic(ops)', diagnostic, step),
    /missing \[.*ops_grep/, 'the step view must be reported as missing names')
})

await test('the hidden official trio leaves the PTC surface now that #961 landed', () => {
  // #961 (hide replaced official file tools under PTC presets) is now in the
  // baseline: the replaced read/glob/grep are withdrawn from the PTC
  // presentation whenever their ops replacements are servable, so the trio no
  // longer appears beside the ops surface. This pin used to assert the opposite
  // visibility; it is updated together with that landing on purpose, so the
  // flip stays a reviewable diff instead of a silent expectation change.
  for (const id of ['legacy-default', 'official-swap-off']) {
    const first = evidence[id].first
    const expectedOfficial = id === 'official-swap-off' ? OFFICIAL_TRIO : []
    assert.deepEqual(first.official, expectedOfficial, id + ' follows the hiding switch')
    assert.deepEqual(first.ops, [I, L, ...OPS_ADMITTED_EXTRA], id + ' publishes the resident surface plus the loader')
  }
  assert.deepEqual(evidence['legacy-default'].first.ops, evidence['official-swap-off'].first.ops,
    'the shipped switch stays inert for PTC rows even with #961 present')
})

report('ptc-two-tier-matrix')
