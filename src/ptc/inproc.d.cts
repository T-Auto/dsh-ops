import { type AstAudit, type SgCrossCheck } from './astdiff';
export interface InprocRequest {
    /** AST 匹配 pattern，如 `return $A` */
    pattern: string;
    /** 重写模板，如 `return ($A);` */
    rewrite: string;
    /** 目标符号；给了就把改写锁进该符号体内 */
    symbol?: string;
    /** 已知目标文件，跳过枚举 */
    file?: string;
    /** 搜索根目录，默认 cwd */
    roots?: string[];
    /** 限定扩展名（不带点），默认 ts/tsx */
    ext?: string[];
    /** apply=落盘，preview=只合成不写 */
    mode?: 'apply' | 'preview';
    /** 本次最多处理多少个文件，默认 1 */
    limit?: number;
    /**
     * 严格模式：落盘前额外用 `sg` CLI 独立跑同一个 pattern，命中数与 napi 对不上就熔断。
     * 成本 +36ms（一次进程启动），换来两套调用路径互证；默认关闭以保持零 fork。
     */
    strict?: boolean;
    /** sg 可执行文件，默认 ast-grep */
    sgPath?: string;
    /** 寻址策略：auto=按规模自动选（默认），walk=只用进程内递归，everything=强制 es.exe */
    strategy?: LocateStrategy;
    /** es.exe 路径；不填走 vendor/ → Everything 安装目录 → PATH 候选链 */
    esPath?: string;
    /** 预筛扫描预算（读多少个文件找符号），默认 3000 */
    scanBudget?: number;
}
/** 寻址元信息：如实报告这一轮用了哪条路 */
export interface LocateInfo {
    via: 'walk' | 'everything';
    ms: number;
    scanned: number;
    /** 枚举达到上限被截断（此时结果可能不完整） */
    truncated: boolean;
    /** 预筛超过扫描预算，只扫了优先级最高的一批（结果可能不完整） */
    pruned?: boolean;
}
export interface InprocOutcome {
    status: 'ok' | 'error';
    engine: 'inproc-ast';
    file?: string;
    symbol?: string;
    /** 实际改写处数 */
    edits?: number;
    /** 涉及文件数 */
    files?: number;
    bytesIn?: number;
    bytesOut?: number;
    /** 真正回到调用方上下文的字节数（outcome 自身序列化长度） */
    contextBytes?: number;
    /** preview 时为 true，表示未落盘 */
    staged?: boolean;
    /** 命中文件里第一个改动片段的原文，用于人工核对（截断 120 字符） */
    sample?: string;
    /** 进程内 AST 审计（替代 difftastic）：语法完整性 + 区间外零改动 + 结构变化 */
    audit?: AstAudit;
    /** 严格模式下 sg CLI 的交叉复核结果 */
    crossCheck?: SgCrossCheck;
    /** 本轮寻址用了哪条路、花了多久（不给 file 时为 undefined） */
    locate?: LocateInfo;
    ms?: number;
    /** 非空表示这条请求应交给 spawn 版（大文件 / 不支持的语言） */
    fallback?: string;
    /** Files actually committed before an I/O failure; multi-file writes are not transactional. */
    committed?: string[];
    partial?: boolean;
    /** Post-commit cleanup failures; committed bytes remain authoritative. */
    cleanupErrors?: string[];
    code?: string;
    message?: string;
}
export type LocateStrategy = 'auto' | 'walk' | 'everything';
export declare function clearEnumCache(): void;
export interface EnumerateResult {
    files: string[];
    /** 实际用了哪种寻址，如实回给调用方 */
    via: 'walk' | 'everything';
    /** 枚举达到上限被截断，结果可能不完整 */
    truncated: boolean;
    ms: number;
    /** 命中进程内缓存（30s TTL），此时 ms≈0 */
    cached?: boolean;
}
export declare function enumerate(roots: string[], exts: Set<string>, opts: {
    strategy?: LocateStrategy;
    esPath?: string;
    cwd: string;
    limit?: number;
    refresh?: boolean;
}): EnumerateResult;
export interface LocateRequest {
    symbol: string;
    file?: string;
    roots?: string[];
    ext?: string[];
    strategy?: LocateStrategy;
    esPath?: string;
    /** 预筛扫描预算（读多少个文件找符号），默认 3000 */
    scanBudget?: number;
    /** 最多返回几个命中文件，默认 5 */
    limit?: number;
}
export interface LocateHit {
    file: string;
    lang: string;
    /** 1-based 行区间 */
    lines: [number, number];
    /** UTF-16 字符区间（与 napi 同域，不是字节） */
    chars: [number, number];
    signature: string;
    /** 符号体字节数 vs 整文件字节数 */
    bodyBytes: number;
    fileBytes: number;
    savedRatio: number;
}
export interface LocateOutcome {
    status: 'ok' | 'error';
    engine: 'inproc-ast';
    hits: LocateHit[];
    locate?: LocateInfo;
    ms: number;
    contextBytes: number;
    code?: string;
    message?: string;
}
export declare function inprocLocate(req: LocateRequest, cwd?: string): LocateOutcome;
export declare function inprocRefactor(req: InprocRequest, cwd?: string): InprocOutcome;
/** inproc 子命令的 CLI 入口；返回进程退出码 */
export declare function runInprocCli(argv: string[], cwd?: string): number;
