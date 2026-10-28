import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report } from './lib/harness.mjs'
import { requireWorker } from './lib/boundary.mjs'
import { fixture, text, full, elided } from './lib/context-read.mjs'
import { publicToolName } from '../lib/policy.js'
import { observeRead } from '../lib/file/native/read-observation.js'
requireWorker('context-read-many')
const MANY = publicToolName('read_files')
const setup = ({ dir, file, read }) => {
  const second = path.join(dir, 'second.txt')
  fs.copyFileSync(file, second)
  const args = { files: [{ path: file, limit: 10 }, { path: second, offset: 3, limit: 12 }] }
  return { second, args, batch: options => read({ name: MANY, args, ...options }) }
}

await test('multi-file repeats require every fresh file and the exact prior batch in current provider context', () => fixture(async context => {
  const { request, policyReads } = context, { batch } = setup(context)
  const first = await batch()
  full(first)
  assert.equal(first.value.status, 'partial', 'bounded file ranges retain incomplete-file coverage')
  full(await batch())
  await request([first.assistant, first.message])
  const before = policyReads.count
  const repeat = await batch()
  assert.ok(policyReads.count > before, 'all reads still cross current host authority')
  elided(repeat)
  assert.deepEqual(repeat.value, first.value)
  assert.equal((text(repeat).match(/=== FILE:/g) ?? []).length, 2)
  assert.match(text(repeat), /nextOffset=11/)
  assert.match(text(repeat), /nextOffset=15/)
  assert.match(text(repeat), /2\/2 requested ranges revalidated/)
  assert.match(text(repeat), /more lines/); assert.equal(repeat.value.complete, false)
}))

await test('a changed sibling, its metadata or its identity restores the entire batch body', () => fixture(async context => {
  const { request } = context, { second, batch } = setup(context)
  const first = await batch(), original = fs.readFileSync(second), stat = fs.statSync(second)
  await request([first.assistant, first.message])
  fs.utimesSync(second, stat.atime, new Date(stat.mtimeMs + 2000))
  full(await batch())
  await request([first.assistant, first.message])
  fs.renameSync(second, second + '.old')
  fs.writeFileSync(second, original)
  fs.utimesSync(second, stat.atime, stat.mtime)
  full(await batch())
  await request([first.assistant, first.message])
  fs.writeFileSync(second, original.toString().replace('payload line 3', 'changed line 3'))
  const changed = await batch()
  full(changed)
  assert.match(text(changed), /^3\|changed/m)
}))

await test('single-file proof, reordered ranges and compaction cannot stand in for a batch', () => fixture(async context => {
  const { request, read, compact } = context, { args, batch } = setup(context)
  await read()
  await request()
  full(await batch())
  const first = await batch()
  await request([first.assistant, first.message])
  const reordered = await batch({ args: { files: [...args.files].reverse() } })
  assert.match(text(reordered), /^3\|payload/m)
  assert.doesNotMatch(text(reordered), /Unchanged file range/)
  compact()
  await request([first.assistant, first.message])
  full(await batch())
}))

await test('failed and clipped file ranges never acquire dedup evidence from a successful sibling', () => fixture(async context => {
  const { request } = context, { second, batch } = setup(context)
  fs.unlinkSync(second)
  const missing = await batch()
  assert.equal(missing.value.failed, 1)
  await request()
  full(await batch())
  fs.writeFileSync(second, 'payload' + 'x'.repeat(100000))
  const clipped = await batch({ args: { files: [{ path: context.file }, { path: second }] } })
  await request()
  const again = await batch({ args: { files: [{ path: context.file }, { path: second }] } })
  full(again)
  assert.doesNotMatch(text(again), /Unchanged file range/)
  assert.ok(clipped.value.items.some(file => file.items?.some(item => item.truncatedInLine)) || text(clipped).includes('TruncatedBy: output-budget'))
}))

await test('pending files and malformed receipt coverage cannot be promoted to evidence', () => fixture(async context => {
  const { ctx, agent } = context, { args, batch } = setup(context)
  const first = await batch(), tool = ctx.get('tools').get(MANY, agent)
  const exec = { agent, name: MANY, arguments: args, signal: new AbortController().signal }
  assert.ok(observeRead(tool, exec, first))
  for (const change of [{ pending: 1 }, { failed: 1 }, { nextIndex: 1 }, { reference: { refId: 'ref://test' } }, { storageError: { code: 'IO_ERROR' } }]) {
    const value = { ...first.value, ...change }
    assert.equal(observeRead(tool, exec, { ...first, value, content: tool.output.render(args, value) }), undefined)
  }
  const value = structuredClone(first.value)
  value.items[1].revision = undefined
  assert.equal(observeRead(tool, exec, { ...first, value, content: tool.output.render(args, value) }), undefined)
}))

report('context-read-many')
