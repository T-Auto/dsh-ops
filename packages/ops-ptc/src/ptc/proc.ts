import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, open } from 'node:fs/promises';
import * as path from 'node:path';

export type Stage = 'everything' | 'sane' | 'astgrep' | 'agentbox' | 'difftastic' | 'inproc' | 'pipeline';
export type PtcErrorCode = 'E_BIN_MISSING' | 'E_TIMEOUT' | 'E_INTERNAL' | 'E_OUTPUT_LIMIT' | 'E_EVERYTHING_FAILED' | 'E_EVERYTHING_IPC' | 'E_EVERYTHING_NOT_FOUND' | 'E_SANE_UNSUPPORTED_LANG' | 'E_SANE_SYMBOL_NOT_FOUND' | 'E_SANE_AMBIGUOUS' | 'E_ASTGREP_FAILED' | 'E_ASTGREP_NO_MATCH' | 'E_ASTGREP_OVERLAP' | 'E_ASTGREP_IDENTITY' | 'E_AGENTBOX_REJECTED' | 'E_AGENTBOX_CRASH' | 'E_DIFF_FAILED' | 'E_DIFF_EMPTY' | 'E_DIFF_REGRESSION' | 'E_BAD_ARGS';

export class PtcOutcomeError extends Error {
    readonly code: PtcErrorCode;
    readonly stage: Stage;
    readonly detail?: unknown;

    constructor(code: PtcErrorCode, stage: Stage, message: string, detail?: unknown) {
        super(message);
        this.code = code;
        this.stage = stage;
        this.detail = detail;
        this.name = 'PtcOutcomeError';
    }

    toOutcome(): { status: 'error'; code: PtcErrorCode; stage: Stage; message: string } {
        return {
            status: 'error',
            code: this.code,
            stage: this.stage,
            message: this.message,
        };
    }
}

export interface PtcConfig {
    cwd: string;
    esPath: string;
    sgPath: string;
    difftPath: string;
    agentBoxWorker: string;
    timeoutMs: number;
    maxOutputBytes: number;
    /** 单次改动字节占比上限，超过即判定回归并回滚 */
    maxChangeRatio: number;
    /** true = difftastic 不可用时回滚报错；false = 标记 degraded 继续 */
    requireAudit: boolean;
    allowMulti: boolean;
    debug: boolean;
}

/**
 * es.exe 寻址候选链：显式配置优先，其次随包 vendor，其次 Everything 官方安装目录，最后 PATH。
 * 为什么要链：es.exe 不是系统命令，单靠 `./es.exe` 会随 cwd 漂移（在 .sandbox 里跑就 ENOENT）。
 */
export const esCandidates = (explicit?: string, cwd?: string): string[] => {
    const list: string[] = [];
    if (explicit)
        list.push(explicit);
    if (cwd)
        list.push(path.resolve(cwd, 'vendor', 'es.exe'), path.resolve(cwd, 'es.exe'));
    list.push(path.join(__dirname, '..', '..', 'vendor', 'es.exe'), 'C:/Program Files/Everything/es.exe', 'C:/Program Files (x86)/Everything/es.exe', 'es.exe', 'es');
    return [...new Set(list)];
};

const RE_ANY_SEP = /[\\/]/;
/**
 * Resolve the Everything CLI once, at config time.
 *
 * `esPath` defaulted to the literal `'./es.exe'`, which is a *path* — so the spawn helper looked
 * for it relative to the process cwd and every consumer that skipped `resolveEs` reported
 * `E_BIN_MISSING` even with the binary sitting in the package's own `vendor/` directory. Resolving
 * here repairs all of them at once, and leaves a bare command name (`es`, `es.exe`) untouched so
 * PATH lookup still works.
 */
export const pickExistingEs = (explicit?: string, cwd?: string): string | undefined => {
    for (const c of esCandidates(explicit, cwd)) {
        if (!RE_ANY_SEP.test(c))
            continue;
        try {
            if (existsSync(c))
                return c;
        }
        catch {
        }
    }
    return explicit;
};

export const defaultConfig = (over: Partial<PtcConfig> = {}): PtcConfig => ({
    cwd: process.cwd(),
    // 候选链全落空时给 `''` 而不是断言：`esPath` 声明为非空 string，空串在任何调用点都是
    // falsy，直接落到 `run()` 报 E_BIN_MISSING —— 与历史上 esPath 为 undefined 的落点一致。
    esPath: pickExistingEs(process.env.PTC_ES, over.cwd ?? process.cwd()) ?? '',
    sgPath: process.env.PTC_SG ?? 'ast-grep',
    difftPath: process.env.PTC_DIFFT ?? 'difft',
    agentBoxWorker: process.env.PTC_AGENTBOX ?? path.join(__dirname, 'agentbox.worker.cjs'),
    timeoutMs: Number(process.env.PTC_TIMEOUT_MS ?? 20_000),
    maxOutputBytes: Number(process.env.PTC_MAX_OUTPUT ?? 8 << 20),
    maxChangeRatio: Number(process.env.PTC_MAX_CHANGE_RATIO ?? 0.2),
    requireAudit: process.env.PTC_REQUIRE_DIFFT === '1',
    allowMulti: process.env.PTC_ALLOW_MULTI === '1',
    debug: process.env.PTC_DEBUG === '1',
    ...over,
});

export const dbg = (cfg: PtcConfig, ...a: unknown[]): void => {
    if (!cfg.debug)
        return;
    const text = a.map((x) => (typeof x === 'string' ? x : safeStr(x))).join(' ');
    process.stderr.write(`[ptc] ${text}\n`);
};

function safeStr(x: unknown): string {
    try {
        return JSON.stringify(x);
    }
    catch {
        return String(x);
    }
}

