/**
 * The in-process engine: enumeration, symbol location and pattern-driven rewriting, no child process.
 *
 * Three layers, each with one job:
 *
 *   · **enumeration** — find candidate files. Walking is bounded by a wall-clock budget, and Everything
 *     is only used when the tree looks like a work root, because a stale index is worse than a slow walk.
 *   · **location** — turn a symbol into node spans. ast-grep patterns cover most declarations; class
 *     methods, fields and object pairs have no valid `$N(...) { }` pattern and are matched by kind+field.
 *   · **rewriting** — expand a template per hit, prove the splice with `auditAst`, then publish through
 *     the lock-and-rename writer.
 *
 * The receipt is an opaque JSON object on purpose: the adapter normalizes it into a host outcome, and
 * naming every field here would be a second, drifting copy of that contract.
 *
 * @module dsh-ops/ptc/inproc
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { auditAst, parseAuditRoot, sgCrossCheck } from './astdiff.cjs'
import { napi } from './engine-load.cjs'
import { esCandidates } from './proc.cjs'
import { reparseEscape } from './reparse.cjs'
import type { NapiApi, SgFindOptions, SgNode } from './sg.cjs'
import { checkedWrite, verifySnapshot } from './safe-write.cjs'


/** What a caller may ask for. `validateRequest` narrows this from `unknown`. */
export interface InprocRequest {
  file?: string
  symbol?: string
  sgPath?: string
  esPath?: string
  pattern?: string
  rewrite?: string
  limit?: number
  scanBudget?: number
  roots?: string[]
  ext?: string[]
  mode?: 'apply' | 'preview'
  strategy?: 'auto' | 'walk' | 'everything'
  strict?: boolean
  body?: boolean | number
}

/** A tool receipt: opaque JSON by design; see the module comment. */
export type InprocReceipt = Record<string, unknown>

/** One located definition, with its body when the byte budget allowed it. */
interface LocateHit {
  file: string
  lang: string
  lines: [number, number]
  signature: string
  body?: string
}

/** A file the refactor would touch, with the audit that justifies it. */
interface TouchedFile {
  file: string
  edits: number
  bytesIn: number
  bytesOut: number
  sample: string
  audit: ReturnType<typeof auditAst>
  cross?: ReturnType<typeof sgCrossCheck>
}

const napiApi = napi as unknown as NapiApi

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const RE_SEP = /[\\/]/
const RE_SEP_G = /[\\/]/g
const RE_SRC_SEG = /[\\/]src[\\/]/
const RE_GENERATED = /\.(gen|d)\.(ts|tsx|js|jsx)$/
const RE_TEST_FILE = /\.(test|spec)\.(t|j)sx?$/
const RE_NOISE_SEG = /[\\/](node_modules|dist|coverage)[\\/]/
const RE_EXCLUDED_SEG = /[\\/](node_modules|\.git|dist|coverage|\.tmp|\.sandbox)[\\/]/
const RE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const RE_KEYWORD_HEAD = /^[A-Za-z_]+/
const RE_LINE = /\r?\n/
const RE_LINE_G = /\r?\n/g
const RE_META_DECL = /\$(?:\$\$)?[A-Z_][A-Z0-9_]*/g
const RE_WS_G = /\s+/g

/** Reject a request before any filesystem work; every refusal names the offending field. */
function validateRequest(value: unknown, refactor: boolean): InprocRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InprocError('E_INPROC_ARGUMENT', 'the request must be an object')
  const req = value as Record<string, unknown>
  for (const key of ['file', 'symbol', 'sgPath', 'esPath']) {
    if (req[key] !== undefined && (typeof req[key] !== 'string' || !(req[key] as string).trim())) {
      throw new InprocError('E_INPROC_ARGUMENT', `${key} must be a non-empty string`)
    }
  }
  if (!refactor && typeof req.symbol !== 'string') throw new InprocError('E_INPROC_ARGUMENT', 'symbol is required')
  if (refactor && (typeof req.pattern !== 'string' || !req.pattern.trim() || typeof req.rewrite !== 'string')) {
    throw new InprocError('E_INPROC_ARGUMENT', 'pattern must be non-empty and rewrite must be a string')
  }
  for (const key of ['limit', 'scanBudget']) {
    const raw = req[key]
    if (raw !== undefined && (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > 150_000)) {
      throw new InprocError('E_INPROC_ARGUMENT', `${key} must be within 1..150000`)
    }
  }
  for (const key of ['roots', 'ext']) {
    const raw = req[key]
    if (raw !== undefined && (!Array.isArray(raw) || !raw.every(s => typeof s === 'string' && s.trim()))) {
      throw new InprocError('E_INPROC_ARGUMENT', `${key} must be an array of non-empty strings`)
    }
  }
  if (req.mode !== undefined && req.mode !== 'apply' && req.mode !== 'preview') throw new InprocError('E_INPROC_ARGUMENT', 'mode must be apply or preview')
  if (req.strategy !== undefined && !['auto', 'walk', 'everything'].includes(req.strategy as string)) throw new InprocError('E_INPROC_ARGUMENT', 'invalid strategy')
  if (req.strict !== undefined && typeof req.strict !== 'boolean') throw new InprocError('E_INPROC_ARGUMENT', 'strict must be a boolean')
  return req as InprocRequest
}

