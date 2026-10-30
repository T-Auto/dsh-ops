'use strict';

/**
 * 跨调用读取缓存（进程内 LRU）：命中判断、容量回收、命中统计。
 *
 * 为什么拆出来：它的生命周期是**进程级**的，和单次并行读完全无关 —— 一个批次的池、deadline、
 * 预算都不影响它，反过来它也不参与任何一条读取闸门。留在主文件里，读者会误以为缓存的
 * 失效依赖某次调用；单独成文件后，"什么时候能命中"（键里带 dev:ino:size:mtime + 全部影响
 * 正文的开关）成了一个可以独立审的契约。逻辑与常量原样搬移。
 */

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

/** 清空缓存与命中统计（测试 / 长驻进程的手动回收口） */
function clearReadCache() {
  readCache.clear();
  readCacheChars = 0;
  readCacheHits = 0;
  readCacheMisses = 0;
}

module.exports = {
  READ_CACHE_MAX_ENTRIES,
  READ_CACHE_MAX_CHARS,
  readCacheGet,
  readCacheSet,
  readCacheStats,
  clearReadCache,
};
