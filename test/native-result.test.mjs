import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { assert, test, report, withTempDir, waitFor } from './lib/harness.mjs'
import { bootHost, mountPlugin, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { invoke } from '../lib/ptc/worker.js'
import * as ptcModule from '../lib/ptc/index.js'
import { legacyComponent } from './lib/legacy-component.mjs'
const ptc = legacyComponent(ptcModule)
import * as discoveryModule from '../lib/discovery/index.js'
const discovery = legacyComponent(discoveryModule)
const hostAgents = new WeakMap()
import { mountNativeCatalogue } from './lib/native-catalogue.mjs'
import { resultStorage } from '../lib/kernel/result-storage.js'
import { resultDefinition } from '../lib/file/result.js'
import { CAPABILITIES, NATIVE_FILE_TOOLS } from '../lib/capabilities/registry.js'
import { NATIVE_RESULT_PARAMETERS, STORAGE_REFERENCE } from '../lib/capabilities/result.js'
requireWorker('native-result')
let serial = 0
async function setup(root) {
  const { ctx } = await bootHost()
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox)
  await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: root, sessionId: session.id }) }))
  const file = { fiber: await mountNativeCatalogue(ctx, { binaryPath: WORKER, required: true }) }
  return { ctx, file }
}
async function agent(ctx, cwd, presentation = 'native', parent) {
  const id = 'native-reference-' + ++serial
  const value = { id, session: { id, mode: 'workspace-write', header: { cwd } } }
  value.ctx = createScope(parent?.ctx ?? ctx, value).ctx
  await value.ctx.plugin({ inject: ['tools'], apply(inner) { value.liftPresentation = inner.tools.presentAs(presentation) } })
  if (!hostAgents.has(ctx)) { hostAgents.set(ctx, []); ctx.provide('agents', { list: () => hostAgents.get(ctx) }) }
  hostAgents.get(ctx).push(value)
  await ctx.serial('agent/created', { agent: value })
  return value
}
const execute = (ctx, agent, args) => ctx.get('tools').execute({ name: 'ops_result', callId: 'native-page-' + ++serial,
  arguments: args, agent, signal: new AbortController().signal })
async function page(ctx, agent, args) {
  const result = await execute(ctx, agent, args)
  assert.equal(result.isError, false, JSON.stringify(result))
  return { ...result, text: result.content.map(block => block.text ?? '').join('\n') }
}
const put = (ctx, owner, root, items) => invoke(ctx, WORKER, 'result', { action: 'put', root, items }, { agent: owner }, undefined, { denyCredentialReads: true })

