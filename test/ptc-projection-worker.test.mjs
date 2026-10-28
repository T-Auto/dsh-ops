/** Validate real canonical worker receipts through the actual PTC output schemas. */
import fs from 'node:fs'
import { textPdf, show } from './lib/pdf-fixture.mjs'
import { docx, paragraph } from './lib/document-fixture.mjs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { validateJsonSchemaValue, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { definition, PTC_API_TOOLS } from '../lib/ptc/contract.js'
import { decodeContinuation } from '../lib/ptc/projection/continuation.js'
import { workerEnvelope } from '../lib/worker-protocol.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { requireWorker, request, callWorker, envelopeOf } from './lib/boundary.mjs'
requireWorker('ptc-projection-worker')
const hash = text => createHash('sha256').update(text).digest('hex')
const seen = new Set()
async function call(root, tool, args, { storage, readOnly = false } = {}) {
  const execute = async () => envelopeOf(await callWorker(JSON.stringify(workerEnvelope(tool === 'batch' || tool === 'result' ? 'ptc' : 'file',
    request(tool, args, { root, scope: 'ptc-projection', readOnly }), undefined, storage))), assert)
  const entry = definition(tool, execute), out = await entry.execute(args, {})
  assertSupportedJsonSchema(entry.output.schema)
  assert.deepEqual(validateJsonSchemaValue(entry.output.schema, out), [], `${tool}: ${JSON.stringify(out)}`)
  seen.add(tool)
  return out
}
await test('all file observations validate and retain text, hex, stat and search canonical types', async () => {
  await withTempDir('ptc-read', async root => {
    const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'alpha\r\nβeta\nlast')
    for (const [tool, args] of [
      ['inspect_local_file', { path: file }], ['inspect_local_file', { path: file, view: 'hex', limit: 1 }],
      ['stat', { path: file }], ['stat', { path: path.join(root, 'absent') }],
      ['diff', { path: file, content: 'changed\n' }], ['glob', { path: root, pattern: ['*.txt'], outputMode: 'details' }],
      ['glob', { path: root, pattern: ['*.txt'] }], ['grep', { path: root, pattern: 'a' }],
      ['read_files', { files: [{ path: file, limit: 1 }] }],
    ]) assert.ok(['completed','partial'].includes((await call(root, tool, args)).status), tool)
    const failed = await call(root, 'read_files', { files: [{ path: file }, { path: path.join(root, 'missing') }] })
    assert.equal(failed.status, 'error'); assert.equal(failed.data.items[0].items[1].text, 'βeta')
    assert.equal((await call(root, 'grep', { path: root, pattern: '[' })).error.code, 'INVALID_ARGUMENT')
  })
})
await test('table observations validate actual lexical rows through the PTC output schema', async () => {
  await withTempDir('ptc-table', async root => {
    const file = path.join(root, 'rows.csv'); fs.writeFileSync(file, 'name,value\nalpha,01\n')
    const out = await call(root, 'read_table', { path: file })
    assert.equal(out.status, 'completed'); assert.deepEqual(out.data.items[0].cells, ['alpha', '01'])
    assert.equal(out.data.scanComplete, true); assert.equal(out.data.rowCount, 1)
  })
})
await test('DOCX observations validate actual main-body paragraphs through the PTC output schema', async () => {
  await withTempDir('ptc-docx', async root => {
    const file = path.join(root, 'paragraphs.docx'); fs.writeFileSync(file, docx(paragraph('Exact Unicode 中')))
    const out = await call(root, 'read_docx', { path: file })
    assert.equal(out.status, 'completed'); assert.equal(out.data.items[0].text, 'Exact Unicode 中')
    assert.equal(out.data.scanComplete, true); assert.equal(out.data.scope, 'main-body-paragraphs')
  })
})
await test('PDF observations validate actual text-layer pages through the PTC output schema', async () => {
  await withTempDir('ptc-pdf', async root => {
    const file = path.join(root, 'pages.pdf'); fs.writeFileSync(file, textPdf([show('Exact PDF text')]))
    const out = await call(root, 'read_pdf', { path: file })
    assert.equal(out.status, 'completed'); assert.equal(out.data.items[0].text, 'Exact PDF text')
    assert.equal(out.data.scanComplete, true); assert.equal(out.data.scope, 'page-text-layer-content-order')
  })
})
await test('mutation receipts and batch plans preserve effects without changing the native kernel', async () => {
  await withTempDir('ptc-write', async root => {
    const file = path.join(root, 'a.txt'), copy = path.join(root, 'copy.txt'), moved = path.join(root, 'moved.txt')
    assert.equal((await call(root, 'write_file', { path: file, content: 'alpha', expectedRevision: 'absent' })).status, 'completed')
    for (const tool of ['edit_file']) assert.equal((await call(root, tool, { path: file, expectedRevision: hash('alpha'), edits: [{ oldText: 'alpha', newText: 'beta' }], dryRun: true })).status, 'completed')
    assert.equal((await call(root, 'replace', { path: root, pattern: 'alpha', replacement: 'beta', dryRun: true })).status, 'completed')
    assert.equal((await call(root, 'copy', { path: file, to: copy, expectedRevision: hash('alpha') })).status, 'completed')
    assert.equal((await call(root, 'move', { path: copy, to: moved, expectedRevision: hash('alpha') })).status, 'completed')
    assert.equal((await call(root, 'remove', { path: moved, expectedRevision: hash('alpha') })).status, 'completed')
    const denied = await call(root, 'write_file', { path: file, content: 'bad', expectedRevision: hash('alpha') }, { readOnly: true })
    assert.equal(denied.status, 'rejected'); assert.equal(denied.error.retry, 'never'); assert.equal(fs.readFileSync(file, 'utf8'), 'alpha')
    const plan = await call(root, 'batch', { action: 'plan', operations: [{ op: 'copy', path: 'a.txt', to: 'batch.txt' }] })
    assert.equal(plan.status, 'completed'); assert.equal(plan.data.status, 'planned')
    assert.equal((await call(root, 'batch', { action: 'resume', id: plan.data.id })).status, 'completed')
  })
})
await test('real reference pages follow a bounded cursor to completion and release reports success', async () => {
  await withTempDir('ptc-pages', async root => {
    const cache = path.join(root, 'cache'); fs.mkdirSync(cache, { mode: 0o700 })
    const storage = { root: cache, authorityId: 'a'.repeat(64), allowedTools: ['result'] }
    const rows = Array.from({ length: 4 }, (_, n) => ({ n, text: 'line' }))
    const put = await call(root, 'result', { action: 'put', items: rows }, { storage })
    assert.equal(put.status, 'completed')
    let args = { action: 'page', id: put.data.id, limit: 1, maxBytes: 2048, fields: ['n'] }, previous = -1
    const collected = []
    for (let page = 0; page < 4; page++) {
      const out = await call(root, 'result', args, { storage })
      collected.push(...out.data.items); assert.ok(out.data.nextOffset > previous); previous = out.data.nextOffset
      if (out.status === 'completed') break
      assert.equal(out.status, 'partial')
      args = decodeContinuation(out.continuation).args
      assert.deepEqual(args.fields, ['n']); assert.equal(args.limit, 1); assert.equal(args.maxBytes, 2048)
    }
    assert.deepEqual(collected, rows.map(({ n }) => ({ n })))
    assert.equal((await call(root, 'result', { action: 'release', id: put.data.id }, { storage })).status, 'completed')
    const legacy = await call(root, 'result', { action: 'put', items: rows })
    assert.equal(legacy.status, 'completed'); assert.match(legacy.data.id, /^r-/)
    assert.equal((await call(root, 'result', { action: 'release', id: legacy.data.id })).status, 'completed')
  })
})
await test('every worker API was validated and unexpected callback rejection becomes an unknown value', async () => {
  assert.deepEqual([...seen].sort(), [...PTC_API_TOOLS].sort())
  for (const tool of ['result','write_file']) {
    const entry = definition(tool, async () => { throw new Error('private transport detail') })
    const out = await entry.execute({}, {})
    assert.equal(out.status, 'unknown'); assert.equal(out.error.retry, 'never')
    assert.deepEqual(validateJsonSchemaValue(entry.output.schema, out), [])
    assert.doesNotMatch(JSON.stringify(out), /private transport detail/)
  }
})
report('ptc-projection-worker')
