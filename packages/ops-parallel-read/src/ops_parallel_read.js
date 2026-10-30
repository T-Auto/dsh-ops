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

/** 默认参数：调用方按需覆盖 */
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
const RESERVED_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$']);
const ILLEGAL_CHARS = /[:*?<>|"]/;

function validateName(name) {
  if (name === '') return;
  if (name.includes('\u0000')) throw new OpsError('INVALID_PATH', `Invalid path component ${JSON.stringify(name)}`);
  if (name === '.' || name === '..') return;
  if (process.platform !== 'win32') return;
  const base = name.split('.')[0].trimEnd().toUpperCase();
  const port = base.startsWith('COM') || base.startsWith('LPT') ? base.slice(3) : null;
  if (
    name.endsWith('.') || name.endsWith(' ') ||
    ILLEGAL_CHARS.test(name) ||
    RESERVED_NAMES.has(base) ||
    (port !== null && /^[1-9¹²³]$/.test(port))
  ) {
    throw new OpsError('INVALID_PATH', `Reserved, ambiguous or device path component ${JSON.stringify(name)}`);
  }
}

/**
 * 快速排除：99% 的路径在这一次正则里就判定"干净"，不做分割与逐段判断。
 * 命中任何可疑形状（冒号、非法字符、设备名、尾点/尾空格）才走慢路径精确判定 ——
 * 慢路径会给出确切的分量名，快路径只需要回答"有没有可能有问题"。
 */
const SUSPECT_PATH = /[:*?<>|"\u0000]|(^|[\\/])(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|[\\/]|$)|[. ][\\/]|[. ]$/i;

/** 逐分量校验；盘符（`K:`）作为第一段放过，其余走 validateName */
function validatePath(raw) {
  let s = String(raw);
  // canonicalize / 超长路径会给出 verbatim 形式：`\\?\K:\...`、`\\?\UNC\srv\shr\...`。
  // 原装把这两种归一后接受，`\\.\`（设备）一律拒绝 —— 跟着做。
  if (s.startsWith('\\\\?\\')) {
    const rest = s.slice(4);
    if (/^UNC[\\/]/i.test(rest)) s = '\\\\' + rest.slice(4);
    else if (/^[A-Za-z]:/.test(rest)) s = rest;
    else throw new OpsError('INVALID_PATH', 'Device and verbatim paths are unsupported');
  } else if (s.startsWith('\\\\.\\')) {
    throw new OpsError('INVALID_PATH', 'Device and verbatim paths are unsupported');
  }
  if (process.platform !== 'win32' || !SUSPECT_PATH.test(s)) return;
  const parts = s.split(/[\\/]+/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0 && /^[A-Za-z]:$/.test(part)) continue;
    validateName(part);
  }
}

/**
 * 路径围栏（opt-in）。传了 root 时：
 *   - 相对路径按 root 解析；
 *   - 绝对路径必须落在 root 内；
 *   - 越界返回 ESCAPE_ROOT，而不是靠上层自己记得校验。
 * path.relative 对 win32 的大小写与盘符差异已经做过归一，无需自己拼字符串。
 */
function resolveTarget(filePath, root) {
  validatePath(filePath);
  if (!root) return filePath;
  const base = path.resolve(root);
  const target = path.resolve(base, filePath);
  const rel = path.relative(base, target);
  // 越界只有三种形状：'..'、'..' + 分隔符 开头、或绝对路径（跨盘符）。
  // rel 为空表示目标就是 root 自身 —— 那是围栏内，让它落到 fstat 去报 NOT_A_FILE，
  // 别用 ESCAPE_ROOT 撒谎。也不能写 startsWith('..')：root 下名为 '..foo' 的合法子目录
  // 会算出 rel='..foo'，被误杀成越界（Windows 上 '..foo' 是合法目录名）。
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new OpsError('ESCAPE_ROOT', `路径越出 root 围栏：${filePath}`);
  }
  return target;
}

