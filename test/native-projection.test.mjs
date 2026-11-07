/** Physical line and encoding behavior through the real worker and Native renderer. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { definition } from '../lib/file/contract.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('native-projection')
const call = async (tool, args, root) => envelopeOf(await callTool(tool, args, { root }), assert)
const render = (tool, args, value) => definition(tool, async () => value).output.render(args, value)[0].text
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

await test('write, stat, read and Native line labels share physical LF boundaries and exact bytes', async () => {
  await withTempDir('physical-lines', async root => {
    const cases = [
      ['empty', '', []], ['no-final-lf', 'one', ['one']], ['final-lf', 'one\n', ['one']],
      ['blank', '\n', ['']], ['two-blank', '\n\n', ['', '']], ['crlf', 'one\r\ntwo\r\n', ['one', 'two']],
      ['bare-cr', 'one\rtwo\r', ['one\rtwo\r']], ['unicode', '\ufeffα\u2028β\u0085γ\n😀', ['\ufeffα\u2028β\u0085γ', '😀']],
    ]
    for (const [name, text, lines] of cases) {
      const target = path.join(root, name)
      const written = await call('write_file', { path: target, content: text, expectedRevision: 'absent' }, root)
      assert.equal(written.status, 'completed', JSON.stringify(written))
      assert.deepEqual(fs.readFileSync(target), Buffer.from(text), `${name}: no platform newline conversion`)
      const stat = await call('stat', { path: target }, root)
      const read = await call('inspect_local_file', { path: target }, root)
      for (const value of [written, stat, read]) {
        assert.equal(value.revision, hash(text), name)
        assert.equal(value.lineCount, lines.length, name)
      }
      assert.deepEqual(read.items.map(item => item.text), lines, name)
      assert.deepEqual(read.items.map(item => item.line), lines.map((_, i) => i + 1), name)
      const native = render('inspect_local_file', { path: target }, read)
      assert.ok(native.includes(`of ${lines.length}) ===`), native)
      for (const [index, line] of lines.entries()) assert.ok(native.includes(`${index + 1} | ${line.replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u0085/g, '\\u0085')}`), name)
      assert.match(native, /complete=true/)
    }
  })
})

await test('paged Native output exposes the worker continuation without advancing past omitted lines', async () => {
  await withTempDir('native-page', async root => {
    const target = path.join(root, 'page'); fs.writeFileSync(target, 'a\nb\nc\n')
    const first = await call('inspect_local_file', { path: target, limit: 2 }, root)
    const native = render('inspect_local_file', { path: target, limit: 2 }, first)
    assert.match(native, /Lines 1-2 of 3/)
    assert.match(native, /complete=false.*nextOffset=3.*omitted=1/)
    const last = await call('inspect_local_file', { path: target, offset: first.nextOffset }, root)
    assert.deepEqual(last.items.map(item => [item.line, item.text]), [[3, 'c']])
    assert.match(render('inspect_local_file', { path: target }, last), /Lines 3-3 of 3/)
  })
})

await test('real grep context and glob paths survive the Native projection', async () => {
  await withTempDir('native-search', async root => {
    const target = path.join(root, 'context.txt'); fs.writeFileSync(target, 'first\nsecond\nmatch\nlast')
    const args = { path: target, pattern: 'match', beforeContext: 2, afterContext: 1 }
    const value = await call('grep', args, root)
    const native = render('grep', args, value)
    assert.equal(value.items[0].line, 3)
    assert.ok(native.includes(`${target}:1 | first`), native)
    assert.ok(native.includes(`${target}:3 | match`), native)
    const glob = await call('glob', { path: root, pattern: ['**/*'], outputMode: 'paths' }, root)
    assert.equal(glob.items.length, 1)
    assert.ok(render('glob', {}, glob).includes(target))
  })
})

await test('definitions rows carry their declaration kind through the Native projection', async () => {
  await withTempDir('native-definitions', async root => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function greet() {}\ngreet()\n')
    const args = { path: root, pattern: 'greet', outputMode: 'definitions' }
    const value = await call('grep', args, root)
    const native = render('grep', args, value)
    assert.ok(native.includes('| function export function greet() {}'), native)
    assert.match(native, /matched=2/)
    assert.match(native, /total=1/)
  })
})

await test('invalid UTF-8 and unsupported encoding report an actionable refusal without lossy decoding or mutation', async () => {
  await withTempDir('native-encoding', async root => {
    const target = path.join(root, 'binary'); const bytes = Buffer.from([0xff, 0xfe, 0x61, 0])
    fs.writeFileSync(target, bytes)
    for (const [tool, extra] of [
      ['inspect_local_file', {}], ['inspect_local_file', { encoding: 'utf-16' }],
      ['diff', { content: 'new' }], ['edit_file', { expectedRevision: hash(bytes), edits: [{ oldText: 'a', newText: 'b' }] }],
    ]) {
      const args = { path: target, ...extra }
      const value = await call(tool, args, root)
      assert.equal(value.status, 'error', JSON.stringify(value))
      assert.equal(value.error.code, 'ERR_INVALID_ENCODING')
      assert.equal(value.error.effectState, 'none')
      assert.match(value.error.nextAction, /document\/binary.*view=hex/)
      assert.match(render(tool, args, value), /error: ERR_INVALID_ENCODING/)
      assert.match(render(tool, args, value), /retry=after-input-change/)
      assert.deepEqual(fs.readFileSync(target), bytes)
    }
    const hex = await call('inspect_local_file', { path: target, view: 'hex' }, root)
    assert.equal(hex.items[0].text, 'ff fe 61 00')
    assert.equal(hex.lineCount, null)
    assert.deepEqual(fs.readdirSync(root), ['binary'], 'refused text edit leaves no lock or publication artifact')
  })
})
report('native-projection')
