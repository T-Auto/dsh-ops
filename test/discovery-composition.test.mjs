import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import * as discoveryModule from '../lib/discovery/index.js'
import * as ptcModule from '../lib/ptc/index.js'
import { applyComponent } from '../lib/index.js'
import { definition } from '../lib/file/contract.js'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { legacyComponent } from './lib/legacy-component.mjs'
const discovery = legacyComponent(discoveryModule)
const ptc = legacyComponent(ptcModule)
requireWorker('discovery-composition')
let sequence = 0
const names = (ctx, agent) => ctx.get('tools').schemas(agent).map(tool => tool.name).filter(name => name.startsWith('ops_')).sort()
const step = (ctx, agent) => ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: ++sequence, signal: new AbortController().signal }, async () => ({ kind: 'continue' }))
const call = (ctx, agent, name, args) => ctx.get('tools').execute({ agent, name, arguments: args, callId: 'combined-' + ++sequence, signal: new AbortController().signal })
async function setup(dir, discoveryFirst = true) {
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  const agents = []; ctx.provide('agents', { list: () => agents })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: dir, sessionId: session?.id }) }))
  const config = { binaryPath: WORKER, required: true }
  const mountDiscovery = (target = ctx, extra = {}) => target.plugin({ apply(inner) { discovery.apply(inner, { ...config, ...extra }) } })
  const mountFile = (target = ctx) => target.plugin({ apply(inner) { applyComponent(inner, config, 'file') } })
  let discoverRow
  if (discoveryFirst) discoverRow = await mountDiscovery()
  const codeRow = await ctx.plugin(ptc, config)
  if (discoveryFirst === false) discoverRow = await mountDiscovery()
  async function mint(mode = 'native', parent) {
    const id = 'combined-' + ++sequence, agent = { id, session: { id, mode: 'workspace-write', header: { cwd: dir }, append() {}, read() { return [] } } }
    agent.ctx = createScope(parent?.ctx ?? ctx, agent, parent ? { parent } : undefined).ctx
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(mode) } })
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    return agent
  }
  return { ctx, mint, mountFile, mountDiscovery, discoverRow, codeRow }
}
for (const discoveryFirst of [true, false]) await test('combined Native/PTC/discovery preserves next-step snapshots and late file rows: ' + (discoveryFirst ? 'discovery first' : 'PTC first'), () => withTempDir('discovery-combined', async dir => {
  const { ctx, mint, mountFile, discoverRow } = await setup(dir, discoveryFirst)
  try {
    fs.writeFileSync(path.join(dir, 'sample.txt'), 'small\n')
    const native = await mint(), code = await mint('ptc'), child = await mint('native', code), sibling = await mint('both')
    const fileRow = await mountFile(native.ctx)
    await waitFor(() => names(ctx, native).includes('ops_read_files'))
    for (const scope of [native, child, sibling]) assert.equal(names(ctx, scope).includes('ops_stat'), false)
    const selection = await call(ctx, native, 'ops_discover_tools', { query: 'select:ops_stat' })
    assert.equal(selection.value.status, 'completed', JSON.stringify(selection))
    const before = await ctx.get('systemPrompt').assemble({ scope: native })
    assert.equal(before.tools.some(tool => tool.name === 'ops_stat'), false)
    await step(ctx, native)
    const stat = await call(ctx, native, 'ops_stat', { path: 'sample.txt' })
    assert.equal(stat.value.bytes, 6, JSON.stringify(stat))
    for (const scope of [child, sibling, code]) assert.equal(names(ctx, scope).includes('ops_stat'), false)
    const firstCode = await call(ctx, code, 'run_code', { description: 'Check progressive loading', code: "const selected=await tools.ops_load_sdk({tools:['stat']});let unavailable=false;try{await tools.ops_stat({path:'sample.txt'})}catch{unavailable=true}return{selected,unavailable}" })
    assert.equal(firstCode.isError, false, JSON.stringify(firstCode)); assert.equal(firstCode.value.result.unavailable, true)
    await ctx.get('systemPrompt').assemble({ scope: code })
    assert.equal(names(ctx, code).includes('ops_stat'), false)
    await step(ctx, code)
    const secondCode = await call(ctx, code, 'run_code', { description: 'Check loaded stat API', code: "return await tools.ops_stat({path:'sample.txt'})" })
    assert.equal(secondCode.value.result.data.bytes, 6, JSON.stringify(secondCode))
    assert.equal(names(ctx, child).includes('ops_stat'), false)
    await fileRow.dispose()
    assert.equal((await call(ctx, native, 'ops_stat', { path: 'sample.txt' })).value.bytes, 6, 'discovery owns its independent worker')
    await discoverRow.dispose()
    assert.equal(names(ctx, native).includes('ops_discover_tools'), false)
    assert.ok(names(ctx, code).includes('ops_load_sdk'))
  } finally { await shutdown(ctx) }
}))
await test('overlapping discovery rows restore nearest ownership and preserve unrelated external definitions', () => withTempDir('discovery-rows', async dir => {
  const { ctx, mint, mountDiscovery, mountFile } = await setup(dir)
  try {
    const external = definition('stat', async () => ({ status: 'completed', bytes: 7 }))
    const removeExternal = ctx.tools.register(external)
    const parent = await mint(), child = await mint('native', parent), sibling = await mint()
    assert.equal(ctx.get('tools').get('ops_stat', parent), external, 'an unrelated global registration must remain visible')
    removeExternal()
    const first = await mountDiscovery(parent.ctx, { allowedTools: ['grep'], alwaysLoaded: ['grep'] })
    await waitFor(() => names(ctx, parent).includes('ops_grep') && names(ctx, child).includes('ops_grep'))
    assert.equal(names(ctx, sibling).includes('ops_grep'), false)
    const old = ctx.get('tools').get('ops_discover_tools', parent)
    const second = await mountDiscovery(parent.ctx, { allowedTools: ['diff'], alwaysLoaded: ['diff'] })
    await waitFor(() => names(ctx, parent).includes('ops_diff') && !names(ctx, parent).includes('ops_grep'))
    assert.equal((await old.execute({ query: 'select:ops_grep' }, { agent: parent })).status, 'rejected')
    let changes = 0; const observe = ctx.on('tools/change', () => { ++changes })
    await step(ctx, parent); await step(ctx, child)
    assert.ok(changes < 100, 'unchanged publication must converge'); observe()
    await second.dispose()
    await waitFor(() => names(ctx, parent).includes('ops_grep') && !names(ctx, parent).includes('ops_diff'))
    await first.dispose()
    await waitFor(() => names(ctx, parent).includes('ops_discover_tools') && !names(ctx, parent).includes('ops_grep'))
    const fileRow = await mountFile()
    await waitFor(() => names(ctx, parent).includes('ops_read_files'))
    const restriction = await parent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.restrict({ deny: ['ops_read_files'] }) } })
    assert.equal(names(ctx, child).includes('ops_read_files'), false)
    await ctx.serial('tools/change'); await step(ctx, child)
    assert.equal(names(ctx, child).includes('ops_read_files'), false, 'PTC shadow refresh must not bypass an external ancestor mask')
    await restriction.dispose(); await fileRow.dispose()
  } finally { await shutdown(ctx) }
}))

