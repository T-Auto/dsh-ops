/** The AST tools are catalogue entries answered in-process: fences, dispatch and receipts. */
import fs from 'node:fs'
import path from 'node:path'
import { AST_TOOLS, CAPABILITIES, NATIVE_TOOLS, capability } from '../lib/capabilities/registry.js'
import { invokeAst } from '../lib/execution/ast-inproc.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

let engine = true
try { await import('@ast-grep/napi') } catch { engine = false }

const ctx = (mode, workspaceRoot) => ({ get: (key) => key === 'sandboxPolicy' ? { resolve: () => ({ mode, workspaceRoot }) } : undefined })
const exec = (cwd) => ({ agent: { session: { id: 'ast-session', header: { cwd } } } })
const call = (tool, args, root, mode = 'workspace-write') =>
  invokeAst(tool, ctx(mode, root), args, exec(root), new AbortController().signal)

/** Two definitions with one call site: enough for a hit, a rewrite and a format-only audit. */
function fixture(root) {
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function greet(name: string) { return `hi ${name}` }\n', 'utf8')
  fs.writeFileSync(path.join(root, 'b.ts'), "import { greet } from './a.js'\nconsole.log(greet('x'))\n", 'utf8')
}

await test('the catalogue publishes the AST tools on the Native presentation only', () => {
  assert.deepEqual(AST_TOOLS, ['ast_locate', 'ast_refactor', 'ast_audit'])
  for (const raw of AST_TOOLS) {
    const entry = capability(raw)
    assert.deepEqual(entry.presentations, ['native'], raw)
    assert.equal(entry.mutates, raw === 'ast_refactor', raw)
    assert.ok(NATIVE_TOOLS.includes(raw), `${raw} is registered on the Native surface`)
    assert.equal(capability(raw), CAPABILITIES.find(other => other.rawName === raw), raw)
  }
})

await test('the catalogue schema is what the bridge enforces before the engine loads', async () => withTempDir('ast-args', async root => {
  fixture(root)
  const missing = await call('ast_refactor', { pattern: 'greet($A)' }, root)
  assert.equal(missing.status, 'error')
  assert.equal(missing.error.code, 'INVALID_ARGUMENT')
  assert.match(missing.error.message, /rewrite/)
  const unowned = await call('grep', { pattern: 'x' }, root)
  assert.equal(unowned.error.code, 'INVALID_ARGUMENT')
}))

await test('the policy fences reject before the engine runs', () => withTempDir('ast-fences', async root => {
  fixture(root)
  const escape = await call('ast_locate', { symbol: 'greet', roots: ['..'] }, root)
  assert.equal(escape.status, 'rejected')
  assert.equal(escape.error.code, 'POLICY_DENIED')

  const readOnly = await call('ast_refactor', { pattern: 'greet($A)', rewrite: 'hello($A)', mode: 'apply' }, root, 'read-only')
  assert.equal(readOnly.status, 'rejected')
  assert.equal(readOnly.error.code, 'POLICY_DENIED')
  assert.match(readOnly.error.message, /workspace-write/)

  const secret = path.join(root, '.ssh')
  fs.mkdirSync(secret)
  fs.writeFileSync(path.join(secret, 'id_rsa'), 'x', 'utf8')
  const denied = await call('ast_locate', { symbol: 'greet', file: '.ssh/id_rsa' }, root)
  assert.equal(denied.status, 'rejected')
  assert.equal(denied.error.code, 'CREDENTIAL_DENIED')
}))

await test('locate, preview, apply and audit report through one receipt shape', () => withTempDir('ast-run', async root => {
  fixture(root)
  assert.ok(engine, '@ast-grep/napi is a declared dependency: it must load, or this suite is blind')
  const found = await call('ast_locate', { symbol: 'greet', body: true }, root)
  assert.equal(found.status, 'completed')
  assert.ok(found.hits.length >= 1, 'expected the definition hit')
  assert.equal(found.hits[0].file, 'a.ts', 'receipt paths are cwd-relative, like every other tool')

  const before = fs.readFileSync(path.join(root, 'b.ts'), 'utf8')
  const preview = await call('ast_refactor', { pattern: "console.log($A)", rewrite: "logger.log($A)" }, root)
  assert.equal(preview.status, 'completed')
  assert.ok(preview.edits >= 1)
  assert.equal(fs.readFileSync(path.join(root, 'b.ts'), 'utf8'), before, 'preview writes nothing')

  const applied = await call('ast_refactor', { pattern: "console.log($A)", rewrite: "logger.log($A)", mode: 'apply' }, root)
  assert.equal(applied.status, 'completed')
  assert.equal(applied.effectState, 'applied')
  assert.match(fs.readFileSync(path.join(root, 'b.ts'), 'utf8'), /logger\.log/)

  // Whitespace only: a comment would add a node and make the change structural.
  fs.writeFileSync(path.join(root, 'after.ts'), 'export function greet(name: string) {\n\n  return `hi ${name}`\n}\n', 'utf8')
  const audit = await call('ast_audit', { file: 'after.ts', beforeFile: 'a.ts' }, root)
  assert.equal(audit.status, 'completed')
  assert.equal(audit.formatOnly, true)
}))

await test('the engine bounds agree with the bridge when cwd is a workspace subdirectory', () => withTempDir('ast-bounds', async root => {
  const sub = path.join(root, 'sub')
  fs.mkdirSync(sub)
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function outer() { return 1 }\n', 'utf8')
  fs.writeFileSync(path.join(sub, 'b.ts'), 'export function inner() { return 1 }\n', 'utf8')
  const inner = (cwd) => ({ agent: { session: { id: 'ast-session', header: { cwd } } } })
  const at = (roots, cwd) => invokeAst('ast_locate', ctx('workspace-write', root), { symbol: 'outer', roots }, inner(cwd), new AbortController().signal)
  // The bridge approves the workspace as a root; the engine must not reject what it just approved.
  const up = await at(['..'], sub)
  assert.equal(up.status, 'completed', JSON.stringify(up))
  assert.equal(up.hits.length, 1)
  const escape = await at(['../..'], sub)
  assert.equal(escape.error.code, 'POLICY_DENIED')
}))

report('ast-inproc')
