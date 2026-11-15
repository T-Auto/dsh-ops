/** hideOfficialTools removes the official file tools a PTC projection replaces. */
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as OpsPtc from '../lib/components/mode-ops-ptc/index.js'
import * as Ptc from '../lib/components/mode-ptc/index.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, prepareStep, executeCall } from './lib/executor.mjs'
import { mountReplacements } from '../lib/publication/replacements.js'
import { integration } from '../lib/integration/index.js'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
process.env.DSH_OPS_LEGACY_ROWS = '1'
requireWorker('ptc-hide-official')

const OFFICIAL = ['read', 'glob', 'grep', 'edit', 'write', 'read_image']
const REPLACED = ['read', 'glob', 'grep']
const definition = name => ({ name, description: `fixture ${name}`, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => name })

let serial = 0
async function fixture(cwd, mode, options, body) {
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd, sessionId: 'hide' }) })
    ctx.provide('agentPresets', { composedPreset: () => undefined })
    for (const name of OFFICIAL) ctx.tools.register(definition(name))
    const agents = []
    ctx.provide('agents', { list: () => agents })
    const row = await ctx.plugin(mode === 'ops-ptc' ? OpsPtc : Ptc,
      { required: true, binaryPath: WORKER, bash: false, batchingGuidance: false, ...options })
    const agent = async (presentation = 'ptc', parent) => {
      const id = `hide-${++serial}`
      const value = { id, session: { id, mode: 'danger-full-access',
        header: { cwd, agentPreset: presentation === 'ptc' ? mode : 'native' }, append() {}, read() { return [] } } }
      value.ctx = createScope(parent?.ctx ?? ctx, value).ctx
      await value.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, presentation) } })
      agents.push(value)
      await ctx.serial('agent/created', { agent: value })
      return value
    }
    await body({ ctx, row, agent })
  } finally { await shutdown(ctx) }
}

