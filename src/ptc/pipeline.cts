/**
 * The refactor pipeline: find the file, locate the symbol, rewrite it, audit it, write it — or roll back.
 *
 * Every step that could leave the tree half-changed has a matching guard: the snapshot is re-proved
 * before the write, the change-ratio ceiling refuses a runaway rewrite, the syntax audit runs before
 * difftastic, and any failure after `agentBoxApply` restores the original bytes and says `rollback: true`.
 *
 * @module dsh-ops/ptc/pipeline
 */

import { readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { auditSyntax } from './astdiff.cjs'
import { napi } from './engine-load.cjs'
import { inprocLocate } from './inproc.cjs'
import { dbg, defaultConfig, detectEol, esCandidates, pickBin, PtcOutcomeError, type PtcConfig } from './proc.cjs'
import { verifySnapshot } from './safe-write.cjs'
import {
  agentBoxApply,
  agentBoxRestore,
  applyEditsInMemory,
  difftAvailable,
  difftasticAudit,
  everythingFind,
  finishRewrite,
  langOf,
  queryRewrite,
  saneLocate,
  type SgMatch,
} from './stages.cjs'

/** What a pipeline caller may ask for. */
export interface PipelineRequest {
  symbol?: string
  astPattern?: string
  astRewrite?: string
  query?: string
  file?: string
  roots?: string[]
  ext?: string
  scope?: 'cwd' | 'global'
  mode?: 'apply' | 'preview'
  limit?: number
}

/** The pipeline receipt: a success summary or a refusal that names the stage that refused. */
export interface PipelineReceipt {
  status: string
  code?: string
  stage?: string
  message?: string
  mode?: string
  file?: string
  symbol?: string
  hunks?: number
  addedLines?: number
  removedLines?: number
  summary?: string
  stages?: string[]
  savedTokensRatio?: number
  degraded?: string
  rollback?: boolean
  ms: number
}

/** Resolve the external binaries once; Everything is only resolved when the caller will use it. */
export async function resolveTools(cfg: PtcConfig, need: { es?: boolean } = { es: true }): Promise<PtcConfig> {
  const resolved: PtcConfig = { ...cfg, sgPath: await pickBin([cfg.sgPath, 'ast-grep', 'sg']) }
  if (need.es) resolved.esPath = await pickBin(esCandidates(cfg.esPath, cfg.cwd))
  return resolved
}

/**
 * Run the whole pipeline.
 *
 * `E_BAD_ARGS` comes first and covers every field, because a partially valid request would otherwise
 * fail later with a message about the wrong thing.
 */
export async function runRefactorPipeline(req: PipelineRequest, rawCfg: PtcConfig): Promise<PipelineReceipt> {
  const t0 = Date.now()
  const stages: string[] = []
  const invalid = !req || typeof req !== 'object' || Array.isArray(req)
    || typeof req.symbol !== 'string' || !req.symbol.trim()
    || typeof req.astPattern !== 'string' || !req.astPattern.trim()
    || typeof req.astRewrite !== 'string'
    || (req.mode !== undefined && req.mode !== 'apply' && req.mode !== 'preview')
    || (req.limit !== undefined && (!Number.isSafeInteger(req.limit) || req.limit < 1 || req.limit > 150_000))
    || (req.file !== undefined && (typeof req.file !== 'string' || !req.file.trim()))
    || (!req.file && (typeof req.query !== 'string' || !req.query.trim()))
    || (req.roots !== undefined && (!Array.isArray(req.roots) || req.roots.some(root => typeof root !== 'string' || !root.trim())))
    || (req.scope !== undefined && req.scope !== 'cwd' && req.scope !== 'global')
  if (invalid) {
    return { status: 'error', code: 'E_BAD_ARGS', stage: 'pipeline', message: 'invalid pipeline request', stages, ms: Date.now() - t0 }
  }

  const mode = req.mode ?? 'apply'
  let cfg = rawCfg
  let file = req.file ? path.resolve(rawCfg.cwd, req.file) : ''
  let beforeBuf: Buffer | null = null
  let applied: { sha256After: unknown } | null = null

  try {
    cfg = await resolveTools(rawCfg, { es: !file })
    let prelocated: Awaited<ReturnType<typeof saneLocate>> | null = null

    if (!file) {
      const files = await everythingFind(cfg, {
        pattern: req.query as string,
        limit: req.limit ?? 32,
        roots: req.roots,
        ext: req.ext,
        scope: req.scope,
      })
      // Taking only files[0] costs a whole failed pipeline whenever the symbol lives in the second
      // candidate. Shortlist by substring first (≤8 reads), then locate (≤3), and stop at the first hit.
      const budget = Math.max(1, Math.min(files.length, 8))
      const shortlist: string[] = []
      for (let i = 0; i < budget; i += 1) {
        try {
          if ((await readFile(files[i], 'utf8')).includes(req.symbol as string)) shortlist.push(files[i])
        } catch { /* an unreadable candidate is not a hit */ }
      }
      const trial = shortlist.length > 0 ? shortlist : files.slice(0, 1)
      let lastError: unknown
      for (const candidate of trial.slice(0, 3)) {
        try {
          prelocated = await saneLocate(cfg, candidate, req.symbol as string)
          file = candidate
          break
        } catch (error) {
          lastError = error
        }
      }
      if (!prelocated && shortlist.length === 0) {
        // The Everything index is asynchronous, so a file written moments ago is absent and the symbol
        // looks missing while it sits on disk. One bounded walk only when no candidate mentioned the
        // symbol at all — bounded cost, and it replaces a false negative plus a retry.
        try {
          const swept = inprocLocate({
            symbol: req.symbol,
            roots: req.roots,
            ext: req.ext ? [req.ext] : undefined,
            limit: 8,
            strategy: 'walk',
          }, cfg.cwd)
          const hits = (swept.hits as Array<{ file: string }> | undefined) ?? []
          for (const hit of hits.slice(0, 3)) {
            try {
              prelocated = await saneLocate(cfg, hit.file, req.symbol as string)
              file = hit.file
              break
            } catch (error) {
              lastError = error
            }
          }
        } catch { /* the walk is a fallback; its own failure must not mask the real error */ }
      }
      if (!prelocated) {
        if (lastError) throw lastError
        throw new PtcOutcomeError('E_EVERYTHING_NOT_FOUND', 'everything', `no candidate file contains the symbol ${req.symbol}`, { query: req.query })
      }
      dbg(cfg, 'hit', file)
      stages.push('everything')
    }

    beforeBuf = await readFile(file)
    const lang = langOf(file)
    const eol = detectEol(beforeBuf)
    // Probe difftastic in parallel with the rewrite work; waiting for it serially was pure latency.
    const difftProbe = difftAvailable(cfg)
    const [located, rewritten] = await Promise.allSettled([
      prelocated ?? saneLocate(cfg, file, req.symbol as string, beforeBuf),
      queryRewrite(cfg, file, { pattern: req.astPattern as string, rewrite: req.astRewrite as string, lang, eol }),
    ])
    if (located.status === 'rejected') throw located.reason
    if (rewritten.status === 'rejected') throw rewritten.reason
    const slice = located.value
    verifySnapshot(file, beforeBuf)
    stages.push('sane')

    const edits = finishRewrite(cfg, rewritten.value as SgMatch[], {
      pattern: req.astPattern as string,
      rewrite: req.astRewrite as string,
      lang,
      within: { startByte: slice.startByte, endByte: slice.endByte },
      eol,
    })
    stages.push('astgrep')

    // A rewrite that touches a large share of the file is almost always a mis-scoped pattern; the ratio
    // ceiling only applies to files big enough for the ratio to be meaningful.
    const touched = edits.reduce((n, edit) => n + (edit.endByte - edit.startByte), 0)
    const ratio = beforeBuf.length > 0 ? touched / beforeBuf.length : 1
    const ratioGuard = beforeBuf.length >= 4096 && touched > 512
    if (ratioGuard && ratio > cfg.maxChangeRatio) {
      throw new PtcOutcomeError('E_DIFF_REGRESSION', 'astgrep', `the change covers ${(ratio * 100).toFixed(1)}% of the file, over the ${(cfg.maxChangeRatio * 100).toFixed(0)}% ceiling; nothing was written`, { touched, total: beforeBuf.length })
    }
    verifySnapshot(file, beforeBuf)

    const afterBuf = applyEditsInMemory(beforeBuf, edits)
    const language = ({
      ts: (napi as unknown as { Lang: Record<string, string> }).Lang.TypeScript,
      tsx: (napi as unknown as { Lang: Record<string, string> }).Lang.Tsx,
      js: (napi as unknown as { Lang: Record<string, string> }).Lang.JavaScript,
      jsx: (napi as unknown as { Lang: Record<string, string> }).Lang.JavaScript,
      html: (napi as unknown as { Lang: Record<string, string> }).Lang.Html,
      css: (napi as unknown as { Lang: Record<string, string> }).Lang.Css,
    } as Record<string, string | undefined>)[slice.lang]

    await difftProbe
    let syntaxAudit: Promise<{ ok: boolean, code?: string, message?: string } | null> = Promise.resolve(null)
    if (language) {
      const beforeText = beforeBuf.toString('utf8')
      // A round-trip mismatch means the file is not valid UTF-8; byte offsets and character offsets would
      // then disagree and every span would land in the wrong place.
      if (!Buffer.from(beforeText, 'utf8').equals(beforeBuf)) {
        throw new PtcOutcomeError('E_BAD_ARGS', 'astgrep', 'the source is not valid UTF-8; nothing was written')
      }
      const source = beforeBuf
      let byteCursor = 0
      let utf16Cursor = 0
      const toUtf16 = (offset: number): number => {
        utf16Cursor += source.subarray(byteCursor, offset).toString('utf8').length
        byteCursor = offset
        return utf16Cursor
      }
      // ast-grep reports byte offsets; the audit works in UTF-16 characters. Converting once, in order,
      // keeps the cost linear and the mapping exact.
      const spanEdits = edits.map(edit => ({ startByte: toUtf16(edit.startByte), endByte: toUtf16(edit.endByte), text: edit.text }))
      const afterText = afterBuf.toString('utf8')
      syntaxAudit = Promise.resolve().then(() => auditSyntax(beforeText, afterText, language, spanEdits))
    }

    const [syntaxSettled, difftSettled] = await Promise.allSettled([
      syntaxAudit,
      difftasticAudit(cfg, beforeBuf, file, edits, afterBuf),
    ])
    if (syntaxSettled.status === 'rejected') throw syntaxSettled.reason
    const syntax = syntaxSettled.value
    if (syntax && !syntax.ok) throw new PtcOutcomeError('E_DIFF_FAILED', 'astgrep', syntax.message ?? 'the candidate source failed the syntax audit; nothing was written')
    if (difftSettled.status === 'rejected') throw difftSettled.reason
    const { audit, dir } = difftSettled.value
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => { /* the temp dir is best effort */ })
    stages.push('difftastic')

    if (audit.degraded && cfg.requireAudit) {
      throw new PtcOutcomeError('E_DIFF_FAILED', 'difftastic', 'the audit is unavailable and requireAudit=true; nothing was written')
    }

    if (mode === 'apply') {
      const shaBefore = createHash('sha256').update(beforeBuf).digest('hex')
      const res = await agentBoxApply(cfg, file, edits, shaBefore)
      applied = { sha256After: res.sha256After }
      stages.push('agentbox')
    }

    return {
      status: 'ok',
      mode,
      file,
      symbol: req.symbol,
      hunks: audit.hunks,
      addedLines: audit.addedLines,
      removedLines: audit.removedLines,
      summary: audit.summary,
      stages,
      savedTokensRatio: Math.round(slice.savedRatio * 100) / 100,
      degraded: audit.degraded,
      ms: Date.now() - t0,
    }
  } catch (error) {
    // A write that landed before the failure is rolled back, and the receipt says so — "maybe changed"
    // is the one answer a caller cannot act on.
    let rolledBack = false
    if (applied && beforeBuf) {
      try {
        await agentBoxRestore(cfg, file, beforeBuf, String(applied.sha256After))
        rolledBack = true
      } catch (restoreError) {
        dbg(cfg, 'rollback failed', String(restoreError))
      }
    }
    if (error instanceof PtcOutcomeError) {
      return { ...error.toOutcome(), mode, file: file || undefined, stages, rollback: rolledBack, ms: Date.now() - t0 }
    }
    return {
      status: 'error',
      code: 'E_INTERNAL',
      stage: 'pipeline',
      message: String((error as Error)?.message ?? error),
      mode,
      file: file || undefined,
      stages,
      rollback: rolledBack,
      ms: Date.now() - t0,
    }
  }
}

