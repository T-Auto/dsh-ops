import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { reparseEscape } from './reparse';
import { walkBounded } from './inproc';
import {
    PtcOutcomeError,
    dbg,
    normalizeEol,
    parseLooseJson,
    pickBin,
    readRange,
    run,
    stripBom,
    toLines,
} from './proc';
import type { ProcResult, PtcConfig, Stage } from './proc';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const RE_NL = /\r?\n/;
const RE_NL_END = /\r?\n$/;

function buildEsQuery(pattern: string, ext?: string): string {
    const p = pattern.trim();
    if (!ext)
        return p || '*';
    const e = ext.replace(/^\./, '').toLowerCase();
    if (!p || p === '*')
        return `ext:${e}`;
    if (p.toLowerCase().endsWith(`.${e}`))
        return p;
    return `${p} ext:${e}`;
}

/** `*.ts` / `a.ts` / `foo?bar.ts` → 扩展名集合 + basename 正则，供零命中时走 walk 兜底。 */
function queryMatcher(pattern: string | undefined, ext?: string): { exts: Set<string>; test: (name: string) => boolean } {
    const exts = new Set<string>();
    const raw = String(pattern ?? '');
    const tail = /\.([A-Za-z0-9]+)$/.exec(raw);
    if (ext)
        for (const entry of String(ext).split(/[,\s]+/))
            if (entry)
                exts.add(`.${entry.replace(/^\./, '').toLowerCase()}`);
    if (tail)
        exts.add(`.${tail[1].toLowerCase()}`);
    if (exts.size === 0)
        for (const entry of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
            exts.add(entry);
    const base = raw.replace(/^.*[\\/]/, '');
    const source = `^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
    const re = new RegExp(source === '^.*$' ? '.' : source, 'i');
    return { exts, test: (name) => re.test(name) };
}

export interface EverythingQuery {
    pattern: string;
    limit?: number;
    roots?: string[];
    ext?: string;
    regex?: boolean;
    /** cwd=只在当前工作目录内找（默认，避免跑偏到全盘同名文件）；global=全盘索引 */
    scope?: 'cwd' | 'global';
}

export async function everythingFind(cfg: PtcConfig, q: EverythingQuery): Promise<string[]> {
    const args = ['-n', String(q.limit ?? 32)];
    if (q.regex)
        args.push('-r');
    const roots = q.roots?.length ? q.roots.map((r) => path.resolve(cfg.cwd, r)) : [];
    if (roots.length === 0 && q.scope !== 'global')
        roots.push(path.resolve(cfg.cwd));
    for (const r of roots)
        args.push('-path', r);
    args.push(buildEsQuery(q.pattern, q.ext));
    const res = await run(cfg.esPath, args, 'everything', { cwd: cfg.cwd, maxOutputBytes: cfg.maxOutputBytes, timeoutMs: cfg.timeoutMs });
    const stderr = stripBom(res.stderr.toString('utf8')).trim();
    if (/IPC|not running|Everything Service/i.test(stderr)) {
        throw new PtcOutcomeError('E_EVERYTHING_IPC', 'everything', 'es.exe 连不上 Everything IPC：Everything 主程序/服务未运行', stderr.slice(0, 400));
    }
    if (res.code !== 0) {
        throw new PtcOutcomeError('E_EVERYTHING_FAILED', 'everything', `es.exe 退出码 ${res.code}`, stderr.slice(0, 400));
    }
    const inside = (root: string, file: string): boolean => {
        const rel = path.relative(root, file);
        return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
    };
    // es.exe 的索引里既有文件也有目录：`-path <root>` + 子串查询会把 `node_modules/@dsh-ops`
    // 这种目录一起吐出来，流水线随后把它当文件读 —— 实测直接死在 `E_SANE_UNSUPPORTED_LANG`
    // （"不支持的文件类型: "，扩展名为空）。这里只放行真正的普通文件，并且不是重解析点：
    // 索引是历史数据，一个早先建立的链接照样能被它命中。
    const insideRoot = (file: string): boolean => roots.length === 0 || roots.some((root) => inside(root, file));
    const files = (await Promise.all(toLines(res.stdout)
        .map((p) => path.resolve(cfg.cwd, p))
        .filter(insideRoot)
        .map(async (file) => {
        if (reparseEscape(file))
            return null;
        try {
            return (await stat(file)).isFile() ? file : null;
        }
        catch {
            return null;
        }
    }))).filter((file): file is string => file !== null);
    if (files.length === 0) {
        // Everything 的索引是异步建立的：新建的目录/文件在几秒到几分钟内根本不在索引里，
        // 于是「盘上就在 src/ 下」被报成「零命中」。这里用一次有界 walk 按 query 的文件名
        // 与扩展名过滤后兜底，只有在兜底也空的时候才真的熔断。
        const { exts, test } = queryMatcher(q.pattern, q.ext);
        const swept: string[] = [];
        for (const root of (roots.length > 0 ? roots : [path.resolve(cfg.cwd)])) {
            let walked: { files: string[] };
            try {
                walked = walkBounded(root, exts, 2000, performance.now() + 500);
            }
            catch {
                continue;
            }
            for (const candidate of walked.files) {
                if (swept.length >= (q.limit ?? 32))
                    break;
                if (!test(path.basename(candidate)))
                    continue;
                if (reparseEscape(candidate))
                    continue;
                swept.push(candidate);
            }
        }
        if (swept.length === 0) {
            throw new PtcOutcomeError('E_EVERYTHING_NOT_FOUND', 'everything', `es.exe 零命中，流水线熔断：${q.pattern}`, {
                pattern: q.pattern,
                roots: q.roots,
            });
        }
        files.push(...swept);
        dbg(cfg, 'everything-fallback-walk', swept.length);
    }
    const cwdRoot = path.resolve(cfg.cwd);
    const bare = q.pattern.replace(/^.*[\\/]/, '').replace(/^\*\./, '').toLowerCase();
    const rank = (p: string): number => {
        const lower = p.toLowerCase();
        let r = 0;
        if (inside(cwdRoot, p))
            r += 2;
        const base = path.basename(lower);
        if (bare && (base === bare || base === `${bare}.ts` || base === `${bare}.js`))
            r += 2;
        else if (bare && base.includes(bare))
            r += 1;
        return r;
    };
    files.sort((a, b) => rank(b) - rank(a));
    dbg(cfg, 'everything', files.length, 'file(s)', 'top=', files[0]);
    return files;
}

const LANG_BY_EXT: Record<string, string> = {
    '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.cts': 'ts',
    '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
    '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
    '.cs': 'cs', '.rb': 'ruby', '.kt': 'kotlin', '.swift': 'swift', '.php': 'php',
};

export function langOf(file: string): string {
    const lang = LANG_BY_EXT[path.extname(file).toLowerCase()];
    if (!lang) {
        throw new PtcOutcomeError('E_SANE_UNSUPPORTED_LANG', 'sane', `不支持的文件类型: ${path.extname(file)}`, { file });
    }
    return lang;
}

function defPatterns(lang: string): string[] {
    switch (lang) {
        case 'ts':
        case 'tsx':
        case 'js':
        case 'jsx':
            return [
                'function $NAME',
                'class $NAME',
                'interface $NAME',
                'type $NAME',
                'enum $NAME',
                'const $NAME = ($$$A) => { $$$B }',
                'const $NAME = async ($$$A) => { $$$B }',
            ];
        case 'python':
            return ['def $NAME', 'async def $NAME', 'class $NAME'];
        case 'go':
            return ['func $NAME', 'func ($$$R) $NAME', 'type $NAME'];
        case 'rust':
            return ['fn $NAME', 'struct $NAME', 'impl $NAME', 'enum $NAME', 'trait $NAME'];
        case 'java':
        case 'cs':
        case 'kotlin':
            return ['class $NAME', 'interface $NAME', 'enum $NAME', 'record $NAME'];
        default:
            return ['$NAME($$$A) { $$$B }'];
    }
}

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

async function sgJson(cfg: PtcConfig, args: string[], stage: Stage): Promise<{ matches: SgMatch[]; res: ProcResult }> {
    const res = await run(cfg.sgPath, [...args, '--json=stream'], stage, {
        cwd: cfg.cwd,
        maxOutputBytes: cfg.maxOutputBytes, timeoutMs: cfg.timeoutMs,
    });
    const parsed = parseLooseJson(res.stdout.toString('utf8'));
    const matches = parsed.filter((m): m is SgMatch => !!m && typeof m === 'object' && 'range' in m);
    return { matches, res };
}

function reachablePatterns(patterns: string[], source: string): string[] {
    return patterns.filter((p) => {
        const head = /^[A-Za-z_]+/.exec(p)?.[0];
        return !head || source.includes(head);
    });
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

export async function saneLocate(cfg: PtcConfig, file: string, symbol: string, snapshot?: Buffer): Promise<SymbolSlice> {
    const lang = langOf(file);
    const size = snapshot ? snapshot.length : (await stat(file)).size;
    const hits: SgMatch[] = [];
    let lastErr = '';
    const patterns = reachablePatterns(defPatterns(lang), snapshot ? snapshot.toString('utf8') : await readFile(file, 'utf8'));
    for (const pattern of patterns) {
        const { matches, res } = await sgJson(cfg, ['run', '--pattern', pattern, '--lang', lang, file], 'sane');
        if (res.code !== 0 && res.code !== 1) {
            lastErr = stripBom(res.stderr.toString('utf8')).slice(0, 300);
            continue;
        }
        for (const m of matches) {
            if (m.metaVariables?.single?.NAME?.text === symbol)
                hits.push(m);
        }
        if (hits.length > 0)
            break;
    }
    if (hits.length === 0) {
        throw new PtcOutcomeError('E_SANE_SYMBOL_NOT_FOUND', 'sane', `符号 ${symbol} 在 ${path.basename(file)} 中未找到`, {
            file,
            lang,
            stderr: lastErr,
        });
    }
    if (hits.length > 1 && !cfg.allowMulti) {
        throw new PtcOutcomeError('E_SANE_AMBIGUOUS', 'sane', `符号 ${symbol} 有 ${hits.length} 处定义，拒绝盲改`, {
            lines: hits.map((h) => h.range.start.line),
        });
    }
    const hit = hits[0];
    const { start, end } = hit.range.byteOffset;
    const slice = snapshot ? snapshot.subarray(start, end) : await readRange(file, start, end);
    return {
        file,
        symbol,
        lang,
        startByte: start,
        endByte: end,
        startLine: hit.range.start.line,
        endLine: hit.range.end.line,
        totalBytes: size,
        signature: stripBom(slice.toString('utf8')).split(RE_NL)[0].trim().slice(0, 200),
        slice,
        savedRatio: size > 0 ? 1 - slice.length / size : 0,
    };
}

function preserveTrailer(orig: string, next: string, eol: '\r\n' | '\n'): string {
    if (!orig)
        return next;
    let out = next;
    const trailer = /([;,]?)([ \t]*)(\r?\n)?$/.exec(orig);
    if (!trailer)
        return out;
    const [, semi, , nl] = trailer;
    if (semi && !out.trimEnd().endsWith(semi))
        out = out.replace(/[ \t]*$/, '') + semi;
    if (nl && !/\n$/.test(out))
        out += eol;
    return out;
}

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
export async function queryRewrite(cfg: PtcConfig, file: string, o: RewriteOpts): Promise<SgMatch[]> {
    if (o.pattern === o.rewrite) {
        throw new PtcOutcomeError('E_ASTGREP_IDENTITY', 'astgrep', 'pattern 与 rewrite 相同，无操作');
    }
    const { matches, res } = await sgJson(cfg, ['run', '--pattern', o.pattern, '--rewrite', o.rewrite, '--lang', o.lang, file], 'astgrep');
    const stderrText = stripBom(res.stderr.toString('utf8')).trim();
    const noMatchExit = res.code === 1 && matches.length === 0 && stderrText === '';
    if (res.code !== 0 && !noMatchExit) {
        throw new PtcOutcomeError('E_ASTGREP_FAILED', 'astgrep', `ast-grep 退出码 ${res.code}`, stderrText.slice(0, 400));
    }
    return matches;
}

/** 把外部命中收敛成可落盘的编辑集：区间锁、保尾、去空改、重叠熔断。 */
export function finishRewrite(cfg: PtcConfig, matches: SgMatch[], o: RewriteOpts): Edit[] {
    const edits: Edit[] = [];
    for (const m of matches) {
        if (m.replacement == null || !m.replacementOffsets)
            continue;
        const s = m.range.byteOffset.start;
        const e = m.range.byteOffset.end;
        if (o.within && (s < o.within.startByte || e > o.within.endByte))
            continue;
        const text = preserveTrailer(m.text, normalizeEol(m.replacement, o.eol), o.eol);
        if (text === m.text)
            continue;
        edits.push({ startByte: m.replacementOffsets.start, endByte: m.replacementOffsets.end, text, before: m.text });
    }
    if (edits.length === 0) {
        throw new PtcOutcomeError('E_ASTGREP_NO_MATCH', 'astgrep', 'ast-grep 零命中（pattern 与目标语法不匹配，或命中已被 within 过滤）', { pattern: o.pattern, within: o.within, rawMatches: matches.length });
    }
    edits.sort((a, b) => a.startByte - b.startByte);
    for (let i = 1; i < edits.length; i++) {
        if (edits[i].startByte < edits[i - 1].endByte) {
            throw new PtcOutcomeError('E_ASTGREP_OVERLAP', 'astgrep', '补丁区间重叠，拒绝写入', {
                prev: edits[i - 1],
                cur: edits[i],
            });
        }
    }
    dbg(cfg, 'astgrep', edits.length, 'edit(s)');
    return edits;
}

/** 顺序版：查询 + 收敛。并发调用方用 queryRewrite/finishRewrite 自行编排。 */
export async function astGrepRewrite(cfg: PtcConfig, file: string, o: RewriteOpts): Promise<Edit[]> {
    return finishRewrite(cfg, await queryRewrite(cfg, file, o), o);
}

export interface AgentBoxResult {
    ok: true;
    bytesBefore: number;
    bytesAfter: number;
    sha256Before: string;
    sha256After: string;
}

/** agentbox.worker.cjs 的应答体；字段缺失时保持 `undefined`，不做默认值填充。 */
interface AgentBoxReply {
    ok?: boolean;
    code?: string;
    message?: string;
    bytesBefore?: number;
    bytesAfter?: number;
    sha256Before?: string;
    sha256After?: string;
}

export async function agentBoxApply(cfg: PtcConfig, file: string, edits: Array<{
    startByte: number;
    endByte: number;
    text: string;
}>, expectSha256: string): Promise<AgentBoxResult> {
    const payload = JSON.stringify({
        path: path.resolve(file),
        expectSha256,
        atomic: true,
        edits: edits.map((e) => ({
            start: e.startByte,
            end: e.endByte,
            b64: Buffer.from(e.text, 'utf8').toString('base64'),
        })),
    });
    const res = await run(process.execPath, [cfg.agentBoxWorker], 'agentbox', {
        cwd: cfg.cwd,
        stdin: payload,
        maxOutputBytes: cfg.maxOutputBytes, timeoutMs: cfg.timeoutMs,
    });
    const body = parseLooseJson(res.stdout.toString('utf8'))[0] as AgentBoxReply | undefined;
    if (!body) {
        throw new PtcOutcomeError('E_AGENTBOX_CRASH', 'agentbox', `AgentBox 无有效返回（exit=${res.code}）`, stripBom(res.stderr.toString('utf8')).slice(0, 400));
    }
    if (!body.ok) {
        throw new PtcOutcomeError('E_AGENTBOX_REJECTED', 'agentbox', body.message as string, { code: body.code });
    }
    return {
        ok: true,
        bytesBefore: body.bytesBefore as number,
        bytesAfter: body.bytesAfter as number,
        sha256Before: body.sha256Before as string,
        sha256After: body.sha256After as string,
    };
}

/** 整文件回滚也走同一条安全通道，不另开写路径 */
export async function agentBoxRestore(cfg: PtcConfig, file: string, original: Buffer, currentSha: string): Promise<void> {
    const { size } = await stat(file);
    await agentBoxApply(cfg, file, [{ startByte: 0, endByte: size, text: original.toString('utf8') }], currentSha);
}

/**
 * preview 模式用：在内存里按同一套字节区间规则合成 after 镜像，绝不落盘。
 * 规则与 agentbox.worker 严格一致（升序、不重叠、夹紧越界），否则 preview 与 apply 会给出不同结果。
 */
export function applyEditsInMemory(before: Buffer, edits: Array<{
    startByte: number;
    endByte: number;
    text: string;
}>): Buffer {
    const sorted = [...edits].sort((a, b) => a.startByte - b.startByte);
    const parts: Buffer[] = [];
    let cur = 0;
    for (const e of sorted) {
        if (!Number.isSafeInteger(e.startByte) || !Number.isSafeInteger(e.endByte)
            || e.startByte < cur || e.endByte < e.startByte || e.endByte > before.length) {
            throw new PtcOutcomeError('E_AGENTBOX_REJECTED', 'agentbox', `preview 合成失败：非法区间 ${e.startByte}-${e.endByte}`, {
                total: before.length,
            });
        }
        parts.push(before.subarray(cur, e.startByte), Buffer.from(e.text, 'utf8'));
        cur = e.endByte;
    }
    parts.push(before.subarray(cur));
    return Buffer.concat(parts);
}

async function auditPair(beforeBuf: Buffer, file: string, afterBuf?: Buffer): Promise<{ dir: string; before: string; after: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), `ptc-${process.pid}-`));
    const base = path.basename(file);
    const before = path.join(dir, 'before', base);
    const after = path.join(dir, 'after', base);
    try {
        const pairs = await Promise.allSettled([
            mkdir(path.dirname(before), { recursive: true }).then(() => writeFile(before, beforeBuf)),
            mkdir(path.dirname(after), { recursive: true }).then(() => afterBuf
                ? writeFile(after, afterBuf) : copyFile(path.resolve(file), after)),
        ]);
        for (const result of pairs)
            if (result.status === 'rejected')
                throw result.reason;
        return { dir, before, after };
    }
    catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
    }
}

const countLines = (s: string): number => s.split(RE_NL).length;

/** difftastic JSON 的递归 chunk 形状：只有 `chunks` 会影响计数。 */
interface DifftChunk {
    chunks?: DifftChunk[];
}

const countHunks = (chunks: DifftChunk[]): number => chunks.reduce((n, c) => {
    const sub = c?.chunks;
    return n + 1 + (Array.isArray(sub) ? countHunks(sub) : 0);
}, 0);

const linesOf = (s: string): number => (s.length === 0 ? 0 : s.replace(RE_NL_END, '').split(RE_NL).length);

/**
 * 纯审计（无编辑清单）的行级加减：先扣掉公共前缀与公共后缀，中间两侧各剩多少行。
 *
 * 这只是 difftastic 不可用时的降级值，但它必须**诚实**：旧实现直接返回 0/0，让「9000 行
 * 新增」的审计回执写着 +0/-0，模型据此判断「没改什么」。
 */
function lineDelta(beforeText: string, afterText: string): { removed: number; added: number } {
    const a = beforeText.split(RE_NL), b = afterText.split(RE_NL);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head
        && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return { removed: a.length - head - tail, added: b.length - head - tail };
}

/**
 * difftastic 的 `aligned_lines` 是权威对齐：`[lhs, rhs]` 两侧都有，`[null, rhs]` 是新增，
 * `[lhs, null]` 是删除。用它算 +/- 比重新做一次行 diff 便宜，也比按 chunk 计数准确
 * （一个 chunk 里既有改动行又有新增行，按 chunk 数会把两者混为一谈）。
 */
function alignedDelta(aligned: unknown): { added: number; removed: number } | undefined {
    if (!Array.isArray(aligned)) return undefined;
    let added = 0, removed = 0;
    for (const pair of aligned as unknown[]) {
        if (!Array.isArray(pair)) continue;
        if (pair[0] === null || pair[0] === undefined) added++;
        else if (pair[1] === null || pair[1] === undefined) removed++;
    }
    return { added, removed };
}

/** difftastic `--display json` 单条记录里本模块读到的字段。 */
interface DifftRecord {
    chunks?: unknown;
    language?: unknown;
    aligned_lines?: unknown;
}

export interface AuditResult {
    hunks: number;
    addedLines: number;
    removedLines: number;
    language: string;
    summary: string;
    degraded?: string;
}

const difftProbes = new Map<string, Promise<boolean>>();

export async function difftAvailable(cfg: PtcConfig): Promise<boolean> {
    let key: string;
    try {
        const bin = path.resolve(await pickBin([cfg.difftPath]));
        const s = await stat(bin, { bigint: true });
        key = `${bin}\0${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}\0${cfg.maxOutputBytes}`;
    }
    catch {
        try {
            return (await run(cfg.difftPath, ['--version'], 'difftastic', {
                timeoutMs: 5000, maxOutputBytes: cfg.maxOutputBytes,
            })).code === 0;
        }
        catch {
            return false;
        }
    }
    const cached = difftProbes.get(key);
    if (cached)
        return cached;
    const probe = (async (): Promise<boolean> => {
        try {
            return (await run(cfg.difftPath, ['--version'], 'difftastic', {
                timeoutMs: 5000, maxOutputBytes: cfg.maxOutputBytes,
            })).code === 0;
        }
        catch {
            return false;
        }
    })();
    if (difftProbes.size >= 64) {
        const oldest = difftProbes.keys().next().value;
        if (oldest !== undefined)
            difftProbes.delete(oldest);
    }
    difftProbes.set(key, probe);
    if (!await probe && difftProbes.get(key) === probe)
        difftProbes.delete(key);
    return probe;
}

export async function difftasticAudit(cfg: PtcConfig, beforeBuf: Buffer, file: string, edits: Edit[], afterBuf?: Buffer): Promise<{
    audit: AuditResult;
    dir: string;
}> {
    // 纯审计（edits 为空）没有编辑清单可数，加减行只能从对齐结果或文本前缀/后缀推。
    const pure = edits.length === 0;
    const added = edits.reduce((n, e) => n + linesOf(e.text), 0);
    const removed = edits.reduce((n, e) => n + linesOf(e.before), 0);
    if (!await difftAvailable(cfg)) {
        const after = afterBuf ?? Buffer.from(await readFile(file));
        const delta = pure ? lineDelta(beforeBuf.toString('utf8'), after.toString('utf8')) : { added, removed };
        const changed = pure ? delta.added + delta.removed : edits.length;
        return {
            dir: '',
            audit: {
                hunks: changed,
                addedLines: delta.added,
                removedLines: delta.removed,
                language: 'unknown',
                summary: pure
                    ? `+${delta.added}/-${delta.removed} 行（difftastic 不可用，审计降级为行级对齐）`
                    : `+${added}/-${removed} 行，${edits.length} 处改写（difftastic 不可用，审计降级）`,
                degraded: 'difftastic-unavailable',
            },
        };
    }
    const { dir, before, after } = await auditPair(beforeBuf, file, afterBuf);
    try {
        const res = await run(cfg.difftPath, ['--color', 'never', '--display', 'json', before, after], 'difftastic', {
            maxOutputBytes: cfg.maxOutputBytes, timeoutMs: cfg.timeoutMs,
            env: { DFT_UNSTABLE: 'yes' },
        });
        if (res.code !== 0) {
            throw new PtcOutcomeError('E_DIFF_FAILED', 'difftastic', `difftastic 退出码 ${res.code}`, stripBom(res.stderr.toString('utf8')).slice(0, 400));
        }
        const records = parseLooseJson(res.stdout.toString('utf8'));
        if (records.length === 0) {
            throw new PtcOutcomeError('E_DIFF_EMPTY', 'difftastic', 'difftastic 无输出：文件内容未变化');
        }
        const rec = records[0] as DifftRecord;
        const hunks = countHunks(Array.isArray(rec.chunks) ? (rec.chunks as DifftChunk[]) : []);
        const language = String(rec.language ?? 'unknown');
        const delta = (pure ? alignedDelta(rec.aligned_lines) : undefined) ?? { added, removed };
        if (language === 'Text' && cfg.requireAudit) {
            throw new PtcOutcomeError('E_DIFF_FAILED', 'difftastic', 'difftastic 判定为 Text（tree-sitter 解析失败），语法审计不可信', { file });
        }
        return {
            dir: '',
            audit: {
                hunks, addedLines: delta.added, removedLines: delta.removed, language,
                summary: pure
                    ? `${path.basename(file)}：${hunks} 个语法 hunk，+${delta.added}/-${delta.removed} 行（${language}）`
                    : `${path.basename(file)}：${hunks} 个语法 hunk，${edits.length} 处改写，+${delta.added}/-${delta.removed} 行（${language}）`,
            },
        };
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}

export { sha256 };
