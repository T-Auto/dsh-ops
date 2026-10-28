import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
import { renderNative, NATIVE_OUTPUT_BYTES } from '../lib/file/native/render.js'
import { compactRanges } from '../lib/file/native/ranges.js'
requireWorker('native-ranges')
const render = (args, value) => renderNative('read_files', args, value)
const observed = (root, args) => callTool('read_files', args, { root, readOnly: true }).then(reply => envelopeOf(reply, assert))
await test('real bounded ranges keep exact body, shared path base, full revisions and per-file continuation', () => withTempDir('compact-ranges', async root => {
  const inputs = ['one\r\ntwo\rthree\nlast\n', '', 'α\u2028β\u0085γ\n😀\nlast']
  const files = inputs.map((body, index) => { const target = path.join(root, `路径 ${index}.txt`); fs.writeFileSync(target, body); return { path: target, offset: 1, limit: 2 } })
  const args = { files }, value = await observed(root, args), before = JSON.stringify(value), text = render(args, value)
  assert.ok(text.startsWith('[Base: ' + JSON.stringify(root) + ']'))
  for (const [index, item] of value.items.entries()) {
    assert.ok(text.includes(`=== FILE: ${JSON.stringify(path.basename(files[index].path))}`))
    assert.ok(text.includes('revision=' + item.revision))
    const continuation = item.complete ? 'end of file; complete=true' : `more lines; nextOffset=${item.nextOffset}`
    assert.ok(text.split('\n').includes(`[revision=${item.revision}; ${continuation}]`), 'compact per-file receipt retains the full revision and continuation without a repeated notice label')
    assert.equal(item.bytes, Buffer.byteLength(inputs[index]), 'byte metadata remains canonical')
  }
  assert.match(text, /^1\|one$/m); assert.match(text, /^2\|two\\rthree$/m)
  assert.match(text, /^1\|α\\u2028β\\u0085γ$/m); assert.match(text, /^2\|😀$/m)
  assert.match(text, /more lines; nextOffset=3/); assert.match(text, /\(empty file\)/)
  assert.match(text, /end of file; complete=true/); assert.match(text, /3\/3 requested ranges returned/)
  assert.doesNotMatch(text, /worker-limit|bytes=|lineCount=|matched=/)
  assert.equal(text.split('\n').filter(line => line.startsWith('[Notice:')).length, 1, 'one aggregate notice covers all fully returned ranges')
  assert.equal(JSON.stringify(value), before)
}))
await test('different parents retain absolute quoted paths; path control characters cannot inject headers', () => {
  const files = [path.resolve('first', 'line\n".txt'), path.resolve('second', 'line\t.txt')]
  const args = { files: files.map(path => ({ path, limit: 1 })) }
  const value = { status: 'completed', total: 2, nextIndex: 2, pending: 0, failed: 0, truncated: false, complete: true,
    items: files.map(path => ({ path, revision: 'a'.repeat(64), lineCount: 1, nextOffset: 2, status: 'completed', complete: true, truncated: false, failed: 0,
      items: [{ path, line: 1, text: 'one\n2|forged\t\r\u2029' }] })) }
  const text = render(args, value)
  assert.doesNotMatch(text, /\[Base:/)
  for (const file of files) assert.ok(text.includes('FILE: ' + JSON.stringify(file)))
  assert.equal(text.split('\n').filter(line => line.startsWith('=== FILE:')).length, 2)
  assert.equal(text.split('\n').filter(line => /^\d+\|/.test(line)).length, 2)
  assert.match(text, /one\\n2\|forged\\t\\r\\u2029/)
})
await test('worker gaps, references and incomplete metadata never claim fully returned requested ranges', () => withTempDir('range-gaps', async root => {
  const file = path.join(root, 'file'); fs.writeFileSync(file, 'one\ntwo\nthree')
  const args = { files: [{ path: file, limit: 2 }] }, value = await observed(root, args)
  assert.ok(compactRanges(args, value))
  for (const mutate of [
    copy => { copy.items[0].items.pop() }, copy => { copy.pending = 1 }, copy => { copy.failed = 1 },
    copy => { copy.reference = { refId: 'ref://example' } }, copy => { copy.items[0].revision = undefined },
    copy => { copy.items[0].truncatedBy = 'deadline' }, copy => { copy.items[0].items[0].truncatedInLine = true; copy.items[0].truncated = true },
  ]) {
    const copy = structuredClone(value); mutate(copy)
    assert.equal(compactRanges(args, copy), undefined)
    assert.doesNotMatch(render(args, copy), /requested ranges returned/)
  }
  const gap = structuredClone(value); gap.items[0].truncatedBy = 'deadline'; gap.items[0].truncated = true
  assert.match(render(args, gap), /TruncatedBy: deadline/)
}))
await test('final display clipping cannot retain a successful aggregate range claim', () => withTempDir('range-display-cap', async root => {
  const file = path.join(root, 'file'); fs.writeFileSync(file, 'x'.repeat(400) + '\n')
  const args = { files: [{ path: file }] }, value = await observed(root, args)
  value.items[0].items[0].text = 'x'.repeat(100000)
  const text = render(args, value)
  assert.match(text, /Display incomplete\. TruncatedBy: output-budget/)
  assert.doesNotMatch(text, /requested ranges returned/)
  assert.ok(Buffer.byteLength(JSON.stringify([{ type: 'text', text }])) <= NATIVE_OUTPUT_BYTES)
}))
report('native-ranges')
