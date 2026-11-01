/**
 * The external stages: Everything search, ast-grep rewrite, the AgentBox writer and difftastic audit.
 *
 * Each function here is one external tool wrapped so the pipeline never has to know which tool answered.
 * The two rules they all follow:
 *
 *   · a refusal is a `PtcOutcomeError` with a code the caller can branch on, never a bare throw;
 *   · a degraded answer says so — a missing difftastic downgrades the audit and marks it, it does not
 *     silently report zeros.
 *
 * @module dsh-ops/ptc/stages
 */

import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { walkBounded } from './inproc.cjs'
import {
  dbg,
  normalizeEol,
  parseLooseJson,
  pickBin,
  PtcOutcomeError,
  readRange,
  run,
  stripBom,
  toLines,
  type ProcResult,
  type PtcConfig,
  type Stage,
} from './proc.cjs'
import { reparseEscape } from './reparse.cjs'

/** One match as ast-grep reports it in `--json=stream` mode. */
export interface SgMatch {
  range: { start: { line: number }, end: { line: number }, byteOffset: { start: number, end: number } }
  text: string
  replacement?: string
  replacementOffsets?: { start: number, end: number }
  metaVariables?: { single?: Record<string, { text: string } | undefined> }
}

/** A replacement this engine will apply. `before` is kept so the audit can count removed lines. */
export interface Edit {
  startByte: number
  endByte: number
  text: string
  before?: string
}

/** An Everything query. `scope: 'global'` means "do not imply a root". */
export interface EsQuery {
  pattern: string
  ext?: string
  roots?: string[]
  limit?: number
  regex?: boolean
  scope?: string
}

/** The result of locating one symbol through ast-grep. */
export interface SaneHit {
  file: string
  symbol: string
  lang: string
  startByte: number
  endByte: number
  startLine: number
  endLine: number
  totalBytes: number
  signature: string
  slice: Buffer
  savedRatio: number
}

/** Options for a rewrite. `within` restricts matches to one symbol's span. */
export interface RewriteOptions {
  pattern: string
  rewrite: string
  lang: string
  eol: string
  within?: { startByte: number, endByte: number }
}

/** What the audit stage reports; `degraded` is present only when a tool was unavailable. */
export interface DiffAudit {
  dir: string
  audit: {
    hunks: number
    addedLines: number
    removedLines: number
    language: string
    summary: string
    degraded?: string
  }
}

/** `sha256` of arbitrary bytes, lowercase hex. */
export const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex')

const RE_NL = /\r?\n/
const RE_NL_END = /\r?\n$/

function buildEsQuery(pattern: string, ext?: string): string {
  const trimmed = pattern.trim()
  if (!ext) return trimmed || '*'
  const clean = ext.replace(/^\./, '').toLowerCase()
  if (!trimmed || trimmed === '*') return `ext:${clean}`
  if (trimmed.toLowerCase().endsWith(`.${clean}`)) return trimmed
  return `${trimmed} ext:${clean}`
}

/**
 * Turn a query into an extension set plus a basename regex.
 *
 * This is the fallback matcher used when Everything returns nothing: the index is built asynchronously,
 * so a file created seconds ago is simply absent, and reading that as "no such file" is the one answer
 * the caller cannot verify.
 */
function queryMatcher(pattern: string | undefined, ext?: string): { exts: Set<string>, test: (name: string) => boolean } {
  const exts = new Set<string>()
  const raw = String(pattern ?? '')
  const tail = /\.([A-Za-z0-9]+)$/.exec(raw)
  if (ext) {
    for (const entry of String(ext).split(/[,\s]+/)) if (entry) exts.add(`.${entry.replace(/^\./, '').toLowerCase()}`)
  }
  if (tail) exts.add(`.${tail[1].toLowerCase()}`)
  if (exts.size === 0) for (const entry of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) exts.add(entry)
  const base = raw.replace(/^.*[\\/]/, '')
  const source = `^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`
  const re = new RegExp(source === '^.*$' ? '.' : source, 'i')
  return { exts, test: (name: string) => re.test(name) }
}

/**
 * Run an Everything query and return real files inside the requested roots.
 *
 * Three filters exist because `es.exe` answers from an index of *both* files and directories: a
 * `-path` query happily returns `node_modules/@dsh-ops`, and the pipeline then tries to parse a
 * directory (measured: `E_SANE_UNSUPPORTED_LANG` with an empty extension). Reparse points are refused
 * for the same reason — the index is historical, so a link created later still matches.
 */
