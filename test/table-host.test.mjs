/** Document tools share live authority while preserving separate Native/PTC projections. */
import fs from 'node:fs'
import path from 'node:path'
import { assertSupportedJsonSchema, jsonSchemaToTs } from '@deepseek-ai/dsh-tools'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { shutdown } from './lib/host.mjs'
import { requireWorker } from './lib/boundary.mjs'
import { documentHost, documentNames, documentCall, documentCode, activateDocument } from './lib/document-host.mjs'
import { capability } from '../lib/capabilities/registry.js'
import { publicToolName } from '../lib/policy.js'
import { canonicalOutput } from '../lib/ptc/projection/canonical-schema.js'
import { decodeContinuation, continuationFor } from '../lib/ptc/projection/continuation.js'
import { definition } from '../lib/file/contract.js'
requireWorker('table-host')
const TOOL = publicToolName('read_table')
const rendered = (args, value) => definition('read_table', async () => value).output.render(args, value)[0].text
await test('table catalogue is discoverable, read-only, strict and generates lexical row types', () => {
  const entry = capability('read_table')
  assert.equal(entry.availability, 'discoverable'); assert.equal(entry.mutates, false); assert.equal(entry.concurrencySafe, true)
  assert.equal(entry.parameters.additionalProperties, false); assert.deepEqual(entry.parameters.required, ['path'])
  for (const schema of [entry.parameters, canonicalOutput('read_table'), canonicalOutput('result')]) assertSupportedJsonSchema(schema)
  const schema = canonicalOutput('read_table')
  assert.equal(schema.properties.items.items.properties.cells.items.type, 'string')
  assert.equal(schema.properties.source.properties.rowsObserved.type, 'integer')
  assert.equal(canonicalOutput('result').properties.source.properties.rowsObserved.type, 'integer')
  assert.match(jsonSchemaToTs(schema), /cells: string\[\]/)
  const common = { scanComplete: true, revision: 'a'.repeat(64), nextOffset: 2, total: 3 }
  assert.equal(decodeContinuation(continuationFor('read_table', { path: 'x' }, common)).args.offset, 2)
  for (const change of [{ scanComplete: false }, { revision: undefined }, { nextOffset: 1 }, { nextOffset: 4 }]) {
    assert.equal(continuationFor('read_table', { path: 'x' }, { ...common, ...change }), undefined)
  }
})
await test('Native table activation is next-step and owner-only; relative cwd and positional records survive rendering', () => withTempDir('table-native', async root => {
  const cwd = path.join(root, 'nested'); fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(cwd, 'data.csv'), 'name,name,\n"中,文","two\nlines",0001\n')
  const { ctx, agent } = await documentHost(root, ['read_table'])
  try {
    const owner = await agent('native', { cwd }), sibling = await agent(), child = await agent('native', { parent: owner })
    assert.equal(documentNames(ctx, owner).includes(TOOL), false)
    const assembly = await ctx.get('systemPrompt').assemble({ scope: owner })
    assert.equal(assembly.tools.some(tool => tool.name === TOOL), false)
    await activateDocument(ctx, owner, 'read_table')
    for (const other of [sibling, child]) assert.equal(documentNames(ctx, other).includes(TOOL), false)
    const data = await documentCall(ctx, owner, 'read_table', { path: 'data.csv' })
    assert.equal(data.status, 'completed', JSON.stringify(data)); assert.equal(data.complete, true)
    assert.deepEqual(data.columns, ['name', 'name', '']); assert.deepEqual(data.items[0].cells, ['中,文', 'two\nlines', '0001'])
    assert.equal(data.path, path.join(cwd, 'data.csv'))
    const text = rendered({ path: 'data.csv' }, data)
    assert.match(text, /Row 1 \(LF lines 2-3\)/); assert.match(text, /"two\\nlines"/); assert.match(text, /scanComplete=true/)
    assert.doesNotMatch(text, /Mutation|receipt/)
  } finally { await shutdown(ctx) }
}))
await test('real PTC SDK returns typed lexical rows and only full stable scans supply forward page cursors', () => withTempDir('table-ptc', async root => {
  fs.writeFileSync(path.join(root, 'rows.tsv'), 'id\tvalue\n0001\tTRUE\n0002\tFALSE\n0003\tnull\n')
  const { ctx, agent } = await documentHost(root, ['read_table'], { real: true })
  try {
    const owner = await agent('ptc'), sibling = await agent('ptc')
    await activateDocument(ctx, owner, 'read_table', 'ptc')
    assert.equal(documentNames(ctx, sibling).includes(TOOL), false)
    const first = await documentCode(ctx, owner, `return await tools.${TOOL}({path:'rows.tsv',limit:1});`)
    assert.equal(first.status, 'partial', JSON.stringify(first)); assert.equal(first.data.scanComplete, true)
    assert.deepEqual(first.data.items[0].cells, ['0001', 'TRUE']); assert.equal(first.data.total, 3)
    const next = decodeContinuation(first.continuation)
    assert.deepEqual(next, { version: 1, tool: 'read_table', args: { path: 'rows.tsv', limit: 1, offset: 2 } })
    const second = await documentCall(ctx, owner, next.tool, next.args)
    assert.equal(second.status, 'partial'); assert.deepEqual(second.data.items[0].cells, ['0002', 'FALSE'])
    assert.equal(second.data.revision, first.data.revision)
    const tail = await documentCall(ctx, owner, 'read_table', { path: 'rows.tsv', offset: 3, limit: 1 })
    assert.equal(tail.status, 'completed'); assert.equal(tail.data.complete, true)
  } finally { await shutdown(ctx) }
}))
await test('malformed late records retain safe prefix data in both projections without resumable scan-gap advice', () => withTempDir('table-gap-host', async root => {
  fs.writeFileSync(path.join(root, 'bad.csv'), 'name\nsafe\n"unterminated')
  const { ctx, agent } = await documentHost(root, ['read_table'])
  try {
    const native = await agent(), code = await agent('ptc')
    await activateDocument(ctx, native, 'read_table'); await activateDocument(ctx, code, 'read_table', 'ptc')
    const raw = await documentCall(ctx, native, 'read_table', { path: 'bad.csv' })
    const text = rendered({ path: 'bad.csv' }, raw)
    assert.match(text, /TABLE_PARSE_ERROR/); assert.match(text, /Row 1.*"safe"/); assert.match(text, /not exhaustive/)
    assert.equal(raw.scanComplete, false); assert.equal(raw.total, undefined)
    const typed = await documentCall(ctx, code, 'read_table', { path: 'bad.csv' })
    assert.equal(typed.status, 'error'); assert.equal(typed.error.code, 'TABLE_PARSE_ERROR'); assert.equal(typed.error.effectState, 'none')
    assert.equal(typed.error.retry, 'after-input-change'); assert.equal(typed.continuation, undefined)
    assert.deepEqual(typed.data.items[0].cells, ['safe']); assert.equal(typed.data.revision, undefined)
  } finally { await shutdown(ctx) }
}))
await test('read-only table calls create no files and current credentials remain denied', () => withTempDir('table-authority-host', async root => {
  fs.writeFileSync(path.join(root, 'ok.csv'), 'key\nvalue\n'); fs.mkdirSync(path.join(root, '.ssh')); fs.writeFileSync(path.join(root, '.ssh', 'id_ed25519.csv'), 'SECRET')
  const before = fs.readdirSync(root, { recursive: true }).sort()
  const { ctx, agent } = await documentHost(root, ['read_table'])
  try {
    const owner = await agent('native', { policy: 'read-only' }); await activateDocument(ctx, owner, 'read_table')
    const ok = await documentCall(ctx, owner, 'read_table', { path: 'ok.csv' })
    assert.equal(ok.complete, true); assert.deepEqual(ok.items[0].cells, ['value'])
    const denied = await documentCall(ctx, owner, 'read_table', { path: '.ssh/id_ed25519.csv' })
    assert.equal(denied.error.code, 'CREDENTIAL_DENIED'); assert.equal(denied.error.effectState, 'none'); assert.doesNotMatch(JSON.stringify(denied), /SECRET/)
    const invalid = await documentCall(ctx, owner, 'read_table', { path: 'ok.csv', limit: 0 })
    assert.equal(invalid.error.code, 'INVALID_ARGUMENT')
    assert.deepEqual(fs.readdirSync(root, { recursive: true }).sort(), before)
  } finally { await shutdown(ctx) }
}))
await test('large Native table rows spill with original coverage and recoverable item metadata', () => withTempDir('table-spill-host', async root => {
  fs.writeFileSync(path.join(root, 'big.csv'), 'value\n' + '😀'.repeat(40000) + '\n')
  const { ctx, agent } = await documentHost(root, ['read_table', 'result'])
  try {
    const owner = await agent(); await activateDocument(ctx, owner, 'read_table'); await activateDocument(ctx, owner, 'result')
    const data = await documentCall(ctx, owner, 'read_table', { path: 'big.csv' })
    assert.equal(data.reference.producerTool, 'read_table'); assert.equal(data.scanComplete, true)
    assert.equal(data.complete, false); assert.equal(data.rowsObserved, 1)
    assert.equal(fs.realpathSync.native(data.referenceRoot), fs.realpathSync.native(root))
    const content = [{ type: 'text', text: rendered({ path: 'big.csv' }, data) }]
    assert.ok(Buffer.byteLength(JSON.stringify(content)) <= 65536); assert.match(content[0].text, /ref:\/\//)
    const page = await documentCall(ctx, owner, 'result', { action: 'page', id: data.reference.refId, root: data.referenceRoot, limit: 1 })
    assert.equal(page.source.rowsObserved, 1); assert.equal(page.source.scanComplete, true)
    assert.equal(page.source.captureComplete, true); assert.equal(page.source.capturedItems, 1)
    assert.equal(page.items[0].kind, 'item-json-chunk'); assert.equal(page.items[0].index, 0); assert.equal(page.items[0].byteOffset, 0)
  } finally { await shutdown(ctx) }
}))
report('table-host')
