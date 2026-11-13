import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
/**
 * The four enhanced-preset mode rows, the Compatibility switch and the dynamic
 * loading entry, on a real host.
 *
 * Every scenario boots the real Cordis host, the real tool/prompt registries and
 * real registration scopes; only the preset roster is a stub, answering
 * `composedPreset(agent.ctx)` the way the host's registry does. Official tools
 * live in the preset composition scope (the agent scope's parent), which is the
 * only place an agent-scope restriction may hide: the host refuses to hide a
 * same-scope registration.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import * as Standard from '../lib/components/mode-standard/index.js'
import * as Cordis from '../lib/components/mode-cordis/index.js'
import * as Ptc from '../lib/components/mode-ptc/index.js'
import * as OpsPtc from '../lib/components/mode-ops-ptc/index.js'
import { MODE_IDS, MODE_PRESET } from '../lib/modes/types.js'
import { PTC_RESIDENT_TOOLS } from '../lib/ptc/config.js'
process.env.DSH_OPS_LEGACY_ROWS = '1'
import * as Discovery from '../lib/components/discovery/index.js'
import { BASH_TOOL, modeSectionName, publicToolName } from '../lib/policy.js'
import { MODE_PLANS, residentTools } from '../lib/modes/plan.js'
import { replacementTargets } from '../lib/modes/apply.js'
import { mountReplacements } from '../lib/publication/replacements.js'
import { WORKER } from './lib/boundary.mjs'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, test, report, skipSuite, wait, waitFor, withTempDir } from './lib/harness.mjs'

const OFFICIAL = ['read', 'glob', 'grep', 'write']
const RESIDENT = ['ops_inspect_local_file', 'ops_glob', 'ops_grep']
const tool = name => ({ name, description: `fixture ${name}`, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })

/** A scope that inherits the tools dependency API, so registrations and restrictions work. */
async function scopedContext(parent, key, parentKey) {
  let scoped
  await parent.plugin({ inject: ['tools'], apply(inner) { scoped = createScope(inner, key, parentKey ? { parent: parentKey } : undefined).ctx } })
  return scoped
}

/** One real host: services, a preset-identity stub, and helper accessors. */
async function boot() {
  const { ctx } = await bootHost()
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  // The native file row's injection prerequisites; a missing service would leave
  // it mounted but never activated, which looks exactly like a gating bug.
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }) })
  const presets = new Map()
  ctx.provide('agentPresets', { composedPreset: scoped => presets.get(scopeParentOf(scopeOf(scoped))) })
  // The host's live-agent roster: reconcile passes relist it after a preset change.
  const live = []
  ctx.provide('agents', { list: () => [...live] })
  const names = agent => scopedToolNames(ctx, agent)
  const assemble = async agent => { const step = await prepareStep(ctx, agent); try { return step.assembly } finally { step.dispose() } }
  const sections = async agent => (await assemble(agent)).sections
  let sequence = 0
  /**
   * Mint one agent whose official tools live in the preset parent scope.
   * @returns the live agent record.
   */
  const mint = async ({ id = 'agent-' + ++sequence, preset, presentation, cwd }) => {
    const presetScope = await scopedContext(ctx, { preset: `${id}-preset` })
    presets.set(scopeOf(presetScope), preset)
    for (const name of OFFICIAL) presetScope.tools.register(tool(name))
    const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd } } }
    agent.ctx = await scopedContext(presetScope, agent, scopeOf(presetScope))
    if (presentation) await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, presentation) } })
    live.push(agent)
    await ctx.serial('agent/created', { agent, source: 'startup' })
    return agent
  }
  const before = () => ctx.get('tools')
  return { ctx, presets, names, assemble, sections, mint, tools: before }
}

