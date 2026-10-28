/** Real Native/PTC PDF observations preserve restricted text scope and bounded page recovery. */
import fs from 'node:fs'
import path from 'node:path'
import { assertSupportedJsonSchema, jsonSchemaToTs } from '@deepseek-ai/dsh-tools'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { shutdown } from './lib/host.mjs'
import { requireWorker } from './lib/boundary.mjs'
import { textPdf, show } from './lib/pdf-fixture.mjs'
import { documentHost, documentNames, documentCall, documentCode, activateDocument } from './lib/document-host.mjs'
import { capability } from '../lib/capabilities/registry.js'
import { publicToolName } from '../lib/policy.js'
import { canonicalOutput } from '../lib/ptc/projection/canonical-schema.js'
import { decodeContinuation } from '../lib/ptc/projection/continuation.js'
import { definition } from '../lib/file/contract.js'
requireWorker('pdf-host')
const TOOL = publicToolName('read_pdf')
const render = value => definition('read_pdf', async () => value).output.render({ path: 'text.pdf' }, value)[0].text
await test('PDF capability stays discoverable and generates strict page/text/run contracts', () => {
  const entry = capability('read_pdf'); assert.equal(entry.availability, 'discoverable'); assert.equal(entry.mutates, false)
  assert.equal(entry.parameters.additionalProperties, false); assert.deepEqual(entry.parameters.required, ['path'])
  const schema = canonicalOutput('read_pdf'); assertSupportedJsonSchema(schema)
  assert.equal(schema.properties.items.items.properties.runs.items.type, 'string')
  assert.equal(schema.properties.items.items.properties.block, undefined); assert.equal(schema.properties.source.properties.pagesObserved.type, 'integer')
  assert.match(jsonSchemaToTs(schema), /runs: string\[\]/); assert.match(entry.description, /images\/OCR/)
})
await test('real PDF discovery activates next step for its owner and PTC pages preserve exact text runs', () => withTempDir('pdf-host-pages', async root => {
  const cwd = path.join(root, 'nested'); fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(cwd, 'text.pdf'), textPdf([show('BM04 PDF text'), show(Buffer.from([0x80, 0x95, 0xa0]))], { deflate: true }))
  const { ctx, agent } = await documentHost(root, ['read_pdf'], { real: true })
  try {
    const native = await agent('native', { cwd }), sibling = await agent(), child = await agent('native', { parent: native }), code = await agent('ptc', { cwd })
    const initial = await ctx.get('systemPrompt').assemble({ scope: native })
    assert.equal(initial.tools.some(tool => tool.name === TOOL), false)
    await activateDocument(ctx, native, 'read_pdf'); await activateDocument(ctx, code, 'read_pdf', 'ptc')
    for (const other of [sibling, child]) assert.equal(documentNames(ctx, other).includes(TOOL), false)
    const raw = await documentCall(ctx, native, 'read_pdf', { path: 'text.pdf', limit: 1 })
    assert.equal(raw.scope, 'page-text-layer-content-order'); assert.equal(raw.total, 2); assert.equal(raw.scanComplete, true)
    assert.deepEqual(raw.items, [{ page: 1, text: 'BM04 PDF text', runs: ['BM04 PDF text'] }])
    const text = render(raw); assert.match(text, /Page 1/); assert.match(text, /BM04 PDF text/); assert.match(text, /images and OCR/)
    assert.match(text, /Completeness applies only to this scope/)
    const result = await documentCode(ctx, code, `return await tools.${TOOL}({path:'text.pdf',limit:1});`)
    assert.equal(result.status, 'partial'); assert.equal(result.data.items[0].runs[0], 'BM04 PDF text')
    const next = decodeContinuation(result.continuation); assert.equal(next.tool, 'read_pdf'); assert.equal(next.args.offset, 2)
    const tail = await documentCall(ctx, code, next.tool, next.args)
    assert.equal(tail.status, 'completed'); assert.equal(tail.data.revision, result.data.revision)
    assert.deepEqual(tail.data.items[0], { page: 2, text: '€• ', runs: ['€• '] })
  } finally { await shutdown(ctx) }
}))
await test('unsupported later PDF pages retain only preceding complete pages and never resume the same gap', () => withTempDir('pdf-host-gap', async root => {
  fs.writeFileSync(path.join(root, 'text.pdf'), textPdf([show('safe prefix'), show('not complete') + '/Im1 Do\n']))
  const { ctx, agent } = await documentHost(root, ['read_pdf'])
  try {
    const native = await agent(), code = await agent('ptc')
    await activateDocument(ctx, native, 'read_pdf'); await activateDocument(ctx, code, 'read_pdf', 'ptc')
    const raw = await documentCall(ctx, native, 'read_pdf', { path: 'text.pdf', limit: 1 })
    assert.equal(raw.scanComplete, false); assert.equal(raw.pageComplete, true); assert.equal(raw.pagesObserved, 1)
    assert.equal(raw.total, undefined); assert.match(render(raw), /UNSUPPORTED_DOCUMENT/); assert.match(render(raw), /Page 1.*safe prefix/)
    assert.match(render(raw), /not exhaustive/); assert.doesNotMatch(render(raw), /not complete/)
    const result = await documentCall(ctx, code, 'read_pdf', { path: 'text.pdf', limit: 1 })
    assert.equal(result.status, 'error'); assert.equal(result.error.code, 'UNSUPPORTED_DOCUMENT'); assert.equal(result.error.retry, 'never')
    assert.equal(result.continuation, undefined); assert.equal(result.data.items[0].text, 'safe prefix'); assert.equal(result.data.revision, undefined)
    assert.match(result.error.nextAction, /page offsets do not bypass/)
  } finally { await shutdown(ctx) }
}))
await test('PDF current credential policy and read-only authority survive decoding; malformed files stay errors', () => withTempDir('pdf-host-authority', async root => {
  fs.writeFileSync(path.join(root, 'text.pdf'), textPdf([show('readonly')]))
  fs.writeFileSync(path.join(root, 'id_ed25519.pdf'), textPdf([show('SECRET')]))
  fs.writeFileSync(path.join(root, 'broken.pdf'), '%PDF-1.4\n')
  const before = fs.readdirSync(root).sort(), { ctx, agent } = await documentHost(root, ['read_pdf'])
  try {
    const owner = await agent('ptc', { policy: 'read-only' }); await activateDocument(ctx, owner, 'read_pdf', 'ptc')
    assert.equal((await documentCall(ctx, owner, 'read_pdf', { path: 'text.pdf' })).status, 'completed')
    const denied = await documentCall(ctx, owner, 'read_pdf', { path: 'id_ed25519.pdf' })
    assert.equal(denied.error.code, 'CREDENTIAL_DENIED'); assert.equal(denied.error.effectState, 'none'); assert.doesNotMatch(JSON.stringify(denied), /SECRET/)
    const broken = await documentCall(ctx, owner, 'read_pdf', { path: 'broken.pdf' })
    assert.equal(broken.status, 'error'); assert.equal(broken.error.code, 'DOCUMENT_PARSE_ERROR'); assert.equal(broken.continuation, undefined)
    const invalid = await documentCall(ctx, owner, 'read_pdf', { path: 'text.pdf', limit: 33 })
    assert.equal(invalid.error.code, 'INVALID_ARGUMENT'); assert.deepEqual(fs.readdirSync(root).sort(), before)
  } finally { await shutdown(ctx) }
}))
await test('large PDF text and run data spill with original page scope and bounded Native output', () => withTempDir('pdf-host-spill', async root => {
  fs.writeFileSync(path.join(root, 'text.pdf'), textPdf([show('ab'.repeat(40000))], { deflate: true }))
  const { ctx, agent } = await documentHost(root, ['read_pdf', 'result'])
  try {
    const owner = await agent(); await activateDocument(ctx, owner, 'read_pdf'); await activateDocument(ctx, owner, 'result')
    const raw = await documentCall(ctx, owner, 'read_pdf', { path: 'text.pdf' })
    assert.equal(raw.reference.producerTool, 'read_pdf'); assert.equal(raw.scanComplete, true); assert.equal(raw.complete, false)
    const content = render(raw); assert.ok(Buffer.byteLength(JSON.stringify([{ type: 'text', text: content }])) <= 65536); assert.match(content, /ref:\/\//)
    const page = await documentCall(ctx, owner, 'result', { action: 'page', id: raw.reference.refId, root: raw.referenceRoot, limit: 1 })
    assert.equal(page.source.scope, 'page-text-layer-content-order'); assert.equal(page.source.pagesObserved, 1)
    assert.equal(page.source.captureComplete, true); assert.ok(page.source.decodedBytes > 80000); assert.ok(page.source.processedBytes > 80000)
    assert.equal(page.items[0].kind, 'item-json-chunk'); assert.equal(page.items[0].byteOffset, 0)
  } finally { await shutdown(ctx) }
}))
report('pdf-host')
