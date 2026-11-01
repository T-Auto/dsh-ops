/** Empty placeholders strict adapters send for optional file-tool fields. */
import { normalizeArguments } from '../lib/file/contract.js'
import { invoke as fileCall } from '../lib/file/worker.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

await test('grep drops empty optional placeholders but keeps false and 0', () => {
  const args = { pattern: 'x', path: '', glob: [], outputMode: '', caseInsensitive: false, offset: 0, lineNumbers: null }
  assert.deepEqual(normalizeArguments('grep', args), { pattern: 'x', caseInsensitive: false, offset: 0 })
})

await test('inspect_local_file drops empty encoding/view and keeps numeric bounds', () => {
  const args = { path: 'a.txt', encoding: '', view: '  ', offset: 0, limit: 0 }
  assert.deepEqual(normalizeArguments('inspect_local_file', args), { path: 'a.txt', offset: 0, limit: 0 })
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

await test('write_file omission becomes the create-only expectation, and only there', () => {
  // Omission is the natural way to say "this file must not exist yet" (#419).
  assert.deepEqual(normalizeArguments('write_file', { path: 'a', content: '' }), { path: 'a', content: '', expectedRevision: 'absent' })
  assert.deepEqual(normalizeArguments('write_file', { path: 'a', content: 'x', dryRun: true }), { path: 'a', content: 'x', dryRun: true, expectedRevision: 'absent' })
  // An explicit baseline is authoritative: blank and null stay on the reject path (#422).
  for (const supplied of ['', '   ', null]) {
    assert.deepEqual(normalizeArguments('write_file', { path: 'a', content: '', expectedRevision: supplied }), { path: 'a', content: '', expectedRevision: supplied })
  }
  // No other mutation has a create mode, so no baseline is invented for it.
  for (const tool of ['edit_file', 'copy', 'move', 'remove']) {
    assert.equal(normalizeArguments(tool, { path: 'a' }).expectedRevision, undefined, tool)
  }
})

const agentAt = root => ({ session: { id: 'file-args-wire', header: { cwd: root } } })

await test('an omitted write_file baseline reaches the worker as an explicit CAS expectation', async () => {
  await withTempDir('file-args-wire', async root => {
    const { ctx } = await bootHost()
    const sent = []
    const completed = { status: 'completed', changed: 1, revision: 'a'.repeat(64), bytes: 6, lineCount: 1, metadata: { created: true } }
    try {
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) }))
      await ctx.plugin(inner => inner.provide('subprocess', { spawn(spec) {
        sent.push(JSON.parse(spec.stdio.stdin.data).request.args)
        return { done: Promise.resolve({ exitCode: 0 }), collected: {
          stdout: { readFrom: () => ({ text: JSON.stringify(completed) }) }, stderr: { readFrom: () => ({ text: '' }) },
        } }
      } }))
      // The host reuses one stable Session object for a session's whole lifetime.
      const exec = { agent: agentAt(root) }
      const call = args => fileCall(ctx, 'unused', 'write_file', args, exec)
      const created = await call({ path: 'new.txt', content: 'hello\n' })
      assert.equal(created.status, 'completed', JSON.stringify(created))
      assert.equal(created.metadata.created, true)
      // The worker still receives an explicit expectation, so a concurrently created
      // path is a REVISION_CONFLICT rather than an overwrite wildcard.
      assert.equal(sent[0].expectedRevision, 'absent', JSON.stringify(sent[0]))
      assert.equal(sent[0].content, 'hello\n')
      assert.ok(String(sent[0].path).endsWith('new.txt'), sent[0].path)
      // A supplied blank or null is never rewritten into the create sentinel (#422).
      const blank = await call({ path: 'new.txt', content: 'hello\n', expectedRevision: '' })
      assert.equal(blank.status, 'completed', JSON.stringify(blank))
      assert.equal(sent[1].expectedRevision, '', JSON.stringify(sent[1]))
      const nul = await call({ path: 'new.txt', content: 'hello\n', expectedRevision: null })
      assert.equal(nul.status, 'completed', JSON.stringify(nul))
      assert.equal(sent[2].expectedRevision, null, JSON.stringify(sent[2]))
    } finally { await shutdown(ctx) }
  })
})

report('file-args')
