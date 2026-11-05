/** The AST engine is a pure (request, cwd) → receipt surface: assert it without a host or worker. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locate, refactor, audit, resolvedInside, rootRealCacheSize } from '../lib/ast/engine.cjs'
import { assert, test, report } from './lib/harness.mjs'

// The engine touches no host state, so a plain temp directory is enough and keeps this suite
// runnable where the fixture-owner repair is unavailable.
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ast-engine-'))
const write = (root, name, text) => {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return file
}
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true })

await test('locate returns a definition hit with the requested body', async () => {
  const root = dir()
  try {
    write(root, 'a.ts', 'export function greet(name: string) { return name }\nexport const other = 1\n')
    const found = await locate({ symbol: 'greet', body: true }, root)
    assert.equal(found.status, 'ok', JSON.stringify(found))
    assert.equal(found.hits.length, 1)
    assert.equal(found.hits[0].file, 'a.ts')
    assert.match(found.hits[0].body ?? '', /return name/)
    const signatureOnly = await locate({ symbol: 'greet', body: false }, root)
    assert.equal(signatureOnly.hits[0].body, undefined, 'body:false returns the signature alone')
  } finally { cleanup(root) }
})

await test('a prefilter that leaves more than 48 candidates is reported as pruned', async () => {
  const root = dir()
  try {
    for (let i = 0; i < 49; i++) write(root, `f${i}.ts`, `// greet appears only in this comment ${i}\nexport const v${i} = ${i}\n`)
    const value = await locate({ symbol: 'greet' }, root)
    assert.equal(value.status, 'error')
    assert.equal(value.code, 'E_NO_MATCH')
    assert.equal(value.pruned, true, 'a short list must say it was pruned, not look complete')
  } finally { cleanup(root) }
})

await test('stopping at limit reports truncated instead of a complete-looking list', async () => {
  const root = dir()
  try {
    for (let i = 0; i < 12; i++) write(root, `m${i}.ts`, `export function sym() { return ${i} }\n`)
    const first = await locate({ symbol: 'sym', limit: 1 }, root)
    assert.equal(first.status, 'ok', JSON.stringify(first))
    assert.equal(first.hits.length, 1)
    assert.equal(first.truncated, true, 'a limit-stopped walk is not the complete set')
    const all = await locate({ symbol: 'sym', limit: 50 }, root)
    assert.equal(all.hits.length, 12)
    assert.notEqual(all.truncated, true)
  } finally { cleanup(root) }
})

await test('an apply plan carries the text to publish, BOM and CRLF included', async () => {
  const root = dir()
  try {
    const file = path.join(root, 'b.ts')
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("console.log('x')\r\nconsole.log('y')\r\n", 'utf8'),
    ]))
    const value = await refactor({ pattern: 'console.log($A)', rewrite: 'logger.log($A)', mode: 'apply' }, root)
    assert.equal(value.status, 'ok', JSON.stringify(value))
    // The engine plans; publishing belongs to the worker. The plan must still carry the exact bytes.
    assert.equal(value.applied, false)
    assert.equal(value.pending, 1)
    const planned = value.files[0]
    assert.match(planned.after, /logger\.log/, 'the plan carries the rewritten text')
    assert.match(planned.after, /\r\n/, 'CRLF survives in the plan')
    assert.match(planned.revision, /^[0-9a-f]{64}$/, 'the plan carries the revision it was built against')
    assert.equal(fs.readFileSync(file).includes(Buffer.from('console.log')), true, 'nothing is written by the engine')
  } finally { cleanup(root) }
})

await test('two roots naming one directory plan the file once', async () => {
  const root = dir()
  try {
    write(root, 'sub/s.ts', "console.log('once')\n")
    const value = await refactor({ roots: ['sub', './sub'], pattern: 'console.log($A)', rewrite: 'logger.log($A)', mode: 'apply' }, root)
    assert.equal(value.status, 'ok', JSON.stringify(value))
    assert.equal(value.filesTotal, 1, 'one path reached twice is still one target')
    assert.equal(value.edits, 1)
    assert.equal((value.files[0].after.match(/logger\.log/g) ?? []).length, 1)
  } finally { cleanup(root) }
})

await test('audit separates a whitespace change from a structural one', async () => {
  const root = dir()
  try {
    write(root, 'before.ts', 'export function f() { return 1 }\n')
    write(root, 'space.ts', 'export function f() {\n\n  return 1\n}\n')
    write(root, 'comment.ts', 'export function f() {\n  // note\n  return 1\n}\n')
    const blank = audit({ file: 'space.ts', beforeFile: 'before.ts' }, root)
    assert.equal(blank.status, 'ok', JSON.stringify(blank))
    assert.equal(blank.formatOnly, true)
    const withComment = audit({ file: 'comment.ts', beforeFile: 'before.ts' }, root)
    assert.equal(withComment.formatOnly, false, 'a comment is a node, so it is a structural change')
    assert.equal(withComment.nodesChanged >= 1, true)
  } finally { cleanup(root) }
})

await test('roots stay inside the session cwd', async () => {
  const root = dir()
  try {
    write(root, 'a.ts', 'export const a = 1\n')
    const value = await locate({ symbol: 'a', roots: ['..'] }, root)
    assert.equal(value.status, 'error')
    assert.equal(value.code, 'E_ROOT_OUTSIDE')
  } finally { cleanup(root) }
})

await test('a junction inside the root does not leak a file outside it', async () => {
  const root = dir(), outside = dir()
  try {
    write(outside, 'x.ts', 'export function leak() { return 1 }\n')
    write(root, 'ok.ts', 'export function keep() { return 1 }\n')
    try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction') } catch { return }
    const value = await locate({ symbol: 'leak' }, root)
    const files = (value.hits ?? []).map((hit) => hit.file)
    assert.equal(files.length, 0, `a reparse point must not surface ${files.join(',')}`)
    const kept = await locate({ symbol: 'keep' }, root)
    assert.equal(kept.hits.length, 1)
  } finally { cleanup(root); cleanup(outside) }
})

await test('denied trees are pruned during enumeration, not just at named paths', async () => {
  const root = dir()
  try {
    write(root, '.ssh/id_rsa', 'export function secret() { return 1 }\n')
    write(root, 'src/app.ts', 'export function publicValue() { return 1 }\n')
    const open = await locate({ symbol: 'secret' }, root)
    assert.equal(open.hits.length, 0, 'the default bound is the cwd, and .ssh is not excluded by itself')
    const fenced = await locate({ symbol: 'secret' }, root, { deny: [path.join(root, '.ssh')] })
    assert.equal(fenced.hits.length, 0)
    const still = await locate({ symbol: 'publicValue' }, root, { deny: [path.join(root, '.ssh')] })
    assert.equal(still.hits.length, 1, 'denying one tree must not disable the rest')
  } finally { cleanup(root) }
})

await test('the resolved-root cache stops growing and keeps answering correctly', async () => {
  const root = dir(), outside = dir()
  try {
    write(root, 'a.ts', 'export function keep() { return 1 }\n')
    const file = path.join(root, 'a.ts')
    // Every distinct root is a cache entry; before the ceiling this grew for the life of the process.
    for (let i = 0; i < 900; i++) resolvedInside(file, [path.join(outside, `nope${i}`)])
    assert.equal(rootRealCacheSize() <= 512, true, `cache grew to ${rootRealCacheSize()}`)
    // Dropping entries is only safe if the answer is the same afterwards.
    assert.notEqual(resolvedInside(file, [root]), null, 'a bounded cache still resolves')
    assert.equal(resolvedInside(path.join(outside, 'x.ts'), [root]), null, 'and still refuses an outsider')
  } finally { cleanup(root); cleanup(outside) }
})

report('ast-engine')