/**
 * 重解析点复核（仅 root 模式）。
 *
 * 词法围栏（path.resolve + path.relative）看不穿 symlink / junction：root 下放一个指向
 * 栏外的目录联接，算出来的 rel 是 'link/secret.txt'，看着在栏内，实际读到栏外。
 * 这里把真实路径再判一次，并且**用真实路径去 open** —— 判的和开的必须是同一个东西。
 * root 的 realpath 每批只算一次（记忆在 opts 上），单文件只多一次 syscall。
 */
async function fenceRealPath(target, root, opts) {
  if (!opts.rootReal) {
    opts.rootReal = fsp.realpath(path.resolve(root));
    opts.rootReal.catch(() => {});     // 失败时不让它变成 unhandledRejection，下次调用会重算
  }
  const realRoot = await opts.rootReal;
  const realTarget = await fsp.realpath(target);
  const rel = path.relative(realRoot, realTarget);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new OpsError('ESCAPE_ROOT', `路径越出 root 围栏（重解析点指向栏外）：${target}`);
  }
  return realTarget;
}

/**
 * 重解析点拒绝（兼容层默认开，对齐原装 Rust `regular()` 的 open_nofollow）。
 *
 * junction 能把 'repo/link/secret.txt' 拼成一个词法上完全合法的路径，读到的却是栏外文件，
 * 而目录联接在 Windows 上不需要管理员权限就能建 —— 原装因此对每一级都做 symlink_metadata。
 * 这里同样逐级验证，但把代价压到最低：目录链走批级缓存，叶子与 open 并发。
 */
const LINK_DENIED = 'Links, reparse points and special objects are not traversed; inspect the target path for the offending entry';

/** 目录链校验：缓存的是**进行中的 promise**，不是结果。
 *  20 个文件同目录时，若只缓存布尔结果，它们会在缓存填好之前各自 lstat 一遍
 *  同一条目录链（实测 20×5=100 次）；缓存 promise 之后整批只付 5 次。 */
function dirLinkCheck(dir, cache) {
  let p = cache.get(dir);
  if (!p) {
    p = fsp.lstat(dir).then((st) => {
      if (st.isSymbolicLink()) throw new OpsError('PATH_RESTRICTED', LINK_DENIED);
    });
    p.catch(() => {});                     // 主流程可能已经失败退出，别让缓存里的 rejection 冒泡
    cache.set(dir, p);
  }
  return p;
}

async function assertParentDirs(target, opts) {
  const cache = opts.linkCache || (opts.linkCache = new Map());
  const dirs = [];
  let dir = path.dirname(target);
  for (;;) {
    dirs.push(dir);
    if (cache.has(dir)) break;
    const up = path.dirname(dir);
    if (up === dir) break;                 // 到盘符根：它自己也要验一次
    dir = up;
  }
  await Promise.all(dirs.map((d) => dirLinkCheck(d, cache)));
}

/**
 * 叶子校验：与 open 并发发起，不额外占墙钟时间。
 * open 本来就要一次 syscall（几十微秒），lstat 挤在同一个窗口里完成；
 * 句柄已拿到但 lstat 说是链接时，由 finally 关掉再抛。
 */
function startLeafCheck(target) {
  const p = fsp.lstat(target);
  p.catch(() => {});                       // 主流程可能先抛，别让它变成 unhandledRejection
  return p;
}

/** 数一段文本里的换行数（full 模式算 lineCount，不需要留存全文） */
function countNewlines(text) {
  let n = 0;
  let i = -1;
  while ((i = text.indexOf('\n', i + 1)) !== -1) n++;
  return n;
}

/** 按字符切，且不劈开代理对（半截 emoji 会变成两个替换符） */
function cutChars(text, max) {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** 智能截断：截断时补标记，标记本身不计入 maxChars（由调用方决定预算口径） */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return { content: text, truncated: false };
  return { content: cutChars(text, maxChars) + TRUNCATED_MARK, truncated: true };
}

/**
 * open 带 FD 耗尽退避。
 *
 * 并发的意义是把 10 个 open 压进一个窗口，副作用是宿主进程本来就紧张时更容易撞 EMFILE。
 * 撞上就立刻失败等于"防 FD 耗尽"这件事防了个寂寞，所以重试两次、退避 8/16ms。
 */
