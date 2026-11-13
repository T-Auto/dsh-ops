/** Independent resident/dynamic switches exercised through the shipped merged row. */
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply } from '../lib/index.js'
import { Config, resolveMergedConfig, effectiveMode } from '../lib/settings/merged.js'
import { modeFields, resolveModeConfig } from '../lib/modes/config.js'
import { NATIVE_RESIDENT_RAW } from '../lib/modes/plan.js'
import { PTC_RESIDENT_TOOLS } from '../lib/ptc/config.js'
import { publicToolName, BASH_TOOL } from '../lib/policy.js'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { prepareStep, executeCall, selectExecutor } from './lib/executor.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { providePublicationAuthorities } from './lib/resident.mjs'

await test('resident settings exist only on enhanced presets, default on, and have no global gate', () => {
  const config = resolveMergedConfig()
  assert.equal(config.minimal.config.residentTools, false)
  assert.equal('residentTools' in Config.dict.minimal.dict, false)
  assert.equal('residentTools' in modeFields('minimal'), false)
  assert.equal('residentTools' in Config.dict.global.dict, false)
  assert.throws(() => resolveMergedConfig({ global: { residentTools: false } }), /unknown global key/)
  for (const mode of ['standard', 'ptc', 'ops-ptc', 'cordis']) {
    assert.equal(config[mode].config.residentTools, true, mode)
    assert.equal(Config.dict[mode].dict.residentTools.type, 'boolean')
    assert.equal(modeFields(mode).residentTools.type, 'boolean')
    assert.throws(() => resolveMergedConfig({ [mode]: { residentTools: 'false' } }), /residentTools must be boolean/)
    for (const residentTools of [true, false]) for (const dynamicTools of [true, false]) {
      const resolved = resolveMergedConfig({ [mode]: { residentTools, dynamicTools } })
      assert.equal(effectiveMode(resolved[mode], resolved.global).residentTools, residentTools)
      assert.equal(effectiveMode(resolved[mode], resolved.global).dynamicTools, dynamicTools)
    }
  }
  const minimal = resolveMergedConfig({ minimal: { residentTools: true } })
  assert.equal(minimal.minimal.config.residentTools, false)
  assert.equal(effectiveMode(minimal.minimal, minimal.global).residentTools, false)
  assert.equal(resolveModeConfig({ residentTools: true }, 'minimal').residentTools, false)
})

requireWorker('resident-switch')
let sequence = 0
const names = (ctx, agent) => ctx.get('tools').definitions(agent, agent.prepared?.toolSet).map(tool => tool.name).sort()
const call = (ctx, agent, raw, args) => executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name: publicToolName(raw), arguments: args,
  callId: 'resident-' + ++sequence, signal: new AbortController().signal })
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
async function setup(cwd, mode, switches, global = {}, override = {}) {
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'danger-full-access', workspaceRoot: cwd, sessionId: session?.id }) })
  const presets = new Map(), agents = []
  providePublicationAuthorities(ctx, agents)
  ctx.provide('agentPresets', { composedPreset: inner => presets.get(scopeParentOf(scopeOf(inner))) })
  const config = { global, discovery: { binaryPath: WORKER, required: true } }
  for (const id of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) config[id] = { enabled: id === mode,
    binaryPath: WORKER, required: true, ...(id === mode ? switches : {}) }
  await ctx.plugin({ name: 'resident-switch-fixture', apply: inner => apply(inner, { ...config, ...override }) })
  const id = 'resident-' + ++sequence, preset = await scoped(ctx, { preset: id })
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

for (const mode of ['standard', 'cordis']) for (const residentTools of [true, false]) for (const dynamicTools of [true, false]) {
  await test(mode + ': resident=' + residentTools + ', dynamic=' + dynamicTools, () => withTempDir('resident-native', async cwd => {
    const { ctx, agent } = await setup(cwd, mode, { residentTools, dynamicTools })
    try {
      if (residentTools) await waitFor(() => names(ctx, agent).includes(publicToolName('inspect_local_file')))
      if (dynamicTools) await waitFor(() => names(ctx, agent).includes(publicToolName('discover_tools')))
      for (const raw of NATIVE_RESIDENT_RAW) assert.equal(names(ctx, agent).includes(publicToolName(raw)), residentTools, raw)
      for (const raw of ['read_files', 'result']) assert.equal(names(ctx, agent).includes(publicToolName(raw)), false, raw + ' starts deferred regardless of the resident switch')
      assert.equal(names(ctx, agent).includes(publicToolName('discover_tools')), dynamicTools)
      assert.equal(names(ctx, agent).includes(BASH_TOOL), process.platform === 'win32', 'resident/dynamic never gate Bash')
      if (!residentTools) for (const raw of ['read', 'glob', 'grep']) assert.ok(names(ctx, agent).includes(raw), raw + ' remains official')
      if (dynamicTools) {
        const selected = await call(ctx, agent, 'discover_tools', { query: 'select:' + publicToolName('glob') })
        assert.deepEqual(selected.value.activated, residentTools ? [] : [publicToolName('glob')])
        if (!residentTools) {
          assert.equal(names(ctx, agent).includes(publicToolName('glob')), false, 'next-step activation only')
          await step(ctx, agent)
          assert.ok(names(ctx, agent).includes(publicToolName('glob')), 'resident-off tools remain discoverable')
        }
      }
    } finally { await shutdown(ctx) }
  }))
}

