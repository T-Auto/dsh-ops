'use strict';

/**
 * ops_parallel_read —— 批量文件并发读取工具（零依赖，仅 Node.js 内建模块）
 *
 * 给 AI Agent 当"眼睛"：一次问 20 个文件，一次可控的批量读取。
 * 七道闸门，任何一道不通过都只让单个文件失败，绝不拖垮整批：
 *
 *   1. 并发池    —— 同时在飞的文件数 <= concurrency，FD 峰值 = concurrency（每文件只开 1 次）
 *   2. 大小闸门  —— fstat 取权威大小（在已打开的 FD 上取，路径被换也骗不到），> 2MB 直接拒
 *   3. 超时强杀  —— 单个文件 3s *总*预算：**一个 deadline 一个 timer**贯穿 open/fstat/read/close
 *   4. 二进制闸门 —— 解码窗口内出现 NUL 即判二进制；UTF-16 BOM 走正常文本路径
 *   5. 解码闸门  —— BOM 识别（UTF-8 / UTF-16LE），UTF-8 BOM 剥掉，不让 U+FEFF 污染首行
 *   6. 单文件截断 —— 最多 50,000 字符；**读的时候就在字符上限处停**，2MB 文件也只读 ~64KB
 *   7. 全局预算  —— 全批最多 120,000 字符（对齐原装 128KiB 输出上限），按输入顺序确定性结算
 *
 * 返回 Key-Value（key = 文件路径），并发乱序也不影响"哪个文件报了什么错"。
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');


const { DEFAULTS, TRUNCATED_MARK, OpsError, runPool } = require('./lib/core');
const { cutChars, truncate } = require('./lib/text');
const { readCacheStats, readOne } = require('./lib/read-one');

function normalizeOptions(options) {
  const opts = { ...DEFAULTS, ...options };
  opts.concurrency = Math.max(1, Math.floor(opts.concurrency) || 1);
  // 统一用 !(x > 0) 而不是 x <= 0：NaN 与任何数比较都是 false，用 <= 判会让 NaN 一路穿过
  // 闸门 —— maxFileSize=NaN 时 size > NaN 恒 false，2MB 限制形同虚设；maxChars=NaN 时
  // keep 变 NaN，正文一个字符都进不来却报 success。
  if (!(opts.maxFileSize > 0)) opts.maxFileSize = DEFAULTS.maxFileSize;
  if (!(opts.maxChars > 0)) opts.maxChars = DEFAULTS.maxChars;
  if (!(opts.maxTotalChars > 0)) opts.maxTotalChars = DEFAULTS.maxTotalChars;
  if (!(opts.timeoutMs > 0)) opts.timeoutMs = DEFAULTS.timeoutMs;
  // Node 的 setTimeout 对 > 2^31-1 的 delay 会静默改成 1ms（并打 TimeoutOverflowWarning）。
  // 于是 timeoutMs=Infinity / 3e9 不是"永不超时"，而是"1ms 后必超时"。封顶到 2^31-1（≈24.8 天）
  // 既保留"等于不超时"的语义，又不触发溢出。
  opts.timeoutMs = Math.min(opts.timeoutMs, 2147483647);
  if (!(opts.chunkBytes > 0)) opts.chunkBytes = DEFAULTS.chunkBytes;
  if (!(opts.closeMs > 0)) opts.closeMs = DEFAULTS.closeMs;
  opts.full = !!opts.full;
  opts.hash = !!opts.hash;
  opts.normalize = opts.normalize !== false;
  // 未显式指定 stripBom 时跟随 normalize：normalize:false 的语义是"原汁原味"，
  // 那就不能只关 CRLF 转换却仍然剥掉 BOM —— 少了 3 个字节同样不是磁盘上的那串。
  // 兼容层两个都显式传，行为不变。
  opts.stripBom = options.stripBom === undefined ? opts.normalize : !!options.stripBom;
  return opts;
}

async function parallelRead(filePaths, options = {}) {
  if (!Array.isArray(filePaths)) {
    throw new TypeError('filePaths 必须是 string[]');
  }

  const opts = normalizeOptions(options);

  // 去重：同一路径传两次不该占两个 FD，也不该读两遍
  const unique = [...new Set(filePaths.map(String))];

  const raw = await runPool(unique, opts.concurrency, (filePath) => readOne(filePath, opts, Date.now()));

  // 渲染阶段按输入顺序串行结算：截断与全局预算因此是确定性的，不受并发完成顺序影响
  const result = Object.create(null);   // null 原型：路径叫 "__proto__" 也污染不到原型链
  let used = 0;

  for (const item of raw) {
    if (item.status !== 'success') {
      result[item.path] = item;
      continue;
    }

    // 空文件不占任何字符预算：这里必须先放行，否则 maxTotalChars 用尽时
    // 一个 0 字节的文件也会被判 BUDGET_EXHAUSTED —— 报的是假错误，上层会去重试一个根本没有内容的东西。
    if (item.content.length === 0 && !item.truncated) {
      result[item.path] = item;
      continue;
    }

    const room = opts.maxTotalChars - used;
    // 余额连截断标记都放不下，就没必要再给半个文件：直接判预算耗尽，让上层分批
    if (room <= TRUNCATED_MARK.length) {
      result[item.path] = {
        ...item,
        status: 'error',
        content: null,
        truncated: false,
        error: {
          code: 'BUDGET_EXHAUSTED',
          message: `全批 ${opts.maxTotalChars} 字符预算已用尽（已返回 ${used} 字符），请分批读取`,
        },
      };
      continue;
    }

    // 两段式：先按单文件上限切（正文 50k + 标记），只有总量顶穿时才按剩余 room 重切。
    // 不把标记预先扣进 maxChars —— 否则每个文件都白少 35 个字符。
    const cap = Math.min(opts.maxChars, room);
    let content;
    let truncated;
    if (item.truncated) {
      // 读取阶段已截断：item.content 是「正文 + 标记」。绝不能拿这串整体再 truncate 一次 ——
      // 正文因代理对保护比 keep 少 1 个字符时（keep 落在 😀 中间），那一刀会切进标记本身，
      // 得到「正文 + 标记首字符 \n」再补一个标记：内容既不是原文前缀，又多出假换行。
      // 只按「正文还能留多少」重算，标记永远只补一次。
      const body = item.content.slice(0, item.content.length - TRUNCATED_MARK.length);
      const maxBody = Math.min(opts.maxChars, room - TRUNCATED_MARK.length);
      content = (body.length > maxBody ? cutChars(body, maxBody) : body) + TRUNCATED_MARK;
      truncated = true;
    } else {
      ({ content, truncated } = truncate(item.content, cap));
      if (content.length > room) {
        ({ content, truncated } = truncate(item.content, room - TRUNCATED_MARK.length));
      }
    }
    used += content.length;
    result[item.path] = { ...item, content, truncated };
  }

  return result;
}

// ---------------------------------------------------------------------------
// 兼容层：对齐原装 dsh-ops 0.4.1 `ops_read_files` 的入参/出参
// ---------------------------------------------------------------------------

/** 原装 read_files 的 schema 上限：1-32 个文件，limit 1-10000 */
const COMPAT_MAX_FILES = 32;
const COMPAT_MAX_LIMIT = 10000;
// 缺省 200 行，与原装 ops_read_files 的 schema 默认值一致。
//
// 4.1.5 曾把缺省抬到 COMPAT_MAX_LIMIT（10000），理由是"200 行会静默少返回内容"。但截断
// 已经不再静默：complete=false + truncatedBy + nextOffset 都在回执里，调用方照常续读。
// 抬缺省的真实代价是 token：同一个 1 MB 文件，缺省 200 行回 10.7 KiB，缺省 10000 行回
// 46.5 KiB —— 4 倍。替换件的默认值必须与原装一致，否则"换掉 ops_read_files"就等于悄悄
// 改了每个会话的上下文成本。
const COMPAT_DEFAULT_LIMIT = 200;

