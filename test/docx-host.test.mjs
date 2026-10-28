/** Scoped DOCX adapters retain main-body scope and safe prefix data. */
import fs from 'node:fs'
import path from 'node:path'
import { assertSupportedJsonSchema, jsonSchemaToTs } from '@deepseek-ai/dsh-tools'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { shutdown } from './lib/host.mjs'
import { requireWorker } from './lib/boundary.mjs'
import { docx, paragraph } from './lib/document-fixture.mjs'
import { documentHost, documentNames, documentCall, documentCode, activateDocument } from './lib/document-host.mjs'
import { capability } from '../lib/capabilities/registry.js'
import { publicToolName } from '../lib/policy.js'
import { canonicalOutput } from '../lib/ptc/projection/canonical-schema.js'
import { decodeContinuation } from '../lib/ptc/projection/continuation.js'
import { definition } from '../lib/file/contract.js'
requireWorker('docx-host')
const TOOL = publicToolName('read_docx')
const render = value => definition('read_docx', async () => value).output.render({ path: 'body.docx' }, value)[0].text
await test('DOCX catalogue and generated schema preserve strict paragraph types and declared main-body limits', () => {
  const entry = capability('read_docx'); assert.equal(entry.availability, 'discoverable'); assert.equal(entry.mutates, false)
  assert.equal(entry.parameters.additionalProperties, false); assert.deepEqual(entry.parameters.required, ['path'])
  const schema = canonicalOutput('read_docx'); assertSupportedJsonSchema(schema)
  assert.equal(schema.properties.items.items.properties.text.type, 'string'); assert.equal(schema.properties.items.items.properties.cells, undefined)
  assert.equal(schema.properties.source.properties.blocksObserved.type, 'integer')
  assert.match(jsonSchemaToTs(schema), /type: "paragraph"/); assert.match(entry.description, /main-body|Scope excludes/)
})
await test('real Native and PTC DOCX discovery remain scoped and typed pages retain main-body coverage', () => withTempDir('docx-host-page', async root => {
  const cwd = path.join(root, 'nested'); fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(cwd, 'body.docx'), docx(paragraph('中😀') + '<w:tbl><w:tr><w:tc>' + paragraph('0001') + '</w:tc></w:tr></w:tbl>', { deflate: true }))
  const { ctx, agent } = await documentHost(root, ['read_docx'], { real: true })
  try {
    const native = await agent('native', { cwd }), sibling = await agent(), code = await agent('ptc', { cwd })
    assert.equal(documentNames(ctx, native).includes(TOOL), false)
    await activateDocument(ctx, native, 'read_docx'); await activateDocument(ctx, code, 'read_docx', 'ptc')
    assert.equal(documentNames(ctx, sibling).includes(TOOL), false)
    const raw = await documentCall(ctx, native, 'read_docx', { path: 'body.docx', limit: 1 })
    assert.equal(raw.format, 'docx'); assert.equal(raw.scope, 'main-body-paragraphs'); assert.equal(raw.scanComplete, true)
    assert.equal(raw.complete, false); assert.equal(raw.total, 2); assert.equal(raw.items[0].text, '中😀')
    const text = render(raw); assert.match(text, /Paragraph 1/); assert.match(text, /main-body-paragraphs/)
    assert.match(text, /headers and footers/); assert.match(text, /Completeness applies only to this scope/)
    const result = await documentCode(ctx, code, `return await tools.${TOOL}({path:'body.docx',limit:1});`)
    assert.equal(result.status, 'partial'); assert.equal(result.data.scope, 'main-body-paragraphs')
    const next = decodeContinuation(result.continuation); assert.equal(next.tool, 'read_docx'); assert.equal(next.args.offset, 2)
    const tail = await documentCall(ctx, code, next.tool, next.args)
    assert.equal(tail.status, 'completed'); assert.equal(tail.data.revision, result.data.revision)
    assert.deepEqual(tail.data.items[0], { block: 2, type: 'paragraph', text: '0001', table: 1, row: 1, cell: 1 })
  } finally { await shutdown(ctx) }
}))
await test('unsupported late DOCX content preserves paragraphs and scope in both projections without looping cursors', () => withTempDir('docx-host-gap', async root => {
  fs.writeFileSync(path.join(root, 'body.docx'), docx(paragraph('safe prefix') + '<w:p><w:r><w:drawing/></w:r></w:p>'))
  const { ctx, agent } = await documentHost(root, ['read_docx'])
  try {
    const native = await agent(), code = await agent('ptc')
    await activateDocument(ctx, native, 'read_docx'); await activateDocument(ctx, code, 'read_docx', 'ptc')
    const raw = await documentCall(ctx, native, 'read_docx', { path: 'body.docx', limit: 1 })
    assert.equal(raw.scanComplete, false); assert.equal(raw.pageComplete, true); assert.equal(raw.total, undefined)
    assert.match(render(raw), /UNSUPPORTED_DOCUMENT/); assert.match(render(raw), /Paragraph 1.*safe prefix/); assert.match(render(raw), /not exhaustive/)
    const result = await documentCall(ctx, code, 'read_docx', { path: 'body.docx', limit: 1 })
    assert.equal(result.status, 'error'); assert.equal(result.error.code, 'UNSUPPORTED_DOCUMENT'); assert.equal(result.error.effectState, 'none')
    assert.equal(result.error.retry, 'never'); assert.equal(result.continuation, undefined); assert.equal(result.data.items[0].text, 'safe prefix')
    assert.match(result.error.nextAction, /dedicated DOCX reader/)
  } finally { await shutdown(ctx) }
}))
await test('read-only DOCX reads retain credential refusal and explicit unsupported binary DOC values', () => withTempDir('docx-host-authority', async root => {
  fs.writeFileSync(path.join(root, 'body.docx'), docx(paragraph('readonly')))
  fs.writeFileSync(path.join(root, 'id_ed25519.docx'), docx(paragraph('SECRET')))
  fs.writeFileSync(path.join(root, 'old.doc'), Buffer.from('d0cf11e0a1b11ae1', 'hex'))
  const before = fs.readdirSync(root).sort(), { ctx, agent } = await documentHost(root, ['read_docx'])
  try {
    const owner = await agent('ptc', { policy: 'read-only' }); await activateDocument(ctx, owner, 'read_docx', 'ptc')
    assert.equal((await documentCall(ctx, owner, 'read_docx', { path: 'body.docx' })).status, 'completed')
    const denied = await documentCall(ctx, owner, 'read_docx', { path: 'id_ed25519.docx' })
    assert.equal(denied.error.code, 'CREDENTIAL_DENIED'); assert.equal(denied.error.effectState, 'none'); assert.doesNotMatch(JSON.stringify(denied), /SECRET/)
    const old = await documentCall(ctx, owner, 'read_docx', { path: 'old.doc' })
    assert.equal(old.error.code, 'UNSUPPORTED_DOCUMENT'); assert.equal(old.continuation, undefined)
    assert.deepEqual(fs.readdirSync(root).sort(), before)
  } finally { await shutdown(ctx) }
}))
await test('large DOCX paragraphs spill with exact paragraph chunks and independently stated source scope', () => withTempDir('docx-host-spill', async root => {
  fs.writeFileSync(path.join(root, 'body.docx'), docx(paragraph('😀'.repeat(40000)), { deflate: true }))
  const { ctx, agent } = await documentHost(root, ['read_docx', 'result'])
  try {
    const owner = await agent(); await activateDocument(ctx, owner, 'read_docx'); await activateDocument(ctx, owner, 'result')
    const raw = await documentCall(ctx, owner, 'read_docx', { path: 'body.docx' })
    assert.equal(raw.reference.producerTool, 'read_docx'); assert.equal(raw.complete, false); assert.equal(raw.scanComplete, true)
    const content = render(raw); assert.ok(Buffer.byteLength(JSON.stringify([{ type: 'text', text: content }])) <= 65536)
    assert.match(content, /ref:\/\//); assert.match(content, /main-body-paragraphs/)
    const page = await documentCall(ctx, owner, 'result', { action: 'page', id: raw.reference.refId, root: raw.referenceRoot, limit: 1 })
    assert.equal(page.source.scope, 'main-body-paragraphs'); assert.equal(page.source.blocksObserved, 1)
    assert.equal(page.source.captureComplete, true); assert.ok(page.source.excludedContent.includes('headers and footers'))
    assert.equal(page.items[0].kind, 'item-json-chunk'); assert.equal(page.items[0].byteOffset, 0)
  } finally { await shutdown(ctx) }
}))
report('docx-host')
