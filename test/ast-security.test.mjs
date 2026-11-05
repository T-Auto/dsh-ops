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
    assert.equal(one.matched, 2, 'both files matched, one was planned')
    assert.equal(one.remaining, 1, 'the receipt must say work is outstanding')
    const both = await call('ast_refactor', { roots: ['.', './'], pattern: 'console.log($A)', rewrite: 'logger.log($A)', limit: 5 }, ws, ws)
    assert.equal(both.planned, 2, 'two roots naming one directory plan each file once')
    assert.equal(both.remaining, 0)
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

report('ast-security')
