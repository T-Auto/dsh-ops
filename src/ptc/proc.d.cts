export type Stage = 'everything' | 'sane' | 'astgrep' | 'agentbox' | 'difftastic' | 'inproc' | 'pipeline';
export type PtcErrorCode = 'E_BIN_MISSING' | 'E_TIMEOUT' | 'E_INTERNAL' | 'E_OUTPUT_LIMIT' | 'E_EVERYTHING_FAILED' | 'E_EVERYTHING_IPC' | 'E_EVERYTHING_NOT_FOUND' | 'E_SANE_UNSUPPORTED_LANG' | 'E_SANE_SYMBOL_NOT_FOUND' | 'E_SANE_AMBIGUOUS' | 'E_ASTGREP_FAILED' | 'E_ASTGREP_NO_MATCH' | 'E_ASTGREP_OVERLAP' | 'E_ASTGREP_IDENTITY' | 'E_AGENTBOX_REJECTED' | 'E_AGENTBOX_CRASH' | 'E_DIFF_FAILED' | 'E_DIFF_EMPTY' | 'E_DIFF_REGRESSION' | 'E_BAD_ARGS';
export declare class PtcOutcomeError extends Error {
    readonly code: PtcErrorCode;
    readonly stage: Stage;
    readonly detail?: unknown | undefined;
    constructor(code: PtcErrorCode, stage: Stage, message: string, detail?: unknown | undefined);
    toOutcome(): {
        status: "error";
        code: PtcErrorCode;
        stage: Stage;
        message: string;
    };
}
export interface PtcConfig {
    cwd: string;
    esPath: string;
    sgPath: string;
    difftPath: string;
    agentBoxWorker: string;
    timeoutMs: number;
    maxOutputBytes: number;
    /** 单次改动字节占比上限，超过即判定回归并回滚 */
    maxChangeRatio: number;
    /** true = difftastic 不可用时回滚报错；false = 标记 degraded 继续 */
    requireAudit: boolean;
    allowMulti: boolean;
    debug: boolean;
}
/**
 * es.exe 寻址候选链：显式配置优先，其次随包 vendor，其次 Everything 官方安装目录，最后 PATH。
 * 为什么要链：es.exe 不是系统命令，单靠 `./es.exe` 会随 cwd 漂移（在 .sandbox 里跑就 ENOENT）。
 */
export declare const esCandidates: (explicit?: string, cwd?: string) => string[];
export declare const defaultConfig: (over?: Partial<PtcConfig>) => PtcConfig;
export declare const dbg: (cfg: PtcConfig, ...a: unknown[]) => void;
export interface ProcResult {
    code: number;
    stdout: Buffer;
    stderr: Buffer;
    truncated: boolean;
    ms: number;
}
export interface RunOpts {
    cwd?: string;
    stdin?: string | Buffer | null;
    timeoutMs?: number;
    maxOutputBytes?: number;
    /** 额外环境变量，合并进 process.env（不改父进程） */
    env?: NodeJS.ProcessEnv;
}
export declare function run(bin: string, args: string[], stage: Stage, opts?: RunOpts): Promise<ProcResult>;
/** PATH 里按名字找真实可执行文件（处理 ast-grep / ast-grep.exe / sg 三套命名） */
export declare function pickBin(candidates: string[]): Promise<string>;
export declare const stripBom: (s: string) => string;
/** es.exe 输出 → 干净路径数组。Windows CRLF、行尾空格、空行、BOM 一次清掉 */
export declare function toLines(buf: Buffer): string[];
/** 文件主 EOL，用于把补丁里的 \n 还原成该文件风格，避免整文件 diff 噪声 */
export declare function detectEol(buf: Buffer): '\r\n' | '\n';
export declare const normalizeEol: (s: string, eol: "\r\n" | "\n") => string;
/** 宽容 JSON：ast-grep 老版本给数组、新版本给 NDJSON、difft 给 NDJSON */
export declare function parseLooseJson(text: string): unknown[];
/** 只读目标字节区间 —— SANE 省 token 的物理实现 */
export declare function readRange(file: string, start: number, end: number): Promise<Buffer>;
