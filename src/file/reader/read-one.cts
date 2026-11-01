// @ts-nocheck — ported from the shipped 4.1.8 reader as-is: the runtime is unchanged, the types
// are the open work. Tracked in docs/CHANGELOG.md under Unreleased.
'use strict';

const fsp = require('fs').promises;
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const { DEFAULTS, TRUNCATED_MARK, OpsError, emptyResult, sleep } = require('./core.cjs');
const { resolveTarget, fenceRealPath, LINK_DENIED, assertParentDirs, startLeafCheck } = require('./path-safety.cjs');
const { countNewlines, cutChars, truncate } = require('./text.cjs');

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

function readCacheReset() {
  readCache.clear();
  readCacheChars = 0;
  readCacheHits = 0;
  readCacheMisses = 0;
}

module.exports = { openWithRetry, readCacheGet, readCacheSet, readCacheStats, readCacheReset, readOne };