export async function everythingFind(cfg: PtcConfig, q: EsQuery): Promise<string[]> {
  const args = ['-n', String(q.limit ?? 32)]
  if (q.regex) args.push('-r')
  const roots = q.roots?.length ? q.roots.map(root => path.resolve(cfg.cwd, root)) : []
  if (roots.length === 0 && q.scope !== 'global') roots.push(path.resolve(cfg.cwd))
  for (const root of roots) args.push('-path', root)
  args.push(buildEsQuery(q.pattern, q.ext))

  const result = await run(cfg.esPath, args, 'everything', { cwd: cfg.cwd, maxOutputBytes: cfg.maxOutputBytes, timeoutMs: cfg.timeoutMs })
  const stderr = stripBom(result.stderr.toString('utf8')).trim()
  if (/IPC|not running|Everything Service/i.test(stderr)) {
    throw new PtcOutcomeError('E_EVERYTHING_IPC', 'everything', 'es.exe cannot reach the Everything IPC: the main program or service is not running', stderr.slice(0, 400))
  }
  if (result.code !== 0) {
    throw new PtcOutcomeError('E_EVERYTHING_FAILED', 'everything', `es.exe exited with ${result.code}`, stderr.slice(0, 400))
  }

  const inside = (root: string, file: string): boolean => {
    const rel = path.relative(root, file)
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))
  }
  const insideRoot = (file: string): boolean => roots.length === 0 || roots.some(root => inside(root, file))
  const files = (await Promise.all(toLines(result.stdout)
    .map(line => path.resolve(cfg.cwd, line))
    .filter(insideRoot)
    .map(async file => {
      if (reparseEscape(file)) return null
      try {
        return (await stat(file)).isFile() ? file : null
      } catch {
        return null
      }
    }))).filter((file): file is string => file !== null)

  if (files.length === 0) {
    // The index is built asynchronously: a directory created minutes ago is not in it, so "on disk right
    // under src/" was being reported as "zero hits". One bounded walk, filtered by the query's basename
    // and extensions, decides whether the truth is really empty.
    const { exts, test } = queryMatcher(q.pattern, q.ext)
    const swept: string[] = []
    for (const root of (roots.length > 0 ? roots : [path.resolve(cfg.cwd)])) {
      let walked
      try {
        walked = walkBounded(root, exts, 2000, performance.now() + 500)
      } catch {
        continue
      }
      for (const candidate of walked.files) {
        if (swept.length >= (q.limit ?? 32)) break
        if (!test(path.basename(candidate))) continue
        if (reparseEscape(candidate)) continue
        swept.push(candidate)
      }
    }
    if (swept.length === 0) {
      throw new PtcOutcomeError('E_EVERYTHING_NOT_FOUND', 'everything', `es.exe returned nothing; the pipeline stops here: ${q.pattern}`, {
        pattern: q.pattern,
        roots: q.roots,
      })
    }
    files.push(...swept)
    dbg(cfg, 'everything-fallback-walk', swept.length)
  }

  const cwdRoot = path.resolve(cfg.cwd)
  const bare = q.pattern.replace(/^.*[\\/]/, '').replace(/^\*\./, '').toLowerCase()
  const rank = (candidate: string): number => {
    const lower = candidate.toLowerCase()
    let score = 0
    if (inside(cwdRoot, candidate)) score += 2
    const base = path.basename(lower)
    if (bare && (base === bare || base === `${bare}.ts` || base === `${bare}.js`)) score += 2
    else if (bare && base.includes(bare)) score += 1
    return score
  }
  files.sort((a, b) => rank(b) - rank(a))
  dbg(cfg, 'everything', files.length, 'file(s)', 'top=', files[0])
  return files
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cs': 'cs', '.rb': 'ruby', '.kt': 'kotlin', '.swift': 'swift', '.php': 'php',
}

/** Map a path to an ast-grep language name, refusing unknown extensions by name. */
export function langOf(file: string): string {
  const lang = LANG_BY_EXT[path.extname(file).toLowerCase()]
  if (!lang) {
    throw new PtcOutcomeError('E_SANE_UNSUPPORTED_LANG', 'sane', `unsupported file type: ${path.extname(file)}`, { file })
  }
  return lang
}

