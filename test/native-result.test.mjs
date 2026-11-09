import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { assert, test, report, withTempDir, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { invoke } from '../lib/ptc/worker.js'
import * as ptcModule from '../lib/ptc/index.js'
import { legacyComponent } from './lib/legacy-component.mjs'
const ptc = legacyComponent(ptcModule)
import * as discoveryModule from '../lib/discovery/index.js'
const discovery = legacyComponent(discoveryModule)
const hostAgents = new WeakMap()
import { prepareStep, executeCall, selectExecutor } from './lib/executor.mjs'
const definition = (ctx, name, owner) => ctx.get('tools').definitions(owner).find(tool => tool.name === name)
async function admitted(ctx, owner) {
  const step = await prepareStep(ctx, owner)
  try { return ctx.get('tools').definitions(owner, step.toolSet) }
  finally { step.dispose() }
}
const admittedDefinition = async (ctx, name, owner) => (await admitted(ctx, owner)).find(tool => tool.name === name)
async function waitAdmission(check, options = {}) {
  const deadline = Date.now() + 5000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for admitted ${options.what ?? 'tool visibility'}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
function inventory(ctx) {
  if (!hostAgents.has(ctx)) { hostAgents.set(ctx, []); ctx.provide('agents', { list: () => [...hostAgents.get(ctx)] }) }
}
import { mountNativeCatalogue } from './lib/native-catalogue.mjs'
import { resultStorage } from '../lib/kernel/result-storage.js'
import { resultDefinition } from '../lib/file/result.js'
import { CAPABILITIES, NATIVE_FILE_TOOLS } from '../lib/capabilities/registry.js'
import { NATIVE_RESULT_PARAMETERS, STORAGE_REFERENCE } from '../lib/capabilities/result.js'
import { isPresentationProbe } from '../lib/publication/presentation.js'
import { publicToolName } from '../lib/policy.js'
requireWorker('native-result')
let serial = 0
async function setup(root) {
  const { ctx } = await bootHost()
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox)
  await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: root, sessionId: session?.id }) }))
  inventory(ctx)
  const file = { fiber: await mountNativeCatalogue(ctx, { binaryPath: WORKER, required: true }) }
  return { ctx, file }
}
async function agent(ctx, cwd, presentation = 'native', parent) {
  const id = 'native-reference-' + ++serial
  const value = { id, session: { id, mode: 'workspace-write', header: { cwd }, append() {}, read() { return [] } } }
  value.ctx = createScope(parent?.ctx ?? ctx, value).ctx
  await value.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { value.liftPresentation = selectExecutor(inner, presentation) } })
  inventory(ctx)
  hostAgents.get(ctx).push(value)
  await ctx.serial('agent/created', { agent: value })
  return value
}
async function call(ctx, owner, name, args) {
  await waitFor(() => definition(ctx, name, owner), { timeoutMs: 5000, what: `${name} agent registration` })
  const prepared = await prepareStep(ctx, owner)
  try {
    assert.ok(ctx.get('tools').executable(name, owner, prepared.toolSet), `${name} admitted to resolved toolSet`)
    return await executeCall(ctx, { name, callId: 'native-page-' + ++serial, arguments: args, agent: owner, toolSet: prepared.toolSet })
  } finally { prepared.dispose() }
}
async function ptcPut(ctx, owner, items) {
  const step = await prepareStep(ctx, owner)
  try {
    const result = await executeCall(ctx, { name: 'run_code', callId: 'ptc-put-' + ++serial,
      arguments: { description: 'Store owned rows', code: `return await tools.ops_result(${JSON.stringify({ action: 'put', items })});` },
      agent: owner, toolSet: step.toolSet })
    assert.equal(result.isError, false, JSON.stringify(result))
    const stored = result.value.result
    assert.equal(stored.status, 'completed', JSON.stringify(stored))
    const lifecycle = await executeCall(ctx, { name: 'run_code', callId: 'ptc-page-' + ++serial,
      arguments: { description: 'Page and release owned rows', code: `const page = await tools.ops_result({action:'page',id:${JSON.stringify(stored.data.id)}}); const release = await tools.ops_result({action:'release',id:${JSON.stringify(stored.data.id)}}); return {page,release};` },
      agent: owner, toolSet: step.toolSet })
    assert.equal(lifecycle.isError, false, JSON.stringify(lifecycle))
    assert.deepEqual(lifecycle.value.result.page.data.items, items)
    assert.equal(lifecycle.value.result.release.data.status, 'released')
    return stored
  } finally { step.dispose() }
}
const execute = (ctx, owner, args) => call(ctx, owner, 'ops_result', args)
async function page(ctx, agent, args) {
  const result = await execute(ctx, agent, args)
  assert.equal(result.isError, false, JSON.stringify(result))
  return { ...result, text: result.content.map(block => block.text ?? '').join('\n') }
}
const put = (ctx, owner, root, items) => invoke(ctx, WORKER, 'result', { action: 'put', root, items }, { agent: owner }, undefined, { denyCredentialReads: true })