/** A refusal raised by the engine; the code reaches the receipt unchanged. */
class InprocError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'InprocError'
  }
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': napiApi.Lang.TypeScript,
  '.mts': napiApi.Lang.TypeScript,
  '.cts': napiApi.Lang.TypeScript,
  '.tsx': napiApi.Lang.Tsx,
  '.js': napiApi.Lang.JavaScript,
  '.mjs': napiApi.Lang.JavaScript,
  '.cjs': napiApi.Lang.JavaScript,
  '.jsx': napiApi.Lang.Tsx,
  '.html': napiApi.Lang.Html,
  '.htm': napiApi.Lang.Html,
  '.css': napiApi.Lang.Css,
}

const INPROC_MAX_BYTES = 2 << 20

const LANG_NAME: Record<string, string> = {
  [napiApi.Lang.TypeScript]: 'ts',
  [napiApi.Lang.Tsx]: 'tsx',
  [napiApi.Lang.JavaScript]: 'js',
  [napiApi.Lang.Html]: 'html',
  [napiApi.Lang.Css]: 'css',
}

const langOf = (file: string): string | null => LANG_BY_EXT[extname(file).toLowerCase()] ?? null

/**
 * Depth-first walk with a hard stop.
 *
 * The deadline is checked every 64 entries rather than every entry: `performance.now()` in the inner
 * loop cost more than the walk itself on wide directories, and being 64 entries late is harmless.
 */
function walkBounded(root: string, exts: Set<string>, cap: number, deadline: number): { files: string[], overflow: boolean } {
  const out: string[] = []
  const stack = [root]
  let ticks = 0
  while (stack.length) {
    const current = stack.pop() as string
    if (++ticks % 64 === 0 && performance.now() > deadline) return { files: out, overflow: true }
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
        stack.push(full)
      } else if (exts.has(extname(entry.name).toLowerCase())) {
        out.push(full)
        if (out.length > cap) return { files: out, overflow: true }
      }
    }
  }
  return { files: out, overflow: false }
}

const ES_CROSSOVER = 12_000
const MAX_ES_FILES = 150_000

interface EnumCacheEntry { files: string[], at: number, via: string, ms: number, truncated: boolean }
const enumCache = new Map<string, EnumCacheEntry>()
const CACHE_TTL = 30_000

/** Drop the enumeration cache; used by tests and by a caller that knows the tree just changed. */
export function clearEnumCache(): void {
  enumCache.clear()
}

/** Pick a working `es.exe`: a real path must exist, a bare name must answer `-h`. */
function resolveEs(explicit: string | undefined, cwd: string): string | null {
  for (const candidate of esCandidates(explicit, cwd)) {
    if (RE_SEP.test(candidate)) {
      if (existsSync(candidate)) return candidate
    } else if (spawnSync(candidate, ['-h'], { windowsHide: true, timeout: 3000 }).error === undefined) {
      return candidate
    }
  }
  return null
}

function enumerateByEverything(roots: string[], exts: Set<string>, esPath: string, limit: number): { files: string[], truncated: boolean } {
  const args = ['-n', String(limit)]
  for (const root of roots) args.push('-path', root)
  args.push(`ext:${[...exts].map(e => e.slice(1)).join(';')}`)
  const result = spawnSync(esPath, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: false, maxBuffer: 256 << 20 })
  if (result.error || result.status !== 0) return { files: [], truncated: false }
  const raw = String(result.stdout ?? '').split(RE_LINE).map(line => line.trim()).filter(Boolean)
  const files = raw.map(line => resolve(line)).filter(file => exts.has(extname(file).toLowerCase())
    && !RE_EXCLUDED_SEG.test(file)
    && roots.some(root => {
      const rel = relative(root, file)
      return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    }))
  return { files, truncated: raw.length >= limit }
}

/** Whether a directory looks like a project root — the only case where Everything earns its staleness risk. */
function looksLikeWorkRoot(root: string): boolean {
  try {
    const names = readdirSync(root, { withFileTypes: true })
    if (names.some(entry => entry.isDirectory() && entry.name === 'node_modules')) return true
    const depth = (root.match(RE_SEP_G) ?? []).length
    const dirs = names.filter(entry => entry.isDirectory()).length
    return depth <= 3 && dirs >= 10
  } catch {
    return false
  }
}

const WALK_BUDGET_MS = 250

/**
 * Enumerate candidate files.
 *
 * `auto` walks first and only falls back to Everything when the walk overflows: a stale index that
 * misses a freshly created file is the one failure mode a caller cannot see, so the cheap reliable
 * answer has to come first.
 */