async function capture(ctx, owner) {
  const step = await prepareStep(ctx, owner)
  try {
    const sdk = step.assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    return { admitted: ctx.get('tools').definitions(owner, step.toolSet).map(tool => tool.name), sdk }
  } finally { step.dispose() }
}
const has = (names, name) => names.includes(name)
// Poll the observable fact instead of sleeping: the replacement shadow registers in its own async inject.
const waitHidden = async (ctx, owner, names) => {
  const deadline = Date.now() + 5000
  while (true) {
    const step = await prepareStep(ctx, owner)
    let admitted
    try { admitted = ctx.get('tools').definitions(owner, step.toolSet).map(tool => tool.name) } finally { step.dispose() }
    if (names.every(name => !admitted.includes(name))) return
    if (Date.now() > deadline) throw new Error('timed out waiting for hidden ' + names.join(', '))
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
const waitPublish = async (ctx, owner, hidden = []) => {
  const deadline = Date.now() + 5000
  while (!ctx.get('tools').definitions(owner).some(tool => tool.name.startsWith('ops_'))) {
    if (Date.now() > deadline) throw new Error('timed out waiting for PTC publication')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (hidden.length) await waitHidden(ctx, owner, hidden)
}

await test('ops-ptc hides the replaced official file tools and keeps the rest', () => withTempDir('hide-default', async cwd => fixture(cwd, 'ops-ptc', {}, async ({ ctx, agent }) => {
  const owner = await agent()
  await waitPublish(ctx, owner, REPLACED)
  const c = await capture(ctx, owner)
  for (const name of REPLACED) {
    assert.equal(has(c.admitted, name), false, name + ' must leave the admitted surface')
    assert.doesNotMatch(c.sdk, new RegExp('(?:^|\\n)\\s*' + name + ':', 'u'), name + ' must leave the SDK declaration')
  }
  for (const name of ['edit', 'write', 'read_image']) assert.ok(has(c.admitted, name), name + ' stays visible')
})))

await test('hideOfficialTools off keeps every official tool', () => withTempDir('hide-off', async cwd => fixture(cwd, 'ops-ptc', { hideOfficialTools: false }, async ({ ctx, agent }) => {
  const owner = await agent()
  await waitPublish(ctx, owner)
  const c = await capture(ctx, owner)
  for (const name of OFFICIAL) assert.ok(has(c.admitted, name), name + ' stays with the switch off')
})))

await test('dynamicTools off keeps glob and grep while read stays replaced', () => withTempDir('hide-dynamic-off', async cwd => fixture(cwd, 'ops-ptc', { dynamicTools: false }, async ({ ctx, agent }) => {
  const owner = await agent()
  await waitPublish(ctx, owner, ['read'])
  const c = await capture(ctx, owner)
  assert.equal(has(c.admitted, 'grep'), true, 'no loader means grep is unreachable')
  assert.equal(has(c.admitted, 'glob'), true, 'no loader means glob is unreachable')
  assert.match(c.sdk, /(?:^|\n)\s*grep:/u, 'the kept official grep is still declared')
  assert.match(c.sdk, /(?:^|\n)\s*glob:/u, 'the kept official glob is still declared')
  assert.equal(has(c.admitted, 'read'), false, 'resident inspect_local_file still replaces read')
  assert.doesNotMatch(c.sdk, /(?:^|\n)\s*read:/u, 'read leaves the SDK while resident')
})))

await test('a narrowed allowedTools pool keeps the official names it excludes', () => withTempDir('hide-narrow', async cwd => fixture(cwd, 'ops-ptc', { allowedTools: ['stat'] }, async ({ ctx, agent }) => {
  const owner = await agent()
  await waitPublish(ctx, owner, ['read'])
  const c = await capture(ctx, owner)
  assert.equal(has(c.admitted, 'grep'), true, 'grep is outside the configured pool')
  assert.equal(has(c.admitted, 'glob'), true, 'glob is outside the configured pool')
})))

await test('residentTools off with a narrow pool keeps every replaced official name', () => withTempDir('hide-resident-off', async cwd => fixture(cwd, 'ops-ptc', { residentTools: false, allowedTools: ['stat'] }, async ({ ctx, agent }) => {
  const owner = await agent()
  await waitPublish(ctx, owner)
  const c = await capture(ctx, owner)
  for (const name of REPLACED) assert.ok(has(c.admitted, name), name + ' has no reachable counterpart')
})))

await test('loading the SDK does not resurrect the official tools', () => withTempDir('hide-load', async cwd => fixture(cwd, 'ops-ptc', {}, async ({ ctx, agent }) => {
  const owner = await agent()
  await waitPublish(ctx, owner, REPLACED)
  const step = await prepareStep(ctx, owner)
  try {
    const run = await executeCall(ctx, { agent: owner, toolSet: step.toolSet, name: 'run_code', callId: 'hide-load',
      arguments: { description: 'Load grep', code: "return await tools.ops_load_sdk({tools:['grep']})" },
      signal: new AbortController().signal })
    assert.equal(run.isError, false, JSON.stringify(run))
  } finally { step.dispose() }
  ctx.emit('session/event', owner.session, { type: 'step/end', turn: 1, step: 1 })
  const after = await capture(ctx, owner)
  assert.equal(has(after.admitted, 'grep'), false, 'selection must not resurrect the official grep')
  assert.ok(has(after.admitted, 'ops_grep'), 'selected OPS grep becomes callable')
})))

await test('a native child of a PTC parent keeps the official file tools', () => withTempDir('hide-tree', async cwd => fixture(cwd, 'ops-ptc', {}, async ({ ctx, agent }) => {
  const parent = await agent('ptc')
  await waitPublish(ctx, parent, REPLACED)
  const child = await agent('native', parent)
  const c = await capture(ctx, child)
  for (const name of REPLACED) assert.ok(has(c.admitted, name), name + ' stays visible to a native child')
})))

await test('a failing presentation probe keeps the official tools', () => withTempDir('hide-probe-fail', async cwd => {
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd, sessionId: 'probe' }) })
    ctx.provide('agentPresets', { composedPreset: () => undefined })
    for (const name of OFFICIAL) ctx.tools.register(definition(name))
    const agents = []
    ctx.provide('agents', { list: () => agents })
    const warnings = []
    ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'warn') warnings.push(message.args.join(' ')) } })
    const owner = { id: 'probe-fail', session: { id: 'probe-fail', mode: 'danger-full-access', header: { cwd }, append() {}, read() { return [] } } }
    owner.ctx = createScope(ctx, owner).ctx
    await owner.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'ptc') } })
    agents.push(owner)
    await ctx.serial('agent/created', { agent: owner })
    const targets = new Map([['read', 'ops_inspect_local_file'], ['glob', 'ops_glob'], ['grep', 'ops_grep']])
    let probes = 0
    await ctx.plugin({ apply(inner) {
      mountReplacements(inner, { id: 'probe-fail', targets, gate: { allows: () => true }, keepOfficial: () => false,
        ptc: { servable: () => new Set(['inspect_local_file', 'glob', 'grep']), isPtc: async () => { probes++; throw new Error('probe failed') } } })
    } })
    // The controller attaches through an async inject callback; let it register before resolving.
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const step = await prepareStep(ctx, owner)
    try {
      const admitted = ctx.get('tools').definitions(owner, step.toolSet).map(tool => tool.name)
      for (const name of REPLACED) assert.ok(admitted.includes(name), name + ' stays visible when the probe fails')
      const failed = warnings.filter(line => line.includes('PTC presentation probe failed'))
      assert.ok(probes >= 1, 'the failing probe was actually consulted')
      assert.equal(failed.length, 1, 'the failure is reported once')
    } finally { step.dispose() }
  } finally { await shutdown(ctx) }
}))

await test('the integration entry hides the replaced official file tools under PTC presentation', () => withTempDir('hide-integration', async cwd => {
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd, sessionId: 'hide-int' }) })
    ctx.provide('agentPresets', { composedPreset: () => undefined })
    for (const name of OFFICIAL) ctx.tools.register(definition(name))
    const agents = []
    ctx.provide('agents', { list: () => agents })
    await ctx.plugin(integration({ preset: 'hide-int', profile: 'ptc', promptPolicy: false,
      replaceOfficial: true, binaryPath: WORKER, required: true }))
    const owner = { id: 'hide-int', session: { id: 'hide-int', mode: 'danger-full-access', header: { cwd, agentPreset: 'hide-int' }, append() {}, read() { return [] } } }
    owner.ctx = createScope(ctx, owner).ctx
    await owner.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'ptc') } })
    agents.push(owner)
    await ctx.serial('agent/created', { agent: owner })
    await waitPublish(ctx, owner, REPLACED)
    const c = await capture(ctx, owner)
    for (const name of REPLACED) assert.equal(c.admitted.includes(name), false, name + ' is hidden through the integration entry')
  } finally { await shutdown(ctx) }
}))

report('ptc-hide-official')
