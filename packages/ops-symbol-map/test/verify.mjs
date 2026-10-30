#!/usr/bin/env node
/**
 * 两段校验：先类型，再运行时。
 *
 *   (a) 类型：用本包自带的 `tsconfig.json` 对整棵 `src/` 跑 `tsc --noEmit`，要求**零诊断**。
 *       这一步能成立，是因为五个宿主模块已在包内补齐（`src/host/*`、`src/adapter/dsh/types.ts`、
 *       `src/symbol-map/grammar.ts` 里就地定义的 `PACKAGE_ROOT`），不再需要先把宿主 `src/`
 *       复制进来才能编译。
 *
 *   (b) 运行时：把 `src/` 编译到临时目录，喂一个临时 `.ts` 文件，走两层入口——
 *       引擎层 `getSymbolMap()` 与工具层 `invokeSymbolMap()`（后者会真正经过
 *       `normalizeArguments` / `MODES` / `record` / 凭据围栏这几份契约副本）。
 *       断言符号表非空、`revision` 是 64 位十六进制、回执里 `fileHash` 与 `symbols` 都在。
 *
 * 依赖探测（都找不到就退出码 2，而不是假装通过）：
 *
 *   typescript      `<pkg>/node_modules`、`SYMBOL_MAP_DEPS`、上两级 `node_modules`、再不行从
 *                   `require.resolve('typescript')` 反推 `bin/tsc`。
 *   语法包          `SYMBOL_MAP_ENGINE_ROOT`（含 `node_modules` 的目录）优先；否则看包根能否
 *                   `require('tree-sitter')`。两者都没有时打印 SKIP 并退出 0 —— 语法包是
 *                   `optionalDependencies`，没装是正常安装态，不是失败。
 *
 * 参数：`--no-typecheck` 跳过 (a)（`npm test` 已经先跑过 tsc 时用）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skipTypecheck = process.argv.includes('--no-typecheck')

/** 找 `typescript/bin/tsc`：显式目录优先，最后从模块解析结果反推。 */
function findTsc() {
  const candidates = [
    join(root, 'node_modules'),
    process.env.SYMBOL_MAP_DEPS,
    resolve(root, '..', '..', 'node_modules'),
    resolve(root, '..', '..', '..', 'node_modules'),
    resolve(root, '..', '..', '..', '..', 'node_modules'),
  ].filter(Boolean)
  for (const dir of candidates) {
    const bin = join(dir, 'typescript', 'bin', 'tsc')
    if (existsSync(bin)) return bin
  }
  try {
    const entry = createRequire(join(root, 'package.json')).resolve('typescript')
    const bin = resolve(dirname(entry), '..', 'bin', 'tsc')
    if (existsSync(bin)) return bin
  } catch {
    /* 没装 typescript */
  }
  return undefined
}

function runTsc(tsc, args, cwd) {
  const run = spawnSync(process.execPath, [tsc, ...args], { cwd, encoding: 'utf-8' })
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() }
}

const tsc = findTsc()
if (!tsc) {
  console.error('[verify] 找不到 typescript；设置 SYMBOL_MAP_DEPS=<含 typescript 的 node_modules>')
  process.exit(2)
}

/* ------------------------------------------------------------------ (a) 类型 */

if (skipTypecheck) {
  console.log('[verify] 跳过类型检查（--no-typecheck）')
} else {
  const { status, output } = runTsc(tsc, ['-p', 'tsconfig.json', '--noEmit'], root)
  if (status !== 0 || output !== '') {
    if (output !== '') console.error(output)
    console.error('[verify] tsc --noEmit 有诊断，类型检查失败')
    process.exit(1)
  }
  console.log('[verify] (a) tsc --noEmit：全包零诊断')
}

/* --------------------------------------------------------------- (b) 运行时 */

/** 语法包在哪。`undefined` 表示这台机器没装，走 SKIP。 */
function engineRoot() {
  const override = process.env.SYMBOL_MAP_ENGINE_ROOT
  if (override !== undefined && override.trim() !== '') return resolve(override)
  try {
    createRequire(join(root, 'package.json')).resolve('tree-sitter')
    return undefined // 包根自己就能解析到，不需要 override
  } catch {
    return null // null = 没装
  }
}

const engine = engineRoot()
if (engine === null) {
  console.log('[verify] SKIP 运行时校验：未安装 tree-sitter/语法包（optionalDependencies）。')
  console.log('[verify]      装了之后重跑，或设 SYMBOL_MAP_ENGINE_ROOT=<含 node_modules 的目录>。')
  process.exit(0)
}
if (engine !== undefined) process.env.DSH_OPS_SYMBOL_MAP_ROOT = engine