export function enumerate(roots: string[], exts: Set<string>, opts: { strategy?: string, limit?: number, cwd: string, esPath?: string, refresh?: boolean }): { files: string[], via: string, truncated: boolean, ms: number, cached?: boolean } {
  const t0 = performance.now()
  const strategy = opts.strategy ?? 'auto'
  const cap = opts.limit ?? ES_CROSSOVER
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_ES_FILES) throw new InprocError('E_INPROC_ARGUMENT', `limit must be within 1..${MAX_ES_FILES}`)
  const resolvedRoots = [...new Set(roots.map(root => resolve(opts.cwd, root)))]
  const key = JSON.stringify([strategy, [...exts].sort(), resolvedRoots, cap, resolve(opts.cwd), opts.esPath ?? null])
  if (!opts.refresh) {
    const hit = enumCache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      return { files: [...hit.files], via: hit.via, truncated: hit.truncated, ms: 0, cached: true }
    }
  }
  const done = (files: string[], via: string, truncated: boolean) => {
    const unique = [...new Set(files)]
    const bounded = unique.slice(0, cap)
    const overflow = truncated || unique.length > cap
    if (enumCache.size >= 32) enumCache.delete(enumCache.keys().next().value as string)
    enumCache.set(key, { files: [...bounded], at: Date.now(), via, ms: performance.now() - t0, truncated: overflow })
    return { files: bounded, via, truncated: overflow, ms: Math.round((performance.now() - t0) * 100) / 100 }
  }
  const fromEs = () => {
    const es = resolveEs(opts.esPath, opts.cwd)
    if (!es) return null
    const result = enumerateByEverything(resolvedRoots, exts, es, Math.min(cap + 1, MAX_ES_FILES))
    return result.files.length ? done(result.files, 'everything', result.truncated) : null
  }
  if (strategy === 'everything' || (strategy === 'auto' && resolvedRoots.some(looksLikeWorkRoot))) {
    const viaEs = fromEs()
    if (viaEs) return viaEs
  }
  const deadline = performance.now() + WALK_BUDGET_MS
  const all = new Set<string>()
  for (const root of resolvedRoots) {
    const { files, overflow } = walkBounded(root, exts, cap + 1 - all.size, deadline)
    for (const file of files) all.add(file)
    if (overflow || all.size > cap) {
      if (strategy === 'auto') {
        const viaEs = fromEs()
        if (viaEs) return viaEs
      }
      return done([...all], 'walk', true)
    }
  }
  return done([...all], 'walk', false)
}

const SCAN_BUDGET = 3000
const SCAN_CHUNK = 400

function countSep(file: string): number {
  let n = 0
  for (let i = 0; i < file.length; i += 1) {
    const c = file.charCodeAt(i)
    if (c === 92 || c === 47) n += 1
  }
  return n
}

/**
 * Priority score: lower is scanned first.
 *
 * Depth dominates, then "is it under src/", then generated > test > noise. The point is that a
 * truncated scan still sees the files a human would have looked at first.
 */
function rank(file: string): number {
  const depth = countSep(file)
  let score = depth * 0.5
  if (!RE_SRC_SEG.test(file)) score += 3
  if (RE_GENERATED.test(file)) score += 2
  if (RE_TEST_FILE.test(file)) score += 1.5
  if (RE_NOISE_SEG.test(file)) score += 9
  return score
}

function rankOrdered(files: string[]): string[] {
  const scored = files.map((file, i) => ({ file, score: rank(file), i }))
  scored.sort((a, b) => a.score - b.score || a.i - b.i)
  return scored.map(item => item.file)
}

/**
 * Shrink the candidate list before parsing.
 *
 * Without a needle this is a plain slice. With one it reads files — but in chunks and it stops at eight
 * hits, because the caller only needs a handful of files to reach its limit and parsing is the expensive
 * half of the work.
 */
function narrow(candidates: string[], needle: string | null | undefined, budget = SCAN_BUDGET): { pool: string[], pruned: boolean, prefiltered: number, scanned: number } {
  if (!needle) return { pool: candidates.slice(0, budget), pruned: candidates.length > budget, prefiltered: 0, scanned: 0 }
  const ordered = candidates.length > budget ? rankOrdered(candidates) : candidates
  const slice = ordered.slice(0, budget)
  const hit: string[] = []
  let scanned = 0
  for (let i = 0; i < slice.length; i += SCAN_CHUNK) {
    const chunk = slice.slice(i, i + SCAN_CHUNK)
    scanned += chunk.length
    for (const file of chunk) {
      try {
        if (reparseEscape(file)) continue
        if (statSync(file).size <= INPROC_MAX_BYTES && readFileSync(file, 'utf8').includes(needle)) hit.push(file)
      } catch { /* unreadable candidate is simply not a hit */ }
    }
    if (hit.length >= 8) break
  }
  return { pool: hit.length ? hit : slice, pruned: scanned < candidates.length, prefiltered: hit.length, scanned }
}