await test('one catalogue entry exposes distinct SDK-valid Native and PTC result contracts', () => {
  const entry = CAPABILITIES.filter(value => value.rawName === 'result')
  assert.equal(entry.length, 1); assert.deepEqual(entry[0].presentations, ['native', 'ptc'])
  assert.equal(entry[0].nativeProjection.component, 'file')
  assertSupportedJsonSchema(NATIVE_RESULT_PARAMETERS); assertSupportedJsonSchema(STORAGE_REFERENCE)
  assert.deepEqual(NATIVE_RESULT_PARAMETERS.properties.action.enum, ['page', 'release'])
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
      assert.deepEqual(first.value.items, [{ n: 1, text: 'alpha' }]); assert.equal(first.value.nextOffset, 1)
      assert.match(first.text, /displayComplete=true; pageComplete=false/); assert.match(first.text, /alpha/)
      const last = await page(ctx, owner, { action: 'page', id: stored.id, offset: 1 })
      assert.equal(last.value.complete, true); assert.deepEqual(last.value.items, [{ n: 2, text: 'beta' }])
      owner.session.header.cwd = root
      assert.equal((await page(ctx, owner, { action: 'page', id: stored.id })).value.error.code, 'POLICY_DENIED')
      const restored = await page(ctx, owner, { action: 'page', id: stored.id, root: cwd, equals: { n: 2 }, fields: ['text'] })
      assert.deepEqual(restored.value.items, [{ text: 'beta' }])
      assert.equal((await page(ctx, owner, { action: 'release', id: stored.id, root: cwd })).value.status, 'released')
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
      const read = await ctx.get('tools').execute({ name: 'ops_inspect_local_file', callId: 'spill-' + ++serial,
        arguments: { path: 'large.txt', limit: 1 }, agent: owner, signal: new AbortController().signal })
      assert.equal(read.isError, false, JSON.stringify(read)); assert.ok(read.value.reference, JSON.stringify(read.value))
      assert.equal(read.value.complete, false); assert.equal(path.toNamespacedPath(read.value.referenceRoot), path.toNamespacedPath(fs.realpathSync.native(cwd)))
      const rendered = read.content.map(block => block.text ?? '').join('\n')
      assert.ok(rendered.includes(read.value.reference.refId)); assert.ok(rendered.includes('referenceRoot='))
      assert.ok(Buffer.byteLength(JSON.stringify(read.content)) <= 65536)
      let offset = 0, encoded = '', finished = false, chunks = 0
      for (let i = 0; i < 40; i++) {
        const current = await page(ctx, owner, { action: 'page', id: read.value.reference.refId, root: read.value.referenceRoot, offset, maxBytes: 24000 })
        assert.equal(current.value.source.itemEncoding, 'tagged-json-v1'); assert.equal(current.value.source.root, read.value.referenceRoot)
        assert.equal(current.value.source.captureComplete, true); assert.equal(current.value.source.capturedItems, 1)
        assert.match(current.text, /displayComplete=true/); assert.ok(Buffer.byteLength(JSON.stringify(current.content)) <= 65536)
        for (const row of current.value.items) {
          assert.equal(row.kind, 'item-json-chunk'); assert.equal(row.index, 0); assert.equal(row.chunk, chunks++)
          assert.equal(row.byteOffset, Buffer.byteLength(encoded)); encoded += row.text; finished = row.complete
        }
        if (current.value.complete) break
        assert.ok(current.value.nextOffset > offset); offset = current.value.nextOffset
      }
      assert.equal(finished, true); assert.ok(chunks > 1)
      const recovered = JSON.parse(encoded); assert.equal(recovered.text, original); assert.equal(recovered.line, 1)
      assert.equal(fs.readFileSync(path.join(cwd, 'large.txt'), 'utf8'), original)
      assert.equal((await page(ctx, owner, { action: 'release', id: read.value.reference.refId, root: read.value.referenceRoot })).value.status, 'released')
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
      for (const args of [{ action: 'put', items: [] }, { action: 'purge' }, { action: 'page', id: 'j-audit' }, { action: 'page', id: stored.id, authority: 'fake' }]) {
        const rejected = await page(ctx, owner, args); assert.equal(rejected.value.error.code, 'INVALID_ARGUMENT', JSON.stringify(rejected))
      }
      const policy = ctx.get('sandboxPolicy').resolve({ session: owner.session })
      const storage = await resultStorage(ctx, owner.session, owner, WORKER, 'result', policy, [], false)
      const blob = path.join(storage.root, 's-' + createHash('sha256').update(owner.session.id).digest('hex'), stored.id.split('/').at(-1) + '.json')
      // Trusted fixture rewrites only the producer binding to exercise the shared cache's visibility check.
      const record = JSON.parse(fs.readFileSync(blob, 'utf8')); record.producerTool = 'grep'; fs.writeFileSync(blob, JSON.stringify(record))
      const grepId = stored.id.replace('/result/', '/grep/')
      assert.equal((await page(ctx, owner, { action: 'page', id: grepId })).value.complete, true)
      const restricted = await owner.ctx.plugin(discovery, { binaryPath: WORKER, required: true, enabled: false, allowedTools: ['result'], alwaysLoaded: ['result'] })
      await waitFor(() => ctx.get('tools').get('ops_result', owner) && !ctx.get('tools').get('ops_grep', owner))
      assert.equal((await page(ctx, owner, { action: 'page', id: grepId })).value.error.code, 'POLICY_DENIED')
      await restricted.dispose()
      await waitFor(() => ctx.get('tools').get('ops_result', owner) && ctx.get('tools').get('ops_grep', owner))
      const retained = ctx.get('tools').get('ops_result', owner)
      await file.fiber.dispose()
      assert.equal((await retained.execute({ action: 'page', id: grepId }, { agent: owner })).error.code, 'POLICY_DENIED')
    } finally { await shutdown(ctx) }
  })
})

