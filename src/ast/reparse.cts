/**
 * Reparse-point refusal for the in-process AST engine.
 *
 * The engine reads whatever path the caller names, and it also reads every file an enumeration
 * hands back. Neither `statSync` nor `readFileSync` notices a symlink or a Windows junction, so a
 * link inside the workspace is enough to read outside it. The host adapter refuses a link the
 * caller *names*; this module covers the files the engine *finds*, which the adapter never sees.
 *
 * Fast path first: one `realpath` resolves the whole chain, and "resolved == requested" proves no
 * component was rewritten. The lstat walk only runs when the two differ, and then it has a job —
 * naming the offending entry. This matters on the enumeration paths: 32 candidates used to cost
 * 32 × (path depth) `lstat` calls, which is the single largest cost of a tree-wide locate.
 *
 * Kept as CommonJS and inside `lib/ast` so the package stays consumable from both the ESM host
 * and a plain `require`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const REPARSE_DENIED = 'Links, reparse points and special objects are not traversed; inspect the target path for the offending entry';

/**
 * Walk to `boundary` (exclusive), naming the first reparse point. Absence is not a verdict.
 *
 * The boundary is the workspace root the caller chose: components at or above it — macOS reaches
 * a tmpdir through `/var → /private/var`, for example — are system-level links, not workspace
 * content, and the caller's choice of workspace is their authority decision. Only a link at or
 * below the boundary can route a workspace read outside the workspace, so only those are named.
 * Without a boundary the walk keeps the old strictness and goes to the volume root.
 */
function walk(target: string, boundary?: string): string | undefined {
    const stop = boundary === undefined ? undefined : path.resolve(boundary);
    let current = path.resolve(target);
    for (;;) {
        if (stop !== undefined) {
            const low = current.toLowerCase();
            const stopLow = stop.toLowerCase();
            if (low === stopLow || !low.startsWith(stopLow + path.sep))
                return undefined;
        }
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(current);
        }
        catch {
            return undefined;
        }
        if (stat.isSymbolicLink())
            return current;
        const parent = path.dirname(current);
        if (parent === current)
            return undefined;
        current = parent;
    }
}

/**
 * The first component at or below `target` that is a reparse point, or `undefined`.
 *
 * A missing path returns `undefined`: absence is the caller's problem to report, not a policy
 * verdict. With a `boundary`, the walk stops there; without one it stops at the volume root.
 */
export function reparseEscape(target: string, boundary?: string): string | undefined {
    if (typeof target !== 'string' || target === '')
        return undefined;
    const resolved = path.resolve(target);
    let real: string;
    try {
        real = fs.realpathSync.native(resolved);
    }
    catch {
        return undefined;
    }
    // 8.3 短名与本机大小写同样会让两个字符串不等，却不含任何链接 —— 所以不等只说明
    // "要再看一眼"，真正定罪仍由 lstat 链给出。
    if (real.toLowerCase() === resolved.toLowerCase())
        return undefined;
    return walk(resolved, boundary);
}

/**
 * The enumerated root that contains `file` (longest prefix wins), or `fallback`.
 *
 * Enumeration hands back paths under one of the roots, so the containing root is the workspace
 * boundary for that candidate. Callers whose file came from outside the roots pass a fallback —
 * the file's own directory, so only the named path itself is judged, never its ancestry.
 */
export function reparseBoundary(file: string, roots: readonly string[], fallback?: string): string | undefined {
    const low = path.resolve(file).toLowerCase();
    let best: string | undefined;
    for (const root of roots) {
        const resolved = path.resolve(root);
        const rootLow = resolved.toLowerCase();
        if ((low === rootLow || low.startsWith(rootLow + path.sep)) && (best === undefined || resolved.length > best.length))
            best = resolved;
    }
    return best ?? fallback;
}
