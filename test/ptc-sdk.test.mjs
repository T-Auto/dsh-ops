import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope } from '@deepseek-ai/dsh-scope'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { jsonSchemaToTs } from '@deepseek-ai/dsh-tool-executor-ptc'
import { assert, test, report, withTempDir, wait, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import * as ptcModule from '../lib/ptc/index.js'
import { withToolChange } from '../lib/tool-changes.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { mountNativeCatalogue } from './lib/native-catalogue.mjs'
import { resolvePtcConfig } from '../lib/config.js'
import { sdkDefinition, requestedApis } from '../lib/ptc/sdk.js'
import { legacyComponent } from './lib/legacy-component.mjs'
const ptc = legacyComponent(ptcModule)
requireWorker('ptc-sdk')
let serial = 0
const tick = () => new Promise(resolve => setImmediate(resolve))
async function visible(ctx, agent) {
  const captured = await prepareStep(ctx, agent)
  try { return ctx.get('tools').schemas(agent, captured.toolSet).map(tool => tool.name).filter(name => name.startsWith('ops_')).sort() }
  finally { captured.dispose() }
}
async function setup(root, { native = false, config = {}, real = false } = {}) {
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  const agents = []; ctx.provide('agents', { list: () => agents })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem)
  await ctx.plugin(inner => {
    inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: root, sessionId: session?.id }) })
    if (!real) inner.provide('ptcRuntime', { language: 'typescript' })
  })
  if (real) await ctx.plugin(NodePtc, {})
  const mountFile = target => mountNativeCatalogue(target, { binaryPath: WORKER, required: true })
  if (native) await mountFile(ctx)
  const component = await ctx.plugin(ptc, { binaryPath: WORKER, required: true, ...config })
  async function agent(mode = 'ptc', parent) {
    const id = 'sdk-' + ++serial
    const value = { id, session: { id, mode: 'workspace-write', header: { cwd: root }, append() {}, read() { return [] } } }
    value.ctx = createScope(parent?.ctx ?? ctx, value, parent ? { parent } : undefined).ctx
    await value.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { value.lift = selectExecutor(inner, mode) } })
    agents.push(value)
    await ctx.serial('agent/created', { agent: value })
    await waitFor(() => ctx.tools.get('ops_load_sdk', value) !== undefined, { what: 'the PTC row has attached stable scoped definitions' })
    return value
  }
  return { ctx, component, agent, mountFile }
}
const step = (ctx, agent) => ctx.serial('session/event', agent.session, { type: 'step/end' })
async function assembleFor(ctx, agent) { const captured = await prepareStep(ctx, agent); try { return captured.assembly } finally { captured.dispose() } }
async function direct(ctx, agent, name, args) {
  const captured = await prepareStep(ctx, agent)
  try { return await ctx.get('tools').executable(name, agent, captured.toolSet).execute(args, { agent, toolSet: captured.toolSet, signal: new AbortController().signal }) }
  finally { captured.dispose() }
}
async function code(ctx, agent, body) {
  const value = await executeCall(ctx, { name: 'run_code', callId: 'sdk-call-' + ++serial, agent,
    signal: new AbortController().signal, arguments: { description: 'Exercise the progressive OPS SDK', code: body } })
  assert.equal(value.isError, false, JSON.stringify(value)); return value.value.result
}
await test('SDK config and request validation name unknown keys and reject unsupported selections atomically', async () => {
  assert.deepEqual(resolvePtcConfig().alwaysLoaded, [])
  assert.throws(() => resolvePtcConfig({ surprise: true }), /surprise/)
  assert.throws(() => resolvePtcConfig({ allowedTools: ['ops_grep'] }), /allowedTools.*ops_grep/)
  assert.throws(() => resolvePtcConfig({ alwaysLoaded: ['load_sdk'] }), /alwaysLoaded.*sdk/)
  for (const input of [{ tools: [] }, { tools: Array(6).fill('grep') }, { tools: ['grep', 'foreign'] }, { tools: ['grep'], root: '/' }]) assert.equal(typeof requestedApis(input, ['grep']), 'string')
  assert.deepEqual(requestedApis({ tools: ['grep', 'grep'] }, ['grep']), ['grep'])
  const schema = sdkDefinition(['grep'], async () => ({})).output.schema
  assertSupportedJsonSchema(schema); assert.match(jsonSchemaToTs(schema), /nextTurn: true/)
  const unavailable = await sdkDefinition([], async () => { throw new Error('fixture') }).execute({}, {})
  assert.equal(unavailable.error.code, 'EXECUTOR_UNAVAILABLE'); assert.equal(unavailable.error.effectState, 'none')
})
await test('real host SDK stays lean without Native file row and activates requested APIs only at next step', async () => {
  await withTempDir('ptc-progressive', async root => {
    const { ctx, agent } = await setup(root, { real: true })
    try {
      fs.writeFileSync(path.join(root, 'note.txt'), 'first\nsecond\n')
      const owner = await agent(), sibling = await agent()
      assert.deepEqual((await visible(ctx, owner)), ['ops_inspect_local_file', 'ops_load_sdk', 'ops_result'])
      const before = await assembleFor(ctx, owner)
      assert.deepEqual(before.tools.map(tool => tool.name), ['run_code'])
      const sdk = before.sections.find(section => section.name === 'tools:sdk').text
      assert.match(sdk, /status: "completed"/); assert.doesNotMatch(sdk, /ops_stat:/)
      const sameCall = await code(ctx, owner, `const invalid = await tools.ops_load_sdk({tools:['stat','unknown']}); const loaded = await tools.ops_load_sdk({tools:['stat','grep','read_files','batch']});
        let refused = false; try { await tools.ops_stat({path:'note.txt'}); } catch { refused = true; }
        const read = await tools.ops_inspect_local_file({path:'note.txt',offset:0,limit:1}); return {invalid,loaded,refused,read};`)
      assert.equal(sameCall.invalid.error.code, 'INVALID_ARGUMENT'); assert.equal(sameCall.loaded.status, 'completed'); assert.equal(sameCall.loaded.data.nextTurn, true)
      assert.equal(sameCall.refused, true); assert.equal(sameCall.read.status, 'partial', JSON.stringify(sameCall.read)); assert.ok(sameCall.read.data.items)
      await assembleFor(ctx, owner); await ctx.serial('tools/change')
      assert.equal((await visible(ctx, owner)).includes('ops_stat'), false, 'assembly and registry events cannot activate pending selections')
      await step(ctx, owner)
      assert.equal((await visible(ctx, owner)).includes('ops_stat'), true)
      assert.deepEqual((await visible(ctx, sibling)), ['ops_inspect_local_file', 'ops_load_sdk', 'ops_result'])
      const nextCall = await code(ctx, owner, `const stat = await tools.ops_stat({path:'note.txt'});
        const batch = await tools.ops_batch({action:'plan',operations:[{op:'copy',path:'note.txt',to:'copy.txt'}]});
        const stored = await tools.ops_result({action:'put',items:[{n:1}]});
        const page = await tools.ops_result({action:'page',id:stored.data.id}); return {stat,batch,stored,page};`)
      for (const result of Object.values(nextCall)) { assert.equal(result.status, 'completed', JSON.stringify(result)); assert.ok(result.data) }
      assert.equal(nextCall.stat.data.exists, true); assert.equal(nextCall.batch.data.status, 'planned'); assert.deepEqual(nextCall.page.data.items, [{ n: 1 }])
      owner.session.mode = 'read-only'
      const denied = await code(ctx, owner, `try { await tools.ops_batch({action:'run',operations:[{op:'remove',path:'note.txt'}]}); return {refused:false}; } catch { return {refused:true}; }`)
      assert.equal(denied.refused, true, 'a fresh read-only SDK omits the mutating batch binding')
      assert.equal(fs.existsSync(path.join(root, 'note.txt')), true)
    } finally { await shutdown(ctx) }
  })
})
await test('Native/PTC child scopes preserve projections and same-layer file rows yield without leaking advanced APIs', async () => {
  await withTempDir('ptc-projection-scopes', async root => {
    const { ctx, agent, mountFile, component } = await setup(root, { native: true })
    try {
      const parent = await agent(), child = await agent('native', parent), nativePeer = await agent('native'), independent = await agent()
      assert.deepEqual((await visible(ctx, parent)), ['ops_inspect_local_file', 'ops_load_sdk', 'ops_read_files', 'ops_result'])
      for (const scope of [child, nativePeer]) { await waitFor(async () => (await visible(ctx, scope)).includes('ops_grep'), { timeoutMs: 5000, what: 'configured Native advanced tools' }); assert.equal((await visible(ctx, scope)).includes('ops_load_sdk'), false) }
      assert.equal(ctx.get('tools').get('ops_result', child).parameters.properties.action.enum.includes('put'), true)
      const previousNative = ctx.get('tools').get('ops_stat', child)
      const scopedFile = await mountFile(parent.ctx)
      await waitFor(async () => (await visible(ctx, parent)).length === 4 && ctx.get('tools').get('ops_stat', child) !== previousNative, { timeoutMs: 5000, what: 'own-layer handoff' })
      await step(ctx, parent) // A real provider call begins after this public reconciliation boundary.
      const loaded = await direct(ctx, parent, 'ops_load_sdk', { tools: ['grep'] }); assert.equal(loaded.status, 'completed', JSON.stringify(loaded))
      await step(ctx, parent); assert.ok((await visible(ctx, parent)).includes('ops_grep'))
      assert.equal((await visible(ctx, independent)).includes('ops_grep'), false)
      assert.equal((await visible(ctx, child)).includes('ops_load_sdk'), false)
      const retained = ctx.get('tools').get('ops_grep', parent)
      parent.lift(); await parent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { parent.lift = selectExecutor(inner, 'native') } })
      const assembled = await assembleFor(ctx, parent)
      assert.equal(assembled.tools.some(tool => tool.name === 'ops_load_sdk'), false)
      assert.equal((await retained.execute({ path: root, pattern: 'x' }, { agent: parent, signal: new AbortController().signal })).error.code, 'PUBLICATION_IDENTITY_MISMATCH')
      await component.dispose(); await waitFor(async () => (await visible(ctx, parent)).includes('ops_grep'), { timeoutMs: 5000, what: 'Native discovery restoration after PTC unload' }); assert.equal((await visible(ctx, child)).includes('ops_load_sdk'), false)
      await scopedFile.dispose(); assert.equal(Object.hasOwn(ctx.get('tools'), 'register'), false)
    } finally { await shutdown(ctx) }
  })
})
await test('allowed pools, always-loaded selections, pending cancellation and retained callbacks remain scope bound', async () => {
  await withTempDir('ptc-sdk-ownership', async root => {
    const { ctx, agent, component } = await setup(root, { config: { allowedTools: ['grep'], alwaysLoaded: ['stat'] } })
    try {
      const owner = await agent(), sibling = await agent(), child = await agent('ptc', owner)
      assert.ok((await visible(ctx, owner)).includes('ops_stat'))
      const retained = ctx.get('tools').get('ops_load_sdk', owner)
      assert.equal((await retained.execute({ tools: ['grep'] }, { agent: sibling, signal: new AbortController().signal })).error.code, 'POLICY_DENIED')
      assert.equal((await direct(ctx, owner, 'ops_load_sdk', { tools: ['grep', 'batch'] })).error.code, 'INVALID_ARGUMENT')
      await step(ctx, owner); assert.equal((await visible(ctx, owner)).includes('ops_grep'), false)
      await direct(ctx, owner, 'ops_load_sdk', { tools: ['grep'] })
      await ctx.serial('session/event', owner.session, { type: 'sandbox/mode' })
      await step(ctx, owner); assert.equal((await visible(ctx, owner)).includes('ops_grep'), false)
      await direct(ctx, owner, 'ops_load_sdk', { tools: ['grep'] }); await step(ctx, owner)
      assert.ok((await visible(ctx, owner)).includes('ops_grep')); assert.equal((await visible(ctx, sibling)).includes('ops_grep'), false); assert.equal((await visible(ctx, child)).includes('ops_grep'), false)
      await ctx.serial('agent/disposed', { agent: owner })
      assert.equal((await retained.execute({ tools: ['grep'] }, { agent: owner, signal: new AbortController().signal })).error.code, 'POLICY_DENIED')
      await component.dispose(); assert.deepEqual((await visible(ctx, sibling)), [])
    } finally { await shutdown(ctx) }
  })
})
await test('Native child restoration honors external ancestor masks and late parent file mounts', async () => {
  await withTempDir('ptc-external-masks', async root => {
    const { ctx, agent, mountFile } = await setup(root)
    try {
      const parent = await agent(), child = await agent('native', parent)
      assert.deepEqual((await visible(ctx, child)), [])
      const file = await mountFile(parent.ctx)
      await waitFor(async () => (await visible(ctx, child)).includes('ops_grep'), { timeoutMs: 5000, what: 'late parent Native provider' })
      assert.deepEqual((await visible(ctx, parent)), ['ops_inspect_local_file', 'ops_load_sdk', 'ops_result'])
      await file.dispose()
      await waitFor(async () => (await visible(ctx, child)).length === 0, { timeoutMs: 5000, what: 'late provider disposal' })
      await mountFile(ctx)
      await waitFor(async () => (await visible(ctx, child)).includes('ops_grep'), { timeoutMs: 5000, what: 'global Native provider' })
      const mask = await parent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(scoped) { scoped.tools.restrict({ deny: ['ops_read_files'] }) } })
      await waitFor(async () => !(await visible(ctx, child)).includes('ops_read_files'), { timeoutMs: 5000, what: 'external ancestor restriction' })
      assert.ok((await visible(ctx, child)).includes('ops_stat'))
      await mask.dispose()
      await waitFor(async () => (await visible(ctx, child)).includes('ops_read_files'), { timeoutMs: 5000, what: 'external restriction release' })
    } finally { await shutdown(ctx) }
  })
})
await test('nearer overlapping PTC rows own their scopes without duplicate registration or event loops', async () => {
  await withTempDir('ptc-overlap', async root => {
    const { ctx, agent } = await setup(root)
    try {
      const parent = await agent(), child = await agent('ptc', parent), sibling = await agent()
      const former = ctx.get('tools').get('ops_load_sdk', parent)
      let events = 0; ctx.on('tools/change', () => { if (++events > 2000) throw new Error('publication event loop') })
      const scoped = await parent.ctx.plugin({ name: 'nearer-ptc-row', apply(inner) { ptc.apply(inner, { binaryPath: WORKER, required: true, allowedTools: ['grep'], alwaysLoaded: ['stat'] }) } })
      await waitFor(async () => (await visible(ctx, parent)).includes('ops_stat') && (await visible(ctx, child)).includes('ops_stat'), { timeoutMs: 5000, what: 'nearer PTC row' }).catch(async error => { throw new Error(String(error) + ' parent=' + (await visible(ctx, parent)) + ' child=' + (await visible(ctx, child)) + ' events=' + events) })
      assert.equal((await visible(ctx, sibling)).includes('ops_stat'), false)
      assert.equal((await former.execute({ tools: ['batch'] }, { agent: parent, signal: new AbortController().signal })).error.code, 'POLICY_DENIED')
      assert.equal((await direct(ctx, parent, 'ops_load_sdk', { tools: ['batch'] })).error.code, 'INVALID_ARGUMENT')
      await direct(ctx, sibling, 'ops_load_sdk', { tools: ['grep'] }); await step(ctx, sibling)
      assert.equal((await visible(ctx, child)).includes('ops_grep'), false)
      const before = events; await assembleFor(ctx, child); await step(ctx, child)
      assert.ok(events - before < 100, 'an unchanged boundary must not repeatedly rebuild overlapping rows')
      await scoped.dispose()
      await waitFor(async () => !(await visible(ctx, parent)).includes('ops_stat') && !(await visible(ctx, child)).includes('ops_stat') && (await visible(ctx, parent)).includes('ops_load_sdk') && (await visible(ctx, child)).includes('ops_load_sdk'), { timeoutMs: 5000, what: 'outer row restored' })
      assert.equal((await direct(ctx, parent, 'ops_load_sdk', { tools: ['batch'] })).status, 'completed')
    } finally { await shutdown(ctx) }
  })
})
await test('Native to PTC and unsignalled executor changes admit the resident SDK', async () => {
  await withTempDir('ptc-verdict-transition', async root => {
    const {ctx,agent}=await setup(root)
    try {
      const owner=await agent('native')
      assert.equal((await visible(ctx, owner)).includes('ops_load_sdk'),false)
      owner.lift()
      await owner.ctx.plugin({inject:['tools','systemPrompt'],apply(inner){owner.lift=selectExecutor(inner, 'ptc')}})
      await step(ctx,owner)
      assert.ok((await visible(ctx, owner)).includes('ops_load_sdk'))
      const other = await agent('native')
      assert.equal((await visible(ctx, other)).includes('ops_load_sdk'), false)
      other.lift()
      await other.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { other.lift = selectExecutor(inner, 'ptc') } })
      assert.ok((await visible(ctx, other)).includes('ops_load_sdk'), 'a fresh resolve admits the SDK without requiring another session event')
    } finally {await shutdown(ctx)}
  })
})
await test('nested foreign ancestor masks cannot borrow an unrelated OPS attribution', async () => {
  await withTempDir('ptc-nested-mask',async root=>{
    const {ctx,agent}=await setup(root,{native:true})
    try {
      const parent=await agent(),child=await agent('native',parent),unrelated=await agent()
      await waitFor(()=>ctx.get('tools').get('ops_read_files',child)!==undefined)
      const captured = await prepareStep(ctx, child)
      let parentTools, unrelatedTools
      await parent.ctx.plugin({inject:['tools','systemPrompt'],apply(inner){parentTools=inner.tools}})
      await unrelated.ctx.plugin({inject:['tools','systemPrompt'],apply(inner){unrelatedTools=inner.tools}})
      let mask,armed=true
      ctx.on('tools/change',()=>{
        if(!armed)return
        armed=false
        mask=parentTools.restrict({deny:['ops_read_files']})
      })
      const remove=withToolChange([unrelated],()=>unrelatedTools.register({name:'nested_trigger',description:'fixture',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>({})}))
      await waitFor(()=>ctx.get('tools').get('ops_read_files',child)===undefined,{timeoutMs:5000,what:'nested foreign restriction'})
      const stale = await executeCall(ctx, { name: 'ops_read_files', arguments: { files: [{ path: 'never-read' }] }, agent: child, toolSet: captured.toolSet })
      assert.equal(stale.isError, true, JSON.stringify(stale)); captured.dispose()
      mask();remove()
      await waitFor(()=>ctx.get('tools').get('ops_read_files',child)!==undefined)
    } finally {await shutdown(ctx)}
  })
})
await test('an unattributed tools/change assembles no prompt for a live Native session', async () => {
  await withTempDir('ptc-unattributed-lazy', async root => {
    const { ctx, agent } = await setup(root)
    try {
      const ptcOwner = await agent(), natives = [await agent('native'), await agent('native'), await agent('native')]
      await waitFor(async () => (await visible(ctx, ptcOwner)).length > 0, { timeoutMs: 5000, what: 'the PTC row publishes' })
      for (const native of natives) assert.equal((await visible(ctx, native)).includes('ops_load_sdk'), false, 'a Native row stays Native')
      const prompt = ctx.get('systemPrompt'), assemble = prompt.assemble.bind(prompt)
      let assemblies = 0
      prompt.assemble = context => { ++assemblies; return assemble(context) }
      // The official host emits `tools/change` with no payload, so nothing is attributable
      // to a scope. A registry change cannot move a presentation mode, so the change owes
      // no probe: paying one full assembly per live session is the defect this guards.
      await ctx.serial('tools/change', {})
      await wait(300)
      assert.equal(assemblies, 0, 'an unattributed tools/change must not assemble a prompt per live session')
      // Losing no capability: the next step still probes and the published rows survive.
      await step(ctx, ptcOwner)
      assert.ok((await visible(ctx, ptcOwner)).length > 0, 'the PTC row stays published across the deferred change')
      assert.equal((await visible(ctx, natives[0])).includes('ops_load_sdk'), false, 'Native sessions stay Native')
    } finally { await shutdown(ctx) }
  })
})
await test('a scoped executor change is observed by the next resolved admission', async () => {
  // Executor contributions own their prompt sections. No eager publication pass
  // is needed: the next public resolve derives the current scope's admission.
  await withTempDir('ptc-prompt-flip', async root => {
    const { ctx, agent } = await setup(root)
    try {
      const value = await agent('native')
      assert.equal((await visible(ctx, value)).includes('ops_load_sdk'), false, 'a Native row starts Native')
      value.lift()
      await value.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { value.lift = selectExecutor(inner, 'ptc') } })
      await ctx.serial('tools/change', {})
      await waitFor(async () => (await visible(ctx, value)).includes('ops_load_sdk'), { timeoutMs: 5000, what: 'the flipped session publishes the PTC row' })
    } finally { await shutdown(ctx) }
  })
})
await test('registry and prompt notifications never spend an admission probe without a resolve', async () => {
  await withTempDir('ptc-verdict-defer', async root => {
    const { ctx, agent } = await setup(root)
    try {
      const owner = await agent('ptc'), prompt = ctx.get('systemPrompt'), probes = new Map()
      prompt.section({ name: 'verdict-counter', order: 10, text: context => {
        if (isPresentationProbe(context)) probes.set(context.scope, (probes.get(context.scope) ?? 0) + 1)
        return ''
      } })
      await prompt.assemble({ scope: owner }); await step(ctx, owner)
      assert.ok((await visible(ctx, owner)).includes('ops_load_sdk'))
      // Registering the counter is itself a prompt change; spend that evidence first so
      // the case below is a registry change with no prompt change behind it.
      await ctx.serial('tools/change')
      for (let i = 0; i < 4; i++) await tick()
      probes.clear()
      // A registration the host reports without naming a scope moves this scope's surface
      // — the new name is visible in it — but cannot move the presentation mode, which
      // only `presentAs` moves. The republish must still happen; the verdict must not cost
      // an assembly to confirm what no registry event can have changed.
      await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
        inner.tools.register({ name: 'verdict_extra', description: '', parameters: { type: 'object' },
          output: { schema: {}, render: () => [] }, execute: () => ({}) })
      } })
      for (let i = 0; i < 4; i++) await tick()
      console.log('  after unattributed registration: probes=' + (probes.get(owner) ?? 0))
      assert.equal(probes.get(owner) ?? 0, 0, 'an unattributed registry change must not re-derive a settled verdict')
      assert.ok((await visible(ctx, owner)).includes('ops_load_sdk'), 'the deferred change still republishes')
      // A changed prompt still owes no background probe; the explicit resolve
      // above is the only operation that consumed an admission context.
      await ctx.serial('system-prompt/change')
      await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
        inner.tools.register({ name: 'verdict_later', description: '', parameters: { type: 'object' },
          output: { schema: {}, render: () => [] }, execute: () => ({}) })
      } })
      for (let i = 0; i < 4; i++) await tick()
      console.log(`  after a prompt change and a registration: probes=${probes.get(owner) ?? 0}`)
      assert.equal(probes.get(owner) ?? 0, 1, 'only the explicit resolve above probes; background registry/prompt notifications do not assemble')
    } finally { await shutdown(ctx) }
  })
})

report('ptc-sdk')
