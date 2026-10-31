/**
 * `ops_ast_*` answered in-process: the dispatch, the fences and the receipt shape.
 *
 * Run after `npm run build`:
 *
 *   node test/ast-inproc.test.mjs
 *
 * The engine is the real one under `lib/ast`; only the host context is a stand-in, because the
 * four things `invokeAst` asks of it — session identity, cwd, policy and a signal — are exactly
 * the four a caller cannot fabricate for itself.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { invokeAst } from '../lib/execution/ast-inproc.js'
import { enumerate, clearEnumCache } from '../lib/ast/inproc.cjs'
import { checkedWrite } from '../lib/ast/safe-write.cjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-ast-'))
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`)
}

const ctxOf = policy => ({ get: key => (key === 'sandboxPolicy' ? { resolve: () => policy } : undefined) })
const execOf = cwd => ({ agent: { session: { id: 'ast-inproc', header: { cwd } } }, signal: new AbortController().signal })
const policy = (mode, workspaceRoot) => ({ mode, workspaceRoot })

const source = [
  'const helper = (value: string) => value.trim();',
  'export function getValidRequestBody(body: unknown): unknown {',
  '  if (body === undefined) return null;',
  '  if (typeof body === "string") return helper(body);',
  '  return body;',
  '}',
  ''
].join('\n')
fs.mkdirSync(path.join(root, 'src'))
fs.writeFileSync(path.join(root, 'src', 'inp.ts'), source)

// 1. locate answers in-process with a relative POSIX path
{
  const out = await invokeAst('ast_locate', ctxOf(policy('danger-full-access', root)), { symbol: 'getValidRequestBody' }, execOf(root))
  check('locate completes', out.status === 'completed', JSON.stringify(out).slice(0, 200))
  const hits = Array.isArray(out.hits) ? out.hits : []
  check('locate finds the symbol', hits.length === 1, String(hits.length))
  check('receipt path is relative POSIX', hits[0]?.file === 'src/inp.ts', String(hits[0]?.file))
  check('boundary is in-process', out.sandbox?.boundary === 'in-process-ast', JSON.stringify(out.sandbox))
}

// 2. a write tool under read-only is refused before the engine runs
{
  const out = await invokeAst('ast_refactor', ctxOf(policy('read-only', root)),
    { query: 'getValidRequestBody', symbol: 'getValidRequestBody', pattern: 'return $A', rewrite: 'return $A' }, execOf(root))
  check('read-only refuses a write', out.status === 'rejected' && out.error?.code === 'POLICY_DENIED', JSON.stringify(out.error))
  check('refusal names the mode', out.sandbox?.mode === 'read-only', JSON.stringify(out.sandbox))
  check('refusal is not retryable', out.error?.retryable === false)
}

// 3. a junction inside the workspace that points outside is refused even in workspace-write
if (process.platform === 'win32') {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-ast-out-'))
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'export function secret() { return 1 }\n')
  const link = path.join(root, 'link')
  let joined = true
  try { fs.symlinkSync(outside, link, 'junction') } catch { joined = false }
  if (joined) {
    const out = await invokeAst('ast_locate', ctxOf(policy('workspace-write', root)),
      { symbol: 'secret', file: 'link/secret.ts' }, execOf(root))
    check('junction is refused', out.status === 'error' && out.error?.code === 'PATH_RESTRICTED', JSON.stringify(out.error))
    fs.unlinkSync(link)
  } else {
    check('junction fixture created', false, 'symlink privilege missing')
  }
}

// 4. required arguments come off the engine schema, not a second copy
{
  const out = await invokeAst('ast_locate', ctxOf(policy('danger-full-access', root)), {}, execOf(root))
  check('missing symbol is INVALID_ARGUMENT', out.error?.code === 'INVALID_ARGUMENT', JSON.stringify(out.error))
  check('message names the field', /symbol/.test(out.error?.message ?? ''), out.error?.message)
}

// 5. an unknown tool never reaches the engine
{
  const out = await invokeAst('ast_nope', ctxOf(policy('danger-full-access', root)), {}, execOf(root))
  check('unknown tool is INVALID_ARGUMENT', out.error?.code === 'INVALID_ARGUMENT', JSON.stringify(out.error))
}

// 6. no session means no execution
{
  const out = await invokeAst('ast_locate', ctxOf(policy('danger-full-access', root)), { symbol: 'x' }, { agent: null, signal: new AbortController().signal })
  check('absent session is EXECUTOR_UNAVAILABLE', out.error?.code === 'EXECUTOR_UNAVAILABLE', JSON.stringify(out.error))
}

// 7. enumerate caps globally and tells the truth about truncation
{
  const a = path.join(root, 'enum-a'), b = path.join(root, 'enum-b')
  fs.mkdirSync(a); fs.mkdirSync(b)
  for (const dir of [a, b]) for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `${i}.ts`), 'function f() { return true }\n')
  clearEnumCache()
  const opts = { cwd: root, strategy: 'walk', limit: 2 }
  const small = enumerate([a, b], new Set(['.ts']), opts)
  check('enumerate honours the cap', small.files.length === 2, String(small.files.length))
  check('enumerate reports truncation', small.truncated === true)
  const hit = enumerate([a, b], new Set(['.ts']), opts)
  check('second pass is cached', hit.cached === true)
  check('cache key includes the cap', enumerate([a, b], new Set(['.ts']), { ...opts, limit: 20 }).files.length === 10)
}

// 8. a placeholder that never resolved cannot be written
{
  let refused = ''
  try { checkedWrite(path.join(root, 'src', 'inp.ts'), Buffer.from(source), 'function $$$() { return 1 }') } catch (error) { refused = String(error?.code ?? error?.message ?? error) }
  check('unresolved placeholder is refused', /E_INPROC_UNRESOLVED_PLACEHOLDER|placeholder/i.test(refused), refused)
  check('file untouched', fs.readFileSync(path.join(root, 'src', 'inp.ts'), 'utf8') === source)
}

fs.rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