await test('one catalogue entry exposes the same SDK-valid Native and PTC result contract', () => {
  const entry = CAPABILITIES.filter(value => value.rawName === 'result')
  assert.equal(entry.length, 1); assert.deepEqual(entry[0].presentations, ['native', 'ptc'])
  assert.equal(entry[0].nativeProjection.component, 'file')
  assertSupportedJsonSchema(NATIVE_RESULT_PARAMETERS); assertSupportedJsonSchema(STORAGE_REFERENCE)
  assert.deepEqual(NATIVE_RESULT_PARAMETERS.properties.action.enum, ['put', 'page', 'release'])
  assert.deepEqual(entry[0].parameters.properties.action.enum, ['put', 'page', 'release'])
  assert.ok(entry[0].parameters.properties.ttlMs); assert.ok(entry[0].output.properties.reference)
})

await test('Native discovery without PTC SDK execution pages/releases with cwd binding, defaults and no business writes', async () => {
  await withTempDir('native-reference', async root => {
    const cwd = path.join(root, 'nested'); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'keep'), 'unchanged')
    const { ctx } = await setup(root)
    try {
      const owner = await agent(ctx, cwd)
      const stored = await put(ctx, owner, cwd, [{ n: 1, text: 'alpha' }, { n: 2, text: 'beta' }])
      assert.equal(stored.status, 'completed', JSON.stringify(stored))
      const first = await page(ctx, owner, { action: 'page', id: stored.id, root: '', limit: 1, fields: [] })
      assert.deepEqual(first.value.data.items, [{ n: 1, text: 'alpha' }]); assert.equal(first.value.data.nextOffset, 1)
      assert.match(first.text, /displayComplete=true; pageComplete=false/); assert.match(first.text, /alpha/)
      const last = await page(ctx, owner, { action: 'page', id: stored.id, offset: 1 })
      assert.equal(last.value.data.complete, true); assert.deepEqual(last.value.data.items, [{ n: 2, text: 'beta' }])
      owner.session.header.cwd = root
      assert.equal((await page(ctx, owner, { action: 'page', id: stored.id })).value.error.code, 'POLICY_DENIED')
      const restored = await page(ctx, owner, { action: 'page', id: stored.id, root: cwd, equals: { n: 2 }, fields: ['text'] })
      assert.deepEqual(restored.value.data.items, [{ text: 'beta' }])
      assert.equal((await page(ctx, owner, { action: 'release', id: stored.id, root: cwd })).value.data.status, 'released')
      assert.equal((await page(ctx, owner, { action: 'page', id: stored.id, root: cwd })).value.error.code, 'REFERENCE_EXPIRED')
      assert.equal(fs.readFileSync(path.join(cwd, 'keep'), 'utf8'), 'unchanged'); assert.equal(fs.existsSync(path.join(root, '.dsh-ops')), false)
    } finally { await shutdown(ctx) }
  })
})

