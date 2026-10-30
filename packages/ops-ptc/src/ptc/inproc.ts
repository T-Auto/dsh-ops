/**
 * 进程内 AST 引擎 —— napi 直解 + 分级寻址 + 就地改写，运行时零 fork。
 *
 * 一次 locate 只在候选文件上各 parse 一次；一次 refactor 在目标文件上 parse 两次
 * （before / after），审计（astdiff）、模板展开、sg CLI 交叉复核全部在同进程完成。
 * 寻址层（walk / es.exe / 30s 缓存）在 `enumerate.ts`，错误类型在 `inproc-error.ts`，
 * 本文件保留定位、改写与 CLI 入口，公开面与原包一致。
 */
import { napi } from './engine-load';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { enumerate } from './enumerate';
import { InprocError } from './inproc-error';
import { auditAst, parseAuditRoot, sgCrossCheck } from './astdiff';
import type { AstAudit, SgCrossCheck } from './astdiff';
import { checkedWrite, verifySnapshot } from './safe-write';
import { reparseEscape } from './reparse';
import type { Lang, Rule, SgNode } from '@ast-grep/napi';
export { clearEnumCache, enumerate, walkBounded } from './enumerate';
export type { EnumerateResult } from './enumerate';
export type LocateStrategy = 'auto' | 'walk' | 'everything';
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
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const RE_SRC_SEG = /[\\/]src[\\/]/;
const RE_GENERATED = /\.(gen|d)\.(ts|tsx|js|jsx)$/;
const RE_TEST_FILE = /\.(test|spec)\.(t|j)sx?$/;
const RE_NOISE_SEG = /[\\/](node_modules|dist|coverage)[\\/]/;
const RE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RE_KEYWORD_HEAD = /^[A-Za-z_]+/;
const RE_LINE = /\r?\n/;
const RE_LINE_G = /\r?\n/g;
const RE_META_DECL = /\$(?:\$\$)?[A-Z_][A-Z0-9_]*/g;
const RE_WS_G = /\s+/g;
/**
 * 语言枚举经 engine-load 的 `napi` Proxy 取：它是双锚点惰性解析，直接从 `@ast-grep/napi`
 * 取会绕过 vendor 兜底；`Lang` 在这里只用于类型标注，不产生运行期 import。
 */
