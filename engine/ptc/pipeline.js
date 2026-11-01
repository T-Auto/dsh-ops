"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTools = resolveTools;
exports.runRefactorPipeline = runRefactorPipeline;
const promises_1 = require("node:fs/promises");
const node_crypto_1 = require("node:crypto");
const node_path_1 = __importDefault(require("node:path"));
const napi_1 = require("./engine-load").napi;
const astdiff_1 = require("./astdiff");
const safe_write_1 = require("./safe-write");
const proc_1 = require("./proc");
const stages_1 = require("./stages");
const inproc_1 = require("./inproc");
async function resolveTools(cfg, need = { es: true }) {
    const resolved = { ...cfg, sgPath: await (0, proc_1.pickBin)([cfg.sgPath, 'ast-grep', 'sg']) };
    if (need.es)
        resolved.esPath = await (0, proc_1.pickBin)((0, proc_1.esCandidates)(cfg.esPath, cfg.cwd));
    return resolved;
}
async function runRefactorPipeline(req, rawCfg) {
    const t0 = Date.now();
    const stages = [];
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
    let file = req.file ? node_path_1.default.resolve(rawCfg.cwd, req.file) : '';
    let beforeBuf = null;
    let applied = null;
    try {
        cfg = await resolveTools(rawCfg, { es: !file });
        let prelocated = null;
        if (!file) {
            const files = await (0, stages_1.everythingFind)(cfg, {
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
            const shortlist = [];
            for (let i = 0; i < budget; i += 1) {
                try {
                    if ((await (0, promises_1.readFile)(files[i], 'utf8')).includes(req.symbol))
                        shortlist.push(files[i]);
                }
                catch { }
            }
            const trial = shortlist.length > 0 ? shortlist : files.slice(0, 1);
            let lastError;
            for (const candidate of trial.slice(0, 3)) {
                try {
                    prelocated = await (0, stages_1.saneLocate)(cfg, candidate, req.symbol);
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
                    const swept = (0, inproc_1.inprocLocate)({
                        symbol: req.symbol,
                        roots: req.roots,
                        ext: req.ext ? [req.ext] : undefined,
                        limit: 8,
                        strategy: 'walk',
                    }, cfg.cwd);
                    for (const hit of (swept.hits ?? []).slice(0, 3)) {
                        try {
                            prelocated = await (0, stages_1.saneLocate)(cfg, hit.file, req.symbol);
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
                throw new proc_1.PtcOutcomeError('E_EVERYTHING_NOT_FOUND', 'everything', `候选文件里没有符号 ${req.symbol}`, { query: req.query });
            }
            (0, proc_1.dbg)(cfg, 'hit', file);
            stages.push('everything');
        }
        beforeBuf = await (0, promises_1.readFile)(file);
        const lang = (0, stages_1.langOf)(file);
        const eol = (0, proc_1.detectEol)(beforeBuf);
        const difftProbe = (0, stages_1.difftAvailable)(cfg);
        const [located, rewritten] = await Promise.allSettled([
            prelocated ?? (0, stages_1.saneLocate)(cfg, file, req.symbol, beforeBuf),
            (0, stages_1.queryRewrite)(cfg, file, { pattern: req.astPattern, rewrite: req.astRewrite, lang, eol }),
        ]);
        if (located.status === 'rejected')
            throw located.reason;
        if (rewritten.status === 'rejected')
            throw rewritten.reason;
        const slice = located.value;
        (0, safe_write_1.verifySnapshot)(file, beforeBuf);
        stages.push('sane');
        const edits = (0, stages_1.finishRewrite)(cfg, rewritten.value, {
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
            throw new proc_1.PtcOutcomeError('E_DIFF_REGRESSION', 'astgrep', `改动面 ${(ratio * 100).toFixed(1)}% 超过阈值 ${(cfg.maxChangeRatio * 100).toFixed(0)}%，未写入`, { touched, total: beforeBuf.length });
        }
        (0, safe_write_1.verifySnapshot)(file, beforeBuf);
        const afterBuf = (0, stages_1.applyEditsInMemory)(beforeBuf, edits);
        const language = { ts: napi_1.Lang.TypeScript, tsx: napi_1.Lang.Tsx, js: napi_1.Lang.JavaScript,
            jsx: napi_1.Lang.JavaScript, html: napi_1.Lang.Html, css: napi_1.Lang.Css }[slice.lang];
        await difftProbe;
        let syntaxAudit = Promise.resolve(null);
        if (language) {
            const beforeText = beforeBuf.toString('utf8');
            if (!Buffer.from(beforeText, 'utf8').equals(beforeBuf)) {
                throw new proc_1.PtcOutcomeError('E_BAD_ARGS', 'astgrep', '源码不是有效 UTF-8，未写入');
            }
            const source = beforeBuf;
            let byteCursor = 0, utf16Cursor = 0;
            const toUtf16 = (offset) => {
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
            syntaxAudit = Promise.resolve().then(() => (0, astdiff_1.auditSyntax)(beforeText, afterText, language, spanEdits));
        }
        const [syntaxSettled, difftSettled] = await Promise.allSettled([
            syntaxAudit,
            (0, stages_1.difftasticAudit)(cfg, beforeBuf, file, edits, afterBuf),
        ]);
        if (syntaxSettled.status === 'rejected')
            throw syntaxSettled.reason;
        const syntax = syntaxSettled.value;
        if (syntax && !syntax.ok)
            throw new proc_1.PtcOutcomeError('E_DIFF_FAILED', 'astgrep', syntax.message ?? '候选源码语法审计失败，未写入');
        if (difftSettled.status === 'rejected')
            throw difftSettled.reason;
        const { audit, dir } = difftSettled.value;
        if (dir)
            await (0, promises_1.rm)(dir, { recursive: true, force: true }).catch(() => { });
        stages.push('difftastic');
        if (audit.degraded && cfg.requireAudit) {
            throw new proc_1.PtcOutcomeError('E_DIFF_FAILED', 'difftastic', '审计不可用且 requireAudit=true，未写入');
        }
        if (mode === 'apply') {
            const shaBefore = (0, node_crypto_1.createHash)('sha256').update(beforeBuf).digest('hex');
            const res = await (0, stages_1.agentBoxApply)(cfg, file, edits, shaBefore);
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
                await (0, stages_1.agentBoxRestore)(cfg, file, beforeBuf, applied.sha256After);
                rolledBack = true;
            }
            catch (re) {
                (0, proc_1.dbg)(cfg, 'rollback failed', String(re));
            }
        }
        if (e instanceof proc_1.PtcOutcomeError) {
            return {
                ...e.toOutcome(),
                mode,
                file: file || undefined,
                stages,
                rollback: rolledBack,
                ms: Date.now() - t0,
            };
        }
        return {
            status: 'error',
            code: 'E_INTERNAL',
            stage: 'pipeline',
            message: String(e?.message ?? e),
            mode,
            file: file || undefined,
            stages,
            rollback: rolledBack,
            ms: Date.now() - t0,
        };
    }
}
function parseArgv(argv) {
    const out = {};
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
const pipelineEntry = process.argv[1] ? node_path_1.default.basename(process.argv[1]) : '';
if (pipelineEntry === 'pipeline.js' || pipelineEntry === 'pipeline.cjs' || pipelineEntry === 'pipeline.mjs') {
    const a = parseArgv(process.argv.slice(2));
    const cfg = (0, proc_1.defaultConfig)({ cwd: process.cwd(), esPath: String(a.es ?? process.env.PTC_ES ?? './es.exe') });
    const req = {
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
