/** Empty placeholders strict adapters send for optional file-tool fields. */
import { normalizeArguments } from '../lib/file/contract.js'
import { assert, report, test } from './lib/harness.mjs'

await test('grep drops empty optional placeholders but keeps false and 0', () => {
  const args = { pattern: 'x', path: '', glob: [], outputMode: '', caseInsensitive: false, offset: 0, lineNumbers: null }
  assert.deepEqual(normalizeArguments('grep', args), { pattern: 'x', caseInsensitive: false, offset: 0 })
})

await test('inspect_local_file drops empty encoding/view and keeps numeric bounds', () => {
  const args = { path: 'a.txt', encoding: '', view: '  ', offset: 0, limit: 0 }
  assert.deepEqual(normalizeArguments('inspect_local_file', args), { path: 'a.txt', offset: 0, limit: 0 })
})

// write_file's expectedRevision stopped being required in #419, so this generic rule now turns a
// blank or null reply into an omitted field — that is, create-only. #422 keeps the "blank means
// create-only" decision open; this test pins the rule that already existed for every optional
// string field rather than a new write-side rule.
await test('write_file drops a blank or null expectedRevision, which the worker reads as create-only', () => {
  assert.deepEqual(normalizeArguments('write_file', { path: 'a', content: 'b', expectedRevision: '' }), { path: 'a', content: 'b' })
  assert.deepEqual(normalizeArguments('write_file', { path: 'a', content: 'b', expectedRevision: '   ' }), { path: 'a', content: 'b' })
  assert.deepEqual(normalizeArguments('write_file', { path: 'a', content: 'b', expectedRevision: null }), { path: 'a', content: 'b' })
  assert.deepEqual(normalizeArguments('write_file', { path: 'a', content: 'b', expectedRevision: 'absent' }), { path: 'a', content: 'b', expectedRevision: 'absent' })
})

await test('replace keeps an empty required replacement', () => {
  const args = { pattern: 'a', replacement: '', path: '', glob: [] }
  assert.deepEqual(normalizeArguments('replace', args), { pattern: 'a', replacement: '' })
})

await test('replace keeps an empty required pattern unchanged', () => {
  const args = { pattern: '', replacement: 'b' }
  assert.deepEqual(normalizeArguments('replace', args), { pattern: '', replacement: 'b' })
})

await test('glob keeps a required empty pattern array', () => {
  assert.deepEqual(normalizeArguments('glob', { pattern: [], path: '' }), { pattern: [] })
})

await test('unknown keys pass through untouched', () => {
  assert.deepEqual(normalizeArguments('grep', { pattern: 'x', bogus: '' }), { pattern: 'x', bogus: '' })
})

await test('the caller object is never mutated and the result is a copy', () => {
  const args = { pattern: 'x', path: '', glob: [] }
  const snapshot = { ...args }
  const result = normalizeArguments('grep', args)
  assert.deepEqual(args, snapshot)
  assert.notEqual(result, args)
})

await test('non-object inputs and unknown tools are returned safely', () => {
  assert.equal(normalizeArguments('grep', null), null)
  assert.equal(normalizeArguments('grep', 'x'), 'x')
  assert.deepEqual(normalizeArguments('grep', [1]), [1])
  const args = { a: '' }
  const result = normalizeArguments('not_a_tool', args)
  assert.deepEqual(result, { a: '' })
  assert.notEqual(result, args)
})

report('file-args')