for (const mode of ['ptc', 'ops-ptc']) for (const residentTools of [true, false]) for (const dynamicTools of [true, false]) {
  await test(mode + ': resident=' + residentTools + ', dynamic=' + dynamicTools, () => withTempDir('resident-ptc', async cwd => {
    const { ctx, agent } = await setup(cwd, mode, { residentTools, dynamicTools, alwaysLoaded: ['stat'], allowedTools: ['stat'] })
    try {
      if (residentTools) await waitFor(() => names(ctx, agent).includes(publicToolName(PTC_RESIDENT_TOOLS[0])))
      if (dynamicTools) await waitFor(() => names(ctx, agent).includes(publicToolName('load_sdk')))
      for (const raw of [...PTC_RESIDENT_TOOLS, 'stat']) assert.equal(names(ctx, agent).includes(publicToolName(raw)), residentTools, raw)
      assert.equal(names(ctx, agent).includes(publicToolName('load_sdk')), dynamicTools, 'mode dynamicTools reaches the PTC gate')
      assert.equal(names(ctx, agent).includes(BASH_TOOL), process.platform === 'win32', 'PTC file switches never gate Bash')
      if (dynamicTools) {
        const requested = residentTools ? ['stat'] : ['stat', 'result']
        const selected = await executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name: 'run_code',
          arguments: { description: 'Load progressive OPS APIs', code: `const selected = await tools.ops_load_sdk({tools:${JSON.stringify(requested)}});
            const blocked = await tools.ops_load_sdk({tools:['inspect_local_file']}); return {selected,blocked}` },
          callId: 'resident-' + ++sequence, signal: new AbortController().signal })
        assert.equal(selected.isError, false, JSON.stringify(selected))
        assert.equal(selected.value.result.selected.status, 'completed', JSON.stringify(selected))
        if (!residentTools) assert.equal(selected.value.result.blocked.error.code, 'INVALID_ARGUMENT', JSON.stringify(selected))
        await step(ctx, agent)
        assert.ok(names(ctx, agent).includes(publicToolName('stat')), 'progressive selection works with resident off')
        if (!residentTools) {
          assert.ok(names(ctx, agent).includes(publicToolName('result')), 'result exception remains loadable')
          for (const raw of ['inspect_local_file', 'read_files']) assert.equal(names(ctx, agent).includes(publicToolName(raw)), false, raw + ' is not implicitly loadable')
        }
      }
    } finally { await shutdown(ctx) }
  }))
}

await test('Minimal YAML cannot enable resident tools', () => withTempDir('resident-minimal', async cwd => {
  const { ctx, agent } = await setup(cwd, 'minimal', { residentTools: true, dynamicTools: true })
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName('discover_tools')))
    for (const raw of NATIVE_RESIDENT_RAW) assert.equal(names(ctx, agent).includes(publicToolName(raw)), false)
    assert.deepEqual((await call(ctx, agent, 'discover_tools', { query: 'select:' + publicToolName('glob') })).value.activated, [publicToolName('glob')])
  } finally { await shutdown(ctx) }
}))

await test('bundle dynamic off suppresses the PTC loader, not baseline APIs', () => withTempDir('resident-global', async cwd => {
  const { ctx, agent } = await setup(cwd, 'ptc', { residentTools: true, dynamicTools: true }, { dynamicTools: false })
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName(PTC_RESIDENT_TOOLS[0])))
    assert.equal(names(ctx, agent).includes(publicToolName('load_sdk')), false)
  } finally { await shutdown(ctx) }
}))
await test('Native discovery disabled does not disable the independent typed PTC loader', () => withTempDir('ptc-native-discovery-off', async cwd => {
  const { ctx, agent } = await setup(cwd, 'ptc', { residentTools: true, dynamicTools: true }, {}, { discovery: { enabled: false, binaryPath: WORKER, required: true } })
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName('load_sdk')))
    assert.equal(names(ctx, agent).includes(publicToolName('discover_tools')), false)
  } finally { await shutdown(ctx) }
}))
await test('a row with batchingGuidance off publishes no notice at all', () => withTempDir('batching-off', async cwd => {
  const { ctx, agent } = await setup(cwd, 'ops-ptc', { residentTools: true, dynamicTools: true,
    batchingGuidance: false, alwaysLoaded: ['stat'], allowedTools: ['stat'] })
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName('stat')))
    // The same program earns a plan notice on a row that enabled the switch.
    const result = await executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name: 'run_code',
      arguments: { description: 'Thin fixture', code: 'const r = await tools.ops_stat({ path: "a" })\nreturn r.status' },
      callId: 'batching-off-' + ++sequence, signal: new AbortController().signal })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal((result.additionalContexts ?? []).length, 0, 'switch off: no listener, therefore no notice')
  } finally { await shutdown(ctx) }
}))

