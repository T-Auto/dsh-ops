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
 *
 * 本文件只留读取主引擎（池 / 闸门 / 解码 / 预算），其余三块按内聚性拆到同级模块：
 *   - errors.js      OpsError（paths 与主引擎共用，下沉到最底层以免反向依赖）
 *   - paths.js       Windows 路径校验 / root 围栏 / 重解析点拒绝
 *   - read-cache.js  跨调用 LRU 缓存（进程级生命周期，与单批读取无关）
 *   - compat.js      原装 dsh-ops `ops_read_files` 兼容层（由本文件注入读取原语）
 * 依赖单向：errors/paths/read-cache -> 本文件 -> compat。尾部 module.exports 的键名与顺序
 * 与拆分前逐字一致（含 `ops_read_files` 别名、`readCacheStats`、`clearReadCache`）。
 */

const fsp = require('fs').promises;
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const { OpsError } = require('./errors');
const {
  resolveTarget,
  fenceRealPath,
  assertParentDirs,
  startLeafCheck,
  LINK_DENIED,
} = require('./paths');
const { readCacheGet, readCacheSet, readCacheStats, clearReadCache } = require('./read-cache');
const { createCompat } = require('./compat');

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

// 兼容层需要主引擎的读取原语；注入而不是让它反向 require 本文件（否则成环）
const { readFilesCompat } = createCompat({ readOne, normalizeOptions, cutChars });

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
  clearReadCache,
};