export interface ProcResult {
    code: number;
    stdout: Buffer;
    stderr: Buffer;
    truncated: boolean;
    ms: number;
}

export interface RunOpts {
    cwd?: string;
    stdin?: string | Buffer | null;
    timeoutMs?: number;
    maxOutputBytes?: number;
    /** 额外环境变量，合并进 process.env（不改父进程） */
    env?: NodeJS.ProcessEnv;
}

export function run(bin: string, args: string[], stage: Stage, opts: RunOpts = {}): Promise<ProcResult> {
    const {
        cwd,
        stdin = null,
        timeoutMs = Number(process.env.PTC_TIMEOUT_MS ?? 20_000),
        maxOutputBytes = 8 << 20,
        env,
    } = opts;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
        return Promise.reject(new PtcOutcomeError('E_BAD_ARGS', stage, 'maxOutputBytes 必须是正安全整数'));
    }
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    return new Promise<ProcResult>((resolve, reject) => {
        let child: ChildProcess;
        try {
            child = spawn(bin, args, {
                cwd,
                shell: false,
                windowsHide: true,
                signal: ac.signal,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: env ? { ...process.env, ...env } : process.env,
            });
        }
        catch (e) {
            clearTimeout(timer);
            reject(new PtcOutcomeError('E_BIN_MISSING', stage, `${bin} 启动失败`, String(e)));
            return;
        }
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outputBytes = 0;
        let outputError: PtcOutcomeError | undefined;
        const collect = (chunks: Buffer[], c: Buffer) => {
            if (outputError)
                return;
            if (c.length > maxOutputBytes - outputBytes) {
                outputError = new PtcOutcomeError('E_OUTPUT_LIMIT', stage, `${bin} stdout/stderr 超过合计输出上限 ${maxOutputBytes} bytes`);
                clearTimeout(timer);
                child.kill();
                reject(outputError);
                return;
            }
            outputBytes += c.length;
            chunks.push(c);
        };
        child.stdout?.on('data', (c: Buffer) => collect(out, c));
        child.stderr?.on('data', (c: Buffer) => collect(err, c));
        child.stdin?.on('error', () => { });
        child.on('error', (e: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            if (e.name === 'AbortError')
                reject(new PtcOutcomeError('E_TIMEOUT', stage, `${bin} 超时 ${timeoutMs}ms`));
            else if (e.code === 'ENOENT')
                reject(new PtcOutcomeError('E_BIN_MISSING', stage, `找不到可执行文件: ${bin}`));
            else
                reject(new PtcOutcomeError('E_BIN_MISSING', stage, `${bin} 异常: ${e.message}`));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (outputError)
                return;
            resolve({
                code: code ?? -1,
                stdout: Buffer.concat(out),
                stderr: Buffer.concat(err),
                truncated: false,
                ms: Date.now() - t0,
            });
        });
        try {
            child.stdin?.end(stdin ?? undefined);
        }
        catch {
        }
    });
}

/** PATH 里按名字找真实可执行文件（处理 ast-grep / ast-grep.exe / sg 三套命名） */
export async function pickBin(candidates: string[]): Promise<string> {
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
    for (const c of candidates) {
        if (!c)
            continue;
        if (c.includes('/') || c.includes('\\')) {
            try {
                await access(c);
                return c;
            }
            catch {
                continue;
            }
        }
        for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
            if (!dir)
                continue;
            for (const ext of exts) {
                const p = path.join(dir, c + ext);
                try {
                    await access(p);
                    return p;
                }
                catch { }
            }
        }
    }
    throw new PtcOutcomeError('E_BIN_MISSING', 'everything', `候选可执行文件均不存在: ${candidates.join(' | ')}`);
}

const RE_LINE = /\r?\n/;
const RE_CR = /\r/g;
const RE_CRLF_G = /\r\n/g;
const RE_LF_G = /\n/g;

export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** es.exe 输出 → 干净路径数组。Windows CRLF、行尾空格、空行、BOM 一次清掉 */
export function toLines(buf: Buffer): string[] {
    return stripBom(buf.toString('utf8'))
        .split(RE_LINE)
        .map((l) => l.replace(RE_CR, '').trim())
        .filter((l) => l.length > 0);
}

/** 文件主 EOL，用于把补丁里的 \n 还原成该文件风格，避免整文件 diff 噪声 */
export function detectEol(buf: Buffer): '\r\n' | '\n' {
    let crlf = 0, lf = 0;
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 10) {
            if (i > 0 && buf[i - 1] === 13)
                crlf++;
            else
                lf++;
        }
    }
    return crlf > lf ? '\r\n' : '\n';
}

export const normalizeEol = (s: string, eol: '\r\n' | '\n'): string => s.replace(RE_CRLF_G, '\n').replace(RE_LF_G, eol);

/** 宽容 JSON：ast-grep 老版本给数组、新版本给 NDJSON、difft 给 NDJSON */
export function parseLooseJson(text: string): unknown[] {
    const t = stripBom(text).trim();
    if (!t)
        return [];
    try {
        const v: unknown = JSON.parse(t);
        return Array.isArray(v) ? v : [v];
    }
    catch {
    }
    const out: unknown[] = [];
    for (const line of t.split(RE_LINE)) {
        const s = line.trim();
        if (!s || (s[0] !== '{' && s[0] !== '['))
            continue;
        try {
            out.push(JSON.parse(s));
        }
        catch { }
    }
    return out;
}

/** 只读目标字节区间 —— SANE 省 token 的物理实现 */
export async function readRange(file: string, start: number, end: number): Promise<Buffer> {
    const fh = await open(file, 'r');
    try {
        const len = Math.max(0, end - start);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, start);
        return buf.subarray(0, bytesRead);
    }
    finally {
        await fh.close();
    }
}