await test('Native discovery without PTC spill pages reconstruct one large escaped line exactly through the real host', async () => {
  await withTempDir('native-spill-roundtrip', async root => {
    const cwd = path.join(root, 'nested'); fs.mkdirSync(cwd)
    const original = '\u0000'.repeat(22000) + '😀end'
    fs.writeFileSync(path.join(cwd, 'large.txt'), original)
    const { ctx } = await setup(root)
    try {
      const owner = await agent(ctx, cwd)
      const read = await call(ctx, owner, 'ops_inspect_local_file', { path: 'large.txt', limit: 1 })
      assert.equal(read.isError, false, JSON.stringify(read)); assert.ok(read.value.data.reference, JSON.stringify(read.value))
      assert.equal(read.value.data.complete, false); assert.equal(path.toNamespacedPath(read.value.data.referenceRoot), path.toNamespacedPath(fs.realpathSync.native(cwd)))
      const rendered = read.content.map(block => block.text ?? '').join('\n')
      assert.ok(rendered.includes(read.value.data.reference.refId)); assert.ok(rendered.includes('referenceRoot='))
      assert.ok(Buffer.byteLength(JSON.stringify(read.content)) <= 65536)
      let offset = 0, encoded = '', finished = false, chunks = 0
      for (let i = 0; i < 40; i++) {
        const current = await page(ctx, owner, { action: 'page', id: read.value.data.reference.refId, root: read.value.data.referenceRoot, offset, maxBytes: 24000 })
        assert.equal(current.value.data.source.itemEncoding, 'tagged-json-v1'); assert.equal(current.value.data.source.root, read.value.data.referenceRoot)
        assert.equal(current.value.data.source.captureComplete, true); assert.equal(current.value.data.source.capturedItems, 1)
        assert.match(current.text, /displayComplete=true/); assert.ok(Buffer.byteLength(JSON.stringify(current.content)) <= 65536)
        for (const row of current.value.data.items) {
          assert.equal(row.kind, 'item-json-chunk'); assert.equal(row.index, 0); assert.equal(row.chunk, chunks++)
          assert.equal(row.byteOffset, Buffer.byteLength(encoded)); encoded += row.text; finished = row.complete
        }
        if (current.value.data.complete) break
        assert.ok(current.value.data.nextOffset > offset); offset = current.value.data.nextOffset
      }
      assert.equal(finished, true); assert.ok(chunks > 1)
      const recovered = JSON.parse(encoded); assert.equal(recovered.text, original); assert.equal(recovered.line, 1)
      assert.equal(fs.readFileSync(path.join(cwd, 'large.txt'), 'utf8'), original)
      assert.equal((await page(ctx, owner, { action: 'release', id: read.value.data.reference.refId, root: read.value.data.referenceRoot })).value.data.status, 'released')
    } finally { await shutdown(ctx) }
  })
})

await test('Native pager denies hidden producers, other sessions, narrower authority, invalid actions and disposed callbacks', async () => {
  await withTempDir('native-reference-authority', async root => {
    const { ctx, file } = await setup(root)
    try {
      const owner = await agent(ctx, root), sibling = await agent(ctx, root)
      const stored = await put(ctx, owner, root, [{ n: 1 }]); assert.equal(stored.status, 'completed', JSON.stringify(stored))
      assert.equal((await page(ctx, sibling, { action: 'page', id: stored.id })).value.error.code, 'POLICY_DENIED')
      owner.session.mode = 'read-only'
      assert.equal((await page(ctx, owner, { action: 'page', id: stored.id })).value.error.code, 'POLICY_DENIED')
      assert.equal((await page(ctx, owner, { action: 'release', id: stored.id })).value.error.code, 'POLICY_DENIED')
      owner.session.mode = 'workspace-write'
      for (const args of [{ action: 'put', items: [] }, { action: 'purge' }, { action: 'page', id: 'j-audit' },
        { action: 'page', id: 'j-00000000-0000-4000-8000-000000000001' }, { action: 'release', id: 'r-00000000-0000-4000-8000-000000000002' },
        { action: 'page', id: stored.id, authority: 'fake' }]) {
        const rejected = await page(ctx, owner, args); assert.equal(rejected.value.error.code, args.action === 'put' ? 'PUBLICATION_DENIED' : 'INVALID_ARGUMENT', JSON.stringify(rejected))
      }
      const policy = ctx.get('sandboxPolicy').resolve({ session: owner.session })
      const storage = await resultStorage(ctx, owner.session, owner, WORKER, 'result', policy, [], false)
      const blob = path.join(storage.root, 's-' + createHash('sha256').update(owner.session.id).digest('hex'), stored.id.split('/').at(-1) + '.json')
      // Trusted fixture rewrites only the producer binding to exercise the shared cache's visibility check.
      const record = JSON.parse(fs.readFileSync(blob, 'utf8')); record.producerTool = 'grep'; fs.writeFileSync(blob, JSON.stringify(record))
      const grepId = stored.id.replace('/result/', '/grep/')
      assert.equal((await page(ctx, owner, { action: 'page', id: grepId })).value.data.complete, true)
      const restricted = await owner.ctx.plugin(discovery, { binaryPath: WORKER, required: true, enabled: false, allowedTools: ['result'], alwaysLoaded: ['result'] })
      await waitAdmission(async () => (await admittedDefinition(ctx, 'ops_result', owner)) && !(await admittedDefinition(ctx, 'ops_grep', owner)))
      assert.equal((await page(ctx, owner, { action: 'page', id: grepId })).value.error.code, 'POLICY_DENIED')
      await restricted.dispose()
      await waitAdmission(async () => (await admittedDefinition(ctx, 'ops_result', owner)) && (await admittedDefinition(ctx, 'ops_grep', owner)))
      const retained = (await admittedDefinition(ctx, 'ops_result', owner))
      await file.fiber.dispose()
      assert.equal((await retained.execute({ action: 'page', id: grepId }, { agent: owner, signal: new AbortController().signal })).error.code, 'PUBLICATION_DENIED')
    } finally { await shutdown(ctx) }
  })
})