/**
 * Patterns that catch a declaration by name.
 *
 * The three expression-bodied arrow forms are not optional: without them the most common short
 * functions in a repository never match, and the caller pays a second round trip to grep.
 */
const DEFINITIONS = [
  'function $N($$$A) { $$$B }',
  'function $N($$$A): $T { $$$B }',
  'const $N = ($$$A) => { $$$B }',
  'const $N = ($$$A): $T => { $$$B }',
  'const $N = async ($$$A) => { $$$B }',
  'const $N = ($$$A) => $B',
  'const $N = ($$$A): $T => $B',
  'const $N = async ($$$A) => $B',
  'const $N = $X => $B',
  'class $N { $$$B }',
  'interface $N { $$$B }',
  'type $N = $T',
]

/** kind + named field: declaration kinds ast-grep cannot capture with `$N`. */
const KIND_FIELDS: ReadonlyArray<[string, string]> = [
  ['method_definition', 'name'],
  ['public_field_definition', 'name'],
  ['pair', 'key'],
]

/**
 * Every node in `root` that defines `symbol`.
 *
 * When `source` is supplied the pattern list is filtered by keyword presence and a scan for the literal
 * name — a cheap refusal that saves parsing files that cannot contain the symbol.
 */
function locateSymbol(root: SgNode, symbol: string, source?: string): SgNode[] {
  if (source && !source.includes(symbol)) return []
  const hits = new Map<string, SgNode>()
  const inline = RE_IDENT.test(symbol)
  let definitions = inline ? DEFINITIONS.map(pattern => pattern.replace('$N', symbol)) : DEFINITIONS
  if (source) {
    definitions = definitions.filter(pattern => {
      const head = RE_KEYWORD_HEAD.exec(pattern)?.[0]
      return !head || source.includes(head)
    })
  }
  if (definitions.length === 0) return []
  const constraints = inline ? undefined : { N: { regex: `\\A${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\z` } }
  const matcher = (rule: Record<string, unknown>): SgFindOptions => (constraints ? { rule, constraints } : { rule })
  let groups: SgNode[][]
  try {
    groups = [root.findAll(matcher({ any: definitions.map(pattern => ({ pattern })) }))]
  } catch {
    // `any` fails when one alternative does not parse; fall back to one pattern at a time.
    groups = []
    for (const pattern of definitions) {
      try {
        groups.push(root.findAll(matcher({ pattern })))
      } catch { /* this pattern is not valid for this language */ }
    }
  }
  for (const found of groups) {
    for (const node of found) {
      if (!inline && node.getMatch('N')?.text() !== symbol) continue
      const range = node.range()
      hits.set(`${range.start.index}:${range.end.index}`, node)
    }
  }
  // Class methods, class fields and object-literal pairs have no valid `$N(...) { }` pattern, so they are
  // matched by kind and name field. Without this `class Beta { gamma() {} }` never resolves, and methods
  // are the most common target of an AST rewrite.
  if (inline) {
    const anchored = `^${symbol}$`
    for (const [kind, field] of KIND_FIELDS) {
      try {
        const found = root.findAll({ rule: { kind, has: { field, regex: anchored } } })
        for (const node of found) {
          const range = node.range()
          hits.set(`${range.start.index}:${range.end.index}`, node)
        }
      } catch { /* this kind does not exist in this language */ }
    }
  }
  return [...hits.values()].sort((a, b) => a.range().start.index - b.range().start.index)
}

const META = /\$(\$\$)?([A-Z_][A-Z0-9_]*)/g

interface TemplateCapture { whole: string, name: string, multi: boolean }
interface CompiledTemplate { parts: Array<string | number>, captures: TemplateCapture[] }

const templateCache = new Map<string, CompiledTemplate>()

/** Split a rewrite template into literal text and capture slots, cached by template text. */
function compileTemplate(tpl: string): CompiledTemplate {
  const cached = templateCache.get(tpl)
  if (cached) {
    templateCache.delete(tpl)
    templateCache.set(tpl, cached)
    return cached
  }
  const parts: Array<string | number> = []
  const captures: TemplateCapture[] = []
  const slots = new Map<string, number>()
  let cursor = 0
  for (const match of tpl.matchAll(META)) {
    parts.push(tpl.slice(cursor, match.index))
    let slot = slots.get(match[0])
    if (slot === undefined) {
      slot = captures.length
      slots.set(match[0], slot)
      captures.push({ whole: match[0], name: match[2], multi: Boolean(match[1]) })
    }
    parts.push(slot)
    cursor = match.index + match[0].length
  }
  parts.push(tpl.slice(cursor))
  const compiled = { parts, captures }
  if (templateCache.size >= 64) templateCache.delete(templateCache.keys().next().value as string)
  templateCache.set(tpl, compiled)
  return compiled
}