/** Declaration patterns per language, tried in order until one hits. */
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
      ]
    case 'python':
      return ['def $NAME', 'async def $NAME', 'class $NAME']
    case 'go':
      return ['func $NAME', 'func ($$$R) $NAME', 'type $NAME']
    case 'rust':
      return ['fn $NAME', 'struct $NAME', 'impl $NAME', 'enum $NAME', 'trait $NAME']
    case 'java':
    case 'cs':
    case 'kotlin':
      return ['class $NAME', 'interface $NAME', 'enum $NAME', 'record $NAME']
    default:
      return ['$NAME($$$A) { $$$B }']
  }
}

/** Run `sg run` with `--json=stream` and keep only the records that carry a range. */
async function sgJson(cfg: PtcConfig, args: string[], stage: Stage): Promise<{ matches: SgMatch[], res: ProcResult }> {
  const res = await run(cfg.sgPath, [...args, '--json=stream'], stage, {
    cwd: cfg.cwd,
    maxOutputBytes: cfg.maxOutputBytes,
    timeoutMs: cfg.timeoutMs,
  })
  const parsed = parseLooseJson(res.stdout.toString('utf8'))
  const matches = parsed.filter((entry): entry is SgMatch => Boolean(entry) && typeof entry === 'object' && 'range' in (entry as object))
  return { matches, res }
}

/** Drop patterns whose leading keyword does not even occur in the source. */
function reachablePatterns(patterns: string[], source: string): string[] {
  return patterns.filter(pattern => {
    const head = /^[A-Za-z_]+/.exec(pattern)?.[0]
    return !head || source.includes(head)
  })
}

/**
 * Locate `symbol` in one file through ast-grep.
 *
 * A multi-definition result is refused unless `cfg.allowMulti`: guessing which of two same-named
 * definitions the caller meant is how a refactor breaks a file.
 */
export async function saneLocate(cfg: PtcConfig, file: string, symbol: string, snapshot?: Buffer): Promise<SaneHit> {
  const lang = langOf(file)
  const size = snapshot ? snapshot.length : (await stat(file)).size
  const hits: SgMatch[] = []
  let lastErr = ''
  const patterns = reachablePatterns(defPatterns(lang), snapshot ? snapshot.toString('utf8') : await readFile(file, 'utf8'))
  for (const pattern of patterns) {
    const { matches, res } = await sgJson(cfg, ['run', '--pattern', pattern, '--lang', lang, file], 'sane')
    if (res.code !== 0 && res.code !== 1) {
      lastErr = stripBom(res.stderr.toString('utf8')).slice(0, 300)
      continue
    }
    for (const match of matches) {
      if (match.metaVariables?.single?.NAME?.text === symbol) hits.push(match)
    }
    if (hits.length > 0) break
  }
  if (hits.length === 0) {
    throw new PtcOutcomeError('E_SANE_SYMBOL_NOT_FOUND', 'sane', `symbol ${symbol} is absent from ${path.basename(file)}`, {
      file,
      lang,
      stderr: lastErr,
    })
  }
  if (hits.length > 1 && !cfg.allowMulti) {
    throw new PtcOutcomeError('E_SANE_AMBIGUOUS', 'sane', `symbol ${symbol} has ${hits.length} definitions; refusing to guess`, {
      lines: hits.map(hit => hit.range.start.line),
    })
  }
  const hit = hits[0]
  const { start, end } = hit.range.byteOffset
  const slice = snapshot ? snapshot.subarray(start, end) : await readRange(file, start, end)
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
  }
}

/**
 * Keep the original statement's terminator.
 *
 * `const a = 1;` rewritten without the `;`, or a body that ended in a newline, produces a diff that
 * touches the following line for no reason — and that noise is what makes an audit unreadable.
 */
function preserveTrailer(orig: string, next: string, eol: string): string {
  if (!orig) return next
  let out = next
  const trailer = /([;,]?)([ \t]*)(\r?\n)?$/.exec(orig)
  if (!trailer) return out
  const [, semi, , nl] = trailer
  if (semi && !out.trimEnd().endsWith(semi)) out = `${out.replace(/[ \t]*$/, '')}${semi}`
  if (nl && !/\n$/.test(out)) out += eol
  return out
}

