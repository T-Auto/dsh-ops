/** Independent resident/dynamic switches exercised through the shipped merged row. */
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { apply } from '../lib/index.js'
import { Config, resolveMergedConfig, effectiveMode } from '../lib/settings/merged.js'
import { modeFields, resolveModeConfig } from '../lib/modes/config.js'
import { NATIVE_RESIDENT_RAW } from '../lib/modes/plan.js'
import { PTC_RESIDENT_TOOLS } from '../lib/ptc/config.js'
import { publicToolName, BASH_TOOL } from '../lib/policy.js'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

await test('resident settings exist only on enhanced presets, default on, and have no global gate', () => {
  const config = resolveMergedConfig()
  assert.equal(config.minimal.config.residentTools, false)
  assert.equal('residentTools' in Config.dict.minimal.dict, false)
  assert.equal('residentTools' in modeFields('minimal'), false)
  assert.equal('residentTools' in Config.dict.global.dict, false)
  assert.throws(() => resolveMergedConfig({ global: { residentTools: false } }), /unknown global key/)
  for (const mode of ['standard', 'ptc', 'cordis']) {
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
const names = (ctx, agent) => scopedToolNames(ctx, agent)
const call = (ctx, agent, raw, args) => ctx.get('tools').execute({ agent, name: publicToolName(raw), arguments: args,
  callId: 'resident-' + ++sequence, signal: new AbortController().signal })
const step = (ctx, agent) => ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: ++sequence,
  signal: new AbortController().signal }, async () => ({ kind: 'continue' }))
async function scoped(parent, key, parentKey) {
  let result
  await parent.plugin({ inject: ['tools'], apply(inner) {
    result = createScope(inner, key, parentKey ? { parent: parentKey } : undefined).ctx
  } })
  return result
}
async function setup(cwd, mode, switches, global = {}, override = {}) {
  const { ctx } = await bootHost()
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'danger-full-access', workspaceRoot: cwd, sessionId: session?.id }) })
  const presets = new Map(), agents = []
  ctx.provide('agents', { list: () => [...agents] })
  ctx.provide('agentPresets', { composedPreset: inner => presets.get(scopeParentOf(scopeOf(inner))) })
  const config = { global, discovery: { binaryPath: WORKER, required: true } }
  for (const id of ['minimal', 'standard', 'ptc', 'cordis']) config[id] = { enabled: id === mode,
    binaryPath: WORKER, required: true, ...(id === mode ? switches : {}) }
  await ctx.plugin({ name: 'resident-switch-fixture', apply: inner => apply(inner, { ...config, ...override }) })
  const id = 'resident-' + ++sequence, preset = await scoped(ctx, { preset: id })
  presets.set(scopeOf(preset), mode)
  for (const name of ['read', 'glob', 'grep']) preset.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
  const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd }, append() {}, read() { return [] } } }
  agent.ctx = await scoped(preset, agent, scopeOf(preset))
  if (mode === 'ptc') await agent.ctx.plugin({ inject: ['tools'], apply: inner => { inner.tools.presentAs('ptc') } })
  agents.push(agent)
  await ctx.serial('agent/created', { agent })
  await step(ctx, agent)
  return { ctx, agent }
}

for (const mode of ['standard', 'cordis']) for (const residentTools of [true, false]) for (const dynamicTools of [true, false]) {
  await test(mode + ': resident=' + residentTools + ', dynamic=' + dynamicTools, () => withTempDir('resident-native', async cwd => {
    const { ctx, agent } = await setup(cwd, mode, { residentTools, dynamicTools })
    try {
      if (residentTools) await waitFor(() => names(ctx, agent).includes(publicToolName('read_files')))
      if (dynamicTools) await waitFor(() => names(ctx, agent).includes(publicToolName('discover_tools')))
      for (const raw of NATIVE_RESIDENT_RAW) assert.equal(names(ctx, agent).includes(publicToolName(raw)), residentTools, raw)
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

for (const residentTools of [true, false]) for (const dynamicTools of [true, false]) {
  await test('PTC: resident=' + residentTools + ', dynamic=' + dynamicTools, () => withTempDir('resident-ptc', async cwd => {
    const { ctx, agent } = await setup(cwd, 'ptc', { residentTools, dynamicTools, alwaysLoaded: ['stat'] })
    try {
      if (residentTools) await waitFor(() => names(ctx, agent).includes(publicToolName(PTC_RESIDENT_TOOLS[0])))
      if (dynamicTools) await waitFor(() => names(ctx, agent).includes(publicToolName('load_sdk')))
      for (const raw of [...PTC_RESIDENT_TOOLS, 'stat']) assert.equal(names(ctx, agent).includes(publicToolName(raw)), residentTools, raw)
      assert.equal(names(ctx, agent).includes(publicToolName('load_sdk')), dynamicTools, 'mode dynamicTools reaches the PTC gate')
      assert.equal(names(ctx, agent).includes(BASH_TOOL), process.platform === 'win32', 'PTC file switches never gate Bash')
      if (dynamicTools) {
        const requested = residentTools ? ['stat'] : ['stat', ...PTC_RESIDENT_TOOLS]
        const selected = await ctx.get('tools').execute({ agent, name: 'run_code',
          arguments: { description: 'Load progressive OPS APIs', code: `return await tools.ops_load_sdk({tools:${JSON.stringify(requested)}})` },
          callId: 'resident-' + ++sequence, signal: new AbortController().signal })
        assert.equal(selected.isError, false, JSON.stringify(selected))
        assert.equal(selected.value.result.status, 'completed', JSON.stringify(selected))
        await step(ctx, agent)
        assert.ok(names(ctx, agent).includes(publicToolName('stat')), 'progressive selection works with resident off')
        if (!residentTools) for (const raw of PTC_RESIDENT_TOOLS) assert.ok(names(ctx, agent).includes(publicToolName(raw)), raw + ' remains loadable')
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
report('resident-switch')