/** The activation targets are pure data; assert them without a host or worker. */
await test('replacement targets map each mode to the tools it hides, platform by platform', () => {
  const win = replacementTargets('standard', 'win32', true)
  assert.equal(win.get('read'), publicToolName('inspect_local_file'))
  assert.equal(win.get('glob'), publicToolName('glob'))
  assert.equal(win.get('grep'), publicToolName('grep'))
  assert.equal(win.get('pwsh'), BASH_TOOL)
  assert.equal(win.get('pwsh_persistent'), BASH_TOOL)
  assert.equal(replacementTargets('standard', 'win32').has('pwsh'), false, 'default Bash publication does not replace PowerShell')
  assert.equal(win.has('write'), false, 'write has no reviewed replacement')
  const linux = replacementTargets('standard', 'linux')
  assert.equal(linux.has('pwsh'), false, 'POSIX keeps the host bash')
  assert.equal(replacementTargets('cordis', 'win32').get('read'), publicToolName('inspect_local_file'))
  // Minimal, PTC and its ops-ptc sibling replace only the Windows shell; their
  // file tools stay official.
  for (const mode of ['minimal', 'ptc', 'ops-ptc']) {
    const targets = replacementTargets(mode, 'win32', true)
    assert.deepEqual([...targets.keys()].sort(), ['pwsh', 'pwsh_persistent'].sort(), mode)
    assert.equal([...targets.values()].every(value => value === BASH_TOOL), true, mode)
    assert.equal(replacementTargets(mode, 'linux', true).size, 0, `${mode} replaces nothing on POSIX`)
  }
  assert.deepEqual(residentTools('standard'), RESIDENT)
  assert.deepEqual(residentTools('cordis'), RESIDENT)
  assert.deepEqual(residentTools('minimal'), [])
  assert.deepEqual(residentTools('ptc'), [])
  assert.equal(MODE_PLANS.minimal.section, null)
  assert.equal(MODE_PLANS.ptc.section, 'ptc')
  // The fifth mode is the PTC plan plus the batching-guidance gate: it publishes
  // the same PTC surface, no Native residents and no discovery population.
  assert.equal(MODE_IDS.includes('ops-ptc'), true)
  assert.equal(MODE_PRESET['ops-ptc'], 'ops-ptc')
  assert.deepEqual(residentTools('ops-ptc'), [])
  assert.deepEqual({ ...MODE_PLANS['ops-ptc'], section: MODE_PLANS.ptc.section }, { ...MODE_PLANS.ptc })
  assert.equal(MODE_PLANS['ops-ptc'].section, 'ops-ptc')
})

if (!fs.existsSync(WORKER)) skipSuite('modes', `no native worker at ${path.relative(process.cwd(), WORKER)}; run npm run build:ptc`)

await test('mode-standard publishes resident OPS tools only for its preset and hides its official counterparts', () => withTempDir('mode-standard', async cwd => {
  const { ctx, names, assemble, mint } = await boot()
  try {
    const standard = await ctx.plugin(Standard, { required: true, promptPolicy: true })
    const own = await mint({ preset: 'standard', cwd })
    await waitFor(() => names(own).includes('ops_inspect_local_file'), { what: 'standard resident publication' })
    for (const name of RESIDENT) assert.ok(names(own).includes(name), `${name} in ${names(own).join(', ')}`)
    assert.ok(names(own).includes('write'), 'unreplaced official mutation tools stay visible')
    for (const name of OFFICIAL) assert.ok(names(own).includes(name), 'conditional counterpart retains official visibility')
    const held = await prepareStep(ctx, own)
    try { for (const name of ['read','glob','grep']) assert.equal((await executeCall(ctx, { agent: own, name, arguments: {}, toolSet: held.toolSet })).isError, true) } finally { held.dispose() }
    assert.equal(names(own).includes('ops_bash'), process.platform === 'win32', 'the Windows shell replacement publishes ops_bash')
    const section = (await assemble(own)).sections.find(entry => entry.name === modeSectionName('mode-standard'))
    assert.ok(section && String(section.text).includes('ops_inspect_local_file'), 'the mode-standard routing section names the surface')
    // A different preset with no mode row mounted sees no OPS surface at all and
    // keeps every official tool.
    const other = await mint({ preset: 'cordis', cwd })
    await wait(300)
    assert.deepEqual(names(other).filter(name => name.startsWith('ops_')), [], 'an unenhanced preset receives no OPS tools')
    for (const name of OFFICIAL) assert.ok(names(other).includes(name), `${name} unchanged for the unenhanced preset`)
    const foreignSections = (await assemble(other)).sections.filter(entry => entry.name.startsWith('dsh-ops:repository-tooling:mode-'))
    assert.equal(foreignSections.some(entry => String(entry.text).trim() !== ''), false, 'no mode routing text leaks to another preset')
    await standard.dispose()
  } finally { await shutdown(ctx) }
}))