/** Ask ast-grep for matches with replacements; an identity pattern/rewrite pair is refused up front. */
async function queryRewrite(cfg: PtcConfig, file: string, o: RewriteOptions): Promise<SgMatch[]> {
  if (o.pattern === o.rewrite) {
    throw new PtcOutcomeError('E_ASTGREP_IDENTITY', 'astgrep', 'pattern and rewrite are identical; nothing to do')
  }
  const { matches, res } = await sgJson(cfg, ['run', '--pattern', o.pattern, '--rewrite', o.rewrite, '--lang', o.lang, file], 'astgrep')
  const stderrText = stripBom(res.stderr.toString('utf8')).trim()
  // Exit 1 with no matches and no stderr is "nothing matched", not a failure.
  const noMatchExit = res.code === 1 && matches.length === 0 && stderrText === ''
  if (res.code !== 0 && !noMatchExit) {
    throw new PtcOutcomeError('E_ASTGREP_FAILED', 'astgrep', `ast-grep exited with ${res.code}`, stderrText.slice(0, 400))
  }
  return matches
}

/** Turn ast-grep matches into a sorted, non-overlapping edit list. */
function finishRewrite(cfg: PtcConfig, matches: SgMatch[], o: RewriteOptions): Edit[] {
  const edits: Edit[] = []
  for (const match of matches) {
    if (match.replacement == null || !match.replacementOffsets) continue
    const start = match.range.byteOffset.start
    const end = match.range.byteOffset.end
    if (o.within && (start < o.within.startByte || end > o.within.endByte)) continue
    const text = preserveTrailer(match.text, normalizeEol(match.replacement, o.eol as '\r\n' | '\n'), o.eol)
    if (text === match.text) continue
    edits.push({ startByte: match.replacementOffsets.start, endByte: match.replacementOffsets.end, text, before: match.text })
  }
  if (edits.length === 0) {
    throw new PtcOutcomeError('E_ASTGREP_NO_MATCH', 'astgrep', 'ast-grep matched nothing (pattern does not fit the target syntax, or every hit was filtered by within)', { pattern: o.pattern, within: o.within, rawMatches: matches.length })
  }
  edits.sort((a, b) => a.startByte - b.startByte)
  for (let i = 1; i < edits.length; i += 1) {
    if (edits[i].startByte < edits[i - 1].endByte) {
      throw new PtcOutcomeError('E_ASTGREP_OVERLAP', 'astgrep', 'patch spans overlap; refusing to write', { prev: edits[i - 1], cur: edits[i] })
    }
  }
  dbg(cfg, 'astgrep', edits.length, 'edit(s)')
  return edits
}

/** The ast-grep rewrite stage: query, then normalize into edits. */
export async function astGrepRewrite(cfg: PtcConfig, file: string, o: RewriteOptions): Promise<Edit[]> {
  return finishRewrite(cfg, await queryRewrite(cfg, file, o), o)
}

/**
 * Apply edits through the AgentBox worker.
 *
 * The worker is a separate process because it owns the atomic write; the payload carries the expected
 * sha256 so a file that changed between planning and writing is refused rather than overwritten.
 */
export async function agentBoxApply(cfg: PtcConfig, file: string, edits: Edit[], expectSha256: string): Promise<Record<string, unknown>> {
  const payload = JSON.stringify({
    path: path.resolve(file),
    expectSha256,
    atomic: true,
    edits: edits.map(edit => ({ start: edit.startByte, end: edit.endByte, b64: Buffer.from(edit.text, 'utf8').toString('base64') })),
  })
  const res = await run(process.execPath, [cfg.agentBoxWorker], 'agentbox', {
    cwd: cfg.cwd,
    stdin: payload,
    maxOutputBytes: cfg.maxOutputBytes,
    timeoutMs: cfg.timeoutMs,
  })
  const body = parseLooseJson(res.stdout.toString('utf8'))[0] as Record<string, unknown> | undefined
  if (!body) {
    throw new PtcOutcomeError('E_AGENTBOX_CRASH', 'agentbox', `AgentBox returned nothing usable (exit=${res.code})`, stripBom(res.stderr.toString('utf8')).slice(0, 400))
  }
  if (!body.ok) {
    throw new PtcOutcomeError('E_AGENTBOX_REJECTED', 'agentbox', String(body.message), { code: body.code })
  }
  return body
}

