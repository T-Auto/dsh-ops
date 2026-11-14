/** Real PDF worker observations: supported text scope, honest gaps, bounded work and authority. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callWorker, request, envelopeOf, requireWorker } from './lib/boundary.mjs'
import { pdf, stream, show, textPdf } from './lib/pdf-fixture.mjs'
requireWorker('pdf-worker')
const fileAt = (root, value, name = 'document.pdf') => { const file = path.join(root, name); fs.writeFileSync(file, value); return file }
async function run(root, args, options = {}) {
  const payload = { version: 1, requestId: 'pdf-test', component: 'file', budget: { timeoutMs: 30000, maxBytes: options.maxBytes ?? 131072 },
    ...(options.cache ? { storage: { root: options.cache, authorityId: 'a'.repeat(64), allowedTools: ['read_pdf', 'result'] } } : {}),
    request: { ...request(options.tool ?? 'read_pdf', args, { root, readOnly: options.readOnly, writeRoots: [] }), ...options.authority } }
  const raw = await callWorker(JSON.stringify(payload)); assert.ok(Buffer.byteLength(raw.stdout) <= payload.budget.maxBytes)
  return envelopeOf(raw, assert)
}
function failure(body, code) { assert.equal(body.error?.code, code, JSON.stringify(body)); assert.equal(body.error.effectState, 'none'); assert.notEqual(body.complete, true); assert.equal(body.total, undefined); assert.equal(body.revision, undefined) }
const catalog = '<< /Type /Catalog /Pages 2 0 R >>'
const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
const page = content => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + content + ' >>'
function padded(size, label = 'ok') { const prefix = show(label); return prefix + '%' + 'x'.repeat(size - Buffer.byteLength(prefix) - 2) + '\n' }

await test('raw and Flate PDF pages preserve literal/hex/TJ runs and exact WinAnsi Unicode', async () => {
  await withTempDir('pdf-text', async root => {
    const content = 'BT /F1 12 Tf (A\\(B\\)\\\\C) Tj [<436166e9> -120 ( ) 5 <80>] TJ T* (next) \' 0 0 (last) " ET\n'
    for (const deflate of [false, true]) {
      const bytes = textPdf([content], { deflate }), body = await run(root, { path: fileAt(root, bytes) })
      assert.equal(body.error, undefined); assert.equal(body.status, 'completed'); assert.equal(body.complete, true)
      assert.equal(body.scope, 'page-text-layer-content-order'); assert.ok(body.excludedContent.includes('images and OCR'))
      assert.deepEqual(body.items, [{ page: 1, text: 'A(B)\\C\nCafé €\nnext\nlast', runs: ['A(B)\\C', 'Café €', 'next', 'last'] }])
      assert.equal(body.total, 1); assert.equal(body.revision, createHash('sha256').update(bytes).digest('hex')); assert.equal(body.nextOffset, 2)
    }
    const aliases = await run(root, { path: fileAt(root, textPdf([show(Buffer.from([127,129,141,143,144,157,160,173,159]))])) })
    assert.equal(aliases.items[0].text, '•••••• -Ÿ')
    const standard = await run(root, { path: fileAt(root, textPdf([show("'quote" + String.fromCharCode(96))], { encoding: null })) })
    assert.equal(standard.items[0].text, '’quote‘')
  })
})
await test('page offsets have complete-scan totals, ten-page default and honest blank/empty documents', async () => {
  await withTempDir('pdf-pages', async root => {
    const file = fileAt(root, textPdf(Array.from({ length: 12 }, (_, i) => show('Page ' + (i + 1)))))
    const first = await run(root, { path: file }); assert.equal(first.items.length, 10); assert.equal(first.nextOffset, 11); assert.equal(first.total, 12); assert.equal(first.scanComplete, true); assert.equal(first.pageComplete, true); assert.equal(first.complete, false)
    const last = await run(root, { path: file, offset: 11, limit: 2 }); assert.deepEqual(last.items.map(i => i.page), [11, 12]); assert.equal(last.complete, true); assert.equal(last.revision, first.revision)
    const blank = await run(root, { path: fileAt(root, textPdf([' \n\t'])) }); assert.deepEqual(blank.items, [{ page: 1, text: '', runs: [] }]); assert.equal(blank.complete, true)
    const empty = await run(root, { path: fileAt(root, textPdf([])) }); assert.equal(empty.total, 0); assert.deepEqual(empty.items, []); assert.equal(empty.complete, true)
    for (const args of [{ offset: 0 }, { offset: 33 }, { limit: 0 }, { limit: 33 }, { unknown: true }]) failure(await run(root, { path: file, ...args }), 'INVALID_ARGUMENT')
  })
})
await test('unsupported later operators keep preceding complete pages without inventing a total or cursor', async () => {
  await withTempDir('pdf-gaps', async root => {
    for (const content of ['/X1 Do', 'BI /W 1 /H 1 ID x EI', '/Tag BMC EMC', '/GS1 gs', '0 0 m 1 1 l S', 'BX weird EX']) {
      const body = await run(root, { path: fileAt(root, textPdf([show('safe'), content, show('unobserved')])), limit: 1 })
      failure(body, 'UNSUPPORTED_DOCUMENT'); assert.equal(body.status, 'partial'); assert.equal(body.scanComplete, false); assert.equal(body.pageComplete, true)
      assert.equal(body.pagesObserved, 1); assert.deepEqual(body.items.map(i => i.text), ['safe']); assert.match(body.nextAction, /paging|offsets|gaps/i); assert.equal(body.continuation, undefined)
    }
  })
})
await test('unsupported fonts mappings controls and older encoding semantics fail explicitly', async () => {
  await withTempDir('pdf-fonts', async root => {
    for (const options of [{ font: 'Symbol' }, { font: 'Arial' }, { encoding: 'MacRomanEncoding' }, { fontExtra: '/ToUnicode 3 0 R' }, { fontExtra: '/FontDescriptor 3 0 R' }, { version: '1.2' }]) {
      failure(await run(root, { path: fileAt(root, textPdf([show('text')], options)) }), 'UNSUPPORTED_DOCUMENT')
    }
    failure(await run(root, { path: fileAt(root, textPdf([show(Buffer.from([0xe9]))], { encoding: null })) }), 'UNSUPPORTED_DOCUMENT')
    failure(await run(root, { path: fileAt(root, textPdf([show(Buffer.from([0,10]))])) }), 'UNSUPPORTED_DOCUMENT')
  })
})
await test('malformed content cannot be accepted as complete text', async () => {
  await withTempDir('pdf-grammar', async root => {
    for (const content of ['BT BT ET ET', '(x) Tj', 'ET', 'BT /F1 Tf ET', 'BT /F1 12 Tf [(x) /bad] TJ ET', 'BT /F1 12 Tf (x) Tj', 'q', 'Q', '1 2', 'BT /F1 12 Tf 8 Tr (x) Tj ET', 'BT /F1 12 Tf <xy> Tj ET']) {
      failure(await run(root, { path: fileAt(root, textPdf([content])) }), 'DOCUMENT_PARSE_ERROR')
    }
  })
})
await test('page counts aliases cycles parents and physical page limits are enforced before text traversal', async () => {
  await withTempDir('pdf-tree', async root => {
    for (const tree of ['<< /Type /Pages /Kids [4 0 R] /Count 2 >>', '<< /Type /Pages /Kids [4 0 R 4 0 R] /Count 2 >>', '<< /Type /Pages /Kids [2 0 R] /Count 1 >>']) {
      failure(await run(root, { path: fileAt(root, pdf([catalog, tree, font, page('5 0 R'), stream(show('safe'))])) }), 'DOCUMENT_PARSE_ERROR')
    }
    failure(await run(root, { path: fileAt(root, pdf([catalog, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', font, page('5 0 R').replace('/Parent 2', '/Parent 1'), stream(show('safe'))])) }), 'DOCUMENT_PARSE_ERROR')
    failure(await run(root, { path: fileAt(root, textPdf(Array.from({ length: 33 }, () => show('x')))), limit: 1 }), 'OUTPUT_LIMIT')
  })
})
await test('raw file and actual decoded stream limits are independent of advertised compressed sizes', async () => {
  await withTempDir('pdf-bounds', async root => {
    failure(await run(root, { path: fileAt(root, Buffer.alloc(16 * 1024 * 1024 + 1)) }), 'OUTPUT_LIMIT')
    for (const deflate of [false, true]) failure(await run(root, { path: fileAt(root, textPdf([padded(1024 * 1024 + 1)], { deflate })) }), 'OUTPUT_LIMIT')
    failure(await run(root, { path: fileAt(root, textPdf([show('x')], { deflate: true, extra: '/DecodeParms << /Predictor 12 >>' })) }), 'UNSUPPORTED_DOCUMENT')
  })
})
await test('unique decoded streams and repeated shared work have separate aggregate caps', async () => {
  await withTempDir('pdf-aggregate', async root => {
    const content = padded(1024 * 1024)
    const unique = await run(root, { path: fileAt(root, textPdf(Array(17).fill(content), { deflate: true })), limit: 1 })
    failure(unique, 'OUTPUT_LIMIT'); assert.equal(unique.pagesObserved, 16); assert.equal(unique.decodedBytes, 16 * 1024 * 1024); assert.equal(unique.items[0].text, 'ok')
    const objects = [catalog, '<< /Type /Pages /Kids [' + Array.from({ length: 17 }, (_, i) => (5 + i) + ' 0 R').join(' ') + '] /Count 17 >>', font, stream(content, { deflate: true }), ...Array(17).fill(page('4 0 R'))]
    const shared = await run(root, { path: fileAt(root, pdf(objects)), limit: 1 })
    failure(shared, 'OUTPUT_LIMIT'); assert.equal(shared.pagesObserved, 16); assert.equal(shared.decodedBytes, 1024 * 1024); assert.equal(shared.processedBytes, 16 * 1024 * 1024)
    const array = [catalog, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', font, page('[5 0 R 6 0 R]'), stream(padded(600000), { deflate: true }), stream(padded(600000), { deflate: true })]
    failure(await run(root, { path: fileAt(root, pdf(array)) }), 'OUTPUT_LIMIT')
  })
})
await test('content arrays concatenate in order and inherited resources resolve without a second decoding', async () => {
  await withTempDir('pdf-inherit', async root => {
    const objects = [catalog, '<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 /Resources << /Font << /F1 3 0 R >> >> >>', font,
      '<< /Type /Page /Parent 2 0 R /Contents [6 0 R 7 0 R] >>', '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>', stream(show('first'), { deflate: true }), stream(show('second'), { deflate: true })]
    const body = await run(root, { path: fileAt(root, pdf(objects)) })
    assert.equal(body.complete, true); assert.deepEqual(body.items.map(i => i.runs), [['first', 'second'], ['first']])
    assert.equal(body.decodedBytes, Buffer.byteLength(show('first') + show('second'))); assert.equal(body.processedBytes, body.decodedBytes + Buffer.byteLength(show('first')))
  })
})
await test('read-only PDF observations create nothing and repeat credential/no-follow checks', async () => {
  await withTempDir('pdf-authority', async root => {
    const file = fileAt(root, textPdf([show('safe')])), before = fs.readdirSync(root)
    assert.equal((await run(root, { path: file }, { readOnly: true })).complete, true); assert.deepEqual(fs.readdirSync(root), before)
    failure(await run(root, { path: file }, { authority: { deny_roots: [root] } }), 'CREDENTIAL_DENIED')
    const target = path.join(root, 'target'); fs.mkdirSync(target); const hidden = fileAt(target, textPdf([show('secret')]))
    const alias = path.join(root, 'alias'); fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const denied = await run(root, { path: path.join(alias, path.basename(hidden)) }); assert.ok(denied.error); assert.equal(denied.error.effectState, 'none'); assert.equal(denied.items, undefined)
  })
})
await test('reference spill reconstructs complete PDF pages and retains source coverage and root', async () => {
  await withTempDir('pdf-spill', async root => {
    const cache = path.join(root, 'cache'); fs.mkdirSync(cache, { mode: 0o700 })
    const value = Buffer.alloc(30000, 0xe9), expected = 'é'.repeat(30000)
    const file = fileAt(root, textPdf([show(value), show('last')], { deflate: true }))
    const head = await run(root, { path: file }, { cache, maxBytes: 4096 })
    assert.ok(head.reference, JSON.stringify(head)); assert.equal(head.complete, false); assert.equal(head.nextOffset, 1)
    assert.equal(head.referenceRoot, process.platform === 'win32' ? path.toNamespacedPath(fs.realpathSync.native(root)) : fs.realpathSync(root))
    const records = []; let offset = 0, source
    for (;;) { const next = await run(head.referenceRoot, { action: 'page', id: head.reference.refId, offset, limit: 512, maxBytes: 65536 }, { cache, tool: 'result', readOnly: true }); assert.equal(next.error, undefined); records.push(...next.items); source = next.source; assert.ok(next.nextOffset > offset); offset = next.nextOffset; if (next.complete) break }
    assert.equal(source.scope, 'page-text-layer-content-order'); assert.equal(source.scanComplete, true); assert.equal(source.captureComplete, true); assert.equal(source.total, 2)
    const rows = []; let chunks = [], byteOffset = 0
    for (const item of records) { assert.equal(item.index, rows.length); if (item.kind === 'item') { rows.push(item.value); continue } assert.equal(item.chunk, chunks.length); assert.equal(item.byteOffset, byteOffset); chunks.push(item.text); byteOffset += Buffer.byteLength(item.text); if (item.complete) { rows.push(JSON.parse(chunks.join(''))); chunks = []; byteOffset = 0 } }
    assert.deepEqual(rows.map(row => row.text), [expected, 'last']); assert.equal(chunks.length, 0); assert.deepEqual(rows[0].runs, [expected])
    const readonly = await run(root, { path: file }, { cache, readOnly: true, maxBytes: 4096 }); assert.equal(readonly.reference, undefined); assert.equal(readonly.storageError.code, 'POLICY_DENIED'); assert.equal(readonly.complete, false)
  })
})
await test('transport output limit still reports no business effects in writable sessions', async () => {
  await withTempDir('pdf-transport', async root => { failure(await run(root, { path: fileAt(root, textPdf([show('x'.repeat(30000))])) }, { maxBytes: 1024 }), 'OUTPUT_LIMIT') })
})
await test('out-of-range offsets count actual skips and sparse blank pages remain empty', async () => {
  await withTempDir('pdf-sparse', async root => {
    const file=fileAt(root,textPdf([show('one'),show('two')]))
    const beyond=await run(root,{path:file,offset:32,limit:1})
    assert.equal(beyond.skipped,2);assert.equal(beyond.total,2);assert.deepEqual(beyond.items,[]);assert.equal(beyond.complete,true)
    const blanks=[catalog,'<< /Type /Pages /Kids [4 0 R 5 0 R 6 0 R] /Count 3 >>',font,
      '<< /Type /Page /Parent 2 0 R >>',page('null'),page('7 0 R'),stream('% comment only\n')]
    const body=await run(root,{path:fileAt(root,pdf(blanks))})
    assert.equal(body.complete,true);assert.deepEqual(body.items.map(item=>item.runs),[[],[],[]])
    failure(await run(root,{path:fileAt(root,textPdf(['BT /F1 12 Tf (x) Tj 0 0 m ET']))}),'DOCUMENT_PARSE_ERROR')
  })
})
await test('empty content arrays are empty pages and non-reference members are parse errors', async () => {
  await withTempDir('pdf-contents', async root => {
    const tree='<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>'
    const blank=await run(root,{path:fileAt(root,pdf([catalog,tree,font,page('[]'),'<< /Type /Page /Parent 2 0 R >>']))})
    assert.equal(blank.complete,true);assert.deepEqual(blank.items.map(item=>item.runs),[[],[]])
    const invalid='<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /Contents [(x)] >>'
    failure(await run(root,{path:fileAt(root,pdf([catalog,'<< /Type /Pages /Kids [4 0 R] /Count 1 >>',font,invalid]))}),'DOCUMENT_PARSE_ERROR')
  })
})
await test('stream-valued font and resource dictionaries cannot be interpreted as plain values', async () => {
  await withTempDir('pdf-stream-dicts',async root=>{
    const tree='<< /Type /Pages /Kids [4 0 R] /Count 1 >>'
    const fontStream=stream('',{extra:'/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding'})
    failure(await run(root,{path:fileAt(root,pdf([catalog,tree,fontStream,page('5 0 R'),stream(show('text'))]))}),'DOCUMENT_PARSE_ERROR')
    const resourcePage='<< /Type /Page /Parent 2 0 R /Resources 6 0 R /Contents 5 0 R >>'
    failure(await run(root,{path:fileAt(root,pdf([catalog,tree,font,resourcePage,stream(show('text')),stream('',{extra:'/Font << /F1 3 0 R >>'})]))}),'DOCUMENT_PARSE_ERROR')
  })
})
report('pdf-worker')
