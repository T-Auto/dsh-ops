/**
 * The fences that are not obvious from the happy path: an enumeration sweep that must not read a
 * credential tree, a cwd that is a read scope rather than a write grant, a cancelled commit, and a
 * target that stops being the file we planned against.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { invokeAst } from '../lib/execution/ast-inproc.js'
import { assert, test, report } from './lib/harness.mjs'

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ast-sec-'))
const write = (dir, name, text) => {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}
const ctx = (mode, workspaceRoot) => ({ get: k => k === 'sandboxPolicy' ? { resolve: () => ({ mode, workspaceRoot }) } : undefined })
const call = (tool, args, cwd, ws, mode = 'workspace-write', signal = new AbortController().signal) =>
  invokeAst(tool, ctx(mode, ws), args, { agent: { session: { id: 'ast-sec', header: { cwd } } } }, signal)

await test('enumeration never reads a credential tree, and a named path is still refused', async () => {
  const ws = root()
  try {
    write(ws, '.ssh/id_rsa', 'export function secretFn() { return "TOKEN" }\n')
    write(ws, 'app.ts', 'export function publicFn() { return 1 }\n')
    const sweep = await call('ast_locate', { symbol: 'secretFn', body: true }, ws, ws)
    assert.equal(sweep.hits.length, 0, 'a walk must not surface a credential file')
    const named = await call('ast_locate', { symbol: 'secretFn', file: '.ssh/id_rsa' }, ws, ws)
    assert.equal(named.error.code, 'CREDENTIAL_DENIED')
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

await test('refactor carries the same deny list as locate', async () => {
  const ws = root()
  try {
    write(ws, '.ssh/id_rsa', 'console.log("in secret")\n')
    write(ws, 'app.ts', "console.log('once')\n")
    const value = await call('ast_refactor', { pattern: 'console.log($A)', rewrite: 'logger.log($A)', mode: 'apply' }, ws, ws)
    assert.equal(value.status, 'completed', JSON.stringify(value.error))
    assert.deepEqual(value.files.map(f => f.file), ['app.ts'], 'the credential file is never planned')
    assert.equal(fs.readFileSync(path.join(ws, '.ssh/id_rsa'), 'utf8').includes('console.log'), true)
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

await test('a cwd outside the workspace is a read scope, never a write grant', async () => {
  const ws = root(), outside = root()
  try {
    write(outside, 'evil.ts', "console.log('x')\n")
    const value = await call('ast_refactor', { pattern: 'console.log($A)', rewrite: 'logger.log($A)', mode: 'apply' }, outside, ws)
    assert.equal(value.status, 'error', JSON.stringify(value.files))
    assert.equal(value.error.code, 'PATH_RESTRICTED')
    assert.equal(fs.readFileSync(path.join(outside, 'evil.ts'), 'utf8').includes('console.log'), true,
      'nothing outside the workspace may be planned for writing')
  } finally { fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) }
})

await test('a cancelled call commits nothing', async () => {
  const ws = root()
  try {
    write(ws, 'app.ts', "console.log('once')\n")
    const controller = new AbortController()
    controller.abort()
    const value = await call('ast_refactor', { pattern: 'console.log($A)', rewrite: 'logger.log($A)', mode: 'apply' }, ws, ws, 'workspace-write', controller.signal)
    assert.notEqual(value.effectState, 'applied', JSON.stringify(value))
    assert.equal(fs.readFileSync(path.join(ws, 'app.ts'), 'utf8').includes('logger.log'), false)
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

await test('a target that is a link is refused instead of followed', async () => {
  const ws = root()
  try {
    write(ws, 'target.ts', "console.log('x')\n")
    try { fs.symlinkSync(path.join(ws, 'target.ts'), path.join(ws, 'link.ts')) } catch { return }
    const value = await call('ast_refactor', { file: 'link.ts', pattern: 'console.log($A)', rewrite: 'logger.log($A)', mode: 'apply' }, ws, ws)
    assert.notEqual(value.status, 'completed', JSON.stringify(value))
    assert.equal(fs.readFileSync(path.join(ws, 'target.ts'), 'utf8').includes('console.log'), true,
      'the link target must not be rewritten through the link')
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

await test('the receipt says how much work a limit left behind', async () => {
  const ws = root()
  try {
    write(ws, 'a.ts', "console.log('a')\n")
    write(ws, 'b.ts', "console.log('b')\n")
    const one = await call('ast_refactor', { pattern: 'console.log($A)', rewrite: 'logger.log($A)', limit: 1 }, ws, ws)
    assert.equal(one.planned, 1)
    assert.ok(one.matched >= 1, 'a stopped walk reports the matches it saw, not the whole tree')
    assert.equal(one.remaining, null, 'a stopped walk reports the rest as unknown, not measured')
    const both = await call('ast_refactor', { roots: ['.', './'], pattern: 'console.log($A)', rewrite: 'logger.log($A)', limit: 5 }, ws, ws)
    assert.equal(both.planned, 2, `two roots naming one directory plan each file once: ${JSON.stringify(both).slice(0, 400)}`)
    assert.equal(both.remaining, 0)
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

await test('an apply publishes through the descriptor and keeps the BOM and CRLF', async () => {
  const ws = root()
  try {
    const file = path.join(ws, 'a.ts')
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("console.log('x')\r\n", 'utf8'),
    ]))
    const value = await call('ast_refactor', { pattern: 'console.log($A)', rewrite: 'logger.log($A)', mode: 'apply' }, ws, ws)
    assert.equal(value.status, 'completed', JSON.stringify(value.error))
    assert.equal(value.effectState, 'applied')
    assert.deepEqual(value.filesApplied, ['a.ts'])
    const raw = fs.readFileSync(file)
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the BOM survives an in-place publish')
    assert.match(raw.toString('utf8'), /logger\.log/)
    assert.match(raw.toString('utf8'), /\r\n/, 'CRLF survives an in-place publish')
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

await test('a rewrite reaches every file unless a limit says otherwise', async () => {
  const ws = root()
  try {
    for (const n of ['f0', 'f1', 'f2']) write(ws, `${n}.ts`, 'export function a() { return 1 }\n')
    // The old default planned exactly one file and said nothing, so a caller expecting a full
    // rename silently got the first file only.
    const all = await call('ast_refactor', { pattern: 'return 1', rewrite: 'return 2', mode: 'apply' }, ws, ws)
    assert.equal(all.status, 'completed', JSON.stringify(all.error))
    assert.deepEqual([...all.filesApplied].sort(), ['f0.ts', 'f1.ts', 'f2.ts'])
    for (const n of ['f0', 'f1', 'f2']) assert.match(fs.readFileSync(path.join(ws, `${n}.ts`), 'utf8'), /return 2/)
    const one = await call('ast_refactor', { pattern: 'return 2', rewrite: 'return 3', mode: 'preview', limit: 1 }, ws, ws)
    assert.equal(one.remaining, null)
    assert.match(String(one.message), /only the first 1/, 'a stopped walk has to say so')
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

await test('a session whose cwd is a link still reaches its own files', async () => {
  const base = root()
  try {
    const real = path.join(base, 'real'), link = path.join(base, 'link')
    fs.mkdirSync(real)
    write(real, 'a.ts', "console.log('a')\n")
    write(real, 'b.ts', "console.log('b')\n")
    try { fs.symlinkSync(real, link, 'junction') } catch { return }
    // The lexical fence compared a realpathed root against an unresolved target, so a cwd reached
    // through a junction matched nothing and every call was POLICY_DENIED.
    const value = await call('ast_refactor', { roots: ['.', './'], pattern: 'console.log($A)', rewrite: 'logger.log($A)', limit: 5 }, link, real)
    assert.equal(value.status, 'completed', JSON.stringify(value.error))
    assert.equal(value.planned, 2)
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})

report('ast-security')