/** Put a file back the way it was, through the same checked writer. */
export async function agentBoxRestore(cfg: PtcConfig, file: string, original: Buffer, currentSha: string): Promise<void> {
  const { size } = await stat(file)
  await agentBoxApply(cfg, file, [{ startByte: 0, endByte: size, text: original.toString('utf8') }], currentSha)
}

/** Apply edits to a buffer without touching disk — the `preview` path. */
export function applyEditsInMemory(before: Buffer, edits: Edit[]): Buffer {
  const sorted = [...edits].sort((a, b) => a.startByte - b.startByte)
  const parts: Buffer[] = []
  let cursor = 0
  for (const edit of sorted) {
    if (!Number.isSafeInteger(edit.startByte) || !Number.isSafeInteger(edit.endByte)
      || edit.startByte < cursor || edit.endByte < edit.startByte || edit.endByte > before.length) {
      throw new PtcOutcomeError('E_AGENTBOX_REJECTED', 'agentbox', `preview assembly failed: illegal span ${edit.startByte}-${edit.endByte}`, { total: before.length })
    }
    parts.push(before.subarray(cursor, edit.startByte), Buffer.from(edit.text, 'utf8'))
    cursor = edit.endByte
  }
  parts.push(before.subarray(cursor))
  return Buffer.concat(parts)
}

