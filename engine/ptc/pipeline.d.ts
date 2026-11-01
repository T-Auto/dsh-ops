import { PtcConfig, Stage } from './proc';
export interface RefactorRequest {
    /** es.exe 搜索条件 */
    query: string;
    /** SANE 目标符号 */
    symbol: string;
    astPattern: string;
    astRewrite: string;
    /** 已知目标文件时跳过第 1 段 */
    file?: string;
    roots?: string[];
    ext?: string;
    limit?: number;
    scope?: 'cwd' | 'global';
    /** preview=只在内存里合成结果并跑 difftastic，不落盘；apply=走 AgentBox 写入（默认） */
    mode?: 'preview' | 'apply';
}
export interface PtcOutcome {
    status: 'ok' | 'error';
    mode?: 'preview' | 'apply';
    file?: string;
    symbol?: string;
    hunks?: number;
    addedLines?: number;
    removedLines?: number;
    summary?: string;
    stages?: Stage[];
    savedTokensRatio?: number;
    degraded?: string;
    rollback?: boolean;
    ms?: number;
    code?: string;
    stage?: Stage;
    message?: string;
}
/** 启动时把可执行文件名解析成真实路径，避免 ast-grep / ast-grep.exe / sg 三套命名踩坑 */
export declare function resolveTools(cfg: PtcConfig, need?: {
    es: boolean;
}): Promise<PtcConfig>;
export declare function runRefactorPipeline(req: RefactorRequest, rawCfg: PtcConfig): Promise<PtcOutcome>;
