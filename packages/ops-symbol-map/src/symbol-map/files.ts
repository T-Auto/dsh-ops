/**
 * Byte-level and line-level primitives: hashing, reading, path display, scope normalisation.
 *
 * Everything here is deliberately boring. The one decision worth calling out is that
 * {@link revisionOf} hashes the **exact bytes that were parsed**, not a decoded string: a BOM, a
 * CRLF, or a lone-surrogate byte all change what tree-sitter saw, so they must change the
 * revision too. Hashing the decoded text would hide exactly the drift a snapshot is supposed to
 * detect.
 *
 * @module dsh-ops/symbol-map/files
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { fail } from './errors.js'
import type { Scope } from './types.js'

/** Refuse to parse anything larger than this unless the caller raises the ceiling. */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** 64 lowercase hex characters. Anything else is not a revision. */
export const REVISION_RE = /^[a-f0-9]{64}$/u

/** How many hex characters a `hash` keeps. Long enough to key a cache, short enough to read. */
export const HASH_LEN = 16

/** SHA-256 of the parsed bytes, lowercase hex. */
export function revisionOf(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** 头尾指纹窗口：各 50 KiB。源码的改动几乎总发生在头尾，中段整段漂移极罕见。 */
export const FAST_HASH_WINDOW = 50 * 1024

/** 从 `position` 读满 `length` 字节。短读说明文件在哈希途中被截短，按实际长度返回。 */
function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const read = fs.readSync(fd, buffer, filled, length - filled, position + filled)
    if (read === 0) break
    filled += read
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

/**
 * 快速变更指纹：头 50 KiB + 尾 50 KiB 的 SHA-256。
 *
 * `size <= 2 * FAST_HASH_WINDOW` 时头尾两段已经覆盖全文，直接复用引擎已有的 `revision`
 * —— 它本来就是整个 buffer 的 SHA-256，此刻再读一遍纯属白费。
 *
 * 超过这个阈值的文件只读 100 KiB，10 MB 与 1 GB 的代价相同。代价是「只改中段、且头尾长度
 * 不变」的修改不会被这个字段捕捉；这类改动由 `revision`（整文件）负责，两者并存正是设计意图：
 * `fileHash` 便宜且适合每轮轮询，`revision` 昂贵但权威。
 */
export function fileFingerprint(
  absolute: string,
  size: number,
  revision: string,
): { hash: string; scope: 'full' | 'head+tail'; bytes: number } {
  if (size <= FAST_HASH_WINDOW * 2) return { hash: revision, scope: 'full', bytes: size }
  const fd = fs.openSync(absolute, 'r')
  try {
    const headLength = Math.min(FAST_HASH_WINDOW, size)
    const tailLength = Math.min(FAST_HASH_WINDOW, size - headLength)
    const hash = createHash('sha256')
    hash.update(readAt(fd, 0, headLength))
    hash.update(readAt(fd, size - tailLength, tailLength))
    return { hash: hash.digest('hex'), scope: 'head+tail', bytes: headLength + tailLength }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * A path as it should appear in output: relative when it stays inside the cwd, absolute otherwise.
 *
 * Relative is the default because a symbol map is usually read by an agent that already knows
 * where it is, and absolute paths burn tokens without adding information. Paths that escape the
 * cwd stay absolute so that nothing looks local when it is not.
 */
export function displayPath(abs: string): string {
  const rel = path.relative(process.cwd(), abs)
  if (rel === '') return abs
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs
  return rel
}

/**
 * Read a regular file, mapping every errno onto a code the caller can act on.
 *
 * `EACCES`/`EPERM` become `E_ACCESS` rather than `E_READ` because "you are not allowed" and "the
 * disk failed" call for different next actions, and a caller cannot tell them apart afterwards.
 */
export function readFileBuffer(abs: string): Buffer {
  try {
    return fs.readFileSync(abs)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') fail('E_NOT_FOUND', `No such file: ${displayPath(abs)}`)
    if (code === 'EISDIR') fail('E_NOT_FILE', `Not a regular file: ${displayPath(abs)}`)
    if (code === 'EACCES' || code === 'EPERM') fail('E_ACCESS', `Read access denied: ${displayPath(abs)}`)
    const reason = error instanceof Error ? error.message : String(error)
    fail('E_READ', `Could not read ${displayPath(abs)}: ${reason}`)
  }
}

/** `stat` a path and enforce the size ceiling before a single byte is read into memory. */
export function statRegularFile(abs: string, maxBytes: number): fs.Stats {
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') fail('E_NOT_FOUND', `No such file: ${displayPath(abs)}`)
    if (code === 'EACCES' || code === 'EPERM') fail('E_ACCESS', `Access denied: ${displayPath(abs)}`)
    const reason = error instanceof Error ? error.message : String(error)
    fail('E_READ', `Could not stat ${displayPath(abs)}: ${reason}`)
  }
  if (!stat.isFile()) fail('E_NOT_FILE', `Not a regular file: ${displayPath(abs)}`)
  if (stat.size > maxBytes) {
    fail('E_FILE_TOO_LARGE', `${displayPath(abs)} is ${stat.size} bytes, over the ${maxBytes} byte ceiling.`, {
      path: displayPath(abs),
      size: stat.size,
      maxBytes,
    })
  }
  return stat
}

function asLine(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.floor(value)
}

function firstLine(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const line = asLine(value)
    if (line !== undefined) return line
  }
  return undefined
}

/**
 * Normalise a scope into a 1-based inclusive window.
 *
 * Three input shapes are accepted because the engine is reachable from three callers: the tool
 * layer hands over the raw `"40-120"` string from the schema, the JS API hands over `{lo, hi}`,
 * and older callers hand over `{startLine, endLine}`. A reversed pair is swapped rather than
 * rejected — asking for lines 120 through 40 means the same range, and refusing it would be
 * pedantry. A start below 1 is clamped to 1 for the same reason.
 */
export function normalizeScope(raw: unknown): Scope | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'string') {
    const match = /^\s*(\d+)\s*[-:]\s*(\d+)\s*$/u.exec(raw)
    if (match === null) fail('E_ARGS', `scope must look like "START-END", for example "40-120"; got ${JSON.stringify(raw)}.`)
    return order(Number(match[1]), Number(match[2]))
  }
  if (typeof raw === 'object') {
    const value = raw as Record<string, unknown>
    const lo = firstLine(value.lo, value.startLine, value.from, value.start)
    const hi = firstLine(value.hi, value.endLine, value.to, value.end)
    if (lo === undefined || hi === undefined) {
      fail('E_ARGS', 'scope needs both a start line and an end line.')
    }
    return order(lo, hi)
  }
  fail('E_ARGS', 'scope must be a "START-END" string or an object carrying start and end lines.')
}

function order(a: number, b: number): Scope {
  const lo = Math.max(1, Math.min(a, b))
  const hi = Math.max(1, Math.max(a, b))
  return { lo, hi }
}
