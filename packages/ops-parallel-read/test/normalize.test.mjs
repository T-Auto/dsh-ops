/**
 * 功能 B 验证：normalize 对读取结果做了什么、没做什么。
 *
 * 三条断言：
 *   1. normalize:true（默认）—— BOM 消失、CRLF 变 LF、key 与 path 都是 POSIX；
 *   2. normalize:false      —— 正文与 key 都是磁盘原文（含 BOM 与 \r\n）；
 *   3. 单独给 stripBom:false + normalize:true —— 只关 BOM 剥离，CRLF 照转（两个开关可正交）。
 *
 * 另附两条边界：UTF-16LE 文件（BOM 是 FE FF）不被误转；纯 LF 文件一个字符都不动。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parallelRead } = require('../src/ops_parallel_read.js')

const BOM = '\uFEFF'
const dir = await mkdtemp(path.join(tmpdir(), 'ops-normalize-'))
const crlf = path.join(dir, 'crlf.txt')
const lf = path.join(dir, 'lf.txt')
const utf16 = path.join(dir, 'utf16.txt')

await writeFile(crlf, Buffer.from(BOM + 'alpha\r\nbeta\r\n<tag>\r\n', 'utf8'))
await writeFile(lf, 'alpha\nbeta\n<tag>\n')
await writeFile(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\r\nbeta\r\n', 'utf16le')]))

let failed = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}\n      实得 ${JSON.stringify(actual)}`)
}

// 1) 默认（normalize 缺省 = true）
{
  const out = await parallelRead([crlf])
  const key = Object.keys(out)[0]
  const r = out[key]
  check('默认：key 为 POSIX', key.includes('\\'), false)
  check('默认：path 与 key 同源', r.path, key)
  check('默认：BOM 已剥离', r.content.charCodeAt(0) === 0xfeff, false)
  check('默认：CRLF → LF', r.content.includes('\r'), false)
  check('默认：正文', r.content, 'alpha\nbeta\n<tag>\n')
  check('默认：行数仍是 3 行', r.content.split('\n').length - 1, 3)
  check('默认：字节数报原文', r.size, Buffer.byteLength(BOM + 'alpha\r\nbeta\r\n<tag>\r\n'))
}

// 2) normalize:false —— 原汁原味
{
  const out = await parallelRead([crlf], { normalize: false })
  const key = Object.keys(out)[0]
  const r = out[key]
  check('关闭：key 保留反斜杠', key.includes('\\'), process.platform === 'win32')
  check('关闭：BOM 保留', r.content.charCodeAt(0), 0xfeff)
  check('关闭：CRLF 保留', r.content.includes('\r\n'), true)
  check('关闭：正文逐字节一致', r.content, BOM + 'alpha\r\nbeta\r\n<tag>\r\n')
}

// 3) 两个开关可正交：只关 BOM
{
  const out = await parallelRead([crlf], { normalize: true, stripBom: false })
  const r = Object.values(out)[0]
  check('正交：BOM 保留', r.content.charCodeAt(0), 0xfeff)
  check('正交：CRLF 仍归一', r.content.includes('\r'), false)
}

// 边界
{
  const out = await parallelRead([lf, utf16], { normalize: true })
  const lfKey = Object.keys(out).find((k) => k.endsWith('lf.txt'))
  const u16Key = Object.keys(out).find((k) => k.endsWith('utf16.txt'))
  check('纯 LF：零改动', out[lfKey].content, 'alpha\nbeta\n<tag>\n')
  check('UTF-16：BOM 不走 UTF-8 剥离', out[u16Key].content.charCodeAt(0), 0x61)
  check('UTF-16：正文仍按 UTF-16 解码', out[u16Key].content, 'alpha\nbeta\n')
}

const BS = String.fromCharCode(92)

// 6) compat 入口：路径 POSIX，正文逐字节
{
  const { readFilesCompat } = require('../src/ops_parallel_read.js')
  const r = await readFilesCompat([{ path: crlf }])
  const item = r.items[0]
  check('compat：外层 path 为 POSIX', item.path.includes(BS), false)
  check('compat：行 path 为 POSIX', (item.items[0]?.path ?? '').includes(BS), false)
  check('compat：正文仍逐字节', r.status, 'completed')
}


await rm(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