/**
 * Creating a session must not cost work proportional to the sessions already
 * open. The replacement controller reads one Agent's tool view per `plan`, so a
 * full pass per creation made every new session pay O(live sessions) view copies
 * — the regression this test pins, measured as a count rather than a duration: a
 * count is stable on a loaded machine where a millisecond budget is not.
 *
 * The controller is mounted alone here. A whole mode row also publishes Native
 * tools and follows the host's own layer changes, and those costs belong to
 * their own controllers; this test is about the replacement pass, which is the
 * one that scaled with the number of open sessions.
 */
await test('creating a session does not re-plan every live session', () => withTempDir('mode-create-cost', async cwd => {
  const { ctx } = await bootHost()
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }) })
  const live = []
  ctx.provide('agents', { list: () => [...live] })
  const presets = new Map()
  ctx.provide('agentPresets', { composedPreset: scoped => presets.get(scopeParentOf(scopeOf(scoped))) })
  const targets = replacementTargets('standard', 'win32', true)
  const mounted = ctx.plugin({ name: 'fixture-replacements', apply(inner) {
    mountReplacements(inner, { id: 'standard', targets, gate: { allows: () => true }, keepOfficial: () => false })
  } })
  let sequence = 0
  /** One live session: its preset scope holds the official tools, its own scope the OPS ones. */
  const prepare = async () => {
    const id = 'cost-agent-' + (++sequence)
    const presetScope = await scopedContext(ctx, { preset: `${id}-preset` })
    presets.set(scopeOf(presetScope), 'standard')
    for (const name of OFFICIAL) presetScope.tools.register(tool(name))
    const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd } } }
    agent.ctx = await scopedContext(presetScope, agent, scopeOf(presetScope))
    // A replacement is hidden only while its counterpart is visible in the same
    // scope, so the fixture publishes the counterparts the real row would.
    for (const counterpart of new Set(targets.values())) agent.ctx.tools.register(tool(counterpart))
    return agent
  }
  try {
    await mounted
    const tools = ctx.get('tools')
    const original = tools.definitions.bind(tools)
    let views = 0
    tools.definitions = (...args) => { views += 1; return original(...args) }
    let baseline
    // Twelve sessions first, so what is measured is the thirteenth.
    for (let index = 0; index < 12; index++) {
      const agent = await prepare()
      live.push(agent)
      views = 0
      await ctx.serial('agent/created', { agent, source: 'startup' })
      baseline ??= views
    }
    const another = await prepare()
    live.push(another)
    views = 0
    await ctx.serial('agent/created', { agent: another, source: 'startup' })
    // One view plans the new Agent. A pass over the twelve already-open sessions
    // shows up here as thirteen, which is the regression.
    assert.ok(views <= baseline, `creating a session read ${views} tool views with twelve sessions open; it must not re-plan them`)
    // The saving must not be a mask that was never applied.
    const step = await prepareStep(ctx, another)
    try {
      const declared = step.assembly.tools.map(tool => tool.name)
      assert.ok(OFFICIAL.filter(name => name !== 'write').every(name => !declared.includes(name)), 'the new session omits replaced official declarations')
    } finally { step.dispose() }
    tools.definitions = original
  } finally { await shutdown(ctx) }
}))

