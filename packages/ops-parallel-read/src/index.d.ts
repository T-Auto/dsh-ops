/**
 * ops-parallel-read 类型声明。零依赖，手写，不依赖 @types/node。
 */

/** 单文件结果：成功与失败共用一套字段，读代码的人不用先判分支再看字段 */
export interface ReadEntry {
  /** 输入原样回写的路径（未 resolve） */
  path: string;
  status: 'success' | 'error';
  /** 成功时的文本；已按 maxChars 截断并附带 TRUNCATED_MARK */
  content: string | null;
  error: { code: string; message: string } | null;
  /** 内容是否被截断（读取阶段早停，或渲染阶段按全局预算二次切） */
  truncated: boolean;
  /** fstat 得到的字节数；打不开时为 null */
  size: number | null;
  /** 实际读入的字节数；早停时小于 size */
  bytes: number | null;
  /** mtime（毫秒，已取整）；打不开时为 null */
  mtimeMs: number | null;
  /** 只在 full 模式或行窗口模式下有值；native 早停模式为 null（不谎报） */
  lineCount: number | null;
  /** SHA-256（hex）；只在 full + hash 模式下有值，早停模式恒为 null */
  revision: string | null;
  elapsedMs: number;
  /** 行窗口模式命中的行文本；native 模式为 null */
  rows: string[] | null;
  /** 行窗口被字节预算削过（与 truncated 分开，便于上层区分"整页被削"与"文件被削"） */
  rowsClipped: boolean;
  /**
   * 二进制闸门与解码闸门实际覆盖的字节数。
   * 早停时小于 `size` —— 说明"这是前缀，前缀之后没做 NUL 判定"，
   * 不要把 `truncated` 当作"NUL 已全文校验过"。
   */
  scannedBytes: number;
}

export interface ReadOptions {
  /**
   * 并发槽位上限，同时等于 FD 峰值。默认 10。
   * `readFilesCompat` 下默认取契约上限 32 —— 那个入口本身已限死 1-32 个文件，
   * FD 峰值天然 <= 32；显式传值（含 1）则按传入值执行。
   */
  concurrency?: number;
  /**
   * 单文件字节上限，超过即拒绝且不读任何字节。默认 2 MiB。
   * `readFilesCompat` 下默认 Number.MAX_SAFE_INTEGER —— 原装没有这个上限，
   * 替换路径若保留 2 MiB，所有大日志当场变成 INVALID_ARGUMENT（4.1.3 修的回归）。
   */
  maxFileSize?: number;
  /** 单文件总预算（覆盖 open/fstat/read/close）。默认 3000 ms */
  timeoutMs?: number;
  /** 单文件返回字符上限。默认 50000 */
  maxChars?: number;
  /** 全批返回字符上限，按输入顺序确定性结算。默认 120000 */
  maxTotalChars?: number;
  /** 分块读取粒度（字节）。默认 65536 */
  chunkBytes?: number;
  /** close 等待上限，卡死也放手。默认 100 ms */
  closeMs?: number;
  /** 无 BOM 时的解码方式。默认 'utf8' */
  encoding?: BufferEncoding;
  /** 非空则把 IO 围栏在此目录内（opt-in）。默认 null */
  root?: string | null;
  /** 取消整批 */
  signal?: AbortSignal | null;
  /** true = 读到 EOF（产 lineCount / revision）。默认 false */
  full?: boolean;
  /** true = 边读边算 SHA-256，仅在 full 模式下生效。默认 false */
  hash?: boolean;
  /** EMFILE/ENFILE/EBUSY 重试次数。默认 2 */
  maxOpenRetries?: number;
  /**
   * true = 非法 UTF-8 直接报 `INVALID_UTF8`，不做 U+FFFD 有损替换。
   * `readFilesCompat` 恒为 true（对齐原装）；native 默认 false（GBK 等仍可降级读取）。
   */
  strictUtf8?: boolean;
  /**
   * false = 拒绝 symlink / junction（逐级 lstat，含父目录链）。
   * `readFilesCompat` 默认 false（对齐原装 open_nofollow）；native 默认 true。
   * 放行时命中 `PATH_RESTRICTED`。
   */
  allowLinks?: boolean;
  /**
   * true = 剥掉文件头的 UTF-8 BOM（U+FEFF）。
   * native 默认 true（省得首行挂个不可见字符污染上下文）；
   * `readFilesCompat` 默认 **false** —— 原装 dsh-ops 实测保留 BOM（BOM-only 文件 lineCount=1），
   * 替换路径若剥掉，上层按返回文本编辑 / CAS / diff 会静默丢 3 个字节。
   */
  stripBom?: boolean;
  /**
   * 跨平台清洗（功能 B）。默认 **true**。
   *
   * - `true`：正文 `\r\n` → `\n`，返回对象的 key 与 `path` 统一 POSIX（`\` → `/`），
   *   并在 `stripBom` 未显式指定时一并剥掉 UTF-8 BOM。
   * - `false`：**原汁原味**，正文、键、BOM 一律与磁盘逐字节一致。
   *
   * `readFilesCompat` 默认 false（回写路径不能清洗）。
   */
  normalize?: boolean;
  /**
   * 路径口径单独一个开关（功能 B 的 `\` → `/` 那半条）。未指定时跟随 `normalize`。
   *
   * 解耦的理由：宿主 compat 层要的是「正文逐字节 + 路径 POSIX」——正文不能清洗（回写会写坏），
   * 但路径必须是 POSIX（回执里的 path 会被当成下一次调用的入参，反斜杠在 JSON 里还要转义）。
   * 传 `{ normalize: false, normalizePaths: true }` 就是这一档，不必为此把 CRLF 也转掉。
   */
  normalizePaths?: boolean;
}