await test('Native children of PTC parents retain page-only projection and Native component unload preserves PTC put', async () => {
  await withTempDir('native-reference-scopes', async root => {
    const { ctx, file } = await setup(root)
    try {
      await ctx.plugin(inner => inner.provide('ptcRuntime', { language: 'typescript' }))
      const component = await ctx.plugin(ptc, { binaryPath: WORKER, required: true })
      const parent = await agent(ctx, root, 'ptc'), child = await agent(ctx, root, 'native', parent)
      const definition = scope => ctx.get('tools').get('ops_result', scope)
      await waitFor(() => definition(parent)?.parameters.properties.action.enum.includes('put')
        && definition(child)?.parameters.properties.action.enum.length === 2, { timeoutMs: 5000, what: 'Native/PTC result projections' })
      assert.equal(ctx.get('tools').schemas(child).some(tool => tool.name === 'ops_batch'), false)
      const stored = await put(ctx, child, root, [{ child: true }])
      assert.deepEqual((await page(ctx, child, { action: 'page', id: stored.id })).value.items, [{ child: true }])
      assert.equal((await page(ctx, child, { action: 'put', items: [] })).value.error.code, 'INVALID_ARGUMENT')
      const nativeDefinition = definition(child)
      await file.fiber.dispose()
      await waitFor(() => !ctx.get('tools').schemas(child).some(tool => tool.name === 'ops_result'), { timeoutMs: 5000, what: 'file pager withdrawal' })
      assert.equal((await nativeDefinition.execute({ action: 'page', id: stored.id }, { agent: child })).error.code, 'POLICY_DENIED')
      await waitFor(() => definition(parent)?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'PTC remains available' })
      const ptcStored = await definition(parent).execute({ action: 'put', items: [{ ptc: true }] }, { agent: parent, signal: new AbortController().signal })
      assert.equal(ptcStored.status, 'completed', JSON.stringify(ptcStored))
      await component.dispose(); assert.equal(ctx.get('tools').schemas(parent).some(tool => tool.name === 'ops_result'), false)
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
        inner.provide('ptcRuntime', { language: 'typescript' })
        inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: root, sessionId: session.id }) })
      })
      const component = await ctx.plugin(ptc, { binaryPath: WORKER, required: true })
      const parent = await agent(ctx, root, 'ptc'), left = await agent(ctx, root, 'native', parent), right = await agent(ctx, root, 'native', parent)
      const current = value => ctx.get('tools').get('ops_result', value)
      const mount = value => mountNativeCatalogue(value.ctx, { binaryPath: WORKER, required: true })
      const leftFile = await mount(left)
      await waitFor(() => current(left)?.parameters.properties.action.enum.length === 2, { timeoutMs: 5000, what: 'left scoped Native pager' })
      assert.equal(current(right), undefined, 'a sibling cannot borrow the left file executor')
      const rightFile = await mount(right)
      await waitFor(() => current(right)?.parameters.properties.action.enum.length === 2, { timeoutMs: 5000, what: 'right scoped Native pager' })
      const rightStored = await put(ctx, right, root, [{ right: true }])
      assert.deepEqual((await page(ctx, right, { action: 'page', id: rightStored.id })).value.items, [{ right: true }])
      left.liftPresentation()
      await left.ctx.plugin({ inject: ['tools'], apply(inner) { left.liftPresentation = inner.tools.presentAs('ptc') } })
      await waitFor(() => current(left)?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'exact-layer PTC takeover' })
      const leftStored = await current(left).execute({ action: 'put', items: [{ left: true }] }, { agent: left, signal: new AbortController().signal })
      assert.equal(leftStored.status, 'completed', JSON.stringify(leftStored))
      assert.equal(current(right).parameters.properties.action.enum.length, 2)
      const late = await agent(ctx, root, 'ptc')
      await waitFor(() => current(late)?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'PTC before file mount' })
      const lateFile = await mount(late)
      await waitFor(() => !ctx.get('tools').get('ops_grep', late) && current(late)?.parameters.properties.action.enum.includes('put'), { timeoutMs: 5000, what: 'file mounted after PTC' })
      await component.dispose()
      for (const value of [left, late]) { value.liftPresentation(); await value.ctx.plugin({ inject: ['tools'], apply(inner) { value.liftPresentation = inner.tools.presentAs('native') } }) }
      await waitFor(() => current(left)?.parameters.properties.action.enum.length === 2 && current(late)?.parameters.properties.action.enum.length === 2, { timeoutMs: 5000, what: 'Native peer resumes on PTC unload' })
      await leftFile.dispose(); assert.equal(current(left), undefined)
      assert.equal(current(right).parameters.properties.action.enum.length, 2)
      await rightFile.dispose(); await lateFile.dispose(); assert.equal(current(right), undefined)
    } finally { await shutdown(ctx) }
  })
})

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
report('native-result')
