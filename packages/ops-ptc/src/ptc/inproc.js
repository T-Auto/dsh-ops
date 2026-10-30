"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearEnumCache = clearEnumCache;
exports.enumerate = enumerate;
exports.inprocLocate = inprocLocate;
exports.inprocRefactor = inprocRefactor;
exports.runInprocCli = runInprocCli;
exports.walkBounded = walkBounded;
const napi_1 = require("./engine-load").napi;
const node_fs_1 = require("node:fs");
const safe_write_1 = require("./safe-write");
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
const astdiff_1 = require("./astdiff");
const proc_1 = require("./proc");
const reparse_1 = require("./reparse");
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const RE_SEP = /[\\/]/;
const RE_SEP_G = /[\\/]/g;
const RE_SRC_SEG = /[\\/]src[\\/]/;
const RE_GENERATED = /\.(gen|d)\.(ts|tsx|js|jsx)$/;
const RE_TEST_FILE = /\.(test|spec)\.(t|j)sx?$/;
const RE_NOISE_SEG = /[\\/](node_modules|dist|coverage)[\\/]/;
const RE_EXCLUDED_SEG = /[\\/](node_modules|\.git|dist|coverage|\.tmp|\.sandbox)[\\/]/;
const RE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RE_KEYWORD_HEAD = /^[A-Za-z_]+/;
const RE_LINE = /\r?\n/;
const RE_LINE_G = /\r?\n/g;
const RE_META_DECL = /\$(?:\$\$)?[A-Z_][A-Z0-9_]*/g;
const RE_WS_G = /\s+/g;
function validateRequest(value, refactor) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new InprocError('E_INPROC_ARGUMENT', '请求必须是对象');
    const req = value;
    const stringFields = ['file', 'symbol', 'sgPath', 'esPath'];
    for (const key of stringFields)
        if (req[key] !== undefined && (typeof req[key] !== 'string' || !req[key].trim()))
            throw new InprocError('E_INPROC_ARGUMENT', `${key} 必须是非空字符串`);
    if (!refactor && typeof req.symbol !== 'string')
        throw new InprocError('E_INPROC_ARGUMENT', 'symbol 必填');
    if (refactor && (typeof req.pattern !== 'string' || !req.pattern.trim() || typeof req.rewrite !== 'string'))
        throw new InprocError('E_INPROC_ARGUMENT', 'pattern 必须非空，rewrite 必须是字符串');
    for (const key of ['limit', 'scanBudget'])
        if (req[key] !== undefined && (!Number.isSafeInteger(req[key]) || req[key] < 1 || req[key] > 150_000))
            throw new InprocError('E_INPROC_ARGUMENT', `${key} 必须在 1..150000`);
    for (const key of ['roots', 'ext'])
        if (req[key] !== undefined && (!Array.isArray(req[key]) || !req[key].every((s) => typeof s === 'string' && s.trim())))
            throw new InprocError('E_INPROC_ARGUMENT', `${key} 必须是非空字符串数组`);
    if (req.mode !== undefined && req.mode !== 'apply' && req.mode !== 'preview')
        throw new InprocError('E_INPROC_ARGUMENT', 'mode 必须为 apply 或 preview');
    if (req.strategy !== undefined && !['auto', 'walk', 'everything'].includes(req.strategy))
        throw new InprocError('E_INPROC_ARGUMENT', '无效 strategy');
    if (req.strict !== undefined && typeof req.strict !== 'boolean')
        throw new InprocError('E_INPROC_ARGUMENT', 'strict 必须是 boolean');
}
class InprocError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'InprocError';
    }
}
const LANG_BY_EXT = {
    '.ts': napi_1.Lang.TypeScript,
    '.mts': napi_1.Lang.TypeScript,
    '.cts': napi_1.Lang.TypeScript,
    '.tsx': napi_1.Lang.Tsx,
    '.js': napi_1.Lang.JavaScript,
    '.mjs': napi_1.Lang.JavaScript,
    '.cjs': napi_1.Lang.JavaScript,
    '.jsx': napi_1.Lang.Tsx,
    '.html': napi_1.Lang.Html,
    '.htm': napi_1.Lang.Html,
    '.css': napi_1.Lang.Css,
};
const INPROC_MAX_BYTES = 2 << 20;
const LANG_NAME = {
    [napi_1.Lang.TypeScript]: 'ts',
    [napi_1.Lang.Tsx]: 'tsx',
    [napi_1.Lang.JavaScript]: 'js',
    [napi_1.Lang.Html]: 'html',
    [napi_1.Lang.Css]: 'css',
};
const langOf = (file) => LANG_BY_EXT[(0, node_path_1.extname)(file).toLowerCase()] ?? null;
function walkBounded(root, exts, cap, deadline) {
    const out = [];
    const stack = [root];
    let ticks = 0;
    while (stack.length) {
        const cur = stack.pop();
        if (++ticks % 64 === 0 && performance.now() > deadline)
            return { files: out, overflow: true };
        let entries;
        try {
            entries = (0, node_fs_1.readdirSync)(cur, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of entries) {
            const p = (0, node_path_1.join)(cur, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist')
                    continue;
                stack.push(p);
            }
            else if (exts.has((0, node_path_1.extname)(e.name).toLowerCase())) {
                out.push(p);
                if (out.length > cap)
                    return { files: out, overflow: true };
            }
        }
    }
    return { files: out, overflow: false };
}
const ES_CROSSOVER = 12_000;
const MAX_ES_FILES = 150_000;
const enumCache = new Map();
const CACHE_TTL = 30_000;
function clearEnumCache() {
    enumCache.clear();
}
function resolveEs(explicit, cwd) {
    for (const c of (0, proc_1.esCandidates)(explicit, cwd)) {
        if (RE_SEP.test(c)) {
            if ((0, node_fs_1.existsSync)(c))
                return c;
        }
        else if ((0, node_child_process_1.spawnSync)(c, ['-h'], { windowsHide: true, timeout: 3000 }).error === undefined) {
            return c;
        }
    }
    return null;
}
function enumerateByEverything(roots, exts, esPath, limit) {
    const args = ['-n', String(limit)];
    for (const r of roots)
        args.push('-path', r);
    args.push(`ext:${[...exts].map((e) => e.slice(1)).join(';')}`);
    const r = (0, node_child_process_1.spawnSync)(esPath, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: false, maxBuffer: 256 << 20 });
    if (r.error || r.status !== 0)
        return { files: [], truncated: false };
    const raw = String(r.stdout ?? '').split(RE_LINE).map((l) => l.trim()).filter(Boolean);
    const files = raw.map((l) => (0, node_path_1.resolve)(l)).filter((file) => exts.has((0, node_path_1.extname)(file).toLowerCase()) &&
        !RE_EXCLUDED_SEG.test(file) &&
        roots.some((root) => { const rel = (0, node_path_1.relative)(root, file); return rel !== '..' && !rel.startsWith(`..${node_path_1.sep}`) && !(0, node_path_1.isAbsolute)(rel); }));
    return { files, truncated: raw.length >= limit };
}
function looksLikeWorkRoot(root) {
    try {
        const names = (0, node_fs_1.readdirSync)(root, { withFileTypes: true });
        if (names.some((e) => e.isDirectory() && e.name === 'node_modules'))
            return true;
        const depth = (root.match(RE_SEP_G) ?? []).length;
        const dirs = names.filter((e) => e.isDirectory()).length;
        return depth <= 3 && dirs >= 10;
    }
    catch {
        return false;
    }
}
const WALK_BUDGET_MS = 250;
function enumerate(roots, exts, opts) {
    const t0 = performance.now();
    const strategy = opts.strategy ?? 'auto';
    const cap = opts.limit ?? ES_CROSSOVER;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_ES_FILES)
        throw new InprocError('E_INPROC_ARGUMENT', `limit 必须在 1..${MAX_ES_FILES}`);
    roots = [...new Set(roots.map((r) => (0, node_path_1.resolve)(opts.cwd, r)))];
    const key = JSON.stringify([strategy, [...exts].sort(), roots, cap, (0, node_path_1.resolve)(opts.cwd), opts.esPath ?? null]);
    if (!opts.refresh) {
        const hit = enumCache.get(key);
        if (hit && Date.now() - hit.at < CACHE_TTL) {
            return { files: [...hit.files], via: hit.via, truncated: hit.truncated, ms: 0, cached: true };
        }
    }
    const done = (files, via, truncated) => {
        const unique = [...new Set(files)];
        const bounded = unique.slice(0, cap);
        truncated ||= unique.length > cap;
        if (enumCache.size >= 32)
            enumCache.delete(enumCache.keys().next().value);
        enumCache.set(key, { files: [...bounded], at: Date.now(), via, ms: performance.now() - t0, truncated });
        return { files: bounded, via, truncated, ms: Math.round((performance.now() - t0) * 100) / 100 };
    };
    const fromEs = () => {
        const es = resolveEs(opts.esPath, opts.cwd);
        if (!es)
            return null;
        const result = enumerateByEverything(roots, exts, es, Math.min(cap + 1, MAX_ES_FILES));
        return result.files.length ? done(result.files, 'everything', result.truncated) : null;
    };
    if (strategy === 'everything' || (strategy === 'auto' && roots.some(looksLikeWorkRoot))) {
        const result = fromEs();
        if (result)
            return result;
    }
    const deadline = performance.now() + WALK_BUDGET_MS;
    const all = new Set();
    for (const r of roots) {
        const { files, overflow } = walkBounded(r, exts, cap + 1 - all.size, deadline);
        for (const file of files)
            all.add(file);
        if (overflow || all.size > cap) {
            if (strategy === 'auto') {
                const result = fromEs();
                if (result)
                    return result;
            }
            return done([...all], 'walk', true);
        }
    }
    return done([...all], 'walk', false);
}
const SCAN_BUDGET = 3000;
const SCAN_CHUNK = 400;
function countSep(file) {
    let n = 0;
    for (let i = 0; i < file.length; i++) {
        const c = file.charCodeAt(i);
        if (c === 92 || c === 47)
            n++;
    }
    return n;
}
function rank(file) {
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
function rankOrdered(files) {
    const scored = files.map((file, i) => ({ file, score: rank(file), i }));
    scored.sort((a, b) => a.score - b.score || a.i - b.i);
    return scored.map((x) => x.file);
}
function narrow(candidates, needle, budget = SCAN_BUDGET) {
    if (!needle)
        return { pool: candidates.slice(0, budget), pruned: candidates.length > budget, prefiltered: 0, scanned: 0 };
    const ordered = candidates.length > budget ? rankOrdered(candidates) : candidates;
    const slice = ordered.slice(0, budget);
    const hit = [];
    let scanned = 0;
    for (let i = 0; i < slice.length; i += SCAN_CHUNK) {
        const chunk = slice.slice(i, i + SCAN_CHUNK);
        scanned += chunk.length;
        for (const f of chunk) {
            try {
                if ((0, reparse_1.reparseEscape)(f))
                    continue;
                if ((0, node_fs_1.statSync)(f).size <= INPROC_MAX_BYTES && (0, node_fs_1.readFileSync)(f, 'utf8').includes(needle))
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
function locateSymbol(root, symbol, source) {
    if (source && !source.includes(symbol))
        return [];
    const hits = new Map();
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
    const matcher = (rule) => (constraints ? { rule, constraints } : { rule });
    let groups;
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
];
const META = /\$(\$\$)?([A-Z_][A-Z0-9_]*)/g;
const templateCache = new Map();
function compileTemplate(tpl) {
    const cached = templateCache.get(tpl);
    if (cached) {
        templateCache.delete(tpl);
        templateCache.set(tpl, cached);
        return cached;
    }
    const parts = [];
    const captures = [];
    const slots = new Map();
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
        templateCache.delete(templateCache.keys().next().value);
    templateCache.set(tpl, compiled);
    return compiled;
}
function expandTemplate(node, tpl, source) {
    if (tpl.captures.length === 0)
        return tpl.parts[0];
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
function inprocLocate(req, cwd = process.cwd()) {
    const t0 = performance.now();
    let locate;
    const done = (o) => ({
        status: o.status ?? 'ok',
        engine: 'inproc-ast',
        ...o,
        hits: o.hits ?? [],
        ...(locate ? { locate } : {}),
        ms: Math.round((performance.now() - t0) * 100) / 100,
    });
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
        let candidates;
        if (req.file) {
            candidates = [(0, node_path_1.resolve)(cwd, req.file)];
        }
        else {
            const exts = new Set((req.ext ?? ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
            const roots = (req.roots ?? [cwd]).map((r) => (0, node_path_1.resolve)(cwd, r));
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
        const hits = [];
        // 正文候选与 hits 同序：先收文本，结算时按额度决定附不附（回执字段顺序保持稳定）
        const bodies = [];
        for (const file of pool) {
            if (hits.length >= limit)
                break;
            const lang = langOf(file);
            if (!lang)
                continue;
            let bytes;
            let src;
            try {
                if ((0, reparse_1.reparseEscape)(file))
                    continue;
                if ((0, node_fs_1.statSync)(file).size > INPROC_MAX_BYTES)
                    continue;
                const buf = (0, node_fs_1.readFileSync)(file);
                bytes = buf.length;
                if (bytes > INPROC_MAX_BYTES)
                    continue;
                src = buf.toString('utf8');
            }
            catch {
                continue;
            }
            const root = (0, astdiff_1.parseAuditRoot)(lang, src);
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
        const wantBody = req.body !== false;
        const budget = typeof req.body === 'number' && req.body > 0
            ? Math.min(req.body, BODY_AUTO_BYTES * 4)
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
        const code = e?.code;
        return done({ status: 'error', code: typeof code === 'string' && code.startsWith('E_INPROC_') ? code : 'E_INPROC_INTERNAL', message: String(e?.message ?? e) });
    }
}
function inprocRefactor(req, cwd = process.cwd()) {
    const t0 = performance.now();
    let locate;
    const done = (o) => ({
        status: o.status ?? 'ok',
        engine: 'inproc-ast',
        ...o,
        ...(locate ? { locate } : {}),
        ms: Math.round((performance.now() - t0) * 100) / 100,
    });
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
        const pending = [];
        let candidates;
        let walked = 0;
        if (req.file) {
            candidates = [(0, node_path_1.resolve)(cwd, req.file)];
        }
        else {
            const exts = new Set((req.ext ?? ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
            const roots = (req.roots ?? [cwd]).map((r) => (0, node_path_1.resolve)(cwd, r));
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
        const touched = [];
        let firstError = null;
        for (const file of candidates) {
            if (touched.length >= limit)
                break;
            let size;
            if ((0, reparse_1.reparseEscape)(file))
                continue;
            try {
                size = (0, node_fs_1.statSync)(file).size;
            }
            catch {
                continue;
            }
            if (size > INPROC_MAX_BYTES) {
                return done({ status: 'error', code: 'E_INPROC_TOO_BIG', message: `${(0, node_path_1.basename)(file)} ${size} 字节超进程内阈值`, fallback: 'spawn' });
            }
            const lang = langOf(file);
            if (!lang)
                continue;
            const buf = (0, node_fs_1.readFileSync)(file);
            if (buf.length > INPROC_MAX_BYTES)
                throw new InprocError('E_INPROC_TOO_BIG', `${(0, node_path_1.basename)(file)} 读取期间超过大小上限`);
            let src;
            try {
                src = utf8Strict.decode(buf);
            }
            catch {
                throw new InprocError('E_INPROC_ENCODING', `${(0, node_path_1.basename)(file)} 不是有效 UTF-8`);
            }
            const root = (0, astdiff_1.parseAuditRoot)(lang, src);
            let scopes;
            if (req.symbol) {
                scopes = locateSymbol(root, req.symbol, src);
                if (scopes.length > 1)
                    throw new InprocError('E_INPROC_SYMBOL_AMBIGUOUS', `${(0, node_path_1.basename)(file)} 有 ${scopes.length} 个同名定义: ${req.symbol}`);
                if (scopes.length === 0) {
                    firstError = firstError ?? `符号 ${req.symbol} 在 ${(0, node_path_1.basename)(file)} 未找到`;
                    continue;
                }
            }
            else {
                scopes = [root];
            }
            const hits = [];
            for (const s of scopes) {
                let found;
                try {
                    found = s.findAll({ rule: { pattern: req.pattern } });
                }
                catch (e) {
                    return done({ status: 'error', code: 'E_INPROC_BAD_PATTERN', message: `pattern 语法错误: ${String(e)}` });
                }
                hits.push(...found);
            }
            const uniq = new Map();
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
            const parts = [];
            let cursor = 0;
            for (const span of spans) {
                parts.push(editSource.slice(cursor, span.startByte), span.text);
                cursor = span.endByte;
            }
            parts.push(editSource.slice(cursor));
            const after = parts.join('');
            const audit = (0, astdiff_1.auditAst)(src, after, lang, spans, root);
            if (!audit.ok) {
                return done({
                    status: 'error',
                    code: audit.code ?? 'E_INPROC_BROKEN_AST',
                    message: `${(0, node_path_1.basename)(file)}: ${audit.message}`,
                    file,
                    edits: nodes.length,
                    audit,
                });
            }
            let cross;
            if (req.strict) {
                let fileWide = nodes.length;
                try {
                    fileWide = root.findAll({ rule: { pattern: req.pattern } }).length;
                }
                catch {
                }
                cross = (0, astdiff_1.sgCrossCheck)(file, req.pattern, LANG_NAME[lang] ?? 'ts', fileWide, req.sgPath ?? 'ast-grep');
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
        const cleanupErrors = [];
        if (mode === 'apply') {
            for (const item of pending)
                (0, safe_write_1.verifySnapshot)(item.file, item.before);
            const committed = [];
            try {
                for (const item of pending) {
                    const receipt = (0, safe_write_1.checkedWrite)(item.file, item.before, item.after);
                    committed.push(item.file);
                    if (receipt.cleanupErrors.length)
                        cleanupErrors.push(...receipt.cleanupErrors);
                }
            }
            catch (error) {
                const cause = error;
                if (cause.cleanupErrors?.length)
                    cleanupErrors.push(...cause.cleanupErrors);
                return done({ status: 'error', code: cause.code ?? 'E_INPROC_WRITE', message: cause.message, committed, partial: committed.length > 0, ...(cleanupErrors.length ? { cleanupErrors } : {}) });
            }
        }
        const total = touched.reduce((a, t) => ({ edits: a.edits + t.edits, bytesIn: a.bytesIn + t.bytesIn, bytesOut: a.bytesOut + t.bytesOut }), { edits: 0, bytesIn: 0, bytesOut: 0 });
        const merged = {
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
        const code = e?.code;
        return done({ status: 'error', code: typeof code === 'string' && code.startsWith('E_INPROC_') ? code : 'E_INPROC_INTERNAL', message: String(e?.message ?? e) });
    }
}
function parseFlags(argv) {
    const flags = new Set();
    const vals = new Map();
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
function runInprocCli(argv, cwd = process.cwd()) {
    const { flags, get } = parseFlags(argv);
    const sub = argv[0] === 'locate' ? 'locate' : 'refactor';
    const wantJson = !flags.has('quiet');
    if (sub === 'locate') {
        const out = inprocLocate({
            symbol: get('symbol') ?? '',
            file: get('file'),
            roots: get('roots') ? [get('roots')] : undefined,
            ext: get('ext') ? get('ext').split(',') : undefined,
            strategy: get('strategy'),
            esPath: get('es'),
            scanBudget: get('budget') ? Number(get('budget')) : undefined,
            limit: get('limit') ? Number(get('limit')) : undefined,
        }, cwd);
        if (wantJson)
            process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        return out.status === 'ok' ? 0 : 1;
    }
    const out = inprocRefactor({
        pattern: get('pattern') ?? '',
        rewrite: get('rewrite') ?? '',
        symbol: get('symbol'),
        file: get('file'),
        roots: get('roots') ? [get('roots')] : undefined,
        ext: get('ext') ? get('ext').split(',') : undefined,
        mode: get('mode') ?? 'preview',
        limit: get('limit') ? Number(get('limit')) : undefined,
        strategy: get('strategy'),
        esPath: get('es'),
        scanBudget: get('budget') ? Number(get('budget')) : undefined,
        strict: flags.has('strict'),
    }, cwd);
    if (wantJson)
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return out.status === 'ok' ? 0 : 1;
}
const entry = process.argv[1] ? (0, node_path_1.basename)(process.argv[1]) : '';
if (entry === 'inproc.js' || entry === 'inproc.cjs' || entry === 'inproc.mjs') {
    process.exit(runInprocCli(process.argv.slice(2)));
}
