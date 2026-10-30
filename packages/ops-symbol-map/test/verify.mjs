#!/usr/bin/env node
/**
 * 这份源码是 **dsh-ops 树内的投放件**（source drop）：`src/` 下的相对路径就是它落进 `dsh-ops/src/`
 * 之后的位置 —— `src/file/symbol-map.ts` 会 `import '../worker-boundary.js'`，
 * `src/symbol-map/grammar.ts` 会 `import '../paths.js'`，这些模块由宿主提供，包内不复制。
 *
 * 所以「能不能编译」只能在实际落位之后回答。本脚本把宿主 `src/` 复制到临时目录，把这棵 `src/`
 * 覆盖上去，再只对本投放件的文件跑 `tsc --noEmit`。只统计本包文件的诊断：宿主自身的类型噪声
 * （缺它的私有依赖时会冒出来）不计入结论，也不掩盖本包的问题。
 *
 * 依赖位置（`typescript`）按序探测：`--deps <dir>`、`SYMBOL_MAP_DEPS`、`<dsh-ops>/node_modules`、
 * `<dsh-ops>/../node_modules`。都没有就跳过（退出码 2），而不是假装通过。
 */
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWNED = [
  'src/authority-paths.ts',
  'src/credential-policy.ts',
  'src/file/symbol-map.ts',
  'src/symbol-map/',
]

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const host = resolve(root, '..', '..')

const hostSrc = join(host, 'src')
const hostTsconfig = join(host, 'tsconfig.json')
if (!existsSync(hostSrc) || !existsSync(hostTsconfig)) {
  console.error(`[verify] 需要 dsh-ops 仓库上下文：${hostSrc}`)
  process.exit(2)
}

const argDeps = process.argv.indexOf('--deps')
const candidates = [
  argDeps > 0 ? process.argv[argDeps + 1] : undefined,
  process.env.SYMBOL_MAP_DEPS,
  join(host, 'node_modules'),
  join(host, '..', 'node_modules'),
].filter(Boolean)

const deps = candidates.find((dir) => existsSync(join(dir, 'typescript', 'bin', 'tsc')))
if (!deps) {
  console.error('[verify] 找不到 typescript；设置 SYMBOL_MAP_DEPS=<含 typescript 的 node_modules>')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'symbol-map-verify-'))
try {
  cpSync(hostSrc, join(work, 'src'), { recursive: true })
  cpSync(join(root, 'src'), join(work, 'src'), { recursive: true })
  cpSync(hostTsconfig, join(work, 'tsconfig.json'))
  writeFileSync(
    join(work, 'tsconfig.verify.json'),
    JSON.stringify(
      {
        extends: './tsconfig.json',
        include: [
          'src/symbol-map/**/*.ts',
          'src/file/symbol-map.ts',
          'src/authority-paths.ts',
          'src/credential-policy.ts',
        ],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  )
  try {
    symlinkSync(resolve(deps), join(work, 'node_modules'), 'junction')
  } catch {
    /* 已存在或没有权限：tsc 仍可能从上层找到依赖，交给下面如实报错 */
  }

  const tsc = join(deps, 'typescript', 'bin', 'tsc')
  const run = spawnSync(process.execPath, [tsc, '-p', join(work, 'tsconfig.verify.json'), '--noEmit'], {
    cwd: work,
    encoding: 'utf-8',
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const own = output
    .split(/\r?\n/)
    .filter((line) => OWNED.some((prefix) => line.startsWith(prefix)))
  const hostNoise = output
    .split(/\r?\n/)
    .filter((line) => /^src\/.+\(\d+,\d+\): error/.test(line) && !OWNED.some((prefix) => line.startsWith(prefix)))

  if (own.length > 0) {
    console.error(own.join('\n'))
    console.error(`[verify] 本包文件有 ${own.length} 条诊断`)
    process.exit(1)
  }
  if (hostNoise.length > 0) console.log(`[verify] 忽略宿主侧诊断 ${hostNoise.length} 条（不在本包范围）`)
  console.log('[verify] 落位后 typecheck 通过：本包文件零诊断')
} finally {
  rmSync(work, { recursive: true, force: true })
}