const LANG_BY_EXT: Record<string, Lang> = {
    '.ts': napi.Lang.TypeScript,
    '.mts': napi.Lang.TypeScript,
    '.cts': napi.Lang.TypeScript,
    '.tsx': napi.Lang.Tsx,
    '.js': napi.Lang.JavaScript,
    '.mjs': napi.Lang.JavaScript,
    '.cjs': napi.Lang.JavaScript,
    '.jsx': napi.Lang.Tsx,
    '.html': napi.Lang.Html,
    '.htm': napi.Lang.Html,
    '.css': napi.Lang.Css,
};
const INPROC_MAX_BYTES = 2 << 20;
const LANG_NAME: Record<string, string> = {
    [napi.Lang.TypeScript]: 'ts',
    [napi.Lang.Tsx]: 'tsx',
    [napi.Lang.JavaScript]: 'js',
    [napi.Lang.Html]: 'html',
    [napi.Lang.Css]: 'css',
};
const langOf = (file: string): Lang | null => LANG_BY_EXT[extname(file).toLowerCase()] ?? null;
function validateRequest(value: unknown, refactor: boolean): void {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new InprocError('E_INPROC_ARGUMENT', '请求必须是对象');
    const req = value as Record<string, unknown>;
    const stringFields = ['file', 'symbol', 'sgPath', 'esPath'];
    for (const key of stringFields) {
        const field = req[key];
        if (field !== undefined && (typeof field !== 'string' || !field.trim()))
            throw new InprocError('E_INPROC_ARGUMENT', `${key} 必须是非空字符串`);
    }
    if (!refactor && typeof req.symbol !== 'string')
        throw new InprocError('E_INPROC_ARGUMENT', 'symbol 必填');
    if (refactor && (typeof req.pattern !== 'string' || !req.pattern.trim() || typeof req.rewrite !== 'string'))
        throw new InprocError('E_INPROC_ARGUMENT', 'pattern 必须非空，rewrite 必须是字符串');
    for (const key of ['limit', 'scanBudget']) {
        const n = req[key] as number;
        if (req[key] !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > 150_000))
            throw new InprocError('E_INPROC_ARGUMENT', `${key} 必须在 1..150000`);
    }
    for (const key of ['roots', 'ext']) {
        const list = req[key];
        if (list !== undefined && (!Array.isArray(list) || !list.every((s: unknown) => typeof s === 'string' && s.trim())))
            throw new InprocError('E_INPROC_ARGUMENT', `${key} 必须是非空字符串数组`);
    }
    if (req.mode !== undefined && req.mode !== 'apply' && req.mode !== 'preview')
        throw new InprocError('E_INPROC_ARGUMENT', 'mode 必须为 apply 或 preview');
    if (req.strategy !== undefined && !['auto', 'walk', 'everything'].includes(req.strategy as string))
        throw new InprocError('E_INPROC_ARGUMENT', '无效 strategy');
    if (req.strict !== undefined && typeof req.strict !== 'boolean')
        throw new InprocError('E_INPROC_ARGUMENT', 'strict 必须是 boolean');
}
const SCAN_BUDGET = 3000;
const SCAN_CHUNK = 400;
function countSep(file: string): number {
    let n = 0;
    for (let i = 0; i < file.length; i++) {
        const c = file.charCodeAt(i);
        if (c === 92 || c === 47)
            n++;
    }
    return n;
}
function rank(file: string): number {
    const depth = countSep(file);
    let s = depth * 0.5;
    if (!RE_SRC_SEG.test(file))
        s += 3;
    if (RE_GENERATED.test(file))
        s += 2;
    if (RE_TEST_FILE.test(file))
        s += 1.5;
    if (RE_NOISE_SEG.test(file))
        s += 9;
    return s;
}
function rankOrdered(files: string[]): string[] {
    const scored = files.map((file, i) => ({ file, score: rank(file), i }));
    scored.sort((a, b) => a.score - b.score || a.i - b.i);
    return scored.map((x) => x.file);
}
function narrow(candidates: string[], needle: string | null | undefined, budget: number = SCAN_BUDGET): {
    pool: string[];
    pruned: boolean;
    prefiltered: number;
    scanned: number;
} {
    if (!needle)
        return { pool: candidates.slice(0, budget), pruned: candidates.length > budget, prefiltered: 0, scanned: 0 };
    const ordered = candidates.length > budget ? rankOrdered(candidates) : candidates;
    const slice = ordered.slice(0, budget);
    const hit: string[] = [];
    let scanned = 0;
    for (let i = 0; i < slice.length; i += SCAN_CHUNK) {
        const chunk = slice.slice(i, i + SCAN_CHUNK);
        scanned += chunk.length;
        for (const f of chunk) {
            try {
                if (reparseEscape(f))
                    continue;
                if (statSync(f).size <= INPROC_MAX_BYTES && readFileSync(f, 'utf8').includes(needle))
                    hit.push(f);
            }
            catch {
            }
        }
        if (hit.length >= 8)
            break;
    }
    return { pool: hit.length ? hit : slice, pruned: scanned < candidates.length, prefiltered: hit.length, scanned };
}
const DEFINITIONS = [
    'function $N($$$A) { $$$B }',
    'function $N($$$A): $T { $$$B }',
    'const $N = ($$$A) => { $$$B }',
    'const $N = ($$$A): $T => { $$$B }',
    'const $N = async ($$$A) => { $$$B }',
    // 表达式体箭头（`const f = () => 4`）。没有这三条时，仓库里最常见的短函数一律漏掉，
    // 调用方拿到 E_INPROC_NO_MATCH 后只能退回 grep/read —— 一次定位变成三次调用。
    'const $N = ($$$A) => $B',
    'const $N = ($$$A): $T => $B',
    'const $N = async ($$$A) => $B',
    'const $N = $X => $B',
    'class $N { $$$B }',
    'interface $N { $$$B }',
    'type $N = $T',
];
function locateSymbol(root: SgNode, symbol: string, source?: string): SgNode[] {
    if (source && !source.includes(symbol))
        return [];
    const hits = new Map<string, SgNode>();
    const inline = RE_IDENT.test(symbol);
    let definitions = inline ? DEFINITIONS.map((p) => p.replace('$N', symbol)) : DEFINITIONS;
    if (source) {
        definitions = definitions.filter((p) => {
            const head = RE_KEYWORD_HEAD.exec(p)?.[0];
            return !head || source.includes(head);
        });
    }
    if (definitions.length === 0)
        return [];
    const constraints = inline
        ? undefined
        : { N: { regex: `\\A${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\z` } };
    const matcher = (rule: Rule) => (constraints ? { rule, constraints } : { rule });
    let groups: SgNode[][];
    try {
        groups = [root.findAll(matcher({ any: definitions.map((pattern) => ({ pattern })) }))];
    }
    catch {
        groups = [];
        for (const pattern of definitions) {
            try {
                groups.push(root.findAll(matcher({ pattern })));
            }
            catch { }
        }
    }
    for (const found of groups) {
        for (const n of found) {
            if (!inline && n.getMatch('N')?.text() !== symbol)
                continue;
            const r = n.range();
            hits.set(`${r.start.index}:${r.end.index}`, n);
        }
    }
    // 类方法 / 类字段 / 对象字面量方法：这三类在 ast-grep 里没有合法的 `$N(...) { }` 模式
    // （模式本身解析不过），只能按 kind + 名字字段定位。缺这一段时 `class Beta { gamma() {} }`
    // 的 gamma 永远零命中，而方法正是 AST 改写最常见的落点。
    if (inline) {
        const anchored = `^${symbol}$`;
        for (const [kind, field] of KIND_FIELDS) {
            try {
                const found = root.findAll({ rule: { kind, has: { field, regex: anchored } } });
                for (const n of found) {
                    const r = n.range();
                    hits.set(`${r.start.index}:${r.end.index}`, n);
                }
            }
            catch { }
        }
    }
    return [...hits.values()].sort((a, b) => a.range().start.index - b.range().start.index);
}
/** kind + 命名字段：ast-grep 里取不到 `$N` 捕获的定义类型。 */
const KIND_FIELDS = [
    ['method_definition', 'name'],
    ['public_field_definition', 'name'],
    ['pair', 'key'],
] as const;
const META = /\$(\$\$)?([A-Z_][A-Z0-9_]*)/g;
interface TemplateCapture {
    whole: string;
    name: string;
    multi: boolean;
}
interface CompiledTemplate {
    /** 字面片段与捕获槽位交替，number 是 captures 的下标 */
    parts: Array<string | number>;
    captures: TemplateCapture[];
}
const templateCache = new Map<string, CompiledTemplate>();
function compileTemplate(tpl: string): CompiledTemplate {
    const cached = templateCache.get(tpl);
    if (cached) {
        templateCache.delete(tpl);
        templateCache.set(tpl, cached);
        return cached;
    }
    const parts: Array<string | number> = [];
    const captures: TemplateCapture[] = [];
    const slots = new Map<string, number>();
    let cursor = 0;
    for (const match of tpl.matchAll(META)) {
        parts.push(tpl.slice(cursor, match.index));
        let slot = slots.get(match[0]);
        if (slot === undefined) {
            slot = captures.length;
            slots.set(match[0], slot);
            captures.push({ whole: match[0], name: match[2], multi: !!match[1] });
        }
        parts.push(slot);
        cursor = match.index + match[0].length;
    }
    parts.push(tpl.slice(cursor));
    const compiled = { parts, captures };
    if (templateCache.size >= 64)
        templateCache.delete(templateCache.keys().next().value as string);
    templateCache.set(tpl, compiled);
    return compiled;
}
function expandTemplate(node: SgNode, tpl: CompiledTemplate, source: string): string {
    if (tpl.captures.length === 0)
        return tpl.parts[0] as string;
    const values = tpl.captures.map(({ whole, name, multi }) => {
        if (multi) {
            const all = node.getMultipleMatches(name);
            if (all.length === 0)
                return '';
            return source.slice(all[0].range().start.index, all[all.length - 1].range().end.index);
        }
        const one = node.getMatch(name);
        if (!one)
            throw new InprocError('E_INPROC_TEMPLATE', `模板变量 ${whole} 未绑定`);
        return one.text();
    });
    let out = '';
    for (const part of tpl.parts)
        out += typeof part === 'number' ? values[part] : part;
    return out;
}
/**
 * 命中正文的自动附赠额度。
 *
 * locate 已经算出了每个命中的区间，正文就在手里 —— 此前丢掉它，模型只能再调一次
 * `ops_read_files` 把同一段字节买第二遍，而那一次调用要重发整个上下文。附赠的代价是
 * 这一次回执变大，收益是省掉一整轮往返（一次往返 ≈ 上下文全量重发，远大于 8 KiB）。
 * 闸门放在 8 KiB：超过它就退回「只给行号 + readHint」，代价不可能失控。
 */