/**
 * 原装的输出预算是 **JSON 字节** 128 KiB，策略是：
 *   按输入顺序累加，超预算时把"当前文件"按行削到刚好放得下，然后停；
 *   nextIndex = 已返回的文件数，pending = 剩余文件数。
 * 实测 20×16KB：返回 3 项 / 第 3 项 169 行（共 186）/ 响应体 98293 字节。
 * 上一版直接套用 native 的字符预算，结果第 9 个文件起整条 BUDGET_EXHAUSTED、
 * 第 8 个文件静默少 129 行且 nextIndex 恒等于 20（上层无法续读）——这是真缺陷。
 */
// 原装把 128 KiB 当**上限**用，实测却总在 1/4 处收手（8×800 行：4 个文件 / 34.1 KiB 就停），
// 我们填满 128 KiB 回 5 个文件 / 47.3 KiB —— 同样的预算，多吐 39% 的字节，等于每次多花 token。
// 取 96 KiB：既留出与原装相当的头寸，又不至于少回一整个文件。
const COMPAT_OUTPUT_BUDGET = 96 * 1024;

/** 错误码映射：这里全部来自对原装 worker 的实测，不是猜的 */
const ERROR_MAP = Object.freeze({
  ENOENT: { code: 'NOT_FOUND', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  ENOTDIR: { code: 'NOT_FOUND', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  EACCES: { code: 'PERMISSION_DENIED', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  EPERM: { code: 'PERMISSION_DENIED', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  NOT_A_FILE: { code: 'INVALID_ARGUMENT', message: 'path is a directory; use ops_glob or ops_grep', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  BINARY_FILE: {
    code: 'ERR_INVALID_ENCODING',
    message: 'File is not valid UTF-8',
    nextAction: 'Use a dedicated document/binary reader, or inspect with view=hex; do not replace invalid bytes with lossy text.',
    retryable: false,
  },
  UNSUPPORTED_ENCODING: { code: 'ERR_INVALID_ENCODING', nextAction: 'Use a dedicated document/binary reader; convert to UTF-8 first.', retryable: false },
  FILE_TOO_LARGE: { code: 'INVALID_ARGUMENT', nextAction: 'Read a line range instead of the whole file.', retryable: false },
  TIMEOUT: { code: 'TIMEOUT', nextAction: 'Retry, or read fewer files at once.', retryable: true },
  EMFILE: { code: 'RESOURCE_EXHAUSTED', nextAction: 'Retry with a smaller batch.', retryable: true },
  ENFILE: { code: 'RESOURCE_EXHAUSTED', nextAction: 'Retry with a smaller batch.', retryable: true },
  ABORTED: { code: 'ABORTED', nextAction: 'Retry if the work is still needed.', retryable: false },
  ESCAPE_ROOT: { code: 'ACCESS_DENIED', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  // 以下三条按原装 Rust 侧实测码对齐：路径分量非法 -> INVALID_ARGUMENT（消息原样带出去），
  // 非法 UTF-8 -> ERR_INVALID_ENCODING "File is not valid UTF-8"，链接 -> PATH_RESTRICTED。
  INVALID_PATH: { code: 'INVALID_ARGUMENT', nextAction: 'Correct the request or inspect the manifest.', retryable: false },
  INVALID_UTF8: { code: 'ERR_INVALID_ENCODING', message: 'File is not valid UTF-8', nextAction: 'Use a dedicated document/binary reader, or inspect with view=hex; do not replace invalid bytes with lossy text.', retryable: false },
  PATH_RESTRICTED: { code: 'PATH_RESTRICTED', nextAction: 'Inspect the target path for the offending entry.', retryable: false },
});

/** 把内层错误折成原装 error 对象的形状（多出 effectState / phase / retryable / nextAction） */
function toCompatError(error, fallbackMessage) {
  const mapped = ERROR_MAP[error && error.code] || {};
  return {
    code: mapped.code || (error && error.code) || 'UNKNOWN',
    message: mapped.message || (error && error.message) || fallbackMessage || 'unknown error',
    phase: 'preflight',
    effectState: 'none',
    retryable: mapped.retryable === true,
    nextAction: mapped.nextAction || 'Correct the request or inspect the manifest.',
  };
}

/**
 * 入参校验：对齐原装 schema（1-32 条、offset >= 1、limit 1..10000）。
 * 原装对非法入参是**整批拒绝**并返回 INVALID_ARGUMENT，不是逐条容错；
 * 兼容层必须一致，否则上层拿到的是"被悄悄纠正过的参数"而不是纠正信号。
 */
function validateCompatInput(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > COMPAT_MAX_FILES) {
    return 'read_files: files must contain 1-32 items';
  }
  for (const f of files) {
    if (typeof f === 'string') { if (f === '') return 'read_files: each item needs a non-empty path string'; continue; }
    if (f === null || typeof f !== 'object' || typeof f.path !== 'string' || f.path === '') {
      return 'read_files: each item needs a non-empty path string';
    }
    if (f.offset !== undefined && (!Number.isInteger(f.offset) || f.offset < 1)) {
      return 'read_files: read_files offset starts at 1 and limit is 1-10000';
    }
    if (f.limit !== undefined && (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > COMPAT_MAX_LIMIT)) {
      return 'read_files: read_files offset starts at 1 and limit is 1-10000';
    }
  }
  return null;
}

/** 只算 JSON 体积，不真的拼字符串（拼 128KB 字符串 ×32 次才是浪费） */
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * 单个文件 -> 原装 item 形状。room 是本文件可用的 JSON 字节额。
 * 放不下整页时按字节前缀二分（不构造中间对象），返回 null 表示一行都放不下。
 */
function compatItem(f, r, room) {
  // 展示路径统一成 POSIX：原生 worker 回的是 Windows 反斜杠，在 JSON 里每个分隔符都变成
  // 两个字节，且与 symbol_map / ptc 的「相对 cwd + POSIX」口径不一致 —— 模型拿回执里的
  // 路径当下一次调用的入参时要跨两套写法。I/O 仍用原始 f.path。
  const shown = f.path.replace(/\\/g, '/');
  if (!r || r.status !== 'success') {
    const e = {
      path: shown, status: 'error', complete: false, items: [],
      error: toCompatError(r && r.error, 'missing result'),
    };
    let bytes = jsonBytes(e);
    // 错误条目没有行可削，此前**完全不看 room** 就直接返回：一条 3000 字符的路径
    // 能让 maxOutputBytes=2048 的调用吐出 6.6KB，预算契约当场失效。
    // 这里按 message 折半缩，把整包拉回预算内。path 本身超预算（极端长路径）时仍然返回 ——
    // 宁可超一点也不能不返回，否则 nextIndex 原地不动，上层按它续读会死循环。
    if (bytes > room) {
      const base = e.error.message;
      let keepLen = base.length;
      while (bytes > room && keepLen > 8) {
        keepLen >>= 1;
        e.error.message = base.slice(0, keepLen) + '…';
        bytes = jsonBytes(e);
      }
    }
    return [e, bytes];
  }

  const page = r.rows || [];
  const total = r.lineCount == null ? page.length : r.lineCount;
  const skeleton = (n) => ({
    path: shown,
    status: 'completed',
    bytes: r.bytes,
    revision: r.revision,
    lineCount: total,
    // 原装语义：complete = "这一页之后没有剩余行了"
    complete: !r.truncated && f.offset + n > total,
    truncated: r.truncated || r.rowsClipped || n < page.length,
    skipped: f.offset - 1,
    omitted: Math.max(0, total - (f.offset - 1) - n),
    matched: total,
    total,
    failed: 0,
    changed: 0,
    phase: 'verify',
    nextOffset: f.offset + n,
  });
  const make = (n) => ({
    ...skeleton(n),
    items: page.slice(0, n).map((text, i) => ({ line: f.offset + i, path: shown, text })),
  });

  // 每行 JSON 字节前缀和：每条一次小 stringify（行级，几 KB），不是整页 128KB。
  // 旧实现按 33+路径字节 估算每行开销，遇到转义密集/中文行会估低 2-4 倍，而修正循环
  // 每退一行就重序列化**整页**：1.2MB 的引号文件实测 38.6ms，比把文件读进来还贵 30 倍。
  const prefix = new Float64Array(page.length + 1);
  for (let i = 0; i < page.length; i++) {
    prefix[i + 1] = prefix[i] + Buffer.byteLength(
      JSON.stringify({ line: f.offset + i, path: shown, text: page[i] }), 'utf8');
  }
  // n 行的精确字节数 = 骨架去掉尾括号 + ',"items":' + 数组本体
  // 数组本体：n=0 是 "[]"；n>=1 是 "[" + 各行 + (n-1) 个逗号 + "]"
  const sizeOf = (n) => Buffer.byteLength(JSON.stringify(skeleton(n)), 'utf8') - 1 + 9
    + (n === 0 ? 2 : prefix[n] + n + 1);

  const full = make(page.length);
  if (sizeOf(page.length) <= room) return [full, jsonBytes(full)];

  let lo = 0;
  let hi = page.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sizeOf(mid) <= room) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // omitted / nextOffset 的数字位数会变，sizeOf 不是严格单调，二分后小幅校正（每步只算骨架）
  while (best > 0 && sizeOf(best) > room) best--;
  while (best < page.length && sizeOf(best + 1) <= room) best++;
  const entry = make(best);
  if (best > 0) {
    const b = jsonBytes(entry);
    return b > room ? null : [entry, b];
  }

  // 一行都放不下（单行 1MB 这类）：按**行内截断**交付前缀，并把 nextOffset 停在原行 ——
  // 对齐原装的 item.nextAction + line.truncatedInLine + bytesOmitted/bytesTotal。
  // 直接返回 0 行会让上层 nextOffset 原地打转、永远拿不到内容，是死循环式的假成功。
  if (page.length === 0) {
    const b = jsonBytes(entry);
    return b > room ? null : [entry, b];
  }
  const lineText = page[0];
  const totalBytes = r.size;
  const build = (n) => {
    const text = cutChars(lineText, n);
    const item = {
      ...make(0),
      complete: false,
      truncated: true,
      omitted: 1,
      nextOffset: f.offset,
      nextAction: 'A line was cut by the output budget. Inspect this file with view=hex and page its 16-byte rows; nextOffset retains the incomplete line, so text paging alone cannot recover its suffix.',
    };
    item.items = [{
      line: f.offset,
      path: shown,
      text,
      truncatedInLine: true,
      bytesOmitted: totalBytes == null ? 0 : Math.max(0, totalBytes - Buffer.byteLength(text)),
      bytesTotal: totalBytes,
    }];
    return item;
  };
  let lo2 = 0;
  let hi2 = lineText.length;
  let bestN = 0;
  while (lo2 <= hi2) {
    const mid = (lo2 + hi2) >> 1;
    if (jsonBytes(build(mid)) <= room) { bestN = mid; lo2 = mid + 1; } else hi2 = mid - 1;
  }
  if (bestN === 0) return null;
  const cut = build(bestN);
  return [cut, jsonBytes(cut)];
}

/**
 * 兼容层：折成原装 dsh-ops `ops_read_files` 的 items 形状，方便原位替换。
 *
 * 原装契约（0.4.1 实测）：
 *   files: [{ path, offset >= 1, limit 1..10000 默认整文件（受 128 KiB 输出预算约束） }]（1-32 条）
 *   -> { status, complete, total, matched, failed, pending, nextIndex, truncated, effectState, items }
 *   items[]: { path, status, bytes, revision, lineCount, complete, truncated, skipped, omitted,
 *              matched, total, failed, changed, phase, nextOffset, items:[{line,path,text}] }
 *
 * 与内层 native 的差异点（全部按实测对齐，不是按文档猜的）：
 *   - text 去掉行尾 \r（CRLF 文件原装给的是 "line1"，不是 "line1\r"）；
 *   - lineCount 不数结尾伪空行（"x\n" × 5 = 5 行）；
 *   - nextOffset = offset + 本次实际返回行数，而不是 offset + limit；
 *   - complete 表示"整个文件都在这一页里"，不是"没报错"；
 *   - ENOENT -> NOT_FOUND，二进制 -> ERR_INVALID_ENCODING，目录 -> INVALID_ARGUMENT；
 *   - revision 用 SHA-256（原装同算法），代价是必须读到 EOF，只在这一层付；
 *   - 输出按 128KiB JSON 字节结算，超预算时**行级削减**并把 nextIndex 指回未返回的文件。
 */
async function readFilesCompat(files, options = {}) {
  const invalid = validateCompatInput(files);
  if (invalid) {
    return {
      status: 'error',
      error: {
        code: 'INVALID_ARGUMENT', message: invalid, phase: 'preflight',
        effectState: 'none', retryable: false, nextAction: 'Correct the request or inspect the manifest.',
      },
    };
  }

  // 入参归一一次，避免并发池和结算各算一遍 offset/limit
  const list = files.map((f) => {
    const o = typeof f === 'string' ? { path: f } : f;
    return {
      path: o.path,
      offset: Math.max(1, Math.floor(o.offset || 1)),
      limit: Math.min(COMPAT_MAX_LIMIT, Math.max(1, Math.floor(o.limit || COMPAT_DEFAULT_LIMIT))),
    };
  });
  // 兼容层比 native 严三处，全部对齐原装实测行为：
  //   strictUtf8 —— 非法 UTF-8 / UTF-16 一律 ERR_INVALID_ENCODING（原装不做有损替换）
  //   allowLinks:false —— symlink / junction 不跟随（原装每级 open_nofollow）
  //   maxFileSize —— 原装**没有** 2MB 上限：3MB / 30MB 文件带 offset/limit 照读（实测 30MB 72ms）。
  //     native 入口保留 2MB 闸门（那是给 AI 直读整篇设计的），但替换路径若有大小限制，
  //     所有 >2MB 的日志 / 构建产物当场变成 INVALID_ARGUMENT —— 这是替换后才会暴露的回归。
  const opts = normalizeOptions({
    strictUtf8: true,
    allowLinks: false,
    ...options,
    stripBom: options.stripBom === true,   // 默认与原装一致：保留 BOM
    normalize: options.normalize === true,  // 默认与原装一致：不清洗，键与正文都逐字节一致
    maxFileSize: options.maxFileSize > 0 ? options.maxFileSize : Number.MAX_SAFE_INTEGER,
    full: true,
    hash: true,
  });
  // 链接检查的批级缓存：32 个文件通常同目录，逐级 lstat 只该付一次
  const linkCache = new Map();
  // 扣掉外层固定字段，保证整包 JSON 不越 128KiB。
  // 下限 2KiB：预算小到连一个空 item 的骨架都放不下时，整批会返回 0 项且 nextIndex 不动，
  // 上层按 nextIndex 续读会原地打转 —— 宁可给一个能推进的最小额度。
  const budget = Math.max(2048, (options.maxOutputBytes > 0 ? options.maxOutputBytes : COMPAT_OUTPUT_BUDGET) - 1024);

  const items = [];
  let used = 0;
  // 分批读：原装"边读边结算、预算满即停"，20×1MB 只读 1 个文件。一次并发 20 个会把
  // 20MB 全读进来，所以首批保守只开 8 个；固定 4 个的代价是 20×2KB 全部放得下时
  // 要跑 5 轮串行 await。自适应：用"已返回项的平均 JSON 字节"反推剩余预算还装得下几个。
  //
  // 上限默认放到 COMPAT_MAX_FILES 而不是 opts.concurrency：这个入口的契约本来就限死 32 个
  // 文件（validateCompatInput 已拦），FD 峰值天然 <= 32，远低于任何系统的 soft limit。
  // 实测 20×2KB 保 10 个上限要 2 轮（0.72ms），放到 20 就 1 轮（0.67ms）。
  // 显式传了 concurrency 就尊重调用方（想要串行就给 1）。
  const maxBatch = Number.isFinite(opts.concurrency) && opts.concurrency > 0
    ? Math.max(1, Math.min(COMPAT_MAX_FILES, opts.concurrency))
    : COMPAT_MAX_FILES;
  let batch = Math.min(maxBatch, 4);
  let cursor = 0;

  outer:
  while (cursor < list.length) {
    if (used >= budget) break;
    const slice = list.slice(cursor, cursor + batch);
    const win = (f) => ({ from: f.offset, to: f.offset + f.limit - 1, maxBytes: budget });
    // slice 的长度已经被 batch 限住（<= 32），这里不需要池：runPool 的 10 个 worker 协程
    // 共享游标换来的只是"限并发"，而并发上限已经由 slice.length 保证。直接 all 省掉
    // 一层闭包 + 游标自增 + 结果回填（实测 20×2KB 再快 6%）。
    const raw = await Promise.all(
      slice.map((f) => readOne(f.path, { ...opts, lineWindow: win(f), linkCache }, Date.now()))
    );

    for (let k = 0; k < slice.length; k++) {
      if (used >= budget) break outer;
      // compatItem 把算好的字节数一起带回来：主循环再 stringify 一次等于把每个文件
      // 序列化两遍（CPU profile 里 jsonBytes 占 12.4%，一半是这次重复）
      const packed = compatItem(slice[k], raw[k], budget - used);
      if (!packed) break outer;                   // 连一行都放不下，留给下一批
      const entry = packed[0];
      items.push(entry);
      used += packed[1];
      if (entry.truncated) break outer;           // 当前文件被削过，预算已到边
    }
    cursor += slice.length;

    if (items.length > 0 && used < budget) {
      const avg = used / items.length;
      batch = Math.max(1, Math.min(opts.concurrency, Math.ceil((budget - used) / avg)));
    }
  }

  const failed = items.filter((i) => i.status !== 'completed').length;
  const truncated = items.some((i) => i.truncated);
  const complete = items.length === list.length && failed === 0 && !truncated && items.every((i) => i.complete);
  const out = {
    status: complete ? 'completed' : 'partial',
    complete,
    total: list.length,
    matched: items.length - failed,     // 原装语义：顶层 matched = 成功返回的文件数，不是条目数
    failed,
    changed: 0,                          // 原装顶层有这个字段（恒 0），缺了会让严格 diff 的上层报字段缺失
    pending: list.length - items.length,
    nextIndex: items.length,
    truncated,
    effectState: 'none',
    phase: 'verify',
    items,
  };
  // 原装只在"没读完"时给顶层 nextAction；completed 时该字段根本不存在
  if (!complete) {
    out.nextAction = "Resume remaining files from nextIndex. Follow each file's nextOffset for more lines; for truncatedInLine use that file's hex inspection guidance.";
  }
  return out;
}


const { readCacheStats: _readCacheStats, readCacheReset: clearReadCache } = require('./lib/read-one');

// Named `exports.x` assignments rather than `module.exports = { ... }`: the object form makes
// cjs-module-lexer publish a spurious `module.exports` key to ESM importers.
exports.parallelRead = parallelRead
exports.ops_parallel_read = parallelRead
exports.readFilesCompat = readFilesCompat
exports.ops_read_files = readFilesCompat
exports.runPool = runPool
exports.truncate = truncate
exports.OpsError = OpsError
exports.DEFAULTS = DEFAULTS
exports.TRUNCATED_MARK = TRUNCATED_MARK
exports.readCacheStats = _readCacheStats
exports.clearReadCache = clearReadCache
