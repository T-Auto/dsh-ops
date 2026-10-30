import { readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { Lang } from '@ast-grep/napi';
import { napi } from './engine-load';
import { auditSyntax } from './astdiff';
import { verifySnapshot } from './safe-write';
import { PtcOutcomeError, dbg, defaultConfig, detectEol, esCandidates, pickBin } from './proc';
import type { PtcConfig, Stage } from './proc';
import {
    agentBoxApply,
    agentBoxRestore,
    applyEditsInMemory,
    difftAvailable,
    difftasticAudit,
    everythingFind,
    finishRewrite,
    langOf,
    queryRewrite,
    saneLocate,
} from './stages';
import type { SymbolSlice } from './stages';
import { inprocLocate } from './inproc';

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
export async function resolveTools(cfg: PtcConfig, need: { es: boolean } = { es: true }): Promise<PtcConfig> {
    const resolved: PtcConfig = { ...cfg, sgPath: await pickBin([cfg.sgPath, 'ast-grep', 'sg']) };
    if (need.es)
        resolved.esPath = await pickBin(esCandidates(cfg.esPath, cfg.cwd));
    return resolved;
}

export async function runRefactorPipeline(req: RefactorRequest, rawCfg: PtcConfig): Promise<PtcOutcome> {
    const t0 = Date.now();
    const stages: Stage[] = [];
    if (!req || typeof req !== 'object' || Array.isArray(req)
        || typeof req.symbol !== 'string' || !req.symbol.trim()
        || typeof req.astPattern !== 'string' || !req.astPattern.trim()
        || typeof req.astRewrite !== 'string'
        || (req.mode !== undefined && req.mode !== 'apply' && req.mode !== 'preview')
        || (req.limit !== undefined && (!Number.isSafeInteger(req.limit) || req.limit < 1 || req.limit > 150000))
        || (req.file !== undefined && (typeof req.file !== 'string' || !req.file.trim()))
        || (!req.file && (typeof req.query !== 'string' || !req.query.trim()))
        || (req.roots !== undefined && (!Array.isArray(req.roots) || req.roots.some(r => typeof r !== 'string' || !r.trim())))
        || (req.scope !== undefined && req.scope !== 'cwd' && req.scope !== 'global')) {
        return { status: 'error', code: 'E_BAD_ARGS', stage: 'pipeline', message: '无效流水线请求', stages, ms: Date.now() - t0 };
    }
    const mode = req.mode ?? 'apply';
    let cfg = rawCfg;
    let file = req.file ? path.resolve(rawCfg.cwd, req.file) : '';
    let beforeBuf: Buffer | null = null;
    let applied: { sha256After: string } | null = null;
    try {
        cfg = await resolveTools(rawCfg, { es: !file });
        let prelocated: SymbolSlice | null = null;
        if (!file) {
            const files = await everythingFind(cfg, {
                pattern: req.query,
                limit: req.limit ?? 32,
                roots: req.roots,
                ext: req.ext,
                scope: req.scope,
            });
            // 只取 files[0] 的代价：符号落在第二个候选就整条流水线误报 E_SANE_SYMBOL_NOT_FOUND，
            // 一次本该成功的改写退化成失败 + 一次带 file 的重试。先用子串把候选缩到真正提到
            // 该符号的文件（≤8 次扫描），再逐个 saneLocate（≤3 次），命中即停。
            const budget = Math.max(1, Math.min(files.length, 8));
            const shortlist: string[] = [];
            for (let i = 0; i < budget; i += 1) {
                try {
                    if ((await readFile(files[i], 'utf8')).includes(req.symbol))
                        shortlist.push(files[i]);
                }
                catch { }
            }
            const trial = shortlist.length > 0 ? shortlist : files.slice(0, 1);
            let lastError: unknown;
            for (const candidate of trial.slice(0, 3)) {
                try {
                    prelocated = await saneLocate(cfg, candidate, req.symbol);
                    file = candidate;
                    break;
                }
                catch (e) {
                    lastError = e;
                }
            }
            if (!prelocated && shortlist.length === 0) {
                // Everything 的索引是异步的：刚写出来的文件常常还没进索引，盘上有符号、es 里没有。
                // 只在「es 一个含符号的候选都没给」时才走一次 walk 兜底，代价有界，换掉的是
                // 一次假阴性（E_SANE_SYMBOL_NOT_FOUND）和随后一整次带 file 的重试。
                try {
                    const swept = inprocLocate({
                        symbol: req.symbol,
                        roots: req.roots,
                        ext: req.ext ? [req.ext] : undefined,
                        limit: 8,
                        strategy: 'walk',
                    }, cfg.cwd);
                    for (const hit of (swept.hits ?? []).slice(0, 3)) {
                        try {
                            prelocated = await saneLocate(cfg, hit.file, req.symbol);
                            file = hit.file;
                            break;
                        }
                        catch (e) {
                            lastError = e;
                        }
                    }
                }
                catch { }
            }
            if (!prelocated) {
                if (lastError)
                    throw lastError;
                throw new PtcOutcomeError('E_EVERYTHING_NOT_FOUND', 'everything', `候选文件里没有符号 ${req.symbol}`, { query: req.query });
            }
            dbg(cfg, 'hit', file);
            stages.push('everything');
        }
        beforeBuf = await readFile(file);
        const lang = langOf(file);
        const eol = detectEol(beforeBuf);
        const difftProbe = difftAvailable(cfg);
        const [located, rewritten] = await Promise.allSettled([
            prelocated ?? saneLocate(cfg, file, req.symbol, beforeBuf),
            queryRewrite(cfg, file, { pattern: req.astPattern, rewrite: req.astRewrite, lang, eol }),
        ]);
        if (located.status === 'rejected')
            throw located.reason;
        if (rewritten.status === 'rejected')
            throw rewritten.reason;
        const slice = located.value;
        verifySnapshot(file, beforeBuf);
        stages.push('sane');
        const edits = finishRewrite(cfg, rewritten.value, {
            pattern: req.astPattern,
            rewrite: req.astRewrite,
            lang,
            within: { startByte: slice.startByte, endByte: slice.endByte },
            eol,
        });
        stages.push('astgrep');
        const touched = edits.reduce((n, e) => n + (e.endByte - e.startByte), 0);
        const ratio = beforeBuf.length > 0 ? touched / beforeBuf.length : 1;
        const ratioGuard = beforeBuf.length >= 4096 && touched > 512;
        if (ratioGuard && ratio > cfg.maxChangeRatio) {
            throw new PtcOutcomeError('E_DIFF_REGRESSION', 'astgrep', `改动面 ${(ratio * 100).toFixed(1)}% 超过阈值 ${(cfg.maxChangeRatio * 100).toFixed(0)}%，未写入`, { touched, total: beforeBuf.length });
        }
        verifySnapshot(file, beforeBuf);
        const afterBuf = applyEditsInMemory(beforeBuf, edits);
        const napiLang: Record<string, Lang | undefined> = { ts: napi.Lang.TypeScript, tsx: napi.Lang.Tsx, js: napi.Lang.JavaScript,
            jsx: napi.Lang.JavaScript, html: napi.Lang.Html, css: napi.Lang.Css };
        const language = napiLang[slice.lang];
        await difftProbe;
        let syntaxAudit: Promise<ReturnType<typeof auditSyntax> | null> = Promise.resolve(null);
        if (language) {
            const beforeText = beforeBuf.toString('utf8');
            if (!Buffer.from(beforeText, 'utf8').equals(beforeBuf)) {
                throw new PtcOutcomeError('E_BAD_ARGS', 'astgrep', '源码不是有效 UTF-8，未写入');
            }
            const source = beforeBuf;
            let byteCursor = 0, utf16Cursor = 0;
            const toUtf16 = (offset: number): number => {
                utf16Cursor += source.subarray(byteCursor, offset).toString('utf8').length;
                byteCursor = offset;
                return utf16Cursor;
            };
            const spanEdits = edits.map(e => ({
                startByte: toUtf16(e.startByte),
                endByte: toUtf16(e.endByte),
                text: e.text,
            }));
            const afterText = afterBuf.toString('utf8');
            syntaxAudit = Promise.resolve().then(() => auditSyntax(beforeText, afterText, language, spanEdits));
        }
        const [syntaxSettled, difftSettled] = await Promise.allSettled([
            syntaxAudit,
            difftasticAudit(cfg, beforeBuf, file, edits, afterBuf),
        ]);
        if (syntaxSettled.status === 'rejected')
            throw syntaxSettled.reason;
        const syntax = syntaxSettled.value;
        if (syntax && !syntax.ok)
            throw new PtcOutcomeError('E_DIFF_FAILED', 'astgrep', syntax.message ?? '候选源码语法审计失败，未写入');
        if (difftSettled.status === 'rejected')
            throw difftSettled.reason;
        const { audit, dir } = difftSettled.value;
        if (dir)
            await rm(dir, { recursive: true, force: true }).catch(() => { });
        stages.push('difftastic');
        if (audit.degraded && cfg.requireAudit) {
            throw new PtcOutcomeError('E_DIFF_FAILED', 'difftastic', '审计不可用且 requireAudit=true，未写入');
        }
        if (mode === 'apply') {
            const shaBefore = createHash('sha256').update(beforeBuf).digest('hex');
            const res = await agentBoxApply(cfg, file, edits, shaBefore);
            applied = { sha256After: res.sha256After };
            stages.push('agentbox');
        }
        return {
            status: 'ok',
            mode,
            file,
            symbol: req.symbol,
            hunks: audit.hunks,
            addedLines: audit.addedLines,
            removedLines: audit.removedLines,
            summary: audit.summary,
            stages,
            savedTokensRatio: Math.round(slice.savedRatio * 100) / 100,
            degraded: audit.degraded,
            ms: Date.now() - t0,
        };
    }
    catch (e) {
        let rolledBack = false;
        if (applied && beforeBuf) {
            try {
                await agentBoxRestore(cfg, file, beforeBuf, applied.sha256After);
                rolledBack = true;
            }
            catch (re) {
                dbg(cfg, 'rollback failed', String(re));
            }
        }
        if (e instanceof PtcOutcomeError) {
            return {
                ...e.toOutcome(),
                mode,
                file: file || undefined,
                stages,
                rollback: rolledBack,
                ms: Date.now() - t0,
            };
        }
        const message = (e as { message?: unknown } | null | undefined)?.message;
        return {
            status: 'error',
            code: 'E_INTERNAL',
            stage: 'pipeline',
            message: String(message ?? e),
            mode,
            file: file || undefined,
            stages,
            rollback: rolledBack,
            ms: Date.now() - t0,
        };
    }
}

type ArgValue = string | string[] | boolean;

function parseArgv(argv: string[]): Record<string, ArgValue> {
    const out: Record<string, ArgValue> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--'))
            continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            out[key] = true;
            continue;
        }
        i += 1;
        const prev = out[key];
        if (prev === undefined)
            out[key] = next;
        else if (Array.isArray(prev))
            prev.push(next);
        else
            out[key] = [String(prev), next];
    }
    return out;
}