await test('Native children of PTC parents share one result schema with Native put denied and Native component unload preserves PTC put', async () => {
  await withTempDir('native-reference-scopes', async root => {
    const { ctx, file } = await setup(root)
    try {
      await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
      inventory(ctx)
      const component = await ctx.plugin(ptc, { binaryPath: WORKER, required: true, alwaysLoaded: ['result'] })
      const parent = await agent(ctx, root, 'ptc'), child = await agent(ctx, root, 'native', parent)
      const resultFor = scope => admittedDefinition(ctx, 'ops_result', scope)
      await waitAdmission(async () => (await resultFor(parent))?.parameters.properties.action.enum.includes('put')
        && (await resultFor(child))?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'Native/PTC result projections' })
      assert.equal((await admitted(ctx, child)).some(tool => tool.name === 'ops_batch'), false)
      const stored = await put(ctx, child, root, [{ child: true }])
      assert.deepEqual((await page(ctx, child, { action: 'page', id: stored.id })).value.data.items, [{ child: true }])
      assert.equal((await page(ctx, child, { action: 'put', items: [] })).value.error.code, 'PUBLICATION_DENIED')
      const nativeDefinition = (await resultFor(child))
      await file.fiber.dispose()
      await waitAdmission(async () => !(await admitted(ctx, child)).some(tool => tool.name === 'ops_result'), { timeoutMs: 5000, what: 'file pager withdrawal' })
      assert.equal((await nativeDefinition.execute({ action: 'page', id: stored.id }, { agent: child, signal: new AbortController().signal })).error.code, 'PUBLICATION_DENIED')
      await waitAdmission(async () => (await resultFor(parent))?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'PTC remains available' })
      const ptcStored = await ptcPut(ctx, parent, [{ ptc: true }])
      assert.equal(ptcStored.status, 'completed', JSON.stringify(ptcStored))
      await component.dispose(); assert.equal((await admitted(ctx, parent)).some(tool => tool.name === 'ops_result'), false)
      assert.equal(Object.hasOwn(ctx.get('tools'), 'register'), false)
    } finally { await shutdown(ctx) }
  })
})

await test('agent-scoped file rows isolate sibling pagers and yield only their exact layer to PTC', async () => {
  await withTempDir('native-reference-scoped-rows', async root => {
    const { ctx } = await bootHost()
    try {
      await ctx.plugin(Subprocess); await ctx.plugin(Sandbox)
      await ctx.plugin(inner => {
        // NodePtc supplies the real runtime below.
        inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: root, sessionId: session?.id }) })
      })
      await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
      inventory(ctx)
      const component = await ctx.plugin(ptc, { binaryPath: WORKER, required: true, alwaysLoaded: ['result'] })
      const parent = await agent(ctx, root, 'ptc'), left = await agent(ctx, root, 'native', parent), right = await agent(ctx, root, 'native', parent)
      const current = value => admittedDefinition(ctx, 'ops_result', value)
      const mount = value => mountNativeCatalogue(value.ctx, { binaryPath: WORKER, required: true })
      const leftFile = await mount(left)
      await waitAdmission(async () => (await current(left))?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'left scoped Native pager' })
      assert.equal((await current(right)), undefined, 'a sibling cannot borrow the left file executor')
      const rightFile = await mount(right)
      await waitAdmission(async () => (await current(right))?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'right scoped Native pager' })
      const rightStored = await put(ctx, right, root, [{ right: true }])
      assert.deepEqual((await page(ctx, right, { action: 'page', id: rightStored.id })).value.data.items, [{ right: true }])
      left.liftPresentation()
      await left.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { left.liftPresentation = selectExecutor(inner, 'ptc') } })
      await waitAdmission(async () => (await current(left))?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'exact-layer PTC takeover' })
      const leftStored = await ptcPut(ctx, left, [{ left: true }])
      assert.equal(leftStored.status, 'completed', JSON.stringify(leftStored))
      assert.deepEqual((await current(right)).parameters.properties.action.enum, ['put', 'page', 'release'])
      const late = await agent(ctx, root, 'ptc')
      await waitAdmission(async () => (await current(late))?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'PTC before file mount' })
      const lateFile = await mount(late)
      await waitAdmission(async () => !(await admittedDefinition(ctx, 'ops_grep', late)) && (await current(late))?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'file mounted after PTC' })
      await component.dispose()
      for (const value of [left, late]) { value.liftPresentation(); await value.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { value.liftPresentation = selectExecutor(inner, 'native') } }) }
      await waitAdmission(async () => (await current(left))?.parameters.properties.action.enum.includes('put') && (await current(late))?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'Native peer resumes on PTC unload' })
      await leftFile.dispose(); assert.equal((await current(left)), undefined)
      assert.deepEqual((await current(right)).parameters.properties.action.enum, ['put', 'page', 'release'])
      await rightFile.dispose(); await lateFile.dispose(); assert.equal((await current(right)), undefined)
    } finally { await shutdown(ctx) }
  })
})