/** Drive the real agent pre-step waterfall once, exactly as the host loop does. */
const drivePreStep = async (agent, turn) => {
  const accepted = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Start the task.' }] })
  return agent.ctx.waterfall('agent/pre-step', {
    agent, messages: [accepted], turn, step: 1, signal: new AbortController().signal,
    modelSelection: { provider: 'fixture', model: 'capture' },
  }, async () => ({ kind: 'enter', messages: [accepted] }))
}
/** Plugin-authored contexts appended to the accepted user batch. */
const stepTailMessages = decision => decision.messages.filter(message => message.source?.kind === 'dsh-ops:step-tail')

await test('ops-ptc batchingGuidance teaches until the lesson is committed to history', () => withTempDir('batching-teach', async cwd => {
  const { ctx, agent } = await setup(cwd, 'ops-ptc', { residentTools: true, dynamicTools: true,
    batchingGuidance: true, alwaysLoaded: ['stat'], allowedTools: ['stat'] })
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName('stat')))
    const first = stepTailMessages(await drivePreStep(agent, 1))
    assert.equal(first.length, 1, JSON.stringify(first))
    assert.equal(first[0].source.contributor, 'batching-guidance')
    assert.match(JSON.stringify(first), /Batch tool calls/)
    assert.match(JSON.stringify(first), /not a user instruction or authorization/)
    // The pre-step decision is not the commit point: a batch withdrawn before
    // admission never becomes history, so the lesson must be offered again.
    assert.equal(stepTailMessages(await drivePreStep(agent, 2)).length, 1, 'an uncommitted lesson is offered again')
    // Once the host reports the durable message, the lesson is spent for the session.
    await ctx.serial('session/event', agent.session, { type: 'user/message', data: { source: first[0].source } })
    assert.equal(stepTailMessages(await drivePreStep(agent, 3)).length, 0, 'a committed lesson is never repeated')
  } finally { await shutdown(ctx) }
}))

await test('ops-ptc without batchingGuidance teaches nothing on the first turn', () => withTempDir('batching-teach-off', async cwd => {
  const { ctx, agent } = await setup(cwd, 'ops-ptc', { residentTools: true, dynamicTools: false,
    batchingGuidance: false, alwaysLoaded: ['stat'], allowedTools: ['stat'] })
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName('stat')))
    assert.equal(stepTailMessages(await drivePreStep(agent, 1)).length, 0)
  } finally { await shutdown(ctx) }
}))

await test('the root run_code trigger answers on its own tool result', () => withTempDir('batching-trigger-live', async cwd => {
  const { ctx, agent } = await setup(cwd, 'ops-ptc', { residentTools: true, dynamicTools: true,
    batchingGuidance: true, alwaysLoaded: ['stat'], allowedTools: ['stat'] })
  try {
    await waitFor(() => names(ctx, agent).includes(publicToolName('stat')))
    const run = code => executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name: 'run_code',
      arguments: { description: 'shape fixture', code }, callId: 'shape-' + ++sequence, signal: new AbortController().signal })
    const contexts = result => result.additionalContexts ?? []
    const text = result => JSON.stringify(contexts(result))
    // A compliant program earns nothing, which is what keeps the notice meaningful.
    const good = await run('// plan: stat one path; stat another\nconst [a, b] = await Promise.all([tools.ops_stat({ path: "a" }), tools.ops_stat({ path: "b" })])\nreturn { a, b }')
    assert.equal(good.isError, false, JSON.stringify(good))
    assert.equal(contexts(good).length, 0, 'a compliant program earns no notice')
    // No plan line: the plan category speaks, and it says only that the comment is missing.
    const thin = await run('const r = await tools.ops_stat({ path: "a" })\nreturn r.status')
    assert.equal(thin.isError, false, JSON.stringify(thin))
    assert.match(text(thin), /did not open with a plan line/, 'the plan notice rides the root result')
    assert.doesNotMatch(text(thin), /Promise\.all/, 'the plan notice stays about the comment')
    // A shell listing is a bypass; the notice names the API that replaces it.
    const bypass = await run('const r = await tools.ops_bash({ description: "list", command: "ls -la" })\nreturn r.stdout.text')
    assert.match(text(bypass), /ops_glob/, 'the bypass notice names the listing tool')
    // The trigger appends context and never rewrites the tool result itself.
    assert.equal(thin.value.result, 'completed', JSON.stringify(thin.value))
  } finally { await shutdown(ctx) }
}))

report('resident-switch')