async function openWithRetry(target, opts, guard, deadline, isAbandoned) {
  for (let attempt = 0; ; attempt++) {
    try {
      const pending = fsp.open(target, 'r');
      // race 输给超时之后，open 仍会在几百毫秒后带着一个句柄落地。没人接就是泄漏一个 FD，
      // 反复调用能把进程的 FD 表磨干 —— 正是本工具声称要防的那件事。
      // close 本身失败（句柄已被系统回收 / 网络盘断开）没有可行动作，吞掉是为了不让
      // 一个"清理失败"变成 unhandledRejection 打崩调用方；泄漏与否由 FD 计数用例兜底。
      pending.then((h) => { if (isAbandoned()) h.close().catch(() => {}); }, () => {});
      return await guard(pending);
    } catch (err) {
      const retryable = err.code === 'EMFILE' || err.code === 'ENFILE' || err.code === 'EBUSY';
      if (!retryable || attempt >= opts.maxOpenRetries) throw err;
      if (deadline - Date.now() <= 0) throw new OpsError('TIMEOUT', '重试期间耗尽总预算');
      await sleep(8 * (attempt + 1));   // 让其它协程先把 FD 还回来
    }
  }
}

/**
 * 跨调用读取缓存（LRU，进程内）。
 *
 * 同一文件在一次会话里被读两遍是常态（读一次、改一次、再读一次确认），而每次都重新付
 * open + fstat + read + 解码 + SHA-256 + 切行。open 与 fstat 必须每次都付 —— 它们是"这个
 * 文件现在是什么"的唯一凭据；能省的是它们之后那段，也就是真正贵的部分。
 *
 * 键里带着 dev:ino:size:mtime 与全部影响正文的开关（full/hash/normalize/stripBom/strictUtf8、
 * 行窗口、字符额度）。inode 拿不到（部分网络盘报 0）就不缓存 —— 没有身份就没有命中判断，
 * 宁可慢也不能给出旧正文。
 */
const READ_CACHE_MAX_ENTRIES = 64;
const READ_CACHE_MAX_CHARS = 8 << 20;
const readCache = new Map();
let readCacheChars = 0;
let readCacheHits = 0;
let readCacheMisses = 0;

function readCacheGet(key) {
  const hit = readCache.get(key);
  if (hit === undefined) {
    readCacheMisses++;
    return undefined;
  }
  // LRU：命中即挪到队尾
  readCache.delete(key);
  readCache.set(key, hit);
  readCacheHits++;
  return hit.value;
}

function readCacheSet(key, value) {
  const chars = (value.content ? value.content.length : 0)
    + (value.rows ? value.rows.reduce((n, row) => n + row.length, 0) : 0);
  if (chars > READ_CACHE_MAX_CHARS) return;      // 单个巨块不值得占着窗口
  readCache.set(key, { value, chars });
  readCacheChars += chars;
  while (readCache.size > READ_CACHE_MAX_ENTRIES || readCacheChars > READ_CACHE_MAX_CHARS) {
    const oldest = readCache.keys().next();
    if (oldest.done) break;
    readCacheChars -= readCache.get(oldest.value).chars;
    readCache.delete(oldest.value);
  }
}

function readCacheStats() {
  return { entries: readCache.size, chars: readCacheChars, hits: readCacheHits, misses: readCacheMisses };
}

/** 单文件读取（async 路径）：open -> fstat -> 分块读（边解码边判闸门）。
 *
 * 三个结构要点：
 *   a) 不 stat + open 各解析一次路径，改成 open 后 handle.stat()。fstat 落在已打开的 FD 上，
 *      路径被换掉也拿不到错的 size。
 *   b) 不"先探测 4KB 再读满 2MB 再截断"，改成边读边解码，字符数到上限就停。
 *   c) **全链路只用一个 deadline、一个 timer**。上一版 open/fstat/read 各一个 withTimeout，
 *      20 个文件实测建 80 个 timer；现在 1 个 deadline + 1 个 close 兜底 = 40 个。
 *      超时靠共享的 expired promise 在任何 await 处立刻炸，不靠每段重新计时。
 */
