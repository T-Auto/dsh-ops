/**
 * 分级寻址的枚举层：进程内 walk + Everything（es.exe）+ 30s 结果缓存。
 *
 * 从 `inproc.ts` 拆出来的原因：inproc 同时装着寻址、改写、CLI 三件事，单文件会越过
 * 1000 行；而这一层自成一体（只依赖 fs / child_process / path 与 es 候选链），
 * 拆开后 `inproc.ts` 原样 re-export，公开面一个字不变。
 */
import { existsSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { esCandidates } from './proc.cjs';
import { InprocError } from './inproc-error.cjs';
import type { LocateStrategy } from './inproc.cjs';
const RE_LINE = /\r?\n/;
const RE_SEP = /[\\/]/;
const RE_SEP_G = /[\\/]/g;
const RE_EXCLUDED_SEG = /[\\/](node_modules|\.git|dist|coverage|\.tmp|\.sandbox)[\\/]/;
export function walkBounded(root: string, exts: Set<string>, cap: number, deadline: number): {
    files: string[];
    overflow: boolean;
} {
    const out: string[] = [];
    const stack: string[] = [root];
    let ticks = 0;
    while (stack.length) {
        // while 保证非空，pop 的结果不可能是 undefined
        const cur = stack.pop() as string;
        if (++ticks % 64 === 0 && performance.now() > deadline)
            return { files: out, overflow: true };
        let entries: Dirent[];
        try {
            entries = readdirSync(cur, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of entries) {
            const p = join(cur, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist')
                    continue;
                stack.push(p);
            }
            else if (exts.has(extname(e.name).toLowerCase())) {
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
interface CachedEnum {
    files: string[];
    at: number;
    via: 'walk' | 'everything';
    ms: number;
    truncated: boolean;
}
const enumCache = new Map<string, CachedEnum>();
const CACHE_TTL = 30_000;
export function clearEnumCache(): void {
    enumCache.clear();
}
function resolveEs(explicit: string | undefined, cwd: string): string | null {
    for (const c of esCandidates(explicit, cwd)) {
        if (RE_SEP.test(c)) {
            if (existsSync(c))
                return c;
        }
        else if (spawnSync(c, ['-h'], { windowsHide: true, timeout: 3000 }).error === undefined) {
            return c;
        }
    }
    return null;
}
function enumerateByEverything(roots: string[], exts: Set<string>, esPath: string, limit: number): {
    files: string[];
    truncated: boolean;
} {
    const args = ['-n', String(limit)];
    for (const r of roots)
        args.push('-path', r);
    args.push(`ext:${[...exts].map((e) => e.slice(1)).join(';')}`);
    const r = spawnSync(esPath, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: false, maxBuffer: 256 << 20 });
    if (r.error || r.status !== 0)
        return { files: [], truncated: false };
    const raw = String(r.stdout ?? '').split(RE_LINE).map((l) => l.trim()).filter(Boolean);
    const files = raw.map((l) => resolve(l)).filter((file) => exts.has(extname(file).toLowerCase()) &&
        !RE_EXCLUDED_SEG.test(file) &&
        roots.some((root) => { const rel = relative(root, file); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }));
    return { files, truncated: raw.length >= limit };
}
function looksLikeWorkRoot(root: string): boolean {
    try {
        const names = readdirSync(root, { withFileTypes: true });
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
export interface EnumerateResult {
    files: string[];
    /** 实际用了哪种寻址，如实回给调用方 */
    via: 'walk' | 'everything';
    /** 枚举达到上限被截断，结果可能不完整 */
    truncated: boolean;
    ms: number;
    /** 命中进程内缓存（30s TTL），此时 ms≈0 */
    cached?: boolean;
}
export function enumerate(roots: string[], exts: Set<string>, opts: {
    strategy?: LocateStrategy;
    esPath?: string;
    cwd: string;
    limit?: number;
    refresh?: boolean;
}): EnumerateResult {
    const t0 = performance.now();
    const strategy = opts.strategy ?? 'auto';
    const cap = opts.limit ?? ES_CROSSOVER;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_ES_FILES)
        throw new InprocError('E_INPROC_ARGUMENT', `limit 必须在 1..${MAX_ES_FILES}`);
    roots = [...new Set(roots.map((r) => resolve(opts.cwd, r)))];
    const key = JSON.stringify([strategy, [...exts].sort(), roots, cap, resolve(opts.cwd), opts.esPath ?? null]);
    if (!opts.refresh) {
        const hit = enumCache.get(key);
        if (hit && Date.now() - hit.at < CACHE_TTL) {
            return { files: [...hit.files], via: hit.via, truncated: hit.truncated, ms: 0, cached: true };
        }
    }
    const done = (files: string[], via: 'walk' | 'everything', truncated: boolean): EnumerateResult => {
        const unique = [...new Set(files)];
        const bounded = unique.slice(0, cap);
        truncated ||= unique.length > cap;
        if (enumCache.size >= 32)
            enumCache.delete(enumCache.keys().next().value as string);
        enumCache.set(key, { files: [...bounded], at: Date.now(), via, ms: performance.now() - t0, truncated });
        return { files: bounded, via, truncated, ms: Math.round((performance.now() - t0) * 100) / 100 };
    };
    const fromEs = (): EnumerateResult | null => {
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
    const all = new Set<string>();
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
