import { readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { PtcOutcomeError, defaultConfig } from './proc';
import { runRefactorPipeline } from './pipeline';
import type { RefactorRequest } from './pipeline';
import { difftasticAudit, everythingFind, saneLocate } from './stages';
import { inprocLocate, inprocRefactor } from './inproc';
import type { InprocRequest, LocateRequest, LocateStrategy } from './inproc';

export interface PtcToolDef {
    name: string;
    title: string;
    /** 一句话，进动态工具列表，不进基础系统提示词 */
    description: string;
    inputSchema: Record<string, unknown>;
}
export interface PtcToolAddition {
    id: string;
    version: string;
    kind: 'tools_addition';
    /** 自定义匹配元数据；需宿主 adapter 显式接线，原 OPS discovery 不消费此结构。 */
    discover: {
        keywords: string[];
        intents: string[];
        minRepoFiles?: number;
        cost: 'light' | 'heavy';
        load: 'on-demand';
    };
    tools: PtcToolDef[];
    handlers: Record<string, (args: any, ctx?: {
        cwd?: string;
    }) => Promise<unknown>>;
}
const OUT_SCHEMA = {
    type: 'object',
    properties: {
        status: { type: 'string', enum: ['ok', 'error'] },
        mode: { type: 'string', enum: ['preview', 'apply'] },
        file: { type: 'string' },
        symbol: { type: 'string' },
        hunks: { type: 'number' },
        addedLines: { type: 'number' },
        removedLines: { type: 'number' },
        summary: { type: 'string' },
        stages: { type: 'array', items: { type: 'string' } },
        degraded: { type: 'string' },
        rollback: { type: 'boolean' },
        code: { type: 'string' },
        stage: { type: 'string' },
        message: { type: 'string' },
    },
};
const cfgFor = (ctx?: { cwd?: string }) => defaultConfig({ cwd: ctx?.cwd ?? process.cwd() });
const asError = (e: unknown) => {
    if (e instanceof PtcOutcomeError)
        return { ...e.toOutcome(), detail: e.detail };
    const message = typeof e === 'object' && e !== null && 'message' in e ? e.message : undefined;
    return { status: 'error', code: 'E_INTERNAL', stage: 'pipeline', message: String(message ?? e) };
};
const asStrategy = (v: unknown): LocateStrategy | undefined => v === 'walk' || v === 'everything' || v === 'auto' ? v : undefined;
/** body 是历史字段，不在公开的 LocateRequest 签名里；引擎从同一个请求对象上读它。 */
type LocateRequestWithBody = LocateRequest & { body?: boolean | number };
export const opsPtcAddition: PtcToolAddition = {
    id: 'ops-ptc',
    version: '2.1.2',
    kind: 'tools_addition',
    discover: {
        keywords: [
            '重构', 'refactor', '大型改造', '跨文件替换', '符号重写', 'AST 改写',
            'ast-grep', 'napi', '进程内 AST', '复杂代码库分析', '符号定位',
            'everything 搜索', '大仓库寻址', '语法级 diff', 'difftastic', 'sane',
        ],
        intents: [
            '需要在大型代码库里按语义定位符号，而不是把整棵树读进上下文',
            '需要 AST 级结构化替换并执行语法审计',
            '需要结构化改写回执与审计；失败后的文件状态以 effectState 和实际检查为准',
        ],
        minRepoFiles: 800,
        cost: 'light',
        load: 'on-demand',
    },
    tools: [
        {
            name: 'ops_ptc_inproc',
            title: 'PTC 进程内 AST 改写（小树/单文件首选）',
            description: '进程内 tree-sitter 做 AST 匹配、结构化改写与语法级审计。常规路径不启动子进程；strict=true 会调用 sg CLI 对账。' +
                '支持 TS/TSX/JS/JSX/HTML/CSS 且单文件 ≤2MB；引擎返回 fallback=spawn 时尝试五段流水线，外部工具缺失会返回错误。',
            inputSchema: {
                type: 'object',
                required: ['pattern', 'rewrite'],
                properties: {
                    pattern: { type: 'string', description: 'AST pattern，如 `return $A`' },
                    rewrite: { type: 'string', description: '重写模板，如 `return ($A);`' },
                    symbol: { type: 'string', description: '锁定到该符号体内' },
                    file: { type: 'string', description: '已知文件，跳过枚举' },
                    roots: { type: 'array', items: { type: 'string' }, description: '枚举根，默认 cwd' },
                    ext: { type: 'array', items: { type: 'string' }, description: '默认 ts/tsx' },
                    mode: { type: 'string', enum: ['apply', 'preview'], description: '默认 apply' },
                    limit: { type: 'number', description: '最多文件数，默认 1' },
                    strategy: {
                        type: 'string',
                        enum: ['auto', 'walk', 'everything'],
                        description: '默认 auto',
                    },
                    strict: {
                        type: 'boolean',
                        description: '落盘前用 sg CLI 复核命中数，默认 false',
                    },
                },
            },
        },
        {
            name: 'ops_ptc_locate',
            title: 'PTC 符号定位（进程内 AST，只读，不回全文）',
            description: '枚举 + 子串预筛 + 单文件 parse，返回符号的行区间、签名与字节量。' +
                '不回文件正文，因此 606 文件的仓库里一次定位只占约 250 字节上下文。',
            inputSchema: {
                type: 'object',
                required: ['symbol'],
                properties: {
                    symbol: { type: 'string', description: '符号名' },
                    file: { type: 'string', description: '已知文件跳过枚举' },
                    roots: { type: 'array', items: { type: 'string' }, description: '枚举根，默认 cwd' },
                    ext: { type: 'array', items: { type: 'string' }, description: '默认 ts/tsx' },
                    strategy: {
                        type: 'string',
                        enum: ['auto', 'walk', 'everything'],
                        description: '默认 auto',
                    },
                    limit: { type: 'number', description: '最多命中文件数，默认 5' },
                    body: {
                        type: ['boolean', 'number'],
                        description: '附命中正文：true/缺省 = 总字节 ≤8KiB 才附，false = 只给行号，数字 = 自定义额度。',
                    },
                },
            },
        },
        {
            name: 'ops_ptc_refactor',
            title: 'PTC 五段重构（Everything→SANE→ast-grep→AgentBox→difftastic）',
            description: '文件寻址 + 符号切片 + AST 重写 + stdin 写入 + 语法级 diff 审计，返回结构化回执。权限隔离必须由宿主可信执行桥提供。',
            inputSchema: {
                type: 'object',
                required: ['query', 'symbol', 'pattern', 'rewrite'],
                properties: {
                    query: { type: 'string', description: '搜索条件，如 *.ts' },
                    roots: { type: 'array', items: { type: 'string' }, description: '搜索根' },
                    ext: { type: 'string', description: '扩展名，如 ts' },
                    scope: { type: 'string', enum: ['cwd', 'global'], description: '默认 cwd' },
                    limit: { type: 'number', description: '返回上限，默认 32' },
                    file: { type: 'string', description: '已知文件跳过寻址' },
                    symbol: { type: 'string', description: 'SANE 目标符号名' },
                    pattern: { type: 'string', description: 'ast-grep pattern，如 "return true"' },
                    rewrite: { type: 'string', description: 'ast-grep rewrite' },
                    mode: {
                        type: 'string',
                        enum: ['preview', 'apply'],
                        description: '默认 apply',
                    },
                },
            },
        },
        {
            name: 'ops_ptc_find',
            title: 'PTC 快速寻址（Everything + SANE，只读）',
            description: '定位文件并返回符号字节区间与骨架签名，不修改目标文件。省略 symbol 时只回匹配文件列表。',
            inputSchema: {
                type: 'object',
                required: ['query'],
                properties: {
                    query: { type: 'string' },
                    symbol: { type: 'string' },
                    roots: { type: 'array', items: { type: 'string' } },
                    ext: { type: 'string' },
                    scope: { type: 'string', enum: ['cwd', 'global'] },
                    limit: { type: 'number' },
                },
            },
        },
        {
            name: 'ops_ptc_audit',
            title: 'PTC 语法级 Diff 审计（difftastic）',
            description: '对两个版本做忽略格式的语法级 diff，返回 hunk 数与语言判定；不改目标文件，可能创建并清理临时文件。',
            inputSchema: {
                type: 'object',
                required: ['file', 'beforeFile'],
                properties: {
                    file: { type: 'string', description: '当前文件' },
                    beforeFile: { type: 'string', description: '改动前镜像' },
                },
            },
        },
    ],
    handlers: {
        async ops_ptc_inproc(args, ctx) {
            if (args.mode !== undefined && args.mode !== 'preview' && args.mode !== 'apply') {
                return new PtcOutcomeError('E_BAD_ARGS', 'inproc', 'mode 必须为 preview 或 apply').toOutcome();
            }
            const req: InprocRequest = {
                pattern: String(args.pattern ?? ''),
                rewrite: String(args.rewrite ?? ''),
                symbol: args.symbol ? String(args.symbol) : undefined,
                file: args.file ? String(args.file) : undefined,
                roots: Array.isArray(args.roots) ? args.roots : undefined,
                ext: Array.isArray(args.ext) ? args.ext : undefined,
                mode: args.mode === 'preview' ? 'preview' : 'apply',
                limit: typeof args.limit === 'number' ? args.limit : undefined,
                strategy: asStrategy(args.strategy),
                scanBudget: typeof args.scanBudget === 'number' ? args.scanBudget : undefined,
                strict: args.strict === true,
            };
            if (!req.pattern || !req.rewrite) {
                return new PtcOutcomeError('E_BAD_ARGS', 'inproc', '缺少必填参数: pattern, rewrite').toOutcome();
            }
            const out = inprocRefactor(req, ctx?.cwd ?? process.cwd());
            if (out.status === 'error' && out.fallback === 'spawn') {
                const piped = await runRefactorPipeline({
                    // 无 roots 时 query 缺省：pipeline 先按 file/query 二选一校验拒绝，与 undefined 等价。
                    query: req.roots ? `${req.roots.join(' ')}` : '',
                    symbol: req.symbol ?? '',
                    astPattern: req.pattern,
                    astRewrite: req.rewrite,
                    file: req.file,
                    roots: req.roots,
                    mode: req.mode,
                }, cfgFor(ctx));
                return { ...piped, engine: 'spawn-fallback' };
            }
            return out;
        },
        async ops_ptc_locate(args, ctx) {
            const symbol = String(args.symbol ?? '');
            if (!symbol) {
                return new PtcOutcomeError('E_BAD_ARGS', 'inproc', '缺少必填参数: symbol').toOutcome();
            }
            const req: LocateRequestWithBody = {
                symbol,
                file: args.file ? String(args.file) : undefined,
                roots: Array.isArray(args.roots) ? args.roots : undefined,
                ext: Array.isArray(args.ext) ? args.ext : undefined,
                strategy: asStrategy(args.strategy),
                scanBudget: typeof args.scanBudget === 'number' ? args.scanBudget : undefined,
                limit: typeof args.limit === 'number' ? args.limit : undefined,
                // 正文额度传给引擎：适配层不参与体积判定，闸门只有一处。
                body: typeof args.body === 'number' || typeof args.body === 'boolean' ? args.body : undefined,
            };
            return inprocLocate(req, ctx?.cwd ?? process.cwd());
        },
        async ops_ptc_refactor(args, ctx) {
            if (args.mode !== undefined && args.mode !== 'preview' && args.mode !== 'apply') {
                return new PtcOutcomeError('E_BAD_ARGS', 'pipeline', 'mode 必须为 preview 或 apply').toOutcome();
            }
            const pick = (k: string, alt: string) => String((args[k] ?? args[alt] ?? ''));
            const req: RefactorRequest = {
                query: pick('query', 'query'),
                symbol: pick('symbol', 'symbol'),
                astPattern: pick('pattern', 'astPattern'),
                astRewrite: pick('rewrite', 'astRewrite'),
                file: args.file ? String(args.file) : undefined,
                roots: Array.isArray(args.roots) ? args.roots : undefined,
                ext: args.ext ? String(args.ext) : undefined,
                limit: typeof args.limit === 'number' ? args.limit : undefined,
                scope: args.scope === 'global' ? 'global' : undefined,
                mode: args.mode === 'preview' ? 'preview' : 'apply',
            };
            const missing: string[] = (['symbol', 'astPattern', 'astRewrite'] as const).filter((k) => !req[k]);
            if (!req.file && !req.query)
                missing.push('query');
            if (missing.length > 0) {
                return new PtcOutcomeError('E_BAD_ARGS', 'pipeline', `缺少必填参数: ${missing.join(', ')}`).toOutcome();
            }
            return runRefactorPipeline(req, cfgFor(ctx));
        },
        async ops_ptc_find(args, ctx) {
            try {
                const cfg = cfgFor(ctx);
                const files = await everythingFind(cfg, {
                    pattern: args.query,
                    limit: args.limit,
                    roots: args.roots,
                    ext: args.ext,
                    scope: args.scope,
                });
                const symbol = args.symbol ? String(args.symbol) : '';
                // 不给 symbol 时就是纯发现：query 已经在 es 索引里过滤过一遍，再逐条 saneLocate
                // 是白花一次 sg 调用。回路径列表，调用方自己决定下钻哪一个。
                if (!symbol) {
                    return { status: 'ok', matches: files.length, files: files.slice(0, 20) };
                }
                // 只试 files[0] 时，符号在第二个候选就误报 E_SANE_SYMBOL_NOT_FOUND。
                // 先子串缩候选（≤8 次读），再逐个 saneLocate（≤3 次），命中即停。
                const shortlist: string[] = [];
                for (const candidate of files.slice(0, 8)) {
                    try {
                        if ((await readFile(candidate, 'utf8')).includes(symbol))
                            shortlist.push(candidate);
                    }
                    catch { }
                }
                if (shortlist.length === 0) {
                    // es 索引是异步的：刚写出的文件常常还没进索引。只有当 es 一个含符号的候选
                    // 都没给时才 walk 兜底，避免把「索引没跟上」报成「符号不存在」。
                    try {
                        const sweep: LocateRequestWithBody = {
                            symbol,
                            roots: args.roots,
                            ext: args.ext ? [args.ext] : undefined,
                            limit: 8,
                            strategy: 'walk',
                            body: false,
                        };
                        const swept = inprocLocate(sweep, cfg.cwd);
                        const hit = swept.hits?.[0];
                        if (hit) {
                            return {
                                status: 'ok',
                                file: hit.file,
                                matches: files.length,
                                symbol,
                                lines: [hit.lines[0], hit.lines[1]],
                                signature: hit.signature,
                                engine: 'inproc-sweep',
                            };
                        }
                    }
                    catch { }
                }
                const trial = shortlist.length > 0 ? shortlist : files.slice(0, 1);
                let lastError: unknown;
                for (const candidate of trial.slice(0, 3)) {
                    try {
                        const hit = await saneLocate(cfg, candidate, symbol);
                        return {
                            status: 'ok',
                            file: candidate,
                            matches: files.length,
                            symbol: hit.symbol,
                            startByte: hit.startByte,
                            endByte: hit.endByte,
                            lines: [hit.startLine + 1, hit.endLine + 1],
                            signature: hit.signature,
                        };
                    }
                    catch (e) {
                        lastError = e;
                    }
                }
                if (lastError)
                    throw lastError;
                throw new PtcOutcomeError('E_EVERYTHING_NOT_FOUND', 'everything', `候选文件里没有符号 ${symbol}`, { query: args.query });
            }
            catch (e) {
                return asError(e);
            }
        },
        async ops_ptc_audit(args, ctx) {
            try {
                const cfg = cfgFor(ctx);
                const before = await readFile(path.resolve(cfg.cwd, args.beforeFile));
                // 纯审计没有编辑清单：传空数组，让 stages 从 difftastic 的对齐行推出真实
                // +/- 行数。此前这里塞了一个占位编辑（startByte 0 长 0），导致每次回执都
                // 声称「1 处改写、+0/-0 行」——同一文件也这么说，9000 行新增也这么说。
                const { audit, dir } = await difftasticAudit(cfg, before, path.resolve(cfg.cwd, args.file), []);
                if (dir)
                    await rm(dir, { recursive: true, force: true }).catch(() => { });
                return { status: 'ok', file: path.resolve(cfg.cwd, args.file), ...audit };
            }
            catch (e) {
                return asError(e);
            }
        },
    },
};
export const opsPtcDiscoveryEntry = {
    id: opsPtcAddition.id,
    summary: 'AST 定位 / 改写 / 审计元数据；须通过可信宿主 adapter 显式注册',
    keywords: opsPtcAddition.discover.keywords,
    intents: opsPtcAddition.discover.intents,
    /** 自定义宿主可使用的选择条件；原 OPS discovery 不自动调用。 */
    gate: (ctx: { repoFileCount?: number; userIntent?: string }) => (ctx.repoFileCount ?? 0) > 800 || /重构|refactor|AST|批量替换|符号定位|代码库分析/i.test(ctx.userIntent ?? ''),
    /** 仅返回 addition 元数据，不向原 OPS discovery 自动注册工具。 */
    load: () => opsPtcAddition,
};
export { OUT_SCHEMA };
export { createHostTools, registerHostTools, toHostOutcome, HOST_OUTCOME_SCHEMA } from './adapter';
export type { HostBridge, HostExec, HostPolicy, HostOutcome, HostToolDefinition } from './adapter';
export default opsPtcAddition;