await test('put rejects Native nested calls, forged parent and stale admission before IO', async () => {
  await withTempDir('native-put-admission', async root => {
    const { ctx } = await setup(root)
    const steps = []
    try {
      const owner = await agent(ctx, root)
      let nested
      owner.ctx.get('tools').register({ name: 'native_nested_put', description: 'Native parent fixture',
        parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] },
        execute: async (_args, exec) => {
          const pipeline = new ToolExecutionPipeline(ctx)
          const prepared = await pipeline.prepare({ name: 'ops_result', callId: 'nested-put', arguments: { action: 'put', items: [{ unsafe: true }] },
            agent: owner, toolSet: exec.toolSet, parent: exec.token, rootCallId: exec.rootCallId, signal: exec.signal })
          const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
          nested = await pipeline.complete(prepared.exec, outcome)
          return { rejected: nested.isError ? nested.error.info.code : nested.value.error.code }
        } })
      const step = await prepareStep(ctx, owner); steps.push(step)
      const result = await executeCall(ctx, { agent: owner, toolSet: step.toolSet, name: 'native_nested_put', callId: 'native-parent', arguments: {} })
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.equal(result.value.rejected, 'UNKNOWN_TOOL', 'Native executor rejects transport sub-dispatch before IO')
      const pipeline = new ToolExecutionPipeline(ctx)
      const prepared = await pipeline.prepare({ name: 'ops_result', callId: 'forged', arguments: { action: 'put', items: [] },
        agent: owner, toolSet: step.toolSet, parent: Symbol('forged'), signal: new AbortController().signal })
      const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
      const forged = await pipeline.complete(prepared.exec, outcome)
      assert.equal(forged.isError, true)
      assert.equal(forged.error.info.code, 'UNKNOWN_TOOL')
      step.dispose()
      const stale = await executeCall(ctx, { agent: owner, toolSet: step.toolSet, name: 'ops_result', callId: 'stale', arguments: { action: 'put', items: [] } })
      assert.equal(stale.isError, true)
      assert.equal(stale.error.info.code, 'UNKNOWN_TOOL')
      assert.equal(fs.existsSync(path.join(root, '.dsh-ops')), false)
    } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
  })
})

