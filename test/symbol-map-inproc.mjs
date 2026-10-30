/**
 * `symbol_map` answered in-process: the fences, the page shape and the fingerprint.
 *
 * Run after `npm run build`:
 *
 *   DSH_OPS_SYMBOL_MAP_ROOT=<dir containing node_modules> node test/symbol-map-inproc.mjs
 *
 * `DSH_OPS_SYMBOL_MAP_ROOT` is the documented escape hatch for a checkout whose grammars live in
 * another install; without it the engine is resolved from this package root. The host context is a
 * stand-in — session identity, cwd, policy and signal are the only things `invokeSymbolMap` asks of
 * it, and a caller cannot fabricate them for itself.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { invokeSymbolMap } from '../lib/file/symbol-map.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-sym-'))
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`)
}

const ctxOf = policy => ({ get: key => (key === 'sandboxPolicy' ? { resolve: () => policy } : undefined) })
const execOf = cwd => ({ agent: { session: { id: 'symbol-map', header: { cwd } } }, signal: new AbortController().signal })
const policy = (mode, workspaceRoot) => ({ mode, workspaceRoot })
const call = (args, mode = 'danger-full-access', cwd = root) =>
  invokeSymbolMap(ctxOf(policy(mode, root)), args, execOf(cwd), new AbortController().signal)

const source = [
  'interface Shape { a: number }',
  'const top = 1',
  'export class Registry {',
  '  add(a: number) { return a }',
  '}',
  'export function load(): number {',
  '  return top',
  '}',
  ''
].join('\n')
fs.mkdirSync(path.join(root, 'src'))
fs.writeFileSync(path.join(root, 'src', 'sample.ts'), source)

// 1. the map itself
{
  const out = await call({ path: 'src/sample.ts' })
  check('map completes', out.status === 'completed', JSON.stringify(out).slice(0, 200))
  check('boundary is in-process', out.sandbox?.boundary === 'in-process-symbol-map', JSON.stringify(out.sandbox))
  check('language detected', out.lang === 'typescript', String(out.lang))
  const names = (out.symbols ?? []).map(String)
  check('class and function are mapped', names.some(s => s.endsWith(' Registry')) && names.some(s => s.endsWith(' load')), names.join(','))
  check('receipt path is relative POSIX', out.file === 'src/sample.ts', String(out.file))
  check('fileHash is sha256', /^[0-9a-f]{64}$/.test(out.fileHash ?? ''), String(out.fileHash))
  check('bytes match the file', out.bytes === Buffer.byteLength(source), String(out.bytes))
}

// 2. a name filter narrows the page and reports honestly
{
  const out = await call({ path: 'src/sample.ts', name: 'load' })
  check('name filter returns one symbol', out.symbols?.length === 1, String(out.symbols?.length))
  check('filtered total is the filtered count', out.total === 1, String(out.total))
}

// 3. pagination never claims completeness it does not have
{
  const out = await call({ path: 'src/sample.ts', limit: 1 })
  check('one page is partial', out.status === 'partial', out.status)
  check('complete is false', out.complete === false)
  check('nextOffset is offered', typeof out.nextOffset === 'number', String(out.nextOffset))
  check('omitted counts the rest', out.omitted > 0, String(out.omitted))
}

// 4. the fingerprint survives paging
{
  const a = await call({ path: 'src/sample.ts' })
  const b = await call({ path: 'src/sample.ts', limit: 1 })
  check('fileHash is page independent', a.fileHash === b.fileHash, `${a.fileHash} vs ${b.fileHash}`)
  fs.appendFileSync(path.join(root, 'src', 'sample.ts'), 'export const later = 2\n')
  const c = await call({ path: 'src/sample.ts' })
  check('fileHash follows an edit', c.fileHash !== a.fileHash)
}

// 5. an anchor breach is refused before the engine reads (a temp dir is itself an anchor, so the
//    outside file has to live somewhere that is neither the workspace, the cwd nor tmpdir)
{
  const outside = fs.mkdtempSync(path.join(os.homedir(), 'ops-sym-out-'))
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'export function secret() { return 1 }\n')
  const out = await call({ path: path.join(outside, 'secret.ts') }, 'workspace-write')
  check('outside the anchor is refused', out.status === 'error' && /POLICY_DENIED|PATH_RESTRICTED/.test(out.error?.code ?? ''), JSON.stringify(out.error))
  fs.rmSync(outside, { recursive: true, force: true })
}

// 6. a junction inside the anchor that resolves outside is refused
if (process.platform === 'win32') {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-sym-j-'))
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'export function secret() { return 1 }\n')
  const link = path.join(root, 'link')
  let joined = true
  try { fs.symlinkSync(outside, link, 'junction') } catch { joined = false }
  if (joined) {
    const out = await call({ path: 'link/secret.ts' }, 'workspace-write')
    check('junction is refused', out.status === 'error' && out.error?.code === 'PATH_RESTRICTED', JSON.stringify(out.error))
    fs.unlinkSync(link)
  } else {
    check('junction fixture created', false, 'symlink privilege missing')
  }
}

// 7. a missing file is the engine's verdict, not a fence verdict
{
  const out = await call({ path: 'src/absent.ts' })
  check('missing file is NOT_FOUND-like', out.status === 'error' && /NOT_FOUND|E_NO_FILE/.test(out.error?.code ?? ''), JSON.stringify(out.error))
}

// 8. no session, no execution
{
  const out = await invokeSymbolMap(ctxOf(policy('danger-full-access', root)), { path: 'src/sample.ts' },
    { agent: null, signal: new AbortController().signal }, new AbortController().signal)
  check('absent session is EXECUTOR_UNAVAILABLE', out.error?.code === 'EXECUTOR_UNAVAILABLE', JSON.stringify(out.error))
}

fs.rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