const pipelineEntry = process.argv[1] ? path.basename(process.argv[1]) : '';
if (pipelineEntry === 'pipeline.js' || pipelineEntry === 'pipeline.cjs' || pipelineEntry === 'pipeline.mjs') {
    const a = parseArgv(process.argv.slice(2));
    const cfg = defaultConfig({ cwd: process.cwd(), esPath: String(a.es ?? process.env.PTC_ES ?? './es.exe') });
    const req: RefactorRequest = {
        query: String(a.query ?? ''),
        symbol: String(a.symbol ?? ''),
        astPattern: String(a.pattern ?? ''),
        astRewrite: String(a.rewrite ?? ''),
        file: a.file ? String(a.file) : undefined,
        limit: a.limit ? Number(a.limit) : undefined,
        ext: a.ext ? String(a.ext) : undefined,
        scope: a.scope === 'global' ? 'global' : undefined,
        mode: a.mode === 'preview' ? 'preview' : 'apply',
    };
    runRefactorPipeline(req, cfg)
        .then((o) => {
        process.stdout.write(JSON.stringify(o, null, 2) + '\n');
        process.exit(o.status === 'ok' ? 0 : 1);
    })
        .catch((e) => {
        process.stdout.write(JSON.stringify({ status: 'error', code: 'E_INTERNAL', message: String(e) }) + '\n');
        process.exit(1);
    });
}
