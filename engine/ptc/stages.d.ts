import { PtcConfig } from './proc';
declare const sha256: (b: Buffer) => string;
export interface EverythingQuery {
    pattern: string;
    limit?: number;
    roots?: string[];
    ext?: string;
    regex?: boolean;
    /** cwd=只在当前工作目录内找（默认，避免跑偏到全盘同名文件）；global=全盘索引 */
    scope?: 'cwd' | 'global';
}
export declare function everythingFind(cfg: PtcConfig, q: EverythingQuery): Promise<string[]>;
export declare function langOf(file: string): string;
interface SgMatch {
    text: string;
    range: {
        byteOffset: {
            start: number;
            end: number;
        };
        start: {
            line: number;
            column: number;
        };
        end: {
            line: number;
            column: number;
        };
    };
    metaVariables?: {
        single?: Record<string, {
            text: string;
        }>;
    };
    replacement?: string | null;
    replacementOffsets?: {
        start: number;
        end: number;
    } | null;
}
export interface SymbolSlice {
    file: string;
    symbol: string;
    lang: string;
    startByte: number;
    endByte: number;
    startLine: number;
    endLine: number;
    totalBytes: number;
    signature: string;
    /** 只把这一段交给上层，其余字节不读 */
    slice: Buffer;
    savedRatio: number;
}
export declare function saneLocate(cfg: PtcConfig, file: string, symbol: string, snapshot?: Buffer): Promise<SymbolSlice>;
export interface Edit {
    startByte: number;
    endByte: number;
    /** 新片段（已对齐文件 EOL） */
    text: string;
    /** 原片段，仅用于统计与摘要 */
    before: string;
}
export interface RewriteOpts {
    pattern: string;
    rewrite: string;
    lang: string;
    within?: {
        startByte: number;
        endByte: number;
    };
    eol: '\r\n' | '\n';
}
/**
 * 只跑外部改写查询并判定退出码，不做区间过滤。
 * 拆出来是为了让调用方能把它和 SANE 定位并发执行 —— 两个进程互不依赖。
 */
export declare function queryRewrite(cfg: PtcConfig, file: string, o: RewriteOpts): Promise<SgMatch[]>;
/** 把外部命中收敛成可落盘的编辑集：区间锁、保尾、去空改、重叠熔断。 */
export declare function finishRewrite(cfg: PtcConfig, matches: SgMatch[], o: RewriteOpts): Edit[];
/** 顺序版：查询 + 收敛。并发调用方用 queryRewrite/finishRewrite 自行编排。 */
export declare function astGrepRewrite(cfg: PtcConfig, file: string, o: RewriteOpts): Promise<Edit[]>;
export interface AgentBoxResult {
    ok: true;
    bytesBefore: number;
    bytesAfter: number;
    sha256Before: string;
    sha256After: string;
}
export declare function agentBoxApply(cfg: PtcConfig, file: string, edits: Array<{
    startByte: number;
    endByte: number;
    text: string;
}>, expectSha256: string): Promise<AgentBoxResult>;
/** 整文件回滚也走同一条安全通道，不另开写路径 */
export declare function agentBoxRestore(cfg: PtcConfig, file: string, original: Buffer, currentSha: string): Promise<void>;
/**
 * preview 模式用：在内存里按同一套字节区间规则合成 after 镜像，绝不落盘。
 * 规则与 agentbox.worker 严格一致（升序、不重叠、夹紧越界），否则 preview 与 apply 会给出不同结果。
 */
export declare function applyEditsInMemory(before: Buffer, edits: Array<{
    startByte: number;
    endByte: number;
    text: string;
}>): Buffer;
export interface AuditResult {
    hunks: number;
    addedLines: number;
    removedLines: number;
    language: string;
    summary: string;
    degraded?: string;
}
export declare function difftAvailable(cfg: PtcConfig): Promise<boolean>;
export declare function difftasticAudit(cfg: PtcConfig, beforeBuf: Buffer, file: string, edits: Edit[], afterBuf?: Buffer): Promise<{
    audit: AuditResult;
    dir: string;
}>;
export { sha256 };