/** Fill a template for one node. A single capture that is unbound is a refusal, not an empty string. */
function expandTemplate(node: SgNode, tpl: CompiledTemplate, source: string): string {
  if (tpl.captures.length === 0) return tpl.parts[0] as string
  const values = tpl.captures.map(({ whole, name, multi }) => {
    if (multi) {
      const all = node.getMultipleMatches(name)
      if (all.length === 0) return ''
      return source.slice(all[0].range().start.index, all[all.length - 1].range().end.index)
    }
    const one = node.getMatch(name)
    if (!one) throw new InprocError('E_INPROC_TEMPLATE', `template variable ${whole} is unbound`)
    return one.text()
  })
  let out = ''
  for (const part of tpl.parts) out += typeof part === 'number' ? values[part] : part
  return out
}

/**
 * The body-attachment budget for a locate receipt.
 *
 * The hit span is already in hand; dropping it forces the model to call `ops_read_files` for the same
 * bytes, and that call re-sends the whole context. 8 KiB is the gate: past it the receipt falls back to
 * line numbers plus a ready-made `readHint`, so the cost cannot run away.
 */
const BODY_AUTO_BYTES = 8 * 1024

/** Locate a symbol and return its definitions, with bodies inside the byte budget. */
export function inprocLocate(req: InprocRequest, cwd = process.cwd()): InprocReceipt {
  const t0 = performance.now()
  let locate: Record<string, unknown> | undefined
  const done = (o: Record<string, unknown>): InprocReceipt => {
    // `locate` is declared after the first pass; the spread order keeps it after the payload fields.
    const extras: Record<string, unknown> = locate ? { locate } : {}
    return {
      status: o.status ?? 'ok',
      engine: 'inproc-ast',
      ...o,
      hits: (o.hits as LocateHit[] | undefined) ?? [],
      ...extras,
      ms: Math.round((performance.now() - t0) * 100) / 100,
    }
  }
  try {
    const request = validateRequest(req, false)
    const limit = request.limit ?? 5
    // Filesystem facts outrank index facts. A stale Everything index finds old files and misses new
    // ones, so enumeration is non-empty, the zero-hit fallback never triggers, and the tool reports
    // "symbol absent" while the file sits on disk. Treating "es enumerated, symbol empty" as one more
    // retry signal costs a walk on the failure path and nothing on the success path.
    for (let pass = 0; ; pass += 1) {
      const retryViaWalk = (): boolean => pass === 0 && request.file === undefined && locate?.via === 'everything' && request.strategy !== 'walk'
      let candidates: string[]
      if (request.file) {
        candidates = [resolve(cwd, request.file)]
      } else {
        const exts = new Set((request.ext ?? ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']).map(e => (e.startsWith('.') ? e : `.${e}`).toLowerCase()))
        const roots = (request.roots ?? [cwd]).map(root => resolve(cwd, root))
        const enumerated = enumerate(roots, exts, { strategy: pass === 0 ? request.strategy : 'walk', esPath: request.esPath, cwd, refresh: pass !== 0 })
        candidates = enumerated.files
        locate = { via: enumerated.via, ms: enumerated.ms, scanned: enumerated.files.length, truncated: enumerated.truncated }
      }
      if (candidates.length === 0) {
        if (retryViaWalk()) continue
        return done({ status: 'error', code: 'E_INPROC_NO_FILES', message: 'enumeration returned no files' })
      }
      const { pool, pruned } = request.file
        ? { pool: candidates, pruned: false }
        : narrow(candidates, request.symbol, request.scanBudget)
      if (locate && pruned) locate = { ...locate, pruned: true }
      const hits: LocateHit[] = []
      // Bodies are collected in hit order and attached at settlement, so the receipt's field order stays stable.
      const bodies: string[] = []
      for (const file of pool) {
        if (hits.length >= limit) break
        const lang = langOf(file)
        if (!lang) continue
        let bytes: number
        let src: string
        try {
          if (reparseEscape(file)) continue
          if (statSync(file).size > INPROC_MAX_BYTES) continue
          const buf = readFileSync(file)
          bytes = buf.length
          if (bytes > INPROC_MAX_BYTES) continue
          src = buf.toString('utf8')
        } catch {
          continue
        }
        const root = parseAuditRoot(lang, src)
        for (const node of locateSymbol(root, request.symbol as string, src)) {
          const range = node.range()
          const text = node.text()
          // Only fields the model can act on: chars/bodyBytes/savedRatio are self-reported numbers it
          // never branches on and cost 82 B per hit.
          hits.push({
            file,
            lang: LANG_NAME[lang] ?? String(lang),
            lines: [range.start.line + 1, range.end.line + 1],
            signature: text.split(RE_LINE)[0].trim().slice(0, 160),
          })
          bodies.push(text)
          if (hits.length >= limit) break
        }
      }
      if (hits.length === 0 && retryViaWalk()) continue
      if (hits.length === 0) {
        const hint = pruned
          ? `; ${candidates.length} files enumerated, the scan budget covered only the ${SCAN_BUDGET} highest-ranked (pruned) — narrow roots or raise scanBudget`
          : ''
        return done({ status: 'error', code: 'E_INPROC_NO_MATCH', message: `symbol ${request.symbol} not found (${pool.length} candidates after prefilter${hint})` })
      }
      // Body attachment: inside the budget the text ships with the receipt; past it the caller gets a
      // ready-made readHint instead. Either way the cost is bounded by one constant.
      const wantBody = request.body !== false
      const budget = typeof request.body === 'number' && request.body > 0
        ? Math.min(request.body, BODY_AUTO_BYTES * 4)
        : BODY_AUTO_BYTES
      let used = 0
      let omitted = 0
      if (wantBody) {
        for (let i = 0; i < hits.length; i += 1) {
          const size = Buffer.byteLength(bodies[i], 'utf8')
          if (used + size > budget) {
            omitted += 1
            continue
          }
          used += size
          hits[i].body = bodies[i]
        }
      } else {
        omitted = hits.length
      }
      const first = hits[0]
      if (omitted === 0) return done({ hits })
      // Parameters only, no body: ~70 B that replaces a round of offset/limit guessing by the model.
      return done({
        hits,
        bodyOmitted: omitted,
        readHint: {
          tool: 'ops_read_files',
          files: [{ path: first.file, offset: first.lines[0], limit: Math.max(1, first.lines[1] - first.lines[0] + 1) }],
        },
      })
    }
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    return done({ status: 'error', code: typeof code === 'string' && code.startsWith('E_INPROC_') ? code : 'E_INPROC_INTERNAL', message: String((error as Error)?.message ?? error) })
  }
}

/** Rewrite every hit of `pattern` inside the resolved scope, then audit and publish. */
export function inprocRefactor(req: InprocRequest, cwd = process.cwd()): InprocReceipt {
  const t0 = performance.now()
  let locate: Record<string, unknown> | undefined
  const done = (o: Record<string, unknown>): InprocReceipt => {
    const extras: Record<string, unknown> = locate ? { locate } : {}
    return {
      status: o.status ?? 'ok',
      engine: 'inproc-ast',
      ...o,
      ...extras,
      ms: Math.round((performance.now() - t0) * 100) / 100,
    }
  }
  try {
    const request = validateRequest(req, true)
    const mode = request.mode ?? 'apply'
    const limit = request.limit ?? 1
    const pattern = request.pattern as string
    const rewrite = request.rewrite as string
    // Every `$NAME` the rewrite uses must be declared by the pattern; an unbound slot would silently
    // produce an empty rewrite.
    const declared = new Set(pattern.match(RE_META_DECL) ?? [])
    for (const meta of rewrite.match(RE_META_DECL) ?? []) {
      if (!declared.has(meta)) throw new InprocError('E_INPROC_TEMPLATE', `the template uses an unbound variable ${meta}`)
    }
    const template = compileTemplate(rewrite)
    const pending: Array<{ file: string, before: Buffer, after: string }> = []
    let candidates: string[]
    let walked = 0
    if (request.file) {
      candidates = [resolve(cwd, request.file)]
    } else {
      const exts = new Set((request.ext ?? ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']).map(e => (e.startsWith('.') ? e : `.${e}`).toLowerCase()))
      const roots = (request.roots ?? [cwd]).map(root => resolve(cwd, root))
      const enumerated = enumerate(roots, exts, { strategy: request.strategy, esPath: request.esPath, cwd })
      walked = enumerated.files.length
      candidates = enumerated.files
      locate = { via: enumerated.via, ms: enumerated.ms, scanned: enumerated.files.length, truncated: enumerated.truncated }
    }
    if (candidates.length === 0) return done({ status: 'error', code: 'E_INPROC_NO_FILES', message: 'enumeration returned no files' })
    const { pool, pruned } = request.file
      ? { pool: candidates, pruned: false }
      : narrow(candidates, request.symbol ?? null, request.scanBudget)
    if (pruned && locate) locate = { ...locate, pruned: true }
    candidates = pool
    const touched: TouchedFile[] = []
    let firstError: string | null = null
    for (const file of candidates) {
      if (touched.length >= limit) break
      if (reparseEscape(file)) continue
      let size: number
      try {
        size = statSync(file).size
      } catch {
        continue
      }
      if (size > INPROC_MAX_BYTES) {
        return done({ status: 'error', code: 'E_INPROC_TOO_BIG', message: `${basename(file)} is ${size} bytes, over the in-process threshold`, fallback: 'spawn' })
      }
      const lang = langOf(file)
      if (!lang) continue
      const buf = readFileSync(file)
      if (buf.length > INPROC_MAX_BYTES) throw new InprocError('E_INPROC_TOO_BIG', `${basename(file)} grew past the size limit while being read`)
      let src: string
      try {
        src = utf8Strict.decode(buf)
      } catch {
        throw new InprocError('E_INPROC_ENCODING', `${basename(file)} is not valid UTF-8`)
      }
      const root = parseAuditRoot(lang, src)
      let scopes: SgNode[]
      if (request.symbol) {
        scopes = locateSymbol(root, request.symbol, src)
        // Ambiguity is refused instead of guessed: rewriting the wrong definition is unrecoverable.
        if (scopes.length > 1) throw new InprocError('E_INPROC_SYMBOL_AMBIGUOUS', `${basename(file)} has ${scopes.length} definitions named ${request.symbol}`)
        if (scopes.length === 0) {
          firstError = firstError ?? `symbol ${request.symbol} is absent from ${basename(file)}`
          continue
        }
      } else {
        scopes = [root]
      }
      const found: SgNode[] = []
      for (const scope of scopes) {
        let matched: SgNode[]
        try {
          matched = scope.findAll({ rule: { pattern } })
        } catch (error) {
          return done({ status: 'error', code: 'E_INPROC_BAD_PATTERN', message: `invalid pattern syntax: ${String(error)}` })
        }
        found.push(...matched)
      }
      const unique = new Map<string, { node: SgNode, startByte: number, endByte: number }>()
      for (const node of found) {
        const range = node.range()
        unique.set(`${range.start.index}:${range.end.index}`, { node, startByte: range.start.index, endByte: range.end.index })
      }
      const nodes = [...unique.values()].sort((a, b) => a.startByte - b.startByte)
      if (nodes.length === 0) {
        firstError = firstError ?? `pattern matched nothing: ${pattern}`
        continue
      }
      const eol = src.includes('\r\n') ? '\r\n' : '\n'
      const templateSource = rewrite.includes('$$$') ? root.text() : src
      const crlf = eol === '\r\n'
      const spans = nodes.map(({ node, startByte, endByte }) => {
        const expanded = expandTemplate(node, template, templateSource)
        // Rewritten text inherits the file's EOL so the diff stays local instead of reflowing the file.
        const needs = crlf ? expanded.includes('\n') : expanded.includes('\r')
        return { startByte, endByte, text: needs ? expanded.replace(RE_LINE_G, eol) : expanded }
      })
      for (let i = 1; i < spans.length; i += 1) {
        if (spans[i].startByte < spans[i - 1].endByte) throw new InprocError('E_INPROC_OVERLAP', 'AST hit spans overlap; refusing to rewrite')
      }
      const editSource = rewrite.includes('$$$') ? templateSource : root.text()
      const parts: string[] = []
      let cursor = 0
      for (const span of spans) {
        parts.push(editSource.slice(cursor, span.startByte), span.text)
        cursor = span.endByte
      }
      parts.push(editSource.slice(cursor))
      const after = parts.join('')
      const audit = auditAst(src, after, lang, spans, root)
      if (!audit.ok) {
        return done({
          status: 'error',
          code: audit.code ?? 'E_INPROC_BROKEN_AST',
          message: `${basename(file)}: ${audit.message}`,
          file,
          edits: nodes.length,
          audit,
        })
      }
      let cross: ReturnType<typeof sgCrossCheck> | undefined
      if (request.strict) {
        let fileWide = nodes.length
        try {
          fileWide = root.findAll({ rule: { pattern } }).length
        } catch { /* keep the scope-local count */ }
        cross = sgCrossCheck(file, pattern, LANG_NAME[lang] ?? 'ts', fileWide, request.sgPath ?? 'ast-grep')
        if (!cross.agree) {
          return done({
            status: 'error',
            code: 'E_INPROC_CROSSCHECK',
            message: `napi and sg disagree on the whole-file hit count for this pattern (${cross.diff.join(' ')}); refusing to write`,
            file,
            audit,
            crossCheck: cross,
          })
        }
      }
      const sample = nodes[0].node.text().replace(RE_WS_G, ' ').slice(0, 120)
      pending.push({ file, before: buf, after })
      touched.push({ file, edits: nodes.length, bytesIn: buf.length, bytesOut: Buffer.byteLength(after), sample, audit, cross })
    }
    if (touched.length === 0) {
      return done({ status: 'error', code: 'E_INPROC_NO_MATCH', message: firstError ?? 'no candidate file changed', files: walked })
    }
    const cleanupErrors: string[] = []
    if (mode === 'apply') {
      // Two phases: prove every snapshot first, then write. A partial proof would mean writing files
      // whose siblings had already changed underneath the plan.
      for (const item of pending) verifySnapshot(item.file, item.before)
      const committed: string[] = []
      try {
        for (const item of pending) {
          const receipt = checkedWrite(item.file, item.before, item.after)
          committed.push(item.file)
          if (receipt.cleanupErrors.length) cleanupErrors.push(...receipt.cleanupErrors)
        }
      } catch (error) {
        const cause = error as { code?: string, message?: string, cleanupErrors?: string[] }
        if (cause.cleanupErrors?.length) cleanupErrors.push(...cause.cleanupErrors)
        return done({
          status: 'error',
          code: cause.code ?? 'E_INPROC_WRITE',
          message: cause.message,
          committed,
          partial: committed.length > 0,
          ...(cleanupErrors.length ? { cleanupErrors } : {}),
        })
      }
    }
    const total = touched.reduce((acc, item) => ({ edits: acc.edits + item.edits, bytesIn: acc.bytesIn + item.bytesIn, bytesOut: acc.bytesOut + item.bytesOut }), { edits: 0, bytesIn: 0, bytesOut: 0 })
    // One merged audit for the receipt: the caller wants a verdict for the operation, not per file.
    const merged = {
      ok: touched.every(item => item.audit.ok),
      hunks: touched.reduce((n, item) => n + item.audit.hunks, 0),
      nodesRemoved: touched.reduce((n, item) => n + item.audit.nodesRemoved, 0),
      nodesAdded: touched.reduce((n, item) => n + item.audit.nodesAdded, 0),
      errorNodes: touched.reduce((n, item) => n + item.audit.errorNodes, 0),
      errorNodesBefore: touched.reduce((n, item) => n + item.audit.errorNodesBefore, 0),
      parser: touched.every(item => item.audit.parser === 'tsc') ? 'tsc' : 'tree-sitter',
      diagAfter: touched.reduce((n, item) => n + item.audit.diagAfter, 0),
      diagBefore: touched.reduce((n, item) => n + item.audit.diagBefore, 0),
      unchangedRatio: Math.min(...touched.map(item => item.audit.unchangedRatio)),
      kinds: [...new Set(touched.flatMap(item => item.audit.kinds))].slice(0, 6),
      bytesBefore: touched.reduce((n, item) => n + item.audit.bytesBefore, 0),
      bytesAfter: touched.reduce((n, item) => n + item.audit.bytesAfter, 0),
      ms: Math.round(touched.reduce((n, item) => n + item.audit.ms, 0) * 100) / 100,
    }
    return done({
      file: touched.length === 1 ? touched[0].file : `${touched.length} files`,
      symbol: request.symbol,
      edits: total.edits,
      files: touched.length,
      bytesIn: total.bytesIn,
      bytesOut: total.bytesOut,
      staged: mode === 'preview',
      sample: touched[0].sample,
      audit: merged,
      crossCheck: touched.find(item => item.cross)?.cross,
      ...(cleanupErrors.length ? { cleanupErrors } : {}),
    })
  } catch (error) {
    if (error instanceof InprocError) return done({ status: 'error', code: error.code, message: error.message })
    const code = (error as { code?: unknown })?.code
    return done({ status: 'error', code: typeof code === 'string' && code.startsWith('E_INPROC_') ? code : 'E_INPROC_INTERNAL', message: String((error as Error)?.message ?? error) })
  }
}

/** Split `--key value` / `--flag` pairs; a value never swallows the next flag. */
function parseFlags(argv: string[]): { flags: Set<string>, get: (key: string) => string | undefined } {
  const flags = new Set<string>()
  const vals = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      flags.add(key)
      continue
    }
    vals.set(key, next)
    i += 1
  }
  return { flags, get: key => vals.get(key) }
}

/** The `ops-ptc` entry: 0 on success, 1 on a business refusal. */
export function runInprocCli(argv: string[], cwd = process.cwd()): number {
  const { flags, get } = parseFlags(argv)
  const sub = argv[0] === 'locate' ? 'locate' : 'refactor'
  const wantJson = !flags.has('quiet')
  if (sub === 'locate') {
    const out = inprocLocate({
      symbol: get('symbol') ?? '',
      file: get('file'),
      roots: get('roots') ? [get('roots') as string] : undefined,
      ext: get('ext') ? (get('ext') as string).split(',') : undefined,
      strategy: get('strategy') as InprocRequest['strategy'],
      esPath: get('es'),
      scanBudget: get('budget') ? Number(get('budget')) : undefined,
      limit: get('limit') ? Number(get('limit')) : undefined,
    }, cwd)
    if (wantJson) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    return out.status === 'ok' ? 0 : 1
  }
  const out = inprocRefactor({
    pattern: get('pattern') ?? '',
    rewrite: get('rewrite') ?? '',
    symbol: get('symbol'),
    file: get('file'),
    roots: get('roots') ? [get('roots') as string] : undefined,
    ext: get('ext') ? (get('ext') as string).split(',') : undefined,
    mode: (get('mode') as InprocRequest['mode']) ?? 'preview',
    limit: get('limit') ? Number(get('limit')) : undefined,
    strategy: get('strategy') as InprocRequest['strategy'],
    esPath: get('es'),
    scanBudget: get('budget') ? Number(get('budget')) : undefined,
    strict: flags.has('strict'),
  }, cwd)
  if (wantJson) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  return out.status === 'ok' ? 0 : 1
}

const entry = process.argv[1] ? basename(process.argv[1]) : ''
if (entry === 'inproc.js' || entry === 'inproc.cjs' || entry === 'inproc.mjs') {
  process.exit(runInprocCli(process.argv.slice(2)))
}