await test('late discovery discovers existing agents and exposes the Native pager independently of PTC', () => withTempDir('discovery-late', async dir => {
  const { ctx, mint, mountFile, mountDiscovery, codeRow } = await setup(dir, null)
  try {
    await mountFile()
    const owner = await mint(), sibling = await mint()
    assert.ok(names(ctx, owner).includes('ops_read_files'))
    const row = await mountDiscovery()
    await waitFor(() => names(ctx, owner).includes('ops_discover_tools') && !names(ctx, owner).includes('ops_stat'))
    await codeRow.dispose()
    owner.session.mode = 'read-only'
    await ctx.serial('session/event', owner.session, { type: 'sandbox/mode', data: { mode: 'read-only' } })
    await waitFor(() => names(ctx, owner).includes('ops_discover_tools'))
    const selected = await call(ctx, owner, 'ops_discover_tools', { query: 'select:ops_result' })
    assert.deepEqual(selected.value.activated, ['ops_result'])
    assert.equal(names(ctx, owner).includes('ops_result'), false)
    await step(ctx, owner)
    const pager = ctx.get('tools').get('ops_result', owner)
    assert.deepEqual(pager.parameters.properties.action.enum, ['page', 'release'])
    assert.equal(names(ctx, sibling).includes('ops_result'), false)
    const invalid = await call(ctx, owner, 'ops_result', { action: 'put', items: [] })
    assert.equal(invalid.value.error.code, 'INVALID_ARGUMENT', 'Native discovery must never expose PTC storage writes')
    await row.dispose()
    assert.ok(names(ctx, owner).includes('ops_read_files'), 'unload preserves the resident file row owned by another component')
  } finally { await shutdown(ctx) }
}))

await test('same-scope PTC rows also use unique owned sections and restore the prior SDK', () => withTempDir('discovery-ptc-rows', async dir => {
  const { ctx, mint } = await setup(dir)
  try {
    const owner = await mint('ptc')
    const mount = tool => owner.ctx.plugin({ apply(inner) { ptc.apply(inner, { binaryPath: WORKER, required: true, alwaysLoaded: [tool] }) } })
    const first = await mount('stat')
    await waitFor(() => names(ctx, owner).includes('ops_stat'))
    const second = await mount('grep')
    await waitFor(() => names(ctx, owner).includes('ops_grep') && !names(ctx, owner).includes('ops_stat'))
    const assembled = await ctx.get('systemPrompt').assemble({ scope: owner })
    assert.equal(assembled.sections.filter(section => section.name.startsWith('dsh-ops:repository-tooling:mode-ptc') && section.text).length, 1)
    await second.dispose()
    await waitFor(() => names(ctx, owner).includes('ops_stat') && !names(ctx, owner).includes('ops_grep'))
    await first.dispose()
    await waitFor(() => names(ctx, owner).includes('ops_load_sdk') && !names(ctx, owner).includes('ops_stat'))
  } finally { await shutdown(ctx) }
}))
report('discovery-composition')