await test('hideOfficialTools false keeps official tools alongside residents', () => withTempDir('mode-coexist', async cwd => {
  const { ctx, names, mint, assemble } = await boot()
  try {
    await ctx.plugin(Standard, { required: true, promptPolicy: true, hideOfficialTools: false })
    const agent = await mint({ preset: 'standard', cwd })
    await waitFor(() => names(agent).includes('ops_inspect_local_file'))
    for (const name of OFFICIAL) assert.ok(names(agent).includes(name), name)
    for (const name of RESIDENT) assert.ok(names(agent).includes(name), name)
  } finally { await shutdown(ctx) }
}))

await test('disposing a mode row withdraws both its OPS surface and its replacements', () => withTempDir('mode-dispose', async cwd => {
  const { ctx, names, mint, assemble } = await boot()
  try {
    const row = await ctx.plugin(Standard, { required: true, promptPolicy: true })
    const agent = await mint({ preset: 'standard', cwd })
    await waitFor(() => names(agent).includes('ops_inspect_local_file') && names(agent).includes('read'), { what: 'mode applied' })
    await row.dispose()
    await waitFor(() => RESIDENT.every(name => !names(agent).includes(name)), { what: 'resident tools withdrawn with the row' })
    await waitFor(() => OFFICIAL.every(name => names(agent).includes(name)), { what: 'official tools restored with the row' })
    assert.equal(names(agent).includes('ops_bash'), false, 'the Windows shell replacement is withdrawn too')
  } finally { await shutdown(ctx) }
}))

await test('mode-cordis serves its own preset with the same resident surface and section', () => withTempDir('mode-cordis', async cwd => {
  const { ctx, names, sections, mint } = await boot()
  try {
    const row = await ctx.plugin(Cordis, { required: true, promptPolicy: true })
    const agent = await mint({ preset: 'cordis', cwd })
    await waitFor(() => names(agent).includes('ops_inspect_local_file') && names(agent).includes('read'), { what: 'cordis mode applied' })
    for (const name of RESIDENT) assert.ok(names(agent).includes(name), name)
    assert.ok((await sections(agent)).some(section => section.name === modeSectionName('mode-cordis') && String(section.text).includes('ops_inspect_local_file')), 'cordis routing section')
    // The Standard row is not mounted here, so a Standard-preset agent stays untouched.
    const standard = await mint({ preset: 'standard', cwd })
    await wait(300)
    assert.deepEqual(names(standard).filter(name => name.startsWith('ops_')), [])
    for (const name of OFFICIAL) assert.ok(names(standard).includes(name), name)
    await row.dispose()
  } finally { await shutdown(ctx) }
}))

await test('dynamic loading serves Minimal always and enabled modes, and never PTC-only presentation', () => withTempDir('mode-discovery', async cwd => {
  const { ctx, names, mint, assemble } = await boot()
  try {
    await ctx.plugin(Discovery, { required: true })
    // The Minimal preset always receives the entry, with no mode-minimal row mounted.
    const minimal = await mint({ preset: 'minimal', cwd })
    await waitFor(() => names(minimal).includes('ops_discover_tools'), { what: 'minimal discovery entry' })
    assert.deepEqual((await assemble(minimal)).tools.filter(t => t.name.startsWith('ops_')).map(t => t.name), ['ops_discover_tools'])
    for (const name of OFFICIAL) assert.ok(names(minimal).includes(name), `minimal keeps ${name}`)
    // A Standard agent receives it as well once its mode row is enabled, and the
    // resident names are not offered as discovery choices.
    const standardRow = await ctx.plugin(Standard, { required: true, promptPolicy: true })
    const standard = await mint({ preset: 'standard', cwd })
    await waitFor(() => names(standard).includes('ops_inspect_local_file') && names(standard).includes('ops_discover_tools'), { what: 'standard discovery entry' })
    const discover = names(standard).includes('ops_discover_tools') && ctx.get('tools').get('ops_discover_tools', standard)
    const residentChoice = (await executeCall(ctx, { agent: standard, name: 'ops_discover_tools', arguments: { query: 'select:ops_glob' } })).value
    assert.deepEqual(residentChoice.activated, [], 'a resident mode tool is not a discovery choice')
    const advancedChoice = (await executeCall(ctx, { agent: standard, name: 'ops_discover_tools', arguments: { query: 'select:ops_stat' } })).value
    assert.deepEqual(advancedChoice.activated, [publicToolName('stat')], 'an advanced capability stays discoverable')
    // An unenhanced PTC-preset agent in PTC-only presentation gets no entry.
    ctx.provide('ptcRuntime', { language: 'typescript' })
    const ptcAgent = await mint({ preset: 'ptc', presentation: 'ptc', cwd })
    await wait(400)
    assert.equal((await assemble(ptcAgent)).tools.some(t => t.name === 'ops_discover_tools'), false, 'PTC-only presentation is not a discovery population')
    await standardRow.dispose()
  } finally { await shutdown(ctx) }
}))