async function readOne(filePath, opts, startedAt) {
  const deadline = startedAt + opts.timeoutMs;
  // 键与结果里的 path 同源：normalize 时统一 POSIX，否则原样回写（兼容层要逐字节一致）
  const base = emptyResult(opts.normalize ? filePath.replace(/\\/g, '/') : filePath);

  let timer = null;
  let abandoned = false;                // 计时器打穿后，晚到的句柄要由 openWithRetry 关掉
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      abandoned = true;
      reject(new OpsError('TIMEOUT', `超出 ${opts.timeoutMs}ms 总预算`));
    }, Math.max(1, opts.timeoutMs));
  });
  timeout.catch(() => {});              // 超时后不再有人 await 它，先挂空 catch 防 unhandledRejection

  // 取消也要能打断**进行中**的 open/read：只在每个 chunk 边界查 aborted 时，
  // 一个挂在坏盘上的 open 会把"已取消"拖到 timeoutMs 才生效。
  // 注意 listener 必须在 finally 摘掉，否则同批 20 个文件往同一个 signal 上挂 20 个闭包。
  const signal = opts.signal;
  let onAbort = null;
  const aborted = signal && typeof signal.addEventListener === 'function'
    ? new Promise((_, reject) => {
      onAbort = () => { abandoned = true; reject(new OpsError('ABORTED', '调用方已取消本批次')); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    })
    : null;
  if (aborted) aborted.catch(() => {});          // 文件先读完时这个 rejection 没人 await

  const guard = (p) => {
    p.catch(() => {});                  // race 输掉的那一方也必须有人接住
    return aborted ? Promise.race([p, timeout, aborted]) : Promise.race([p, timeout]);
  };

  let handle;
  try {
    if (opts.signal && opts.signal.aborted) throw new OpsError('ABORTED', '调用方已取消本批次');

    // 1) 开句柄：之后所有元数据都从这个 FD 拿，不再二次解析路径
    const target = resolveTarget(filePath, opts.root);
    // 传了 root 才付这次 realpath：词法检查拦 '../'，真实路径检查拦 symlink / junction
    const opened = opts.root ? await guard(fenceRealPath(target, opts.root, opts)) : target;
    let leafStat = null;
    if (!opts.allowLinks) {
      await guard(assertParentDirs(opened, opts));   // 目录链：批级缓存
      leafStat = startLeafCheck(opened);             // 叶子：与 open 同一个 syscall 窗口
    }
    handle = await openWithRetry(opened, opts, guard, deadline, () => abandoned);
    if (leafStat) {
      leafStat = await guard(leafStat);
      if (leafStat.isSymbolicLink()) throw new OpsError('PATH_RESTRICTED', LINK_DENIED);
    }

    // 2) 大小闸门（fstat）：先拦后读，2MB 以上的文件一个字节都不读
    const stat = await guard(handle.stat());
    // lstat 与 open 是并发的：两者之间把普通文件换成链接，lstat 仍说"普通"，而 open 已经
    // 跟到栏外。句柄的身份（dev+ino）与 lstat 的身份不一致，就是那次替换。关句柄由 finally
    // 负责；这一判等价于原装 open_nofollow 的原子性，不额外付 syscall（两个 stat 本来就有）。
    if (leafStat && leafStat.ino !== 0 && stat.ino !== 0
        && (stat.ino !== leafStat.ino || stat.dev !== leafStat.dev)) {
      throw new OpsError('PATH_RESTRICTED', LINK_DENIED + ' (replaced between check and open)');
    }
    if (!stat.isFile()) throw new OpsError('NOT_A_FILE', '不是普通文件（目录 / 设备 / 管道）');
    base.size = stat.size;
    base.mtimeMs = Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null;
    if (stat.size > opts.maxFileSize) {
      throw new OpsError('FILE_TOO_LARGE', `文件 ${stat.size} 字节，超过上限 ${opts.maxFileSize} 字节，已拒绝读取`);
    }

    // 3) 分块读 + 边解码边判闸门
    //    行窗口模式（兼容层）：只留 [from,to] 行，正文不进内存
    //    —— 20×1MB 实测堆占用 28.6MB → 1.6MB
    const win = opts.lineWindow || null;
    const rows = win ? [] : null;
    const winMaxBytes = win && win.maxBytes > 0 ? win.maxBytes : 0;
    let winBytes = 0;
    let rowsClipped = false;
    let winStop = 0;                     // 本页的终止行号：页内行必须是从 from 起的稠密前缀
    let carry = '';
    let lineNo = 0;

    let text = '';
    let bytes = 0;
    let position = 0;
    let lineBreaks = 0;
    let lastChar = '';
    let truncated = false;
    let textCut = false;                // 正文真的被 keep 切掉过（区别于"字节读完了"）
    let decoder = null;                 // 首块见过 BOM 之后再建
    let enc = opts.encoding;
    let nulGate = true;                 // UTF-16 天然含 NUL，命中 BOM 后关掉这道闸
    // native 模式：单文件能交付多少字符；full 模式：留多少正文用于切行
    const keep = opts.full ? opts.maxChars : Math.min(opts.maxChars, opts.maxTotalChars);

    // 3.5) 缓存命中：身份（dev:ino:size:mtime）+ 所有影响正文的开关都进键，
    //      所以命中即等价于"同样的字节、同样的窗口、同样的开关"。
    const cacheKey = stat.ino !== 0
      ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}|${opts.full ? 1 : 0}${opts.hash ? 1 : 0}${opts.normalize ? 1 : 0}${opts.stripBom ? 1 : 0}${opts.strictUtf8 ? 1 : 0}|${keep}|${win ? `${win.from}:${win.to}:${win.maxBytes}` : '-'}`
      : null;
    if (cacheKey !== null) {
      const cached = readCacheGet(cacheKey);
      if (cached !== undefined) {
        return { ...base, status: 'success', ...cached, elapsedMs: Date.now() - startedAt };
      }
    }
    // 摘要必须是"整个文件"的摘要。早停模式下哈希只覆盖前缀，产出的 revision 会被上层
    // 当成内容指纹做 CAS 判旧，错得无声无息 —— 所以 hash 只在读到 EOF 的 full 模式生效。
    const hasher = opts.hash && opts.full ? crypto.createHash('sha256') : null;
    // 整文件只分配一次缓冲；超时后该缓冲被遗弃，不会被下一次 read 复用。
    // 长度至少 3 字节：BOM 判定（UTF-8 是 3 字节）必须能在一块内看全，否则 chunkBytes=1/2 时
    // BOM 跨块 —— U+FEFF 会漏进首行，UTF-16 会被 NUL 闸误杀成二进制。
    const buf = Buffer.allocUnsafe(Math.max(3, Math.min(opts.chunkBytes, Math.max(1, stat.size))));

    /** 喂一段已解码文本：窗口模式只记行号与命中行，非窗口模式累积正文 */
    const feed = (piece) => {
      if (piece.length === 0) return;
      lastChar = piece[piece.length - 1];        // 末尾有没有换行，决定 lineCount 要不要 +1
      if (!win) {
        if (opts.full) lineBreaks += countNewlines(piece);
        if (textCut) return;                        // 配额已满：后续只喂行数/摘要，不再拼正文
        const room = keep - text.length;
        // 判据是"这一块比剩余配额长"。注意 textCut 置位后必须一直保留判断，
        // 否则块很小时（chunkBytes=1）正文满了却不再报截断，还会把整个文件白读完。
        if (piece.length > room) {
          textCut = true;
          text += cutChars(piece, room);
        } else {
          text += piece;
        }
        return;
      }
      let start = 0;
      for (;;) {
        const nl = piece.indexOf('\n', start);
        if (nl === -1) break;
        lineNo++;
        if (winStop === 0 && lineNo >= win.from && lineNo <= win.to) {
          // carry 只在"当前行落在窗口内"时累积，窗口外的巨行不会把内存吃掉
          const line = carry.length > 0 ? carry + piece.slice(start, nl) : piece.slice(start, nl);
          // 窗口行总字节封顶在输出预算：超了也送不到上层，多留纯属浪费堆
          if (winMaxBytes && winBytes + line.length > winMaxBytes && rows.length > 0) {
            // **一旦削行，本页立即定界**。此前只是跳过这一行、后面的小行继续往里塞，
            // 结果 page 变成"有洞"的数组；而上层拿到的行号是 offset+i 算出来的稠密编号，
            // 于是巨行之后每一行都被报成前一行号（实测 400KB 行之后整体错位 1 行，
            // 巨行内容则彻底丢失）。定界后 rows 恒为 [from, nextOffset) 的稠密前缀。
            rowsClipped = true;
            winStop = lineNo;
          } else {
            rows.push(line.charCodeAt(line.length - 1) === 13 ? line.slice(0, -1) : line);
            winBytes += line.length;
          }
        }
        carry = '';
        start = nl + 1;
      }
      // 未闭合的尾部：只在页未定界时继续累积，且"这一整行"超预算就当场定界。
      // 不这么做的话，巨行会被截成「前半段 + 最后一块」拼起来当作完整行交付（内容中间缺一段）。
      if (start < piece.length && winStop === 0 && lineNo + 1 >= win.from && lineNo + 1 <= win.to) {
        const rest = piece.length - start;
        if (winMaxBytes && winBytes + carry.length + rest > winMaxBytes && rows.length > 0) {
          rowsClipped = true;
          winStop = lineNo + 1;
        } else {
          carry += piece.slice(start);
        }
      }
    };

    while (bytes < stat.size) {
      if (opts.signal && opts.signal.aborted) throw new OpsError('ABORTED', '调用方已取消本批次');

      const cap = Math.min(buf.length, stat.size - bytes);
      const { bytesRead } = await guard(handle.read(buf, 0, cap, position));
      if (bytesRead === 0) break;                 // 文件被并发截短
      // 判定要对 buf.length，不是 cap。最后一次读通常 cap < buf.length（文件大小不是块大小的整数倍），
      // 用 cap 判定会把整块 buf 当成新数据，把上一块的尾部重新解码一遍 —— 100000 字节文件实测
      // 末尾多解 34464 字节，直接导致内容重复 + 假截断。
      const view = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
      bytes += bytesRead;
      position += bytesRead;
      if (hasher) hasher.update(view);            // 摘要按原始字节算，含 BOM，和原装 revision 同源

      let body = view;
      if (decoder === null) {
        // 4) 解码闸门：BOM 优先于调用方的 encoding
        if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
          if (opts.stripBom) body = body.subarray(3);   // 兼容层不剥：返回文本必须与磁盘逐字节一致
        } else if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
          // 严格模式（兼容层）只接受 UTF-8：UTF-16 原装报 ERR_INVALID_ENCODING，
          // 而且放它过去更危险 —— 上层 ops_edit_file 按 UTF-8 回写会把整个文件写坏。
          if (opts.strictUtf8) throw new OpsError('INVALID_UTF8', 'File is not valid UTF-8');
          enc = 'utf16le'; nulGate = false; body = body.subarray(2);   // Windows 的 Unicode 文本
        } else if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
          throw new OpsError(opts.strictUtf8 ? 'INVALID_UTF8' : 'UNSUPPORTED_ENCODING',
            opts.strictUtf8 ? 'File is not valid UTF-8' : '检测到 UTF-16BE BOM，暂不支持；请先转成 UTF-8');
        }
        // 严格模式用 fatal TextDecoder：非法字节当场抛，而不是塞一堆 U+FFFD 进上下文。
        // 它自带跨块缓冲，UTF-8 被切成半截序列也不会误判（StringDecoder 不做合法性检查）。
        // ignoreBOM 必须显式 true：TextDecoder 默认会自己再剥一次 BOM，与上面的 subarray(3)
        // 叠加成"剥两层" —— 双 BOM 文件在兼容层被吃掉两个 U+FEFF，而 native 只吃一个。
        decoder = opts.strictUtf8
          ? new TextDecoder(enc, { fatal: true, ignoreBOM: true })
          : new StringDecoder(enc);
      }

      // 5) 二进制闸门：解码窗口内出现 NUL 即判二进制，绝不按 utf-8 吐几百万乱码
      if (nulGate && body.includes(0)) {
        throw new OpsError('BINARY_FILE', `前 ${bytes} 字节内检测到 NUL，判定为二进制文件，拒绝按文本返回`);
      }

      try {
        feed(opts.strictUtf8 ? decoder.decode(body, { stream: true }) : decoder.write(body));
      } catch (err) {
        if (opts.strictUtf8 && err && err.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
          throw new OpsError('INVALID_UTF8', 'File is not valid UTF-8');
        }
        throw err;
      }

      // 6) 单文件截断：字符配额真被切掉就停手，尾部压根不读 —— 这是 2MB 文件不拖慢整批的关键。
      //    判据是 textCut 而不是 text.length >= keep：文件小于一个 chunk 时一次就读到 EOF，
      //    此时 bytes == stat.size，但字符照样可能被 keep 砍掉（60,000 字符的文件读成 50,000）。
      //    只看字节就会把这种真截断报成 truncated=false。
      if (!opts.full && !win && textCut) { truncated = true; break; }
      // 注意不把"短读"当 EOF：SMB / 网络盘会返回不满的读，短读即停会把文件悄悄读半截。
      // 退出条件只看 bytes >= stat.size 或 bytesRead === 0。
    }

    let tail = '';
    if (decoder) {
      try {
        tail = opts.strictUtf8 ? decoder.decode() : decoder.end();   // 冲掉残留的半截序列
      } catch (err) {
        if (opts.strictUtf8 && err && err.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
          throw new OpsError('INVALID_UTF8', 'File is not valid UTF-8');
        }
        throw err;
      }
    }
    if (tail.length > 0) feed(tail);
    if (win && lastChar && lastChar !== '\n') {  // 末行没有换行符
      lineNo++;
      if (winStop === 0 && carry.length > 0 && lineNo >= win.from && lineNo <= win.to) {
        // 只有被 '\n' 结束的行才剥 '\r'（那是 CRLF 的一半）。文件末尾孤零零一个 '\r'
        // 是内容本身：原装给 "a\rb\rc\r"，上层的 diff / 编辑都按这个原文算。
        rows.push(carry);
      }
    }

    // 跨平台清洗：CRLF → LF。先探再换 —— 纯 LF 文件零分配；1.5MB 有 CR 时 2.15ms，
    // 不探直接 replace 是 4.97ms（2.3×），因为 V8 对无命中 replace 有快速路径但正则仍要建栈。
    // 放在截断之后、补标记之前：标记自身含 \n，先归一不会把它切出半个 \r。
    if (opts.normalize && text.indexOf('\r') !== -1) text = text.replace(/\r\n/g, '\n');

    // full 模式为了 lineCount / 摘要必须读完整个文件，但正文一样会被 keep 砍掉。
    // 此前只有"提前 break"那条路会置 truncated，full 模式读满 80000 字符只回 50000
    // 却报 truncated=false —— 上层拿到半截内容当成完整，与 native 早停是同源的静默错误。
    if (!win && textCut) truncated = true;
    // 停读时正文已按 keep 切齐，这里只补标记；不能走 truncate()，恰好切在 keep 上时它不补标记
    if (truncated) text += TRUNCATED_MARK;

    const payload = {
      status: 'success',
      content: text,
      truncated,
      bytes,
      // 二进制闸门与解码闸门覆盖的字节数。早停时它 < size —— 上层据此知道
      // "这只是一段前缀，且前缀之后的内容没做 NUL 判定"，而不是把 truncated 当前缀长度看。
      scannedBytes: bytes,
      rows,
      rowsClipped,
      // 行数只对"读到 EOF"的 full 模式有意义；native 模式提前停读，报 null 而不是报错数
      lineCount: win ? lineNo : (opts.full ? lineBreaks + (lastChar && lastChar !== '\n' ? 1 : 0) : null),
      revision: hasher ? hasher.digest('hex') : null,
      elapsedMs: Date.now() - startedAt,
    };
    // 只缓存"成功且未被取消"的读：取消是调用方的事，不该把一个半成品留给下一次调用。
    if (cacheKey !== null && !(signal && signal.aborted)) {
      const { elapsedMs, ...rest } = payload;
      readCacheSet(cacheKey, { ...rest, rows: rest.rows ? rest.rows.slice() : rest.rows });
    }
    return { ...base, ...payload };
  } catch (err) {
    return {
      ...base,
      error: { code: err.code || err.name || 'UNKNOWN', message: err.message || String(err) },
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    if (signal && onAbort && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort);
    }
    // 无论成败、无论超时，FD 一定回收 —— 这正是本工具存在的理由。
    // close 自身也可能卡在同一块坏盘上：给它上限，超过就放手（FD 由进程回收），
    // 否则一个坏文件能拖住整批，比泄漏一个句柄更糟。
    if (handle) {
      const remaining = deadline - Date.now();
      const capMs = remaining > 0 ? Math.min(opts.closeMs, remaining) : 1;
      // 这个 timer 必须显式清掉：正常路径 close 只要几微秒，但 Promise.race 不会取消输家，
      // 不清就会留一个 100ms 的 timer 在堆里 —— 20 个文件 20 个，白白占着 libuv 的 timer 堆。
      let ct = null;
      const cap = new Promise((resolve) => { ct = setTimeout(resolve, capMs); if (ct.unref) ct.unref(); });
      try {
        // close 失败同样没有可行动作（句柄可能已被回收），吞掉只影响这一处；
        // 真正要防的是 close 卡死，那由上面的 cap 计时器解决。
        await Promise.race([handle.close().catch(() => {}), cap]);
      } finally {
        clearTimeout(ct);
      }
    }
  }
}
/**
 * 对外入口。
 *
 * @param {string[]} filePaths              待读文件路径数组
 * @param {object}   [options]              覆盖 DEFAULTS 的任意字段
 * @returns {Promise<Object<string, {path:string,status:'success'|'error',content:string|null,
 *                                   error:{code:string,message:string}|null,truncated:boolean,
 *                                   size:number|null,bytes:number|null,mtimeMs:number|null,
 *                                   lineCount:number|null,revision:string|null,elapsedMs:number}>>}
 */
/** 参数兜底：并发至少 1，阈值 <= 0 视为非法并回落到默认（两处入口共用一份，避免漂移） */
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
// 4.1.5：默认不再按 200 行截断。200 行是原装的静默上限，270 行的文件因此少 70 行
// 且 status 仍是 complete —— 模型看不到 nextOffset 提示就会漏内容，或者多花一轮补读。
// 现在缺省 limit = COMPAT_MAX_LIMIT，真正的闸门只剩输出预算（128 KiB JSON）。
const COMPAT_DEFAULT_LIMIT = COMPAT_MAX_LIMIT;

/**
 * 原装的输出预算是 **JSON 字节** 128 KiB，策略是：
 *   按输入顺序累加，超预算时把"当前文件"按行削到刚好放得下，然后停；
 *   nextIndex = 已返回的文件数，pending = 剩余文件数。
 * 实测 20×16KB：返回 3 项 / 第 3 项 169 行（共 186）/ 响应体 98293 字节。
 * 上一版直接套用 native 的字符预算，结果第 9 个文件起整条 BUDGET_EXHAUSTED、
 * 第 8 个文件静默少 129 行且 nextIndex 恒等于 20（上层无法续读）——这是真缺陷。
 */
const COMPAT_OUTPUT_BUDGET = 128 * 1024;

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

module.exports = {
  parallelRead,
  ops_parallel_read: parallelRead,
  readFilesCompat,
  ops_read_files: readFilesCompat,   // 原名别名：替换 dsh-ops 时调用点不用改
  runPool,
  truncate,
  OpsError,
  DEFAULTS,
  TRUNCATED_MARK,
  readCacheStats,
  clearReadCache: () => { readCache.clear(); readCacheChars = 0; readCacheHits = 0; readCacheMisses = 0; },
};
