"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeEol = exports.stripBom = exports.dbg = exports.defaultConfig = exports.esCandidates = exports.PtcOutcomeError = void 0;
exports.run = run;
exports.pickBin = pickBin;
exports.toLines = toLines;
exports.detectEol = detectEol;
exports.parseLooseJson = parseLooseJson;
exports.readRange = readRange;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
class PtcOutcomeError extends Error {
    code;
    stage;
    detail;
    constructor(code, stage, message, detail) {
        super(message);
        this.code = code;
        this.stage = stage;
        this.detail = detail;
        this.name = 'PtcOutcomeError';
    }
    toOutcome() {
        return {
            status: 'error',
            code: this.code,
            stage: this.stage,
            message: this.message,
        };
    }
}
exports.PtcOutcomeError = PtcOutcomeError;
const esCandidates = (explicit, cwd) => {
    const list = [];
    if (explicit)
        list.push(explicit);
    if (cwd)
        list.push(node_path_1.default.resolve(cwd, 'vendor', 'es.exe'), node_path_1.default.resolve(cwd, 'es.exe'));
    list.push(node_path_1.default.join(__dirname, '..', '..', 'vendor', 'es.exe'), 'C:/Program Files/Everything/es.exe', 'C:/Program Files (x86)/Everything/es.exe', 'es.exe', 'es');
    return [...new Set(list)];
};
exports.esCandidates = esCandidates;
const node_fs_sync = require("node:fs");
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
const pickExistingEs = (explicit, cwd) => {
    for (const c of esCandidates(explicit, cwd)) {
        if (!RE_ANY_SEP.test(c))
            continue;
        try {
            if (node_fs_sync.existsSync(c))
                return c;
        }
        catch {
        }
    }
    return explicit;
};
exports.pickExistingEs = pickExistingEs;
const defaultConfig = (over = {}) => ({
    cwd: process.cwd(),
    esPath: pickExistingEs(process.env.PTC_ES, over.cwd ?? process.cwd()),
    sgPath: process.env.PTC_SG ?? 'ast-grep',
    difftPath: process.env.PTC_DIFFT ?? 'difft',
    agentBoxWorker: process.env.PTC_AGENTBOX ?? node_path_1.default.join(__dirname, 'agentbox.worker.cjs'),
    timeoutMs: Number(process.env.PTC_TIMEOUT_MS ?? 20_000),
    maxOutputBytes: Number(process.env.PTC_MAX_OUTPUT ?? 8 << 20),
    maxChangeRatio: Number(process.env.PTC_MAX_CHANGE_RATIO ?? 0.2),
    requireAudit: process.env.PTC_REQUIRE_DIFFT === '1',
    allowMulti: process.env.PTC_ALLOW_MULTI === '1',
    debug: process.env.PTC_DEBUG === '1',
    ...over,
});
exports.defaultConfig = defaultConfig;
const dbg = (cfg, ...a) => {
    if (!cfg.debug)
        return;
    const text = a.map((x) => (typeof x === 'string' ? x : safeStr(x))).join(' ');
    process.stderr.write(`[ptc] ${text}\n`);
};
exports.dbg = dbg;
function safeStr(x) {
    try {
        return JSON.stringify(x);
    }
    catch {
        return String(x);
    }
}
function run(bin, args, stage, opts = {}) {
    const { cwd, stdin = null, timeoutMs = Number(process.env.PTC_TIMEOUT_MS ?? 20_000), maxOutputBytes = 8 << 20, env, } = opts;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
        return Promise.reject(new PtcOutcomeError('E_BAD_ARGS', stage, 'maxOutputBytes 必须是正安全整数'));
    }
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = (0, node_child_process_1.spawn)(bin, args, {
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
        const out = [];
        const err = [];
        let outputBytes = 0;
        let outputError;
        const collect = (chunks, c) => {
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
        child.stdout?.on('data', (c) => collect(out, c));
        child.stderr?.on('data', (c) => collect(err, c));
        child.stdin?.on('error', () => { });
        child.on('error', (e) => {
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
async function pickBin(candidates) {
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
    for (const c of candidates) {
        if (!c)
            continue;
        if (c.includes('/') || c.includes('\\')) {
            try {
                await (0, promises_1.access)(c);
                return c;
            }
            catch {
                continue;
            }
        }
        for (const dir of (process.env.PATH ?? '').split(node_path_1.default.delimiter)) {
            if (!dir)
                continue;
            for (const ext of exts) {
                const p = node_path_1.default.join(dir, c + ext);
                try {
                    await (0, promises_1.access)(p);
                    return p;
                }
                catch { }
            }
        }
    }
    throw new PtcOutcomeError('E_BIN_MISSING', 'everything', `候选可执行文件均不存在: ${candidates.join(' | ')}`);
}
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
exports.stripBom = stripBom;
const RE_LINE = /\r?\n/;
const RE_CR = /\r/g;
const RE_CRLF_G = /\r\n/g;
const RE_LF_G = /\n/g;
function toLines(buf) {
    return (0, exports.stripBom)(buf.toString('utf8'))
        .split(RE_LINE)
        .map((l) => l.replace(RE_CR, '').trim())
        .filter((l) => l.length > 0);
}
function detectEol(buf) {
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
const normalizeEol = (s, eol) => s.replace(RE_CRLF_G, '\n').replace(RE_LF_G, eol);
exports.normalizeEol = normalizeEol;
function parseLooseJson(text) {
    const t = (0, exports.stripBom)(text).trim();
    if (!t)
        return [];
    try {
        const v = JSON.parse(t);
        return Array.isArray(v) ? v : [v];
    }
    catch {
    }
    const out = [];
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
async function readRange(file, start, end) {
    const fh = await (0, promises_1.open)(file, 'r');
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
