/**
 * The tool catalogue: five `ops_ptc_*` tools, their schemas, their handlers and the discovery entry.
 *
 * The schemas are the contract the host publishes, so they are declared once here rather than derived.
 * Handlers never throw: a refusal is returned, because a thrown error loses the code the caller branches
 * on and the host turns it into an anonymous failure.
 *
 * @module dsh-ops/ptc/tools
 */

import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { defaultConfig, PtcOutcomeError, type PtcConfig } from './proc.cjs'
import { runRefactorPipeline, type PipelineRequest } from './pipeline.cjs'
import { difftasticAudit, everythingFind, saneLocate } from './stages.cjs'
import { inprocLocate, inprocRefactor } from './inproc.cjs'

export { createHostTools, HOST_OUTCOME_SCHEMA, registerHostTools, toHostOutcome } from './adapter.cjs'

/** The shape every `ops_ptc_*` tool returns. */
export const OUT_SCHEMA = {
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
}

/** The context a handler is called with; only `cwd` is used here. */
interface ToolContext { cwd?: string }

/** A handler's argument bag — untrusted JSON, narrowed field by field. */
type ToolArgs = Record<string, unknown>

const cfgFor = (ctx?: ToolContext): PtcConfig => defaultConfig({ cwd: ctx?.cwd ?? process.cwd() })

/** Turn any thrown value into the refusal shape the host understands. */
const asError = (error: unknown): Record<string, unknown> => error instanceof PtcOutcomeError
  ? { ...error.toOutcome(), detail: error.detail }
  : { status: 'error', code: 'E_INTERNAL', stage: 'pipeline', message: String((error as Error)?.message ?? error) }

const asStrategy = (value: unknown): 'auto' | 'walk' | 'everything' | undefined =>
  value === 'walk' || value === 'everything' || value === 'auto' ? value : undefined