for (const mode of ['changed', 'failed', 'cwd-changed', 'confine-changed']) await test(`PTC put refuses ${mode} preparation before cache IO`, () => withTempDir('ptc-put-presentation', async root => {
  let workerCalls = 0
  let enter, release = () => {}, armed = true, admissionSeen = false
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const hold = async phase => {
    if (armed && admissionSeen && mode === phase + '-changed') { armed = false; enter(); await gate }
  }
  class CountingSubprocess extends Subprocess {
    spawn(spec) {
      if (path.resolve(spec.argv[0]) === path.resolve(WORKER)) ++workerCalls
      return super.spawn(spec)
    }
  }
  class HeldSandbox extends Sandbox {
    async confine(...args) { await hold('confine'); return super.confine(...args) }
  }
  const { ctx } = await bootHost({ withWorkingDirectory: false })
  let step, remove = () => {}
  try {
    ctx.provide('workingDirectory', {
      get: session => session.header.cwd,
      async ensure(owner) { await hold('cwd'); return owner.session.header.cwd },
    })
    for (const plugin of [CountingSubprocess, HeldSandbox, FileSystem, NodePtc]) await ctx.plugin(plugin)
    ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: session?.id }) })
    inventory(ctx)
    await mountNativeCatalogue(ctx, { binaryPath: WORKER, required: true })
    await ctx.plugin(ptc, { binaryPath: WORKER, required: true, alwaysLoaded: ['result'] })
    await new Promise(resolve => setImmediate(resolve))
    const owner = await agent(ctx, root, 'ptc')
    step = await prepareStep(ctx, owner)
    remove = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (context.scope === owner && isPresentationProbe(context)) admissionSeen = true
      if (armed && admissionSeen && (mode === 'changed' || mode === 'failed')) {
        armed = false; enter(); await gate
        if (mode === 'failed') throw new Error('presentation fixture unavailable')
      }
      return result
    })
    const work = executeCall(ctx, { name: 'run_code', callId: 'put-presentation-' + mode, agent: owner, toolSet: step.toolSet,
      arguments: { description: 'Attempt storage across a presentation change', code: `return await tools.${publicToolName('result')}({action:'put',items:[{unsafe:true}]});` } })
    let timer
    try { await Promise.race([entered,
      work.then(result => { throw new Error('result operation settled before its controlled preflight: ' + JSON.stringify(result)) }),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`result admission inspection was not reached (admissionSeen=${admissionSeen}, armed=${armed}, workerCalls=${workerCalls})`)), 5000) }),
    ]) }
    finally { clearTimeout(timer) }
    if (mode !== 'failed') {
      owner.liftPresentation()
      await owner.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { owner.liftPresentation = selectExecutor(inner, 'native') } })
    }
    release()
    const result = await work
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.ok(result.value.result.error, JSON.stringify(result))
    assert.equal(result.value.result.error.code, 'PUBLICATION_DENIED', JSON.stringify(result))
    assert.equal(result.value.result.error.effectState, 'none')
    assert.equal(workerCalls, 0, 'rejected admission must not start result cache IO')
    assert.equal(fs.existsSync(path.join(root, '.dsh-ops')), false)
  } finally { release(); remove(); step?.dispose(); await shutdown(ctx) }
}))

await test('Native page rendering preserves source/capture facts, complete chunks and bounded recoverability', () => {
  const render = resultDefinition(async () => null).output.render
  const value = { id: 'ref://s/grep/id', root: '/work', complete: true, nextOffset: 2, omitted: 0,
    source: { root: '/original-root', scanComplete: false, capturedItems: 1, captureComplete: true, itemEncoding: 'tagged-json-v1' },
    items: [{ kind: 'item-json-chunk', index: 0, chunk: 0, byteOffset: 0, text: '{"text":', complete: false },
      { kind: 'item-json-chunk', index: 0, chunk: 1, byteOffset: 8, text: '"large"}', complete: true }] }
  const text = render({ offset: 0 }, value)[0].text
  assert.match(text, /root="\/original-root"/); assert.match(text, /"scanComplete":false/); assert.match(text, /"captureComplete":true/)
  assert.match(text, /pageComplete=true/); assert.match(text, /final chunk alone is not a complete item/)
  assert.ok(text.includes(JSON.stringify(value.items[1])))
  const big = render({ offset: 7 }, { ...value, items: Array.from({ length: 100 }, (_, n) => ({ n, text: '\u0000😀'.repeat(400) })) })
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= 65536)
  assert.match(big[0].text, /displayComplete=false/); assert.match(big[0].text, /repeatOffset=7/)
  assert.match(big[0].text, /Do not advance/)
  const failed = render({}, { status: 'error', error: { code: 'REFERENCE_EXPIRED', effectState: 'none', message: 'expired' } })[0].text
  assert.match(failed, /REFERENCE_EXPIRED/); assert.doesNotMatch(failed, /pageComplete=true/)
})
await test('Native stored-reference output names the deferred pager selection route', async () => {
  const { renderNative } = await import('../lib/projections/native/render.js')
  const text = renderNative('grep', {}, { status: 'completed', items: [], reference: { refId: 'ref://s/grep/id' }, referenceRoot: '/work' })
  assert.match(text, /Page via ops_result/)
  assert.match(text, /discover with query \"select:ops_result\"/)
  assert.match(text, /source capture\/coverage/)
})
report('native-result')
