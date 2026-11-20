/** #788: an indirect /Length "N G R" resolves through the same classic xref table.
 * No endstream scanning, no recovery: absent, free, chained, non-integer or oversized
 * providers keep failing closed exactly like an invalid direct length. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callWorker, request, envelopeOf, requireWorker } from './lib/boundary.mjs'
import { pdf, show } from './lib/pdf-fixture.mjs'
requireWorker('pdf-indirect-length')

const catalog = '<< /Type /Catalog /Pages 2 0 R >>'
const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
const pages = kids => '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + kids.length + ' >>'
const page = ref => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + ref + ' >>'
const direct = content => '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + '\nendstream'
const indirect = (content, ref) => '<< /Length ' + ref + ' >>\nstream\n' + content + '\nendstream'

async function run(root, args) {
  const payload = { version: 1, requestId: 'pdf-indirect-test', component: 'file',
    budget: { timeoutMs: 30000, maxBytes: 131072 },
    request: request('read_pdf', args, { root }) }
  return envelopeOf(await callWorker(JSON.stringify(payload)), assert)
}
const failure = (body, code) => {
  assert.equal(body.error?.code, code, JSON.stringify(body))
  assert.equal(body.error.effectState, 'none')
  assert.notEqual(body.complete, true)
}
const fileAt = (root, value) => { const file = path.join(root, 'document.pdf'); fs.writeFileSync(file, value); return file }

await test('indirect stream lengths read like direct ones in both file orders', async () => {
  await withTempDir('pdf-indirect', async root => {
    // Objects: 4 is the page, 5 its content stream, 6 the length provider that follows it.
    const providerAfter = pdf([catalog, pages(['4 0 R']), font, page('5 0 R'),
      indirect(show('later provider'), '6 0 R'), String(Buffer.byteLength(show('later provider')))])
    const after = await run(root, { path: fileAt(root, providerAfter) })
    assert.equal(after.error, undefined, JSON.stringify(after))
    assert.equal(after.status, 'completed'); assert.equal(after.complete, true)
    assert.deepEqual(after.items.map(i => i.text), ['later provider'])
    // Provider object 5 sits before the stream object 6 in file order.
    const providerBefore = pdf([catalog, pages(['4 0 R']), font, page('6 0 R'),
      String(Buffer.byteLength(show('earlier provider'))), indirect(show('earlier provider'), '5 0 R')])
    const before = await run(root, { path: fileAt(root, providerBefore) })
    assert.equal(before.error, undefined, JSON.stringify(before))
    assert.deepEqual(before.items.map(i => i.text), ['earlier provider'])
  })
})

await test('direct and indirect lengths coexist in one document', async () => {
  await withTempDir('pdf-indirect-mixed', async root => {
    const one = show('direct page'), two = show('indirect page')
    const mixed = pdf([catalog, pages(['4 0 R', '6 0 R']), font, page('5 0 R'), direct(one),
      page('7 0 R'), indirect(two, '8 0 R'), String(Buffer.byteLength(two))])
    const body = await run(root, { path: fileAt(root, mixed) })
    assert.equal(body.error, undefined, JSON.stringify(body))
    assert.deepEqual(body.items.map(i => i.text), ['direct page', 'indirect page'])
  })
})

await test('absent, non-integer, mismatched, chained and oversized providers fail closed', async () => {
  await withTempDir('pdf-indirect-negative', async root => {
    const text = show('safe')
    const cases = [
      ['9 0 R', String(Buffer.byteLength(text)), 'DOCUMENT_PARSE_ERROR'],
      ['3 0 R', font, 'DOCUMENT_PARSE_ERROR'],
      ['6 1 R', String(Buffer.byteLength(text)), 'DOCUMENT_PARSE_ERROR'],
      ['2 0 R', '2 0 R', 'DOCUMENT_PARSE_ERROR'],
    ]
    for (const [ref, provider, code] of cases) {
      const bytes = pdf([catalog, pages(['4 0 R']), font, page('5 0 R'), indirect(text, ref), provider])
      failure(await run(root, { path: fileAt(root, bytes) }), code)
    }
    failure(await run(root, { path: fileAt(root, pdf([catalog, pages(['4 0 R']), font, page('5 0 R'),
      indirect(show('x'), '6 0 R'), String(1024 * 1024 + 1)])) }), 'OUTPUT_LIMIT')
  })
})

report('pdf-indirect-length')
