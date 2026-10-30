'use strict';

/**
 * 路径闸门：Windows 路径分量校验 + root 围栏 + 重解析点（symlink / junction）拒绝。
 *
 * 为什么拆出来：这一整块是**纯策略**，只依赖 fs/path 与 OpsError，不碰并发池、不碰预算、
 * 不碰解码 —— 和读取引擎的生命周期完全正交。留在主文件里会让"怎么读一个文件"和
 * "哪些路径不许读"混在一条 1159 行的流水线上；拆开后，这套校验可以单独被审、单独被复用，
 * 主文件只剩读取主流程。函数体、常量、报错消息全部原样搬移，一个字符没改。
 */

const fsp = require('fs').promises;
const path = require('path');
const { OpsError } = require('./errors');

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

module.exports = {
  RESERVED_NAMES,
  ILLEGAL_CHARS,
  SUSPECT_PATH,
  validateName,
  validatePath,
  resolveTarget,
  fenceRealPath,
  LINK_DENIED,
  dirLinkCheck,
  assertParentDirs,
  startLeafCheck,
};