/** `--key value` / repeated `--key` into arrays / bare `--flag` into `true`. */
function parseArgv(argv: string[]): Record<string, string | boolean | string[]> {
  const out: Record<string, string | boolean | string[]> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = true
      continue
    }
    i += 1
    const previous = out[key]
    if (previous === undefined) out[key] = next
    else if (Array.isArray(previous)) previous.push(next)
    else out[key] = [String(previous), next]
  }
  return out
}

const pipelineEntry = process.argv[1] ? path.basename(process.argv[1]) : ''
if (pipelineEntry === 'pipeline.js' || pipelineEntry === 'pipeline.cjs' || pipelineEntry === 'pipeline.mjs') {
  const argv = parseArgv(process.argv.slice(2))
  const cfg = defaultConfig({ cwd: process.cwd(), esPath: String(argv.es ?? process.env.PTC_ES ?? './es.exe') })
  const request: PipelineRequest = {
    query: String(argv.query ?? ''),
    symbol: String(argv.symbol ?? ''),
    astPattern: String(argv.pattern ?? ''),
    astRewrite: String(argv.rewrite ?? ''),
    file: argv.file ? String(argv.file) : undefined,
    limit: argv.limit ? Number(argv.limit) : undefined,
    ext: argv.ext ? String(argv.ext) : undefined,
    scope: argv.scope === 'global' ? 'global' : undefined,
    mode: argv.mode === 'preview' ? 'preview' : 'apply',
  }
  runRefactorPipeline(request, cfg)
    .then(outcome => {
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
      process.exit(outcome.status === 'ok' ? 0 : 1)
    })
    .catch(error => {
      process.stdout.write(`${JSON.stringify({ status: 'error', code: 'E_INTERNAL', message: String(error) })}\n`)
      process.exit(1)
    })
}