await test('PTC mode publishes the scoped SDK surface and replaces only the Windows shell', () => withTempDir('mode-ptc', async cwd => {
  const { ctx, names, mint, assemble } = await boot()
  try {
    const NodePtc = (await import('@deepseek-ai/dsh-ptc-runtime-node')).default
    const FileSystem = (await import('@deepseek-ai/dsh-fs-local')).default
    // The PTC runtime injects fs/subprocess/sandbox/sandboxPolicy; without fs it
    // never activates and the row's presentation probe sees no ptcRuntime.
    await ctx.plugin(FileSystem, {})
    await ctx.plugin(NodePtc, {})
    const row = await ctx.plugin(Ptc, { required: true })
    const agent = await mint({ preset: 'ptc', presentation: 'ptc', cwd })
    await waitFor(() => names(agent).includes('ops_load_sdk'), { what: 'PTC SDK publication' })
    for (const name of OFFICIAL) assert.ok(names(agent).includes(name), `PTC replaces no official file tool; ${name} stays visible`)
    assert.equal(names(agent).includes('ops_bash'), process.platform === 'win32', 'only the Windows shell is replaced')
    // A Standard-preset agent is not served by the PTC row.
    const standard = await mint({ preset: 'standard', cwd })
    await wait(300)
    assert.equal(names(standard).includes('ops_load_sdk'), false)
    await row.dispose()
  } finally { await shutdown(ctx) }
}))

await test('a preset selection change withdraws the old mode surface and the new row takes over', () => withTempDir('mode-switch', async cwd => {
  const { ctx, presets, names, sections, mint } = await boot()
  try {
    await ctx.plugin(Standard, { required: true, promptPolicy: true })
    await ctx.plugin(Cordis, { required: true, promptPolicy: true })
    const agent = await mint({ preset: 'standard', cwd })
    await waitFor(() => names(agent).includes('ops_inspect_local_file') && names(agent).includes('read'), { what: 'standard mode applied' })
    assert.ok((await sections(agent)).some(section => section.name === modeSectionName('mode-standard') && String(section.text).length > 0))
    // A blank session may select another preset before its first turn.
    presets.set(scopeParentOf(scopeOf(agent.ctx)), 'cordis')
    await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' })
    const waitForSection = async (name, what) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await sections(agent)).some(section => section.name === name && String(section.text).length > 0)) return
        await wait(50)
      }
      throw new Error(`timed out waiting for ${what}`)
    }
    assert.ok(names(agent).includes('read'), 'conditional replacement leaves official schema visible')
    await waitForSection(modeSectionName('mode-cordis'), 'the cordis routing section')
    assert.ok(names(agent).includes('ops_inspect_local_file'), 'the new matching row publishes the resident surface')
    assert.equal(names(agent).includes('read'), true, 'conditional counterpart is guarded, not statically hidden')
    presets.set(scopeParentOf(scopeOf(agent.ctx)), 'standard')
    await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' })
    await waitForSection(modeSectionName('mode-standard'), 'the standard routing section to return')
  } finally { await shutdown(ctx) }
}))