const work = mkdtempSync(join(tmpdir(), 'ops-symbol-map-verify-'))
const failures = []
function check(label, condition, detail) {
  if (condition) return
  failures.push(detail === undefined ? label : `${label}（${detail}）`)
}

try {
  const out = join(work, 'dist')
  const emit = runTsc(tsc, ['-p', 'tsconfig.json', '--outDir', out, '--declaration', 'false'], root)
  if (emit.status !== 0) {
    console.error(emit.output)
    console.error('[verify] 编译到临时目录失败')
    process.exit(1)
  }

  const fixture = join(work, 'sample.ts')
  writeFileSync(
    fixture,
    [
      'export interface Shape { area(): number }',
      '',
      'export class Circle implements Shape {',
      '  constructor(private readonly radius: number) {}',
      '  area(): number { return Math.PI * this.radius ** 2 }',
      '}',
      '',
      'export function perimeter(radius: number): number {',
      '  return 2 * Math.PI * radius',
      '}',
      '',
      'export const label = (value: string): string => `circle:${value}`',
      '',
    ].join('\n'),
    'utf-8',
  )

  const engineModule = await import(pathToFileURL(join(out, 'symbol-map', 'index.js')).href)

  /* 引擎层：符号表 + 内容指纹 */
  const map = engineModule.getSymbolMap(fixture, { extended: true })
  const names = map.symbols.map((symbol) => symbol.name)
  check('lang 识别为 typescript', map.lang === 'typescript', String(map.lang))
  check('symbols 非空', map.symbols.length > 0, `got ${map.symbols.length}`)
  check('符号含 Circle/area/perimeter', ['Circle', 'area', 'perimeter'].every((name) => names.includes(name)), names.join(','))
  check('extended 档补上 const 箭头函数 label', names.includes('label'), names.join(','))
  check('revision 是 64 位小写十六进制', /^[0-9a-f]{64}$/u.test(map.revision), map.revision)
  check('hash 是 16 位小写十六进制', /^[0-9a-f]{16}$/u.test(map.hash), map.hash)
  check('bytes 与文件大小一致', map.bytes === Buffer.byteLength(readFileSync(fixture)))

  /* 工具层：normalizeArguments / MODES / record / 凭据围栏 一起过一遍 */
  const toolModule = await import(pathToFileURL(join(out, 'file', 'symbol-map.js')).href)
  const ctx = {
    get: (name) => name === 'sandboxPolicy'
      ? { resolve: () => ({ mode: 'read-only', workspaceRoot: work }) }
      : undefined,
  }
  const exec = { agent: { session: { id: 'verify', header: { cwd: work } } } }
  // scope/offset 是严格适配器会发来的空占位：必须被 normalizeArguments 丢掉，而不是让引擎报 E_ARGS。
  const receipt = await toolModule.invokeSymbolMap(ctx, { path: 'sample.ts', extended: true, scope: '', offset: null }, exec, new AbortController().signal, {})

  check('回执不是失败', receipt?.error === undefined, JSON.stringify(receipt?.error))
  check('回执状态 completed/partial', receipt?.status === 'completed' || receipt?.status === 'partial', String(receipt?.status))
  check('回执 file 相对 cwd', receipt?.file === 'sample.ts', String(receipt?.file))
  check('回执 symbols 非空', Array.isArray(receipt?.symbols) && receipt.symbols.length > 0, `got ${receipt?.symbols?.length}`)
  check('回执 fileHash 是 64 位十六进制', /^[0-9a-f]{64}$/u.test(receipt?.fileHash ?? ''), String(receipt?.fileHash))
  check('回执 sandbox.mode 取自权威策略', receipt?.sandbox?.mode === 'read-only', String(receipt?.sandbox?.mode))

  /* 凭据围栏：契约副本 credentialDenied() 的字段形状 */
  const denied = await toolModule.invokeSymbolMap(ctx, { path: join(work, '.ssh', 'id_rsa') }, exec, new AbortController().signal, {})
  check('凭据路径被拒', denied?.status === 'rejected' && denied?.error?.code === 'CREDENTIAL_DENIED', JSON.stringify(denied?.error?.code))
  check('凭据拒绝是 preflight/零副作用', denied?.error?.phase === 'preflight' && denied?.error?.effectState === 'none')
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`[verify] (b) 运行时校验失败 ${failures.length} 项：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('[verify] (b) 运行时校验通过：符号表、revision、fileHash、回执与凭据围栏均符合预期')