const BODY_AUTO_BYTES = 8 * 1024;
/** 实际发出去的命中形状：自报口径字段（chars/bodyBytes/fileBytes/savedRatio）已删，可能带正文。 */
interface LocateHitDraft {
    file: string;
    lang: string;
    /** 1-based 行区间 */
    lines: [number, number];
    signature: string;
    /** 额度内附赠的正文 */
    body?: string;
}
interface ReadHint {
    tool: 'ops_read_files';
    files: Array<{ path: string; offset: number; limit: number }>;
}
interface LocateDraft {
    status?: 'ok' | 'error';
    code?: string;
    message?: string;
    hits?: LocateHitDraft[];
    bodyOmitted?: number;
    readHint?: ReadHint;
}
export function inprocLocate(req: LocateRequest, cwd: string = process.cwd()): LocateOutcome {
    const t0 = performance.now();
    let locate: LocateInfo | undefined;
    // `hits` 用实际发出的窄形状，`contextBytes` 由 host 侧补算 —— 公开签名保留这两个字段，
    // 所以出口统一断言一次，不为了过类型去伪造空值。
    const done = (o: LocateDraft): LocateOutcome => ({
        status: o.status ?? 'ok',
        engine: 'inproc-ast',
        ...o,
        hits: o.hits ?? [],
        ...(locate ? { locate } : {}),
        ms: Math.round((performance.now() - t0) * 100) / 100,
    } as LocateOutcome);
    try {
        validateRequest(req, false);
        const limit = req.limit ?? 5;
        // 文件系统事实高于索引事实。
        //
        // Everything 的「部分陈旧」是最难发现的一种：索引命中了旧文件、漏了刚建的文件，于是
        // 枚举非空、零命中也就不触发零命中兜底，工具报「符号不存在」——而文件就在盘上。
        // 这里把「es 枚举过、符号零命中」也当成一次可疑信号，第二遍强制 walk 重扫。
        // 只在失败路径上多付一次 walk，成功路径一分不付。
        for (let pass = 0;; pass++) {
            const retryViaWalk = () => pass === 0 && req.file === undefined && locate?.via === 'everything' && req.strategy !== 'walk';
            let candidates: string[];
            if (req.file) {
                candidates = [resolve(cwd, req.file)];
            }
            else {
                const exts = new Set((req.ext ?? ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
                const roots = (req.roots ?? [cwd]).map((r) => resolve(cwd, r));
                const e = enumerate(roots, exts, { strategy: pass === 0 ? req.strategy : 'walk', esPath: req.esPath, cwd, refresh: pass !== 0 });
                candidates = e.files;
                locate = { via: e.via, ms: e.ms, scanned: e.files.length, truncated: e.truncated };
            }
            if (candidates.length === 0) {
                if (retryViaWalk())
                    continue;
                return done({ status: 'error', code: 'E_INPROC_NO_FILES', message: '枚举零命中' });
            }
            const { pool, pruned } = req.file
                ? { pool: candidates, pruned: false }
                : narrow(candidates, req.symbol, req.scanBudget);
            if (locate && pruned)
                locate = { ...locate, pruned: true };
            const hits: LocateHitDraft[] = [];
            // 正文候选与 hits 同序：先收文本，结算时按额度决定附不附（回执字段顺序保持稳定）
            const bodies: string[] = [];
            for (const file of pool) {
                if (hits.length >= limit)
                    break;
                const lang = langOf(file);
                if (!lang)
                    continue;
                let src: string;
                try {
                    if (reparseEscape(file))
                        continue;
                    if (statSync(file).size > INPROC_MAX_BYTES)
                        continue;
                    const buf = readFileSync(file);
                    const bytes = buf.length;
                    if (bytes > INPROC_MAX_BYTES)
                        continue;
                    src = buf.toString('utf8');
                }
                catch {
                    continue;
                }
                const root = parseAuditRoot(lang, src);
                for (const n of locateSymbol(root, req.symbol, src)) {
                    const r = n.range();
                    const text = n.text();
                    // 回执只留模型拿得走的字段：chars/bodyBytes/fileBytes/savedRatio 是自报口径，
                    // 模型从不据此决策，每命中白付 82 B。正文由下面的额度闸门决定附不附。
                    hits.push({
                        file,
                        lang: LANG_NAME[lang] ?? String(lang),
                        lines: [r.start.line + 1, r.end.line + 1],
                        signature: text.split(RE_LINE)[0].trim().slice(0, 160),
                    });
                    bodies.push(text);
                    if (hits.length >= limit)
                        break;
                }
            }
            if (hits.length === 0 && retryViaWalk())
                continue;
            if (hits.length === 0) {
                const hint = pruned
                    ? `；枚举 ${candidates.length} 个文件，扫描预算只覆盖了优先级最高的 ${SCAN_BUDGET}（pruned），请收敛 roots 或调大 scanBudget`
                    : '';
                return done({ status: 'error', code: 'E_INPROC_NO_MATCH', message: `符号 ${req.symbol} 未找到（预筛后 ${pool.length} 个候选${hint}）` });
            }
            // 正文附赠：额度内直接给正文，超了退回「行号 + 一次就够的 readHint」。
            // 代价上限 = 一个常量，收益 = 省掉一次 ops_read_files 往返 —— 那次往返要重发整个上下文，
            // 恒大于这点字节，所以只要模型本来就要看这段源码，这一附就是净赚。
            // `body` 不在公开签名里（历史字段）：false 关掉正文，正数当字节预算。
            const body = (req as LocateRequest & { body?: boolean | number }).body;
            const wantBody = body !== false;
            const budget = typeof body === 'number' && body > 0
                ? Math.min(body, BODY_AUTO_BYTES * 4)
                : BODY_AUTO_BYTES;
            let used = 0;
            let omitted = 0;
            if (wantBody) {
                for (let i = 0; i < hits.length; i++) {
                    const size = Buffer.byteLength(bodies[i], 'utf8');
                    if (used + size > budget) {
                        omitted++;
                        continue;
                    }
                    used += size;
                    hits[i].body = bodies[i];
                }
            }
            else {
                omitted = hits.length;
            }
            const first = hits[0];
            if (omitted === 0)
                return done({ hits });
            // 只带参数、不带正文：约 70 B，换掉的是模型自己算 offset/limit 的试错轮。
            return done({
                hits,
                bodyOmitted: omitted,
                readHint: {
                    tool: 'ops_read_files',
                    files: [{ path: first.file, offset: first.lines[0], limit: Math.max(1, first.lines[1] - first.lines[0] + 1) }],
                },
            });
        }
    }
    catch (e) {
        const error = e as { code?: unknown; message?: unknown } | null | undefined;
        const code = error?.code;
        return done({ status: 'error', code: typeof code === 'string' && code.startsWith('E_INPROC_') ? code : 'E_INPROC_INTERNAL', message: String(error?.message ?? e) });
    }
}
/** refactor 结算的入参：status 可省（默认 ok），engine 与 ms 由结算函数自己填。 */
type InprocDraft = Omit<Partial<InprocOutcome>, 'engine' | 'ms'>;
interface TouchedFile {
    file: string;
    edits: number;
    bytesIn: number;
    bytesOut: number;
    sample: string;
    audit: AstAudit;
    cross?: SgCrossCheck;
}
export function inprocRefactor(req: InprocRequest, cwd: string = process.cwd()): InprocOutcome {
    const t0 = performance.now();
    let locate: LocateInfo | undefined;
    // `...o` 在 status 之后展开（调用方给了 status 就用它），类型上 status 因此可能为
    // undefined，出口断言回声明类型。
    const done = (o: InprocDraft): InprocOutcome => ({
        status: o.status ?? 'ok',
        engine: 'inproc-ast',
        ...o,
        ...(locate ? { locate } : {}),
        ms: Math.round((performance.now() - t0) * 100) / 100,
    } as InprocOutcome);
    try {
        validateRequest(req, true);
        const mode = req.mode ?? 'apply';
        const limit = req.limit ?? 1;
        const declared = new Set(req.pattern.match(RE_META_DECL) ?? []);
        for (const meta of req.rewrite.match(RE_META_DECL) ?? []) {
            if (!declared.has(meta))
                throw new InprocError('E_INPROC_TEMPLATE', `模板使用未绑定变量 ${meta}`);
        }
        const template = compileTemplate(req.rewrite);
        const pending: Array<{ file: string; before: Buffer; after: string }> = [];
        let candidates: string[];
        let walked = 0;
        if (req.file) {
            candidates = [resolve(cwd, req.file)];
        }
        else {
            const exts = new Set((req.ext ?? ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
            const roots = (req.roots ?? [cwd]).map((r) => resolve(cwd, r));
            const e = enumerate(roots, exts, { strategy: req.strategy, esPath: req.esPath, cwd });
            walked = e.files.length;
            candidates = e.files;
            locate = { via: e.via, ms: e.ms, scanned: e.files.length, truncated: e.truncated };
        }
        if (candidates.length === 0) {
            return done({ status: 'error', code: 'E_INPROC_NO_FILES', message: '枚举零命中' });
        }
        const { pool, pruned } = req.file
            ? { pool: candidates, pruned: false }
            : narrow(candidates, req.symbol ?? null, req.scanBudget);
        if (pruned && locate)
            locate = { ...locate, pruned: true };
        candidates = pool;
        const touched: TouchedFile[] = [];
        let firstError: string | null = null;
        for (const file of candidates) {
            if (touched.length >= limit)
                break;
            let size: number;
            if (reparseEscape(file))
                continue;
            try {
                size = statSync(file).size;
            }
            catch {
                continue;
            }
            if (size > INPROC_MAX_BYTES) {
                return done({ status: 'error', code: 'E_INPROC_TOO_BIG', message: `${basename(file)} ${size} 字节超进程内阈值`, fallback: 'spawn' });
            }
            const lang = langOf(file);
            if (!lang)
                continue;
            const buf = readFileSync(file);
            if (buf.length > INPROC_MAX_BYTES)
                throw new InprocError('E_INPROC_TOO_BIG', `${basename(file)} 读取期间超过大小上限`);
            let src: string;
            try {
                src = utf8Strict.decode(buf);
            }
            catch {
                throw new InprocError('E_INPROC_ENCODING', `${basename(file)} 不是有效 UTF-8`);
            }
            const root = parseAuditRoot(lang, src);
            let scopes: SgNode[];
            if (req.symbol) {
                scopes = locateSymbol(root, req.symbol, src);
                if (scopes.length > 1)
                    throw new InprocError('E_INPROC_SYMBOL_AMBIGUOUS', `${basename(file)} 有 ${scopes.length} 个同名定义: ${req.symbol}`);
                if (scopes.length === 0) {
                    firstError = firstError ?? `符号 ${req.symbol} 在 ${basename(file)} 未找到`;
                    continue;
                }
            }
            else {
                scopes = [root];
            }
            const hits: SgNode[] = [];
            for (const s of scopes) {
                let found: SgNode[];
                try {
                    found = s.findAll({ rule: { pattern: req.pattern } });
                }
                catch (e) {
                    return done({ status: 'error', code: 'E_INPROC_BAD_PATTERN', message: `pattern 语法错误: ${String(e)}` });
                }
                hits.push(...found);
            }
            const uniq = new Map<string, { node: SgNode; startByte: number; endByte: number }>();
            for (const node of hits) {
                const r = node.range();
                uniq.set(`${r.start.index}:${r.end.index}`, { node, startByte: r.start.index, endByte: r.end.index });
            }
            const nodes = [...uniq.values()].sort((a, b) => a.startByte - b.startByte);
            if (nodes.length === 0) {
                firstError = firstError ?? `pattern 零命中: ${req.pattern}`;
                continue;
            }
            const eol = src.includes('\r\n') ? '\r\n' : '\n';
            const templateSource = req.rewrite.includes('$$$') ? root.text() : src;
            const crlf = eol === '\r\n';
            const spans = nodes.map(({ node, startByte, endByte }) => {
                const expanded = expandTemplate(node, template, templateSource);
                const needs = crlf ? expanded.includes('\n') : expanded.includes('\r');
                return { startByte, endByte, text: needs ? expanded.replace(RE_LINE_G, eol) : expanded };
            });
            for (let i = 1; i < spans.length; i++)
                if (spans[i].startByte < spans[i - 1].endByte)
                    throw new InprocError('E_INPROC_OVERLAP', 'AST 命中区间重叠，拒绝改写');
            const editSource = req.rewrite.includes('$$$') ? templateSource : root.text();
            const parts: string[] = [];
            let cursor = 0;
            for (const span of spans) {
                parts.push(editSource.slice(cursor, span.startByte), span.text);
                cursor = span.endByte;
            }
            parts.push(editSource.slice(cursor));
            const after = parts.join('');
            const audit = auditAst(src, after, lang, spans, root);
            if (!audit.ok) {
                return done({
                    status: 'error',
                    code: audit.code ?? 'E_INPROC_BROKEN_AST',
                    message: `${basename(file)}: ${audit.message}`,
                    file,
                    edits: nodes.length,
                    audit,
                });
            }
            let cross: SgCrossCheck | undefined;
            if (req.strict) {
                let fileWide = nodes.length;
                try {
                    fileWide = root.findAll({ rule: { pattern: req.pattern } }).length;
                }
                catch {
                }
                cross = sgCrossCheck(file, req.pattern, LANG_NAME[lang] ?? 'ts', fileWide, req.sgPath ?? 'ast-grep');
                if (!cross.agree) {
                    return done({
                        status: 'error',
                        code: 'E_INPROC_CROSSCHECK',
                        message: `napi 与 sg 对同一 pattern 的整文件命中数不一致（${cross.diff.join(' ')}），拒绝落盘`,
                        file,
                        audit,
                        crossCheck: cross,
                    });
                }
            }
            const sample = nodes[0].node.text().replace(RE_WS_G, ' ').slice(0, 120);
            pending.push({ file, before: buf, after });
            touched.push({
                file,
                edits: nodes.length,
                bytesIn: buf.length,
                bytesOut: Buffer.byteLength(after),
                sample,
                audit,
                cross,
            });
        }
        if (touched.length === 0) {
            return done({
                status: 'error',
                code: 'E_INPROC_NO_MATCH',
                message: firstError ?? '所有候选文件均未改动',
                files: walked,
            });
        }
        const cleanupErrors: string[] = [];
        if (mode === 'apply') {
            for (const item of pending)
                verifySnapshot(item.file, item.before);
            const committed: string[] = [];
            try {
                for (const item of pending) {
                    const receipt = checkedWrite(item.file, item.before, item.after);
                    committed.push(item.file);
                    if (receipt.cleanupErrors.length)
                        cleanupErrors.push(...receipt.cleanupErrors);
                }
            }
            catch (error) {
                const cause = error as { code?: string; message: string; cleanupErrors?: string[] };
                if (cause.cleanupErrors?.length)
                    cleanupErrors.push(...cause.cleanupErrors);
                return done({ status: 'error', code: cause.code ?? 'E_INPROC_WRITE', message: cause.message, committed, partial: committed.length > 0, ...(cleanupErrors.length ? { cleanupErrors } : {}) });
            }
        }
        const total = touched.reduce((a, t) => ({ edits: a.edits + t.edits, bytesIn: a.bytesIn + t.bytesIn, bytesOut: a.bytesOut + t.bytesOut }), { edits: 0, bytesIn: 0, bytesOut: 0 });
        const merged: AstAudit = {
            ok: touched.every((t) => t.audit.ok),
            hunks: touched.reduce((n, t) => n + t.audit.hunks, 0),
            nodesRemoved: touched.reduce((n, t) => n + t.audit.nodesRemoved, 0),
            nodesAdded: touched.reduce((n, t) => n + t.audit.nodesAdded, 0),
            errorNodes: touched.reduce((n, t) => n + t.audit.errorNodes, 0),
            errorNodesBefore: touched.reduce((n, t) => n + t.audit.errorNodesBefore, 0),
            parser: touched.every((t) => t.audit.parser === 'tsc') ? 'tsc' : 'tree-sitter',
            diagAfter: touched.reduce((n, t) => n + t.audit.diagAfter, 0),
            diagBefore: touched.reduce((n, t) => n + t.audit.diagBefore, 0),
            unchangedRatio: Math.min(...touched.map((t) => t.audit.unchangedRatio)),
            kinds: [...new Set(touched.flatMap((t) => t.audit.kinds))].slice(0, 6),
            bytesBefore: touched.reduce((n, t) => n + t.audit.bytesBefore, 0),
            bytesAfter: touched.reduce((n, t) => n + t.audit.bytesAfter, 0),
            ms: Math.round(touched.reduce((n, t) => n + t.audit.ms, 0) * 100) / 100,
        };
        return done({
            file: touched.length === 1 ? touched[0].file : `${touched.length} files`,
            symbol: req.symbol,
            edits: total.edits,
            files: touched.length,
            bytesIn: total.bytesIn,
            bytesOut: total.bytesOut,
            staged: mode === 'preview',
            sample: touched[0].sample,
            audit: merged,
            crossCheck: touched.find((t) => t.cross)?.cross,
            ...(cleanupErrors.length ? { cleanupErrors } : {}),
        });
    }
    catch (e) {
        if (e instanceof InprocError) {
            return done({ status: 'error', code: e.code, message: e.message });
        }
        const error = e as { code?: unknown; message?: unknown } | null | undefined;
        const code = error?.code;
        return done({ status: 'error', code: typeof code === 'string' && code.startsWith('E_INPROC_') ? code : 'E_INPROC_INTERNAL', message: String(error?.message ?? e) });
    }
}
function parseFlags(argv: string[]): { flags: Set<string>; get: (k: string) => string | undefined } {
    const flags = new Set<string>();
    const vals = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--'))
            continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            flags.add(key);
            continue;
        }
        vals.set(key, next);
        i += 1;
    }
    return { flags, get: (k) => vals.get(k) };
}
/** inproc 子命令的 CLI 入口；返回进程退出码 */
export function runInprocCli(argv: string[], cwd: string = process.cwd()): number {
    const { flags, get } = parseFlags(argv);
    const sub = argv[0] === 'locate' ? 'locate' : 'refactor';
    const wantJson = !flags.has('quiet');
    if (sub === 'locate') {
        const roots = get('roots');
        const ext = get('ext');
        const out = inprocLocate({
            symbol: get('symbol') ?? '',
            file: get('file'),
            roots: roots ? [roots] : undefined,
            ext: ext ? ext.split(',') : undefined,
            strategy: get('strategy') as LocateStrategy | undefined,
            esPath: get('es'),
            scanBudget: get('budget') ? Number(get('budget')) : undefined,
            limit: get('limit') ? Number(get('limit')) : undefined,
        }, cwd);
        if (wantJson)
            process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        return out.status === 'ok' ? 0 : 1;
    }
    const roots = get('roots');
    const ext = get('ext');
    const out = inprocRefactor({
        pattern: get('pattern') ?? '',
        rewrite: get('rewrite') ?? '',
        symbol: get('symbol'),
        file: get('file'),
        roots: roots ? [roots] : undefined,
        ext: ext ? ext.split(',') : undefined,
        mode: (get('mode') ?? 'preview') as 'apply' | 'preview',
        limit: get('limit') ? Number(get('limit')) : undefined,
        strategy: get('strategy') as LocateStrategy | undefined,
        esPath: get('es'),
        scanBudget: get('budget') ? Number(get('budget')) : undefined,
        strict: flags.has('strict'),
    }, cwd);
    if (wantJson)
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return out.status === 'ok' ? 0 : 1;
}
const entry = process.argv[1] ? basename(process.argv[1]) : '';
if (entry === 'inproc.js' || entry === 'inproc.cjs' || entry === 'inproc.mjs') {
    process.exit(runInprocCli(process.argv.slice(2)));
}