/** 批量读取，返回以路径为 key 的对象（null 原型） */
export declare function parallelRead(
  filePaths: string[],
  options?: ReadOptions
): Promise<Record<string, ReadEntry>>;

/** parallelRead 的原名别名 */
export declare const ops_parallel_read: typeof parallelRead;

/** 兼容层入参：字符串或 { path, offset, limit } */
export interface CompatFileInput {
  path: string;
  /** 起始行号，1 起 */
  offset?: number;
  /** 返回行数，1..10000，默认 200 */
  limit?: number;
}

export interface CompatLine {
  line: number;
  path: string;
  text: string;
  /** 单行超过输出预算时被行内截断，nextOffset 会停在原行 */
  truncatedInLine?: true;
  bytesOmitted?: number;
  bytesTotal?: number | null;
}

export interface CompatError {
  code: string;
  message: string;
  phase: string;
  effectState: string;
  retryable: boolean;
  nextAction: string;
}

export interface CompatItem {
  path: string;
  status: 'completed' | 'error';
  bytes: number | null;
  revision: string | null;
  lineCount: number | null;
  complete: boolean;
  truncated: boolean;
  skipped: number;
  omitted: number;
  matched: number;
  total: number;
  failed: number;
  changed: number;
  phase: string;
  nextOffset: number;
  nextAction?: string;
  items: CompatLine[];
  error?: CompatError;
}

export interface CompatResult {
  status: 'completed' | 'partial' | 'error';
  complete?: boolean;
  total?: number;
  matched?: number;
  failed?: number;
  pending?: number;
  nextIndex?: number;
  truncated?: boolean;
  effectState?: string;
  phase?: string;
  nextAction?: string;
  items?: CompatItem[];
  error?: CompatError;
}

export interface CompatOptions extends ReadOptions {
  /** 覆盖 128 KiB JSON 输出预算（下限 2 KiB） */
  maxOutputBytes?: number;
}

/** 对齐 dsh-ops `ops_read_files` 的契约，用于原位替换 */
export declare function readFilesCompat(
  files: Array<CompatFileInput | string>,
  options?: CompatOptions
): Promise<CompatResult>;

/** readFilesCompat 的原名别名 */
export declare const ops_read_files: typeof readFilesCompat;

/** 极简并发池：worker 数量恒等于 limit，共享游标 */
export declare function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R> | R
): Promise<R[]>;

/** 按字符截断并补标记；不劈开代理对 */
export declare function truncate(
  text: string,
  maxChars: number
): { content: string; truncated: boolean };

export declare class OpsError extends Error {
  constructor(code: string, message: string);
  code: string;
}

export declare const DEFAULTS: Readonly<Required<Pick<ReadOptions,
  'concurrency' | 'maxFileSize' | 'timeoutMs' | 'maxChars' | 'maxTotalChars' |
  'chunkBytes' | 'closeMs' | 'encoding' | 'root' | 'signal' | 'full' | 'hash' |
  'maxOpenRetries' | 'strictUtf8' | 'allowLinks' | 'stripBom' | 'normalize' | 'normalizePaths'>>>;

export declare const TRUNCATED_MARK: string;

declare const _default: {
  parallelRead: typeof parallelRead;
  ops_parallel_read: typeof parallelRead;
  readFilesCompat: typeof readFilesCompat;
  ops_read_files: typeof readFilesCompat;
  runPool: typeof runPool;
  truncate: typeof truncate;
  OpsError: typeof OpsError;
  DEFAULTS: typeof DEFAULTS;
  TRUNCATED_MARK: string;
};

export default _default;