/** The tool addition the host registers. */
export const opsPtcAddition = {
  id: 'ops-ptc',
  version: '2.1.1',
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
      description: '进程内 tree-sitter 做 AST 匹配、结构化改写与语法级审计。常规路径不启动子进程；strict=true 会调用 sg CLI 对账。'
        + '支持 TS/TSX/JS/JSX/HTML/CSS 且单文件 ≤2MB；引擎返回 fallback=spawn 时尝试五段流水线，外部工具缺失会返回错误。',
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
          strategy: { type: 'string', enum: ['auto', 'walk', 'everything'], description: '默认 auto' },
          strict: { type: 'boolean', description: '落盘前用 sg CLI 复核命中数，默认 false' },
        },
      },
    },
    {
      name: 'ops_ptc_locate',
      title: 'PTC 符号定位（进程内 AST，只读，不回全文）',
      description: '枚举 + 子串预筛 + 单文件 parse，返回符号的行区间、签名与字节量。'
        + '不回文件正文，因此 606 文件的仓库里一次定位只占约 250 字节上下文。',
      inputSchema: {
        type: 'object',
        required: ['symbol'],
        properties: {
          symbol: { type: 'string', description: '符号名' },
          file: { type: 'string', description: '已知文件跳过枚举' },
          roots: { type: 'array', items: { type: 'string' }, description: '枚举根，默认 cwd' },
          ext: { type: 'array', items: { type: 'string' }, description: '默认 ts/tsx' },
          strategy: { type: 'string', enum: ['auto', 'walk', 'everything'], description: '默认 auto' },
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
          mode: { type: 'string', enum: ['preview', 'apply'], description: '默认 apply' },
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
    async ops_ptc_inproc(args: ToolArgs, ctx?: ToolContext): Promise<Record<string, unknown>> {
      if (args.mode !== undefined && args.mode !== 'preview' && args.mode !== 'apply') {
        return new PtcOutcomeError('E_BAD_ARGS', 'inproc', 'mode 必须为 preview 或 apply').toOutcome()
      }
      const request = {
        pattern: String(args.pattern ?? ''),
        rewrite: String(args.rewrite ?? ''),
        symbol: args.symbol ? String(args.symbol) : undefined,
        file: args.file ? String(args.file) : undefined,
        roots: Array.isArray(args.roots) ? args.roots as string[] : undefined,
        ext: Array.isArray(args.ext) ? args.ext as string[] : undefined,
        mode: args.mode === 'preview' ? 'preview' as const : 'apply' as const,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        strategy: asStrategy(args.strategy),
        scanBudget: typeof args.scanBudget === 'number' ? args.scanBudget : undefined,
        strict: args.strict === true,
      }
      if (!request.pattern || !request.rewrite) {
        return new PtcOutcomeError('E_BAD_ARGS', 'inproc', '缺少必填参数: pattern, rewrite').toOutcome()
      }
      const out = inprocRefactor(request, ctx?.cwd ?? process.cwd())
      if (out.status === 'error' && out.fallback === 'spawn') {
        // The file is too big for the in-process engine; the five-stage pipeline is the answer, and the
        // receipt says which engine produced it.
        const piped = await runRefactorPipeline({
          query: request.roots ? `${request.roots.join(' ')}` : undefined,
          symbol: request.symbol ?? '',
          astPattern: request.pattern,
          astRewrite: request.rewrite,
          file: request.file,
          roots: request.roots,
          mode: request.mode,
        }, cfgFor(ctx))
        return { ...(piped as unknown as Record<string, unknown>), engine: 'spawn-fallback' }
      }
      return out
    },

    async ops_ptc_locate(args: ToolArgs, ctx?: ToolContext): Promise<Record<string, unknown>> {
      const symbol = String(args.symbol ?? '')
      if (!symbol) return new PtcOutcomeError('E_BAD_ARGS', 'inproc', '缺少必填参数: symbol').toOutcome()
      return inprocLocate({
        symbol,
        file: args.file ? String(args.file) : undefined,
        roots: Array.isArray(args.roots) ? args.roots as string[] : undefined,
        ext: Array.isArray(args.ext) ? args.ext as string[] : undefined,
        strategy: asStrategy(args.strategy),
        scanBudget: typeof args.scanBudget === 'number' ? args.scanBudget : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        // The body budget is the engine's business: the adapter does not second-guess size, so there is
        // exactly one gate.
        body: typeof args.body === 'number' || typeof args.body === 'boolean' ? args.body : undefined,
      }, ctx?.cwd ?? process.cwd())
    },

    async ops_ptc_refactor(args: ToolArgs, ctx?: ToolContext): Promise<Record<string, unknown>> {
      if (args.mode !== undefined && args.mode !== 'preview' && args.mode !== 'apply') {
        return new PtcOutcomeError('E_BAD_ARGS', 'pipeline', 'mode 必须为 preview 或 apply').toOutcome()
      }
      const pick = (key: string, alt: string): string => String(args[key] ?? args[alt] ?? '')
      const request: PipelineRequest = {
        query: pick('query', 'query'),
        symbol: pick('symbol', 'symbol'),
        astPattern: pick('pattern', 'astPattern'),
        astRewrite: pick('rewrite', 'astRewrite'),
        file: args.file ? String(args.file) : undefined,
        roots: Array.isArray(args.roots) ? args.roots as string[] : undefined,
        ext: args.ext ? String(args.ext) : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        scope: args.scope === 'global' ? 'global' : undefined,
        mode: args.mode === 'preview' ? 'preview' : 'apply',
      }
      const missing: string[] = (['astPattern', 'astRewrite'] as const).filter(key => !request[key]).map(key => (key === 'astPattern' ? 'pattern' : 'rewrite'))
      if (!request.symbol) missing.unshift('symbol')
      if (!request.file && !request.query) missing.push('query')
      if (missing.length > 0) {
        return new PtcOutcomeError('E_BAD_ARGS', 'pipeline', `缺少必填参数: ${missing.join(', ')}`).toOutcome()
      }
      return { ...(await runRefactorPipeline(request, cfgFor(ctx))) } as Record<string, unknown>
    },

    async ops_ptc_find(args: ToolArgs, ctx?: ToolContext): Promise<Record<string, unknown>> {
      try {
        const cfg = cfgFor(ctx)
        const files = await everythingFind(cfg, {
          pattern: String(args.query ?? ''),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          roots: Array.isArray(args.roots) ? args.roots as string[] : undefined,
          ext: args.ext ? String(args.ext) : undefined,
          scope: args.scope === 'global' ? 'global' : undefined,
        })
        const symbol = args.symbol ? String(args.symbol) : ''
        // No symbol means pure discovery: the query already filtered in the es index, so locating each
        // hit would spend an sg call for nothing. Return paths and let the caller choose.
        if (!symbol) return { status: 'ok', matches: files.length, files: files.slice(0, 20) }

        // Trying only files[0] reported E_SANE_SYMBOL_NOT_FOUND whenever the symbol lived in the second
        // candidate. Substring-shortlist first (≤8 reads), then locate (≤3), stop at the first hit.
        const shortlist: string[] = []
        for (const candidate of files.slice(0, 8)) {
          try {
            if ((await readFile(candidate, 'utf8')).includes(symbol)) shortlist.push(candidate)
          } catch { /* an unreadable candidate is not a hit */ }
        }
        if (shortlist.length === 0) {
          // The index is asynchronous; a freshly written file is often absent. Walk only when nothing in
          // the index mentioned the symbol, so "index lag" never surfaces as "symbol missing".
          try {
            const swept = inprocLocate({ symbol, roots: args.roots as string[] | undefined, ext: args.ext ? [String(args.ext)] : undefined, limit: 8, strategy: 'walk', body: false }, cfg.cwd)
            const hit = (swept.hits as Array<{ file: string, lines: [number, number], signature: string }> | undefined)?.[0]
            if (hit) {
              return { status: 'ok', file: hit.file, matches: files.length, symbol, lines: [hit.lines[0], hit.lines[1]], signature: hit.signature, engine: 'inproc-sweep' }
            }
          } catch { /* the sweep is a fallback; its failure must not mask the real error */ }
        }
        const trial = shortlist.length > 0 ? shortlist : files.slice(0, 1)
        let lastError: unknown
        for (const candidate of trial.slice(0, 3)) {
          try {
            const hit = await saneLocate(cfg, candidate, symbol)
            return {
              status: 'ok',
              file: candidate,
              matches: files.length,
              symbol: hit.symbol,
              startByte: hit.startByte,
              endByte: hit.endByte,
              lines: [hit.startLine + 1, hit.endLine + 1],
              signature: hit.signature,
            }
          } catch (error) {
            lastError = error
          }
        }
        if (lastError) throw lastError
        throw new PtcOutcomeError('E_EVERYTHING_NOT_FOUND', 'everything', `no candidate file contains the symbol ${symbol}`, { query: args.query })
      } catch (error) {
        return asError(error)
      }
    },

    async ops_ptc_audit(args: ToolArgs, ctx?: ToolContext): Promise<Record<string, unknown>> {
      try {
        const cfg = cfgFor(ctx)
        const current = path.resolve(cfg.cwd, String(args.file))
        const before = await readFile(path.resolve(cfg.cwd, String(args.beforeFile)))
        // A pure audit has no edit list: pass an empty array so the stage derives the real +/- from
        // difftastic's alignment. A placeholder edit here used to make every receipt claim "1 rewrite,
        // +0/-0 lines" — for any file, and for a 9000-line addition.
        const { audit, dir } = await difftasticAudit(cfg, before, current, [])
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => { /* temp dir is best effort */ })
        return { status: 'ok', file: current, ...audit }
      } catch (error) {
        return asError(error)
      }
    },
  },
}

/** The discovery entry the host consults before deciding to load the addition. */
export const opsPtcDiscoveryEntry = {
  id: opsPtcAddition.id,
  summary: 'AST 定位 / 改写 / 审计元数据；须通过可信宿主 adapter 显式注册',
  keywords: opsPtcAddition.discover.keywords,
  intents: opsPtcAddition.discover.intents,
  gate: (ctx: { repoFileCount?: number, userIntent?: string }): boolean =>
    (ctx.repoFileCount ?? 0) > 800 || /重构|refactor|AST|批量替换|符号定位|代码库分析/i.test(ctx.userIntent ?? ''),
  load: () => opsPtcAddition,
}

export default opsPtcAddition
