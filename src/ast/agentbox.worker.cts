'use strict';
/**
 * AgentBox Worker：唯一真正落盘的进程。
 * 输入：stdin 上的 JSON（字节区间 + base64 片段 + 期望 pre-image 哈希）
 * 输出：stdout 上一行 JSON。绝不接受命令行参数形式的代码内容，也没有任何 shell 参与。
 */
import fs = require('node:fs/promises');
import crypto = require('node:crypto');
import { resolve } from 'node:path';
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EDITS = 10000;

const hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function reject(code: string, message: string, detail?: unknown): never {
  throw Object.assign(new Error(message), { code, detail });
}

// Read through a bounded descriptor; readFile alone can allocate unboundedly if a file grows.
async function readTarget(file: string) {
  const initial = await fs.lstat(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink > 1) reject('E_AGENTBOX_FILE_TYPE', '目标必须为无硬链接的普通文件');
  if (initial.size > MAX_FILE_BYTES) reject('E_AGENTBOX_TOO_BIG', '目标超过 16 MiB');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== initial.ino || opened.dev !== initial.dev || opened.nlink > 1) reject('E_AGENTBOX_CHANGED', '打开期间目标被替换');
    if (opened.size > MAX_FILE_BYTES) reject('E_AGENTBOX_TOO_BIG', '目标超过 16 MiB');
    const buffer = Buffer.allocUnsafe(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== opened.size) reject('E_AGENTBOX_CHANGED', '读取期间目标大小变化');
    return { data: buffer.subarray(0, length), mode: opened.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function verifySnapshot(file: string, expected: Buffer) {
  const current = await readTarget(file);
  if (!current.data.equals(expected)) reject('E_AGENTBOX_CHANGED', '文件在审计期间发生变化');
  return current.mode;
}

async function checkedWrite(file: string, before: Buffer, after: Buffer) {
  const lock = `${file}.ops-ast.lock`;
  const tmp = `${file}.ast-${crypto.randomUUID()}.tmp`;
  let lockHandle, tmpHandle;
  let ownsTemp = false;
  try {
    try { lockHandle = await fs.open(lock, 'wx', 0o600); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') reject('E_AGENTBOX_LOCKED', '另一个 ops-ast 写入占用目标'); throw e; }
    const mode = await verifySnapshot(file, before);
    tmpHandle = await fs.open(tmp, 'wx', mode);
    ownsTemp = true;
    await tmpHandle.writeFile(after);
    await tmpHandle.close();
    tmpHandle = undefined;
    await fs.chmod(tmp, mode);
    await verifySnapshot(file, before);
    await fs.rename(tmp, file);
    ownsTemp = false;
  } finally {
    if (tmpHandle) await tmpHandle.close().catch(() => {});
    if (ownsTemp) await fs.unlink(tmp).catch(() => {});
    if (lockHandle) {
      await lockHandle.close().catch(() => {});
      await fs.unlink(lock).catch(() => {});
    }
  }
}

(async () => {
  const chunks = [];
  let payloadBytes = 0;
  for await (const c of process.stdin) {
    const chunk = Buffer.from(c);
    payloadBytes += chunk.length;
    if (payloadBytes > MAX_PAYLOAD_BYTES) reject('E_AGENTBOX_PAYLOAD_TOO_BIG', 'stdin 载荷超过 16 MiB');
    chunks.push(chunk);
  }

  let payload: { path: string; edits: { start: number; end: number; b64: string }[]; atomic?: boolean; expectSha256: string };
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    reject('E_AGENTBOX_PAYLOAD', 'stdin 载荷不是合法 JSON', String(e));
    return;
  }
  if (!payload || typeof payload.path !== 'string' || !payload.path.trim() || !Array.isArray(payload.edits) || payload.edits.length > MAX_EDITS) {
    reject('E_AGENTBOX_PAYLOAD', '载荷缺 path/edits 或超过 10000 个编辑');
  }
  if (payload.atomic !== undefined && payload.atomic !== true) reject('E_AGENTBOX_ATOMIC', '必须使用原子替换');
  if (typeof payload.expectSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(payload.expectSha256)) reject('E_AGENTBOX_PAYLOAD', '缺少合法 pre-image SHA256');
  payload.path = resolve(payload.path);
  const { data: before } = await readTarget(payload.path);

  const preSha = hash(before);
  if (preSha !== payload.expectSha256.toLowerCase()) {
    reject('E_AGENTBOX_HASH_MISMATCH', 'pre-image 哈希不匹配：文件在流水线期间被外部改动', {
      expect: payload.expectSha256,
      actual: preSha,
    });
    return;
  }

  const edits = payload.edits
    .map((e) => {
      if (!e || !Number.isSafeInteger(e.start) || !Number.isSafeInteger(e.end) || typeof e.b64 !== 'string') reject('E_AGENTBOX_PAYLOAD', '编辑缺少整数 start/end 或 base64');
      const buf = Buffer.from(e.b64, 'base64');
      if (buf.toString('base64') !== e.b64) reject('E_AGENTBOX_PAYLOAD', '编辑不是规范 base64');
      return { start: e.start, end: e.end, buf };
    })
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!Number.isInteger(e.start) || !Number.isInteger(e.end)) {
      reject('E_AGENTBOX_RANGE', '区间不是整数');
      return;
    }
    if (e.start < 0 || e.end < e.start || e.end > before.length) {
      reject('E_AGENTBOX_RANGE', `非法字节区间 ${e.start}-${e.end}（文件 ${before.length} 字节）`);
      return;
    }
    if (i > 0 && e.start < edits[i - 1].end) {
      reject('E_AGENTBOX_OVERLAP', '编辑区间重叠');
      return;
    }
  }

  const outputBytes = edits.reduce((size, e) => size - (e.end - e.start) + e.buf.length, before.length);
  if (outputBytes > MAX_FILE_BYTES) reject('E_AGENTBOX_TOO_BIG', '改写结果超过 16 MiB');
  const parts = [];
  let cur = 0;
  for (const e of edits) {
    parts.push(before.subarray(cur, e.start), e.buf);
    cur = e.end;
  }
  parts.push(before.subarray(cur));
  const after = Buffer.concat(parts);

  await checkedWrite(payload.path, before, after);

  process.stdout.write(
    JSON.stringify({
      ok: true,
      bytesBefore: before.length,
      bytesAfter: after.length,
      sha256Before: preSha,
      sha256After: hash(after),
    }),
  );
})().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, code: String(e && e.code || 'E_AGENTBOX_IO'), message: String(e && e.message), detail: e && e.detail }) + '\n');
  process.exitCode = 2;
});
