"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAuditRoot = parseAuditRoot;
exports.spliceExpect = spliceExpect;
exports.auditSyntax = auditSyntax;
exports.auditAst = auditAst;
exports.sgCrossCheck = sgCrossCheck;
const napi_1 = require("./engine-load").napi;
const errorsOf = (meta) => meta.errors ?? (meta.errors = meta.root.findAll({ rule: { kind: 'ERROR' } }));
const auditRoots = new WeakMap();
const ROOT_CACHE_MAX_ENTRIES = 6;
const ROOT_CACHE_MAX_CHARS = 4 << 20;
const rootCache = new Map();
let rootCacheChars = 0;
let rootCacheEntries = 0;
function evictOldestRoot() {
    for (const [key, bucket] of rootCache) {
        const first = bucket.keys().next();
        if (first.done) {
            rootCache.delete(key);
            continue;
        }
        const meta = bucket.get(first.value);
        bucket.delete(first.value);
        if (meta) {
            rootCacheChars -= meta.text.length;
            rootCacheEntries -= 1;
        }
        if (bucket.size === 0)
            rootCache.delete(key);
        return true;
    }
    return false;
}
function cachedRoot(lang, text) {
    const bucket = rootCache.get(String(lang));
    const hit = bucket?.get(text);
    if (!hit || !bucket)
        return undefined;
    bucket.delete(text);
    bucket.set(text, hit);
    return hit;
}
function parseAuditRoot(lang, text) {
    const hit = cachedRoot(lang, text);
    if (hit)
        return hit.root;
    const root = (0, napi_1.parse)(lang, text).root();
    const meta = { lang, text, root, errors: null };
    auditRoots.set(root, meta);
    const key = String(lang);
    let bucket = rootCache.get(key);
    if (!bucket) {
        bucket = new Map();
        rootCache.set(key, bucket);
    }
    bucket.set(text, meta);
    rootCacheChars += text.length;
    rootCacheEntries += 1;
    while (rootCacheEntries > ROOT_CACHE_MAX_ENTRIES || rootCacheChars > ROOT_CACHE_MAX_CHARS) {
        if (!evictOldestRoot())
            break;
    }
    return root;
}
const collect = (node, out) => {
    for (const child of node.namedChildren()) {
        const r = child.range();
        out.push({ kind: String(child.kind()), start: r.start.index, end: r.end.index });
        collect(child, out);
    }
};
const firstEndingAfter = (spans, start) => {
    let lo = 0, hi = spans.length;
    while (lo < hi) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (spans[mid].endByte <= start)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
};
const collectWithin = (node, spans, out) => {
    for (const child of node.namedChildren()) {
        const r = child.range();
        const s = spans[firstEndingAfter(spans, r.start.index)];
        if (!s || r.end.index <= s.startByte)
            continue;
        if (r.start.index >= s.startByte && r.end.index <= s.endByte) {
            out.push({ kind: String(child.kind()), start: r.start.index, end: r.end.index });
        }
        collectWithin(child, spans, out);
    }
};
const containedSpans = (spans, nodes) => {
    const minEnds = new Array(nodes.length + 1);
    minEnds[nodes.length] = Infinity;
    for (let i = nodes.length - 1; i >= 0; i--)
        minEnds[i] = Math.min(nodes[i].end, minEnds[i + 1]);
    let cursor = 0;
    return spans.map((s) => {
        while (cursor < nodes.length && nodes[cursor].start < s.startByte)
            cursor++;
        return minEnds[cursor] <= s.endByte;
    });
};
const normalizeSpans = (spans) => [...spans].sort((a, b) => a.startByte - b.startByte);
let tsMod;
const loadTs = () => {
    if (tsMod !== undefined)
        return tsMod;
    try {
        tsMod = require('typescript');
    }
    catch {
        tsMod = null;
    }
    return tsMod;
};
const diagnosticCaches = new Map();
const DIAGNOSTIC_CACHE_ENTRIES = 16;
const DIAGNOSTIC_CACHE_CHARS = 4_000_000;
let diagnosticCacheChars = 0;
function tsDiagnostics(text, lang) {
    let cache = diagnosticCaches.get(lang);
    const cached = cache?.get(text);
    if (cached !== undefined) {
        cache.delete(text);
        cache.set(text, cached);
        return cached;
    }
    const ts = loadTs();
    if (!ts)
        return null;
    const kinds = {
        TypeScript: ts.ScriptKind.TS,
        Tsx: ts.ScriptKind.TSX,
        JavaScript: ts.ScriptKind.JS,
    };
    const kind = kinds[lang];
    if (kind === undefined)
        return null;
    const sf = ts.createSourceFile('ptc.ts', text, ts.ScriptTarget.Latest, false, kind);
    const diagnostics = sf.parseDiagnostics.map((d) => ({
        start: d.start ?? 0,
        length: d.length ?? 0,
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    }));
    if (!cache) {
        cache = new Map();
        diagnosticCaches.set(lang, cache);
    }
    if (text.length <= DIAGNOSTIC_CACHE_CHARS) {
        while (diagnosticCaches.size > 0 && (diagnosticCacheChars + text.length > DIAGNOSTIC_CACHE_CHARS
            || [...diagnosticCaches.values()].reduce((n, c) => n + c.size, 0) >= DIAGNOSTIC_CACHE_ENTRIES)) {
            const oldestLang = diagnosticCaches.keys().next().value;
            const oldest = diagnosticCaches.get(oldestLang);
            const oldestText = oldest.keys().next().value;
            oldest.delete(oldestText);
            diagnosticCacheChars -= oldestText.length;
            if (oldest.size === 0)
                diagnosticCaches.delete(oldestLang);
        }
        cache.set(text, diagnostics);
        diagnosticCacheChars += text.length;
    }
    return diagnostics;
}
function hasNewDiagnostics(before, after, edits, beforeText) {
    if (after.length === 0)
        return false;
    if (before.length === 0)
        return true;
    const changed = edits.filter((e) => beforeText.slice(e.startByte, e.endByte) !== e.text);
    const key = (d) => JSON.stringify([d.start, d.length, d.code, d.message]);
    const remaining = new Map();
    for (const d of before) {
        const end = d.start + d.length;
        const overlaps = changed.some((e) => {
            if (e.startByte === e.endByte)
                return e.startByte > d.start && e.startByte < end;
            return d.length === 0
                ? d.start >= e.startByte && d.start < e.endByte
                : e.startByte < end && e.endByte > d.start;
        });
        if (overlaps)
            continue;
        const delta = changed.reduce((n, e) => e.endByte <= d.start ? n + e.text.length - (e.endByte - e.startByte) : n, 0);
        const k = key({ ...d, start: d.start + delta });
        remaining.set(k, (remaining.get(k) ?? 0) + 1);
    }
    for (const d of after) {
        const k = key(d);
        const count = remaining.get(k) ?? 0;
        if (count === 0)
            return true;
        remaining.set(k, count - 1);
    }
    return false;
}
function spliceSorted(before, sorted) {
    const parts = [];
    let cur = 0;
    for (const e of sorted) {
        if (!Number.isSafeInteger(e.startByte) || !Number.isSafeInteger(e.endByte)
            || e.startByte < cur || e.endByte < e.startByte || e.endByte > before.length) {
            throw new Error(`非法区间 ${e.startByte}-${e.endByte}（文件 ${before.length} 字符）`);
        }
        parts.push(before.slice(cur, e.startByte), e.text);
        cur = e.endByte;
    }
    parts.push(before.slice(cur));
    return parts.join('');
}
function spliceExpect(before, edits) {
    return spliceSorted(before, normalizeSpans(edits));
}
function auditSyntax(beforeText, afterText, lang, edits) {
    const spans = normalizeSpans(edits);
    let expect;
    try {
        expect = spliceSorted(beforeText, spans);
    }
    catch (e) {
        return { ok: false, code: 'E_AST_AUDIT_SPAN', message: String(e.message) };
    }
    if (expect !== afterText) {
        return {
            ok: false,
            code: 'E_AST_AUDIT_SPLICE',
            message: `编辑区间外出现意外改动（期望 ${expect.length} 字符，实得 ${afterText.length}）`,
        };
    }
    const tscBefore = tsDiagnostics(beforeText, String(lang));
    const tscAfter = tsDiagnostics(afterText, String(lang));
    let diagnosticsBefore;
    let diagnosticsAfter;
    if (tscBefore !== null && tscAfter !== null) {
        diagnosticsBefore = tscBefore;
        diagnosticsAfter = tscAfter;
    }
    else {
        const treeDiagnostics = (root) => root.findAll({ rule: { kind: 'ERROR' } }).map(n => {
            const start = n.range().start.index;
            const end = n.range().end.index;
            return { start, length: end - start, code: 'ERROR', message: n.text() };
        });
        diagnosticsBefore = treeDiagnostics(parseAuditRoot(lang, beforeText));
        diagnosticsAfter = treeDiagnostics(parseAuditRoot(lang, afterText));
    }
    const broke = hasNewDiagnostics(diagnosticsBefore, diagnosticsAfter, spans, beforeText);
    return {
        ok: !broke,
        code: broke ? 'E_AST_AUDIT_BROKEN' : undefined,
        message: broke
            ? `改写引入新语法诊断（改后 ${diagnosticsAfter.length} 条，改前 ${diagnosticsBefore.length} 条，oracle=${tscBefore ? 'tsc' : 'tree-sitter'}），文件已破损`
            : undefined,
    };
}
function auditAst(beforeText, afterText, lang, edits, beforeRoot) {
    const t0 = performance.now();
    const spans = normalizeSpans(edits);
    const base = {
        ok: true,
        hunks: 0,
        nodesRemoved: 0,
        nodesAdded: 0,
        errorNodes: 0,
        errorNodesBefore: 0,
        parser: 'tree-sitter',
        diagAfter: 0,
        diagBefore: 0,
        unchangedRatio: 1,
        kinds: [],
        bytesBefore: Buffer.byteLength(beforeText, 'utf8'),
        bytesAfter: Buffer.byteLength(afterText, 'utf8'),
        ms: 0,
    };
    let expect;
    try {
        expect = spliceSorted(beforeText, spans);
    }
    catch (e) {
        return { ...base, ok: false, code: 'E_AST_AUDIT_SPAN', message: String(e.message), ms: performance.now() - t0 };
    }
    if (expect !== afterText) {
        return {
            ...base,
            ok: false,
            code: 'E_AST_AUDIT_SPLICE',
            message: `编辑区间外出现意外改动（期望 ${expect.length} 字符，实得 ${afterText.length}）`,
            ms: performance.now() - t0,
        };
    }
    const touchedBytes = spans.reduce((n, s) => n + Buffer.byteLength(beforeText.slice(s.startByte, s.endByte), 'utf8'), 0);
    base.unchangedRatio = base.bytesBefore ? Math.max(0, 1 - touchedBytes / base.bytesBefore) : 1;
    const provenance = beforeRoot ? auditRoots.get(beforeRoot) : undefined;
    const reuseBefore = provenance?.lang === lang && provenance.text === beforeText;
    const rootBefore = reuseBefore ? beforeRoot : parseAuditRoot(lang, beforeText);
    const rootAfter = parseAuditRoot(lang, afterText);
    const errorsBefore = errorsOf(reuseBefore ? provenance : auditRoots.get(rootBefore));
    const errorsAfter = errorsOf(auditRoots.get(rootAfter));
    const errBefore = errorsBefore.length;
    const errAfter = errorsAfter.length;
    const removed = [];
    const added = [];
    let delta = 0;
    const afterSpans = spans.map((s) => {
        const startByte = s.startByte + delta;
        delta += s.text.length - (s.endByte - s.startByte);
        return { startByte, endByte: startByte + s.text.length };
    });
    collectWithin(rootBefore, spans, removed);
    collectWithin(rootAfter, afterSpans, added);
    const inBefore = containedSpans(spans, removed);
    const inAfter = containedSpans(afterSpans, added);
    const hunks = spans.filter((_, i) => inBefore[i] || inAfter[i]).length;
    const kinds = [...new Set([...removed, ...added].map((n) => n.kind))].slice(0, 6);
    const tscBefore = tsDiagnostics(beforeText, String(lang));
    const tscAfter = tsDiagnostics(afterText, String(lang));
    const useTsc = tscBefore !== null && tscAfter !== null;
    const parser = useTsc ? 'tsc' : 'tree-sitter';
    const treeDiagnostics = (nodes) => nodes.map((n) => ({
        start: n.range().start.index,
        length: n.range().end.index - n.range().start.index,
        code: 'ERROR',
        message: n.text(),
    }));
    const diagnosticsBefore = tscBefore ?? treeDiagnostics(errorsBefore);
    const diagnosticsAfter = tscAfter ?? treeDiagnostics(errorsAfter);
    const dBefore = diagnosticsBefore.length;
    const dAfter = diagnosticsAfter.length;
    const broke = hasNewDiagnostics(diagnosticsBefore, diagnosticsAfter, spans, beforeText);
    return {
        ...base,
        ok: !broke,
        hunks,
        nodesRemoved: removed.length,
        nodesAdded: added.length,
        errorNodes: errAfter,
        errorNodesBefore: errBefore,
        parser,
        diagAfter: useTsc ? dAfter : errAfter,
        diagBefore: useTsc ? dBefore : errBefore,
        kinds,
        code: broke ? 'E_AST_AUDIT_BROKEN' : undefined,
        message: broke
            ? `改写引入新语法诊断（改后 ${dAfter} 条，改前 ${dBefore} 条，oracle=${parser}），文件已破损`
            : undefined,
        ms: Math.round((performance.now() - t0) * 100) / 100,
    };
}
const node_child_process_1 = require("node:child_process");
function sgCrossCheck(file, pattern, lang, napiCount, sgPath = 'ast-grep', timeoutMs = 20_000) {
    const t0 = performance.now();
    const r = (0, node_child_process_1.spawnSync)(sgPath, ['run', '--pattern', pattern, '--lang', lang, '--json=stream', file], {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        shell: false,
    });
    if (r.error || r.status !== 0) {
        return {
            agree: false,
            napiCount,
            sgCount: -1,
            diff: [],
            ms: Math.round((performance.now() - t0) * 100) / 100,
            stderr: String(r.error?.message ?? r.stderr ?? '').slice(0, 300),
        };
    }
    let sgCount = 0;
    for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s[0] !== '{')
            continue;
        try {
            JSON.parse(s);
            sgCount += 1;
        }
        catch {
        }
    }
    const agree = sgCount === napiCount;
    return {
        agree,
        napiCount,
        sgCount,
        diff: agree ? [] : [`napi=${napiCount}`, `sg=${sgCount}`],
        ms: Math.round((performance.now() - t0) * 100) / 100,
    };
}
