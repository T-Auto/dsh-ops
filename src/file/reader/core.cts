// @ts-nocheck — ported from the shipped 4.1.8 reader as-is: the runtime is unchanged, the types
// are the open work. Tracked in docs/CHANGELOG.md under Unreleased.
'use strict';

const DEFAULTS = Object.freeze({
  concurrency: 10,                     // 并发槽位上限（同时也是 FD 上限）
  maxFileSize: 2 * 1024 * 1024,        // 单文件字节上限 2MB
  timeoutMs: 3000,                     // 单文件总预算，覆盖 open/fstat/read/close 全程
  maxChars: 50000,                     // 单文件返回字符上限
  maxTotalChars: 120000,               // 全批返回字符上限（上下文防线）
  chunkBytes: 64 * 1024,               // 分块读取粒度
  closeMs: 100,                        // close 等待上限，卡死也放手
  encoding: 'utf8',                    // 无 BOM 时的解码方式
  root: null,                          // 非空则把 IO 围栏在 root 内（opt-in，比原装更严）
  signal: null,                        // AbortSignal，取消整批
  full: false,                         // true = 读到 EOF（兼容层用；产 lineCount / revision）
  hash: false,                         // true = 边读边算 SHA-256（需配合 full）
  maxOpenRetries: 2,                   // EMFILE/ENFILE/EBUSY 时的重试次数
  strictUtf8: false,                   // true = 非法 UTF-8 直接报错，而不是填 U+FFFD（兼容层开）
  allowLinks: true,                    // false = 拒绝 symlink / junction（兼容层关，对齐原装）
  // true = 剥掉 UTF-8 BOM。native（AI 直读整篇）默认剥，省得首行开头挂个 U+FEFF 污染上下文；
  // 兼容层强制 false —— 原装 dsh-ops 实测**保留** BOM（首行 "\uFEFFhello"、BOM-only 文件
  // lineCount=1），替换路径若剥掉，上层拿返回文本做编辑 / CAS / diff 会按"少了 3 个字节"处理，
  // 属于静默写坏。剥与不剥都保留开关，由调用方决定。
  stripBom: true,
  // true = 跨平台清洗：CRLF → LF、路径键 \ → /。native 入口默认开（AI 直接看文本，
  // 混着 \r 的行尾会让 diff / 编辑锚点错位）；兼容层强制 false —— 原装回写的是磁盘原文，
  // 清洗过再交给 ops_edit_file 就是静默写坏。
  normalize: true,
});

/** 截断标记，原样输出，便于上层用字符串匹配判断 */
const TRUNCATED_MARK = '\n...[Warning: Content truncated]...';

/** 带 error.code 的业务错误，方便上层按 code 分支处理 */
class OpsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OpsError';
    this.code = code;
  }
}

/** 统一的结果骨架：只在两处构造，避免字段漂移（隐藏类一致，V8 不会退化成字典模式） */
function emptyResult(filePath) {
  return {
    path: filePath, status: 'error', content: null, error: null, truncated: false,
    size: null, bytes: null, mtimeMs: null, lineCount: null, revision: null, elapsedMs: 0,
    rows: null, rowsClipped: false, scannedBytes: 0,
  };
}

const sleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (t.unref) t.unref();              // 兜底等待不该阻止进程退出
});

/**
 * 极简并发池（手写，不引 p-limit）。
 *
 * 一次性拉起 N 个 worker 协程共享游标：每个 worker 循环"抢号 -> 执行 -> 抢下一个号"。
 * worker 数量恒等于 concurrency，因此在飞任务数恒 <= concurrency，同步自增即可，无需锁。
 */
async function runPool(items, limit, worker) {
  const total = items.length;
  if (total === 0) return [];

  const results = new Array(total);
  // limit 可能被外部直接传成 NaN / Infinity：NaN 会让 Array.from({length:NaN}) 得到空数组，
  // 整批静默丢失（返回一堆 undefined）。这里归一成"至少 1 个 worker"。
  const slots = Math.max(1, Math.min(Math.floor(limit) || 1, total));
  let cursor = 0;

  const runners = Array.from({ length: slots }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= total) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        // 最后一道保险：兜底对象也带上 path，否则该文件会从结果里消失
        results[index] = {
          ...emptyResult(String(items[index])),
          error: { code: err.code || 'UNKNOWN', message: err.message || String(err) },
        };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Windows 路径分量校验（对齐原装 Rust `validate_name`，逐条实测过）。
 *
 * 为什么必须有：Windows 把这些名字解析成**设备**而不是文件 ——
 *   `NUL` 读出来是空、`CON` 是控制台（读它会卡住等输入）、`x.txt:stream` 是 NTFS 备用数据流
 *   （内容不在目录列表里，扫描工具看不见）。
 * 对 AI Agent 来说这是"读到不存在的东西"和"读到看不见的东西"，两种都是静默错误，
 * 原装一律 INVALID_ARGUMENT 拒绝，这里保持一致。
 */

module.exports = { DEFAULTS, TRUNCATED_MARK, OpsError, emptyResult, sleep, runPool };
