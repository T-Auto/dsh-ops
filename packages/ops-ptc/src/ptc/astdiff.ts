/**
 * 进程内 AST 审计 —— difftastic 的零 fork 替代品
 *
 * difftastic 要起一个 36ms 的子进程、把两份文件写到 tmp、再读回 JSON。
 * 但它真正要回答的问题只有三个，全都能在已经 parse 过的两棵树上就地算出来：
 *
 *   ① 改后的文件语法还完整吗？          → after 树里的 ERROR 节点数
 *   ② 改动的范围是不是只有我提交的那几处？→ 区间外逐字节比对 + 区间内节点计数
 *   ③ 结构有没有被大改？                → 区间内 kind 集合的前后差异
 *
 * 成本：两次 parse（~0.4ms/千行）+ O(n) 遍历，比 difftastic 快两个数量级，
 * 且不需要任何外部二进制。`ops_ptc_audit` 仍然保留 difftastic 作为独立复核。
 */
import { parse, type SgNode } from '@ast-grep/napi';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export interface AstSpan {
    /**
     * 注意：与 `@ast-grep/napi` 的 `range().index` 同域 —— **UTF-16 字符索引，不是字节偏移**。
     * napi 的 `node.replace()` / `commitEdits()` 也在这个域里工作，混用字节偏移会在
     * 中文/emoji 源码上错位（实测：`export function demo(){\r\n return 说明; }` 字节 59 vs 字符 49）。
     */
    startByte: number;
    endByte: number;
}

export interface AstAudit {
    ok: boolean;
    /** 真实产生了结构变化的编辑区间数 */
    hunks: number;
    /** 区间内被替换掉的命名节点数 */
    nodesRemoved: number;
    /** 区间内新产生的命名节点数 */
    nodesAdded: number;
    /** after 树里的 ERROR 节点数；是否新增诊断由 ok 表示 */
    errorNodes: number;
    /** before 树里的 ERROR 节点数，>0 说明原文件本来就不完整 */
    errorNodesBefore: number;
    /** 谁判的语法完整性：tsc=TypeScript 编译器解析诊断，tree-sitter=仅 ERROR 节点 */
    parser: 'tsc' | 'tree-sitter';
    /** 语法诊断条数（parser=tsc 时来自 parseDiagnostics，tree-sitter 时同 errorNodes） */
    diagAfter: number;
    diagBefore: number;
    /** 区间外字节占比，越低说明改动面越大 */
    unchangedRatio: number;
    /** 区间内出现过的顶层 kind，用于摘要（最多 6 个） */
    kinds: string[];
    bytesBefore: number;
    bytesAfter: number;
    ms: number;
    code?: string;
    message?: string;
}

/** 缓存里的 root 及其出处：`lang` / `text` 用来验证调用方传进来的树确实是同一份快照 */
interface RootMeta {
    lang: Parameters<typeof parse>[0];
    text: string;
    root: SgNode;
    errors: SgNode[] | null;
}

/** 命名节点的区间，与 {@link AstSpan} 同域（UTF-16 字符索引） */
interface NodeSpan {
    kind: string;
    start: number;
    end: number;
}

/** 一条待应用的编辑：区间 + 替换文本 */
type EditSpan = AstSpan & {
    text: string;
};

/** 一条语法诊断；`code` 在 tsc 口径下是数字，在 tree-sitter 口径下固定 'ERROR' */
interface SyntaxDiag {
    start: number;
    length: number;
    code: number | string;
    message: string;
}

const errorsOf = (meta: RootMeta): SgNode[] => meta.errors ?? (meta.errors = meta.root.findAll({ rule: { kind: 'ERROR' } }));

/** root → 出处。WeakMap 保证树被回收时元数据一并释放 */
const auditRoots = new WeakMap<SgNode, RootMeta>();

const ROOT_CACHE_MAX_ENTRIES = 6;
const ROOT_CACHE_MAX_CHARS = 4 << 20;

/** lang → (整份文本 → root)。同一份文本重复审计时省掉第二次 parse */
const rootCache = new Map<string, Map<string, RootMeta>>();
let rootCacheChars = 0;
let rootCacheEntries = 0;

