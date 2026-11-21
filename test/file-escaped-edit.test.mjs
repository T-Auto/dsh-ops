/** #939: the Native reader renders backslashes and controls with reversible JSON
 * escapes. ops_edit_file matches oldText against the raw bytes first; when that
 * misses, exactly one re-interpretation is tried - the rendered form decoded - and
 * the receipt says so. Raw matches keep precedence, so literal text is never
 * re-read through the decoder. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { encodeSourceLine } from '../lib/file/native/line-encoding.js'
import { renderNative } from '../lib/file/native/render.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('file-escaped-edit')
const call = async (tool, args, root) => envelopeOf(await callTool(tool, args, { root }), assert)
const rev = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

await test('oldText copied from the rendered line edits after the raw miss', async () => {
  await withTempDir('file-escaped-edit', async root => {
    const target = path.join(root, 'rendered.txt')
    fs.writeFileSync(target, 'alpha\ttab C:\\path\nbeta\n')
    const revision = rev(target)
    const rendered = encodeSourceLine('alpha\ttab C:\\path')
    assert.notEqual(rendered, 'alpha\ttab C:\\path', 'the raw line must be rendered escaped before the model sees it')
    const body = await call('edit_file', { path: target, expectedRevision: revision,
      edits: [{ oldText: rendered, newText: encodeSourceLine('alpha\ttab C:\\renamed') }] }, root)
    assert.equal(body.status, 'completed', JSON.stringify(body))
    assert.equal(body.items[0].renderedMatches, 1, JSON.stringify(body))
    assert.equal(fs.readFileSync(target, 'utf8'), 'alpha\ttab C:\\renamed\nbeta\n')
  })
})

await test('raw literal matches keep precedence and never decode newText', async () => {
  await withTempDir('file-escaped-precedence', async root => {
    const target = path.join(root, 'precedence.txt')
    // The file holds BOTH a literal backslash-t pair and a raw tab.
    fs.writeFileSync(target, 'literal\\tab\treal\n')
    const body = await call('edit_file', { path: target, expectedRevision: rev(target),
      edits: [{ oldText: 'literal\\tab', newText: 'literal\\kept' }] }, root)
    assert.equal(body.status, 'completed', JSON.stringify(body))
    assert.equal(body.items[0].renderedMatches, undefined, 'a raw match must not count as rendered')
    assert.equal(fs.readFileSync(target, 'utf8'), 'literal\\kept\treal\n')
  })
})

await test('ambiguous or absent decodes stay honest EDIT_CONFLICTs', async () => {
  await withTempDir('file-escaped-conflict', async root => {
    const target = path.join(root, 'conflict.txt')
    fs.writeFileSync(target, 'a\tb a\tb\n')
    const duplicated = await call('edit_file', { path: target, expectedRevision: rev(target),
      edits: [{ oldText: encodeSourceLine('a\tb'), newText: 'x' }] }, root)
    assert.equal(duplicated.error?.code, 'EDIT_CONFLICT', JSON.stringify(duplicated))
    assert.equal(duplicated.error.effectState, 'none')
    fs.writeFileSync(target, 'plain line\n')
    const missing = await call('edit_file', { path: target, expectedRevision: rev(target),
      edits: [{ oldText: encodeSourceLine('absent\\q'), newText: 'x' }] }, root)
    assert.equal(missing.error?.code, 'EDIT_CONFLICT', JSON.stringify(missing))
    assert.match(missing.error.message, /rendered|escaped/i, 'the refusal must name the second interpretation')
    assert.equal(fs.readFileSync(target, 'utf8'), 'plain line\n')
  })
})

await test('write_file stays byte-verbatim and never decodes content', async () => {
  await withTempDir('file-escaped-write', async root => {
    const target = path.join(root, 'verbatim.txt')
    const body = await call('write_file', { path: target, expectedRevision: 'absent', content: 'keep \\t literal\n' }, root)
    assert.equal(body.status, 'completed', JSON.stringify(body))
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep \\t literal\n')
  })
})

await test('the rendered receipt and read output state the escape contract', async () => {
  const file = path.resolve('rendered-source.txt')
  const value = { status: 'completed', path: file, revision: 'a'.repeat(64), lineCount: 1, nextOffset: 2,
    complete: true, truncated: false, failed: 0,
    items: [{ path: file, line: 1, text: 'alpha\ttab' }] }
  const mutated = { status: 'completed', phase: 'verify', complete: true, changed: 1, dryRun: false,
    items: [{ path: file, status: 'completed', changed: 1, renderedMatches: 1 }] }
  const inspection = renderNative('inspect_local_file', { path: file, limit: 1 }, value)
  assert.match(inspection, /reversible escapes/, 'reads must warn when escapes are displayed')
  assert.doesNotMatch(renderNative('inspect_local_file', { path: file, limit: 1 },
    { ...value, items: [{ path: file, line: 1, text: 'plain' }] }), /reversible escapes/)
  const batch = { status: 'completed', total: 1, nextIndex: 1, pending: 0, failed: 0, truncated: false, items: [value] }
  assert.match(renderNative('read_files', { files: [{ path: file, limit: 1 }] }, batch), /reversible escapes/)
  assert.match(renderNative('edit_file', { path: file }, mutated), /renderedMatches=1/, 'the receipt must surface rendered matches')
  assert.doesNotMatch(renderNative('edit_file', { path: file },
    { ...mutated, items: [{ path: file, status: 'completed', changed: 1 }] }), /renderedMatches/)
})

report('file-escaped-edit')