await test('a mode row keeps one consumer state per Cordis root', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { joinMode, enabledModes } = await import('../lib/modes/registry.js')
  const ctx = new Context(); ctx.logger.level = 0
  try {
    const firstConfig = { residentTools: true }, secondConfig = { residentTools: false }
    const first = joinMode(ctx, 'ops-ptc', firstConfig)
    const second = joinMode(ctx, 'ops-ptc', secondConfig)
    assert.equal(enabledModes(ctx).size, 1, 'one row per mode and Cordis root')
    assert.equal(enabledModes(ctx).get('ops-ptc'), secondConfig)
    first()
    assert.equal(enabledModes(ctx).get('ops-ptc'), secondConfig, 'a superseded disposer never removes the newer registration')
    second()
    assert.equal(enabledModes(ctx).has('ops-ptc'), false)
  } finally { await ctx.fiber.dispose() }
})

await test('mode-ops-ptc serves its own preset with the PTC surface, not the plain PTC one', () => withTempDir('mode-ops-ptc', async cwd => {
  const { ctx, names, mint } = await boot()
  try {
    const NodePtc = (await import('@deepseek-ai/dsh-ptc-runtime-node')).default
    const FileSystem = (await import('@deepseek-ai/dsh-fs-local')).default
    await ctx.plugin(FileSystem, {})
    await ctx.plugin(NodePtc, {})
    const row = await ctx.plugin(OpsPtc, { required: true })
    const agent = await mint({ preset: 'ops-ptc', presentation: 'ptc', cwd })
    await waitFor(() => names(agent).includes('ops_load_sdk'), { what: 'ops-ptc SDK publication' })
    // dynamicTools defaults on: the loader is published beside the resident API.
    assert.ok(names(agent).includes('ops_load_sdk'))
    for (const raw of PTC_RESIDENT_TOOLS) assert.ok(names(agent).includes(publicToolName(raw)), raw)
    // The scoped PTC file surface is published, not the Native one.
    for (const raw of ['write_file', 'grep', 'glob']) assert.ok(names(agent).includes(publicToolName(raw)), raw)
    // The PTC presentation is never a discovery population.
    assert.equal(names(agent).includes(publicToolName('discover_tools')), false)
    for (const name of OFFICIAL) assert.ok(names(agent).includes(name), `the PTC file surface keeps official ${name}`)
    // The row serves its own preset only, so the plain PTC and Standard presets get no SDK.
    const plain = await mint({ preset: 'ptc', presentation: 'ptc', cwd })
    const standard = await mint({ preset: 'standard', cwd })
    await wait(300)
    assert.equal(names(plain).includes('ops_load_sdk'), false)
    assert.equal(names(standard).includes('ops_load_sdk'), false)
    await row.dispose()
  } finally { await shutdown(ctx) }
}))

await test('mode-ops-ptc dynamicTools off withdraws the loader but keeps the resident PTC surface', () => withTempDir('mode-ops-ptc-static', async cwd => {
  const { ctx, names, mint } = await boot()
  try {
    const NodePtc = (await import('@deepseek-ai/dsh-ptc-runtime-node')).default
    const FileSystem = (await import('@deepseek-ai/dsh-fs-local')).default
    await ctx.plugin(FileSystem, {})
    await ctx.plugin(NodePtc, {})
    await ctx.plugin(OpsPtc, { required: true, dynamicTools: false })
    const agent = await mint({ preset: 'ops-ptc', presentation: 'ptc', cwd })
    await waitFor(() => names(agent).includes(publicToolName(PTC_RESIDENT_TOOLS[0])), { what: 'resident PTC API' })
    await wait(300)
    // The switch removes progressive disclosure, never the APIs: the pool that would
    // have waited behind the loader is published as resident instead, so a provider
    // that cannot take dynamically added tools still sees the whole surface.
    assert.equal(names(agent).includes('ops_load_sdk'), false)
    for (const raw of PTC_RESIDENT_TOOLS) assert.ok(names(agent).includes(publicToolName(raw)), raw)
    for (const raw of ['write_file', 'grep', 'glob', 'read_files', 'stat', 'result']) {
      assert.ok(names(agent).includes(publicToolName(raw)), 'a loader-less scope publishes ' + raw + ' as resident')
    }
    assert.equal(names(agent).includes(publicToolName('discover_tools')), false)
  } finally { await shutdown(ctx) }
}))

report('modes')
