/**
 * ops-parallel-read 冒烟：并发读的四道闸门 + 跨平台清洗开关。
 *
 * 全部对着公开入口 `parallelRead`，不碰内部函数 —— 这是包对外承诺的那条线。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parallelRead, DEFAULTS, TRUNCATED_MARK } = require('../src/ops_parallel_read.js')

let failed = 0
const check = (name, actual, expected) => {
  const ok = Object.is(actual, expected)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}\n      实得 ${JSON.stringify(actual)}`)
}

const dir = await mkdtemp(path.join(tmpdir(), 'ops-read-'))

const normal = path.join(dir, 'normal.txt')
const missing = path.join(dir, 'missing.txt')
const big = path.join(dir, 'big.log')
const binary = path.join(dir, 'image.png')
const long = path.join(dir, 'long.txt')
const crlf = path.join(dir, 'crlf.txt')
const nested = path.join(dir, 'nested', 'deep.txt')

await writeFile(normal, 'alpha\nbeta\n')
await writeFile(big, 'A'.repeat(DEFAULTS.maxFileSize + 1))
await writeFile(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]))
await writeFile(long, 'L'.repeat(DEFAULTS.maxChars + 500))
await writeFile(crlf, Buffer.from('\uFEFFalpha\r\nbeta\r\n', 'utf8'))
await mkdir(path.dirname(nested), { recursive: true })
await writeFile(nested, 'deep\n')

// 1) 正常文件：正文、字节数、key 为 POSIX
{
  const out = await parallelRead([normal])
  const key = Object.keys(out)[0]
  const r = out[key]
  check('正常：status', r.status, 'success')
  check('正常：正文', r.content, 'alpha\nbeta\n')
  check('正常：bytes 为文件长度', r.bytes, 11)
  check('正常：未截断', r.truncated, false)
  check('正常：key 已 POSIX', key.includes('\\'), false)
}

// 2) 缺文件不影响同批其它文件
{
  const out = await parallelRead([normal, missing])
  const values = Object.values(out)
  check('缺文件：条数仍是 2', values.length, 2)
  check('缺文件：另一条仍成功', values.filter((v) => v.status === 'success').length, 1)
  const bad = values.find((v) => v.status !== 'success')
  check('缺文件：错误码', bad.error.code, 'ENOENT')
}

// 3) 超限与二进制各走各的码
{
  const out = await parallelRead([big, binary])
  const values = Object.values(out)
  const codes = values.map((v) => v.error && v.error.code).sort()
  check('闸门：超大文件', codes[0], 'BINARY_FILE')
  check('闸门：二进制文件', codes[1], 'FILE_TOO_LARGE')
}

// 4) 字符截断：标记追加在尾部，且不改写正文
{
  const r = Object.values(await parallelRead([long]))[0]
  check('截断：truncated', r.truncated, true)
  check('截断：正文长度', r.content.length, DEFAULTS.maxChars + TRUNCATED_MARK.length)
  check('截断：尾部是标记', r.content.endsWith(TRUNCATED_MARK), true)
}

// 5) normalize 默认开：BOM 与 CRLF 都归一；关掉就逐字节原样
{
  const on = Object.values(await parallelRead([crlf]))[0]
  check('normalize:true 剥 BOM', on.content.charCodeAt(0) === 0xfeff, false)
  check('normalize:true 无 CR', on.content.includes('\r'), false)

  const off = Object.values(await parallelRead([crlf], { normalize: false }))[0]
  check('normalize:false 留 BOM', off.content.charCodeAt(0), 0xfeff)
  check('normalize:false 留 CRLF', off.content.includes('\r\n'), true)
}

// 6) 深层路径不被误判、重复路径只算一次
{
  const out = await parallelRead([nested, nested])
  check('深层路径：单条结果', Object.keys(out).length, 1)
  check('深层路径：内容', Object.values(out)[0].content, 'deep\n')
}

// 7) 入参不是数组就立刻报错，而不是静默返回空对象
{
  let threw = null
  try {
    await parallelRead('/not/an/array')
  } catch (err) {
    threw = err
  }
  check('入参校验：抛 TypeError', threw instanceof TypeError, true)
}

await rm(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