/** 淘汰最老的一条 root 缓存；全空时返回 false，让调用方的 while 收口 */
function evictOldestRoot(): boolean {
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

function cachedRoot(lang: Parameters<typeof parse>[0], text: string): RootMeta | undefined {
    const bucket = rootCache.get(String(lang));
    const hit = bucket?.get(text);
    if (!hit || !bucket)
        return undefined;
    bucket.delete(text);
    bucket.set(text, hit);
    return hit;
}

export function parseAuditRoot(lang: Parameters<typeof parse>[0], text: string): SgNode {
    const hit = cachedRoot(lang, text);
    if (hit)
        return hit.root;
    const root = parse(lang, text).root();
    const meta: RootMeta = { lang, text, root, errors: null };
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

const collect = (node: SgNode, out: NodeSpan[]): void => {
    for (const child of node.namedChildren()) {
        const r = child.range();
        out.push({ kind: String(child.kind()), start: r.start.index, end: r.end.index });
        collect(child, out);
    }
};

/** 二分找第一个 `endByte > start` 的区间，即唯一可能包含 `start` 的那个 */
const firstEndingAfter = (spans: ReadonlyArray<AstSpan>, start: number): number => {
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

const collectWithin = (node: SgNode, spans: ReadonlyArray<AstSpan>, out: NodeSpan[]): void => {
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

/** 每个编辑区间内是否至少落着一个节点；用后缀最小 end 做 O(n) 判定 */
const containedSpans = (spans: ReadonlyArray<AstSpan>, nodes: ReadonlyArray<NodeSpan>): boolean[] => {
    const minEnds = new Array<number>(nodes.length + 1);
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

const normalizeSpans = <T extends AstSpan>(spans: ReadonlyArray<T>): T[] => [...spans].sort((a, b) => a.startByte - b.startByte);

type TsModule = typeof import('typescript');
type TsScriptKind = import('typescript').ScriptKind;
type TsDiagnostic = import('typescript').Diagnostic;

/** `parseDiagnostics` 是 tsc 的内部字段，公共 d.ts 里没有声明，只能按真实形状取 */
type SourceFileWithDiagnostics = { parseDiagnostics: ReadonlyArray<TsDiagnostic> };

let tsMod: TsModule | null | undefined;

/** 本模块编成 CJS，`createRequire` 是唯一能在 import 之外做同步可选依赖探测的入口 */
const requireFromHere = createRequire(__filename);

/**
 * `typescript` 是可选依赖：装了就拿它的 parseDiagnostics 当语法 oracle，没装就退回
 * tree-sitter 的 ERROR 节点。所以这里只能同步探测，不能写成静态 import。
 */
const loadTs = (): TsModule | null => {
    if (tsMod !== undefined)
        return tsMod;
    try {
        tsMod = requireFromHere('typescript') as TsModule;
    }
    catch {
        tsMod = null;
    }
    return tsMod;
};

const diagnosticCaches = new Map<string, Map<string, SyntaxDiag[]>>();
const DIAGNOSTIC_CACHE_ENTRIES = 16;
const DIAGNOSTIC_CACHE_CHARS = 4_000_000;
let diagnosticCacheChars = 0;

/** 淘汰最老的一条诊断缓存；全空时返回 false，让调用方的 while 收口 */
function evictOldestDiagnostics(): boolean {
    const oldestLang = diagnosticCaches.keys().next().value;
    const bucket = oldestLang === undefined ? undefined : diagnosticCaches.get(oldestLang);
    const oldestText = bucket?.keys().next().value;
    if (oldestLang === undefined || bucket === undefined || oldestText === undefined)
        return false;
    bucket.delete(oldestText);
    diagnosticCacheChars -= oldestText.length;
    if (bucket.size === 0)
        diagnosticCaches.delete(oldestLang);
    return true;
}

function tsDiagnostics(text: string, lang: string): SyntaxDiag[] | null {
    let cache = diagnosticCaches.get(lang);
    const cached = cache?.get(text);
    if (cache && cached !== undefined) {
        cache.delete(text);
        cache.set(text, cached);
        return cached;
    }
    const ts = loadTs();
    if (!ts)
        return null;
    const kinds: Record<string, TsScriptKind | undefined> = {
        TypeScript: ts.ScriptKind.TS,
        Tsx: ts.ScriptKind.TSX,
        JavaScript: ts.ScriptKind.JS,
    };
    const kind = kinds[lang];
    if (kind === undefined)
        return null;
    const sf = ts.createSourceFile('ptc.ts', text, ts.ScriptTarget.Latest, false, kind);
    const diagnostics: SyntaxDiag[] = (sf as unknown as SourceFileWithDiagnostics).parseDiagnostics.map((d) => ({
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
        while (diagnosticCacheChars + text.length > DIAGNOSTIC_CACHE_CHARS
            || [...diagnosticCaches.values()].reduce((n, c) => n + c.size, 0) >= DIAGNOSTIC_CACHE_ENTRIES) {
            if (!evictOldestDiagnostics())
                break;
        }
        cache.set(text, diagnostics);
        diagnosticCacheChars += text.length;
    }
    return diagnostics;
}

/**
 * after 是否出现了 before 没有的诊断。
 *
 * 区间内的诊断本来就可能整条变化（改的就是它），所以先剔掉与编辑区间重叠的旧诊断，
 * 再把剩下的按「编辑前的累计平移量」挪到改后坐标，最后和改后诊断做多重集比对。
 */
function hasNewDiagnostics(before: ReadonlyArray<SyntaxDiag>, after: ReadonlyArray<SyntaxDiag>, edits: ReadonlyArray<EditSpan>, beforeText: string): boolean {
    if (after.length === 0)
        return false;
    if (before.length === 0)
        return true;
    const changed = edits.filter((e) => beforeText.slice(e.startByte, e.endByte) !== e.text);
    const key = (d: SyntaxDiag): string => JSON.stringify([d.start, d.length, d.code, d.message]);
    const remaining = new Map<string, number>();
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

/** 按区间把编辑拼回 before；区间本身非法（越界/乱序）时抛错，由调用方翻成 E_AST_AUDIT_SPAN */
function spliceSorted(before: string, sorted: ReadonlyArray<EditSpan>): string {
    const parts: string[] = [];
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

/** 把编辑还原成 after，用于证明「除了我提交的这几处，没有任何字符被动过」 */
export function spliceExpect(before: string, edits: Array<AstSpan & {
    text: string;
}>): string {
    return spliceSorted(before, normalizeSpans(edits));
}

/**
 * @param lang  已解析出 AST 时用的语言（与调用方 parse 时相同）
 * @param edits 本轮提交的编辑，用于区间外比对
 */
/** Pipeline preflight needs syntax and exact-splice proof, not unused hunk statistics. */
export function auditSyntax(beforeText: string, afterText: string, lang: Parameters<typeof parse>[0], edits: Array<AstSpan & {
    text: string;
}>): Pick<AstAudit, 'ok' | 'code' | 'message'> {
    const spans = normalizeSpans(edits);
    let expect: string;
    try {
        expect = spliceSorted(beforeText, spans);
    }
    catch (e) {
        const error = e as Error;
        return { ok: false, code: 'E_AST_AUDIT_SPAN', message: String(error.message) };
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
    let diagnosticsBefore: SyntaxDiag[];
    let diagnosticsAfter: SyntaxDiag[];
    if (tscBefore !== null && tscAfter !== null) {
        diagnosticsBefore = tscBefore;
        diagnosticsAfter = tscAfter;
    }
    else {
        const treeDiagnostics = (root: SgNode): SyntaxDiag[] => root.findAll({ rule: { kind: 'ERROR' } }).map(n => {
            const start = n.range().start.index;
            const end = n.range().end.index;
            return { start, length: end - start, code: 'ERROR' as const, message: n.text() };
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

export function auditAst(beforeText: string, afterText: string, lang: Parameters<typeof parse>[0], edits: Array<AstSpan & {
    text: string;
}>, 
/** Same-language whole-source root from this call's immutable snapshot. */
beforeRoot?: SgNode): AstAudit {
    const t0 = performance.now();
    const spans = normalizeSpans(edits);
    const base: AstAudit = {
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
    let expect: string;
    try {
        expect = spliceSorted(beforeText, spans);
    }
    catch (e) {
        const error = e as Error;
        return { ...base, ok: false, code: 'E_AST_AUDIT_SPAN', message: String(error.message), ms: performance.now() - t0 };
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
    const reuseBefore = provenance !== undefined && provenance.lang === lang && provenance.text === beforeText;
    const rootBefore = reuseBefore && beforeRoot !== undefined ? beforeRoot : parseAuditRoot(lang, beforeText);
    const rootAfter = parseAuditRoot(lang, afterText);
    // 两个 root 都出自 `parseAuditRoot`，元数据必然登记过
    const errorsBefore = errorsOf(auditRoots.get(rootBefore)!);
    const errorsAfter = errorsOf(auditRoots.get(rootAfter)!);
    const errBefore = errorsBefore.length;
    const errAfter = errorsAfter.length;
    const removed: NodeSpan[] = [];
    const added: NodeSpan[] = [];
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
    const treeDiagnostics = (nodes: ReadonlyArray<SgNode>): SyntaxDiag[] => nodes.map((n) => ({
        start: n.range().start.index,
        length: n.range().end.index - n.range().start.index,
        code: 'ERROR' as const,
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

export interface SgCrossCheck {
    /** 两引擎命中数是否一致 */
    agree: boolean;
    napiCount: number;
    sgCount: number;
    /** 失败的命中区间（sg 独有 / napi 独有），一致时为空 */
    diff: string[];
    ms: number;
    stderr?: string;
}

/**
 * 用 `sg` CLI 独立跑同一个 pattern，和 napi 的命中数对账。
 *
 * 用途不是提速，是证伪：napi 与 CLI 走同一份 Rust 核心但不同调用路径
 * （addon vs 二进制、rule 解析 vs 命令行参数），两者一致才说明
 * 「我改的确实是这个 pattern 的结果」，而不是 addon 版本的行为偏差。
 */
export function sgCrossCheck(file: string, pattern: string, lang: string, napiCount: number, sgPath = 'ast-grep', timeoutMs = 20_000): SgCrossCheck {
    const t0 = performance.now();
    const r = spawnSync(sgPath, ['run', '--pattern', pattern, '--lang', lang, '--json=stream', file], {
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