/** Stage both sides of a comparison in a temp directory so difftastic can read them. */
async function auditPair(beforeBuf: Buffer, file: string, afterBuf?: Buffer): Promise<{ dir: string, before: string, after: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), `ptc-${process.pid}-`))
  const base = path.basename(file)
  const before = path.join(dir, 'before', base)
  const after = path.join(dir, 'after', base)
  try {
    const pairs = await Promise.allSettled([
      mkdir(path.dirname(before), { recursive: true }).then(() => writeFile(before, beforeBuf)),
      mkdir(path.dirname(after), { recursive: true }).then(() => afterBuf ? writeFile(after, afterBuf) : copyFile(path.resolve(file), after)),
    ])
    for (const result of pairs) if (result.status === 'rejected') throw result.reason
    return { dir, before, after }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

const countLines = (s: string): number => s.split(RE_NL).length
const countHunks = (chunks: unknown[]): number => chunks.reduce<number>((n, chunk) => {
  const sub = (chunk as { chunks?: unknown })?.chunks
  return n + 1 + (Array.isArray(sub) ? countHunks(sub) : 0)
}, 0)
const linesOf = (s: string): number => (s.length === 0 ? 0 : s.replace(RE_NL_END, '').split(RE_NL).length)

/**
 * Line delta for a pure audit (no edit list): strip the common prefix and suffix, then count what is
 * left on each side.
 *
 * This is the degraded path when difftastic is unavailable, and it has to be honest: the old version
 * returned 0/0, so an audit of a 9000-line rewrite reported +0/-0 and the model concluded nothing
 * changed.
 */
function lineDelta(beforeText: string, afterText: string): { added: number, removed: number } {
  const a = beforeText.split(RE_NL)
  const b = afterText.split(RE_NL)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  return { removed: a.length - head - tail, added: b.length - head - tail }
}

/**
 * difftastic's `aligned_lines` is the authoritative alignment: `[lhs, rhs]` is both sides, `[null, rhs]`
 * an addition, `[lhs, null]` a removal. Counting it is cheaper than a second line diff and more accurate
 * than counting chunks, which mixes changed and added lines together.
 */
function alignedDelta(aligned: unknown): { added: number, removed: number } | undefined {
  if (!Array.isArray(aligned)) return undefined
  let added = 0
  let removed = 0
  for (const pair of aligned) {
    if (!Array.isArray(pair)) continue
    if (pair[0] === null || pair[0] === undefined) added += 1
    else if (pair[1] === null || pair[1] === undefined) removed += 1
  }
  return { added, removed }
}

const difftProbes = new Map<string, Promise<boolean>>()

/** Whether difftastic is usable, cached by binary identity so an upgrade invalidates the probe. */
export async function difftAvailable(cfg: PtcConfig): Promise<boolean> {
  let key: string
  try {
    const bin = path.resolve(await pickBin([cfg.difftPath]))
    const info = await stat(bin, { bigint: true })
    key = `${bin}\0${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}\0${cfg.maxOutputBytes}`
  } catch {
    // No stable identity — ask the binary itself rather than caching something unfalsifiable.
    try {
      return (await run(cfg.difftPath, ['--version'], 'difftastic', { timeoutMs: 5000, maxOutputBytes: cfg.maxOutputBytes })).code === 0
    } catch {
      return false
    }
  }
  const cached = difftProbes.get(key)
  if (cached) return cached
  const probe = (async () => {
    try {
      return (await run(cfg.difftPath, ['--version'], 'difftastic', { timeoutMs: 5000, maxOutputBytes: cfg.maxOutputBytes })).code === 0
    } catch {
      return false
    }
  })()
  if (difftProbes.size >= 64) difftProbes.delete(difftProbes.keys().next().value as string)
  difftProbes.set(key, probe)
  // A failed probe is not worth remembering: the binary may simply have been mid-install.
  if (!await probe && difftProbes.get(key) === probe) difftProbes.delete(key)
  return probe
}

/**
 * Audit a change with difftastic, or degrade honestly when it is unavailable.
 *
 * A pure audit (no edit list) has no per-edit counters, so its +/- comes from the alignment; a rewrite
 * audit uses the edits it already has.
 */
export async function difftasticAudit(cfg: PtcConfig, beforeBuf: Buffer, file: string, edits: Edit[], afterBuf?: Buffer): Promise<DiffAudit> {
  const pure = edits.length === 0
  const added = edits.reduce((n, edit) => n + linesOf(edit.text), 0)
  const removed = edits.reduce((n, edit) => n + linesOf(edit.before ?? ''), 0)

  if (!await difftAvailable(cfg)) {
    const after = afterBuf ?? Buffer.from(await readFile(file))
    const delta = pure ? lineDelta(beforeBuf.toString('utf8'), after.toString('utf8')) : { added, removed }
    const changed = pure ? delta.added + delta.removed : edits.length
    return {
      dir: '',
      audit: {
        hunks: changed,
        addedLines: delta.added,
        removedLines: delta.removed,
        language: 'unknown',
        summary: pure
          ? `+${delta.added}/-${delta.removed} lines (difftastic unavailable; the audit degraded to line alignment)`
          : `+${added}/-${removed} lines across ${edits.length} rewrite(s) (difftastic unavailable; degraded)`,
        degraded: 'difftastic-unavailable',
      },
    }
  }

  const { dir, before, after } = await auditPair(beforeBuf, file, afterBuf)
  try {
    const res = await run(cfg.difftPath, ['--color', 'never', '--display', 'json', before, after], 'difftastic', {
      maxOutputBytes: cfg.maxOutputBytes,
      timeoutMs: cfg.timeoutMs,
      env: { DFT_UNSTABLE: 'yes' },
    })
    if (res.code !== 0) {
      throw new PtcOutcomeError('E_DIFF_FAILED', 'difftastic', `difftastic exited with ${res.code}`, stripBom(res.stderr.toString('utf8')).slice(0, 400))
    }
    const records = parseLooseJson(res.stdout.toString('utf8'))
    if (records.length === 0) throw new PtcOutcomeError('E_DIFF_EMPTY', 'difftastic', 'difftastic produced no output: the file did not change')
    const rec = records[0] as Record<string, unknown>
    const hunks = countHunks(Array.isArray(rec.chunks) ? rec.chunks : [])
    const language = String(rec.language ?? 'unknown')
    const delta = (pure ? alignedDelta(rec.aligned_lines) : undefined) ?? { added, removed }
    // difftastic falling back to Text means tree-sitter could not parse the file, so its syntax verdict
    // is worthless — and `requireAudit` says the caller wants to know that rather than be told "fine".
    if (language === 'Text' && cfg.requireAudit) {
      throw new PtcOutcomeError('E_DIFF_FAILED', 'difftastic', 'difftastic classified the file as Text (tree-sitter could not parse it); the syntax audit cannot be trusted', { file })
    }
    return {
      dir: '',
      audit: {
        hunks,
        addedLines: delta.added,
        removedLines: delta.removed,
        language,
        summary: pure
          ? `${path.basename(file)}: ${hunks} syntactic hunk(s), +${delta.added}/-${delta.removed} lines (${language})`
          : `${path.basename(file)}: ${hunks} syntactic hunk(s), ${edits.length} rewrite(s), +${delta.added}/-${delta.removed} lines (${language})`,
      },
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
