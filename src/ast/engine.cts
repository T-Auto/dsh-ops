/**
 * In-process AST engine: locate, rewrite, audit. No child process.
 *
 * `@ast-grep/napi` is a native module, so its types are declared locally and the module is required
 * lazily through the host bridge. Platform facts (BOM, EOL, permission bits) are read from the real
 * file at commit time, never taken from the caller.
 *
 * @module dsh-ops/ast/engine
 */

import { existsSync, lstatSync, mkdirSync, promises as fsp, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

/* ── Types borrowed from @ast-grep/napi itself: `import type` erases, so the require stays lazy. ── */

import type { NapiConfig, SgNode as NapiNode } from '@ast-grep/napi'
import { prefilterAsync, srcOf, type Candidate } from './prefilter.cjs'

type NapiRoot = NapiNode
type NapiModule = typeof import('@ast-grep/napi')
const kindOf = (node: NapiNode): string => String(node.kind())

let napiModule: NapiModule | undefined
const napi = (): NapiModule => (napiModule ??= require('@ast-grep/napi') as NapiModule)
const parseTree = (lang: string, text: string): NapiRoot => napi().parse(lang, text).root()

/* ── Receipts and internal values ── */

/** Source-file value object: one shape everywhere. `text === null` means unreadable. */
export interface SourceFile { file: string; text: string | null; error?: string | null }
export interface SourceHit { file: string; lang: string; lines: [number, number]; signature: string; body?: string }
export interface DiscoverStats { total: number; truncated: boolean; truncatedBy?: 'deadline' | 'page' | null; continuation?: string | null; reusedDirs?: number; scannedDirs?: number }
export interface LocateReceipt {
  status: 'ok' | 'error'
  hits: SourceHit[]
  discover?: DiscoverStats
  continuation?: string
  pruned?: boolean
  /** True when `limit` stopped the walk early; the list is then not the complete set of hits. */
  truncated?: boolean
  code?: string
  message?: string
}
export interface FileDelta { file: string; edits: number; addedLines: number; removedLines: number }
export interface AuditFacts {
  edits?: number
  addedLines: number
  removedLines: number
  formatOnly: boolean
  errorNodesBefore: number
  errorNodesAfter: number
  nodesBefore?: number
  nodesAfter?: number
  nodesChanged?: number
  /** True when the walk hit its depth or node ceiling: the counts below are lower bounds. */
  nodeScanTruncated?: boolean
  ok?: boolean
}
export interface RefactorReceipt {
  status: 'ok' | 'error'
  mode: 'preview' | 'apply'
  edits?: number
  files?: FileDelta[]
  filesTotal?: number
  filesApplied?: string[]
  /** Present on `apply`: the full replacement text, so a caller can commit it elsewhere. */
  after?: string
  /** Present on `apply`: the SHA-256 of the bytes the plan was built against. */
  revision?: string
  /** Files the caller still has to publish. */
  pending?: number
  /** Files whose content matched, before `limit` was applied. */
  matched?: number
  planned?: number
  /** Matched but not planned because `limit` stopped the walk; `null` when the walk stopped early. */
  remaining?: number | null
  applied?: boolean
  effectState?: 'none' | 'applied' | 'partial'
  audit?: AuditFacts
  conflicts?: Array<{ file: string; code: string; message: string }>
  discover?: DiscoverStats
  continuation?: string
  code?: string
  message?: string
}
export interface AuditReceipt extends AuditFacts { status: 'ok' | 'error'; file?: string; lang?: string; code?: string; message?: string }
export interface EngineOptions {
  /** Every root must resolve inside one of these. Absent means the session cwd. */
  bounds?: readonly string[]
  /** Trees never entered and never read: the credential locations, pruned during enumeration. */
  deny?: readonly string[]
  /** False in a read-only session: the scan still runs, it just leaves no index behind. */
  cache?: boolean
  /** Cancels enumeration and prefiltering; a truncation is reported, never a silent success. */
  signal?: AbortSignal
  /** Where a commit may land. Absent means `bounds`; the session cwd is a read scope, not a write one. */
  writeRoots?: readonly string[]
  /** Files already narrowed by a faster scan; the engine still fences each one. */
  candidates?: readonly string[]
}
export interface LocateRequest { symbol?: string; file?: string; roots?: string[]; ext?: string[]; limit?: number; body?: number | boolean; continuation?: string; skipDirs?: string[] }
export interface RefactorRequest extends LocateRequest { pattern?: string; rewrite?: string; mode?: 'preview' | 'apply'; detail?: boolean }
export interface AuditRequest { file?: string; beforeFile?: string }

interface Plan { rel: string; target: string; text: string; after: string; delta: { addedLines: number; removedLines: number }; audit: AuditFacts; edits: number }
interface Conflict { file: string; code: string; message: string; audit?: AuditFacts }

/* ── Constants ── */

const LANG_BY_EXT: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.tsx': 'Tsx', '.jsx': 'Tsx',
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.html': 'Html', '.css': 'Css',
}
const LANG_NAME: Readonly<Record<string, string>> = { TypeScript: 'ts', Tsx: 'tsx', JavaScript: 'js', Html: 'html', Css: 'css' }
const EXT_DEFAULT: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
/** Directories skipped by enumeration. `out` is absent: it is also a common source directory name. */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'target', 'vendor', '.cache'])
const MAX_BYTES = 2 << 20
const CAP = 20000
const BUDGET_MS = 400
const BODY_BUDGET = 8 * 1024
const LOCATE_PARSE_MAX = 48
const ROOT_CACHE_ENTRIES = 8
const ROOT_CACHE_CHARS = 4 << 20

const safeName = (n: unknown): n is string => typeof n === 'string' && n.length > 0 && n.length < 255 && !n.includes('/') && !n.includes('\\') && n !== '.' && n !== '..'

/* ── Languages ── */

const langFor = (file: string): string | null => {
  const ext = extname(file).toLowerCase()
  return LANG_BY_EXT[ext] ?? null
}
const langLabel = (lang: string): string => LANG_NAME[lang] ?? lang.toLowerCase()

/* ── Parse caches ── */

const rootCache = new Map<string, NapiRoot>()
let rootCacheChars = 0

/** Parsed-root cache (key = lang + text, matched by value). Ranges are UTF-16 code units. */
function cachedRoot(lang: string, text: string): NapiRoot {
  const key = lang + '\u0000' + text
  const hit = rootCache.get(key)
  if (hit) { rootCache.delete(key); rootCache.set(key, hit); return hit }
  const root = parseTree(lang, text)
  rootCache.set(key, root)
  rootCacheChars += text.length
  while (rootCache.size > ROOT_CACHE_ENTRIES || rootCacheChars > ROOT_CACHE_CHARS) {
    const oldest = rootCache.keys().next().value
    if (oldest === undefined || rootCache.size === 1) break
    rootCacheChars -= oldest.length > lang.length ? oldest.length - lang.length - 1 : 0
    rootCache.delete(oldest)
  }
  return root
}

const patternCache = new Map<string, NapiConfig>()
const matcher = (lang: string, pattern: string): NapiConfig => {
  const key = lang + '\u0000' + pattern
  let m = patternCache.get(key)
  if (!m) {
    try { m = napi().pattern(lang, pattern) } catch { m = { rule: { pattern } } }
    if (patternCache.size > 256) patternCache.clear()
    patternCache.set(key, m)
  }
  return m
}

const symbolCache = new WeakMap<NapiRoot, Map<string, NapiNode[]>>()

/* ── Enumeration and index ── */

const INDEX_DIR = join(tmpdir(), 'dsh-ast-index')
const indexOf = (root: string, skipKey = ''): string =>
  join(INDEX_DIR, createHash('sha256').update(root + '|' + skipKey).digest('hex').slice(0, 16) + '.json')

/**
 * The index lives in %TEMP%, where any local process can rewrite it, so nothing here is trusted:
 * every entry is re-anchored by `safeName`, every file is realpath-checked again, and a malformed
 * file is simply a cache miss. There is no key to forge because there is no claim being made.
 */
interface IndexEntry { mtimeMs: number; dirs: string[]; files: string[] }
function loadIndex(root: string, skipKey: string): { dirs: Record<string, IndexEntry> } | null {
  try {
    const raw = JSON.parse(readFileSync(indexOf(root, skipKey), 'utf8')) as { dirs?: Record<string, IndexEntry> }
    return raw && raw.dirs && typeof raw.dirs === 'object' ? { dirs: raw.dirs } : null
  } catch { return null }
}

interface DiscoverResult { files: string[]; total: number; truncated: boolean; truncatedBy: 'deadline' | 'page' | null; continuation: string | null; reusedDirs: number; scannedDirs: number; ms: number }

/** Bounded enumeration with continuation. A directory whose mtime is unchanged skips readdir. */
async function discover(roots: string[], exts: ReadonlySet<string>, opts: { offset?: number; cap?: number; budgetMs?: number; index?: { dirs: Record<string, IndexEntry> } | null; skip?: ReadonlySet<string>; deny?: readonly string[]; cache?: boolean; signal?: AbortSignal; roots?: readonly string[] } = {}): Promise<DiscoverResult> {
  const t0 = performance.now()
  const skip = opts.skip ?? SKIP_DIRS
  const skipKey = [...skip].sort().join(',')
  const offset = opts.offset ?? 0
  const cap = opts.cap ?? CAP
  const deadline = t0 + (opts.budgetMs ?? BUDGET_MS)
  const prior = opts.index?.dirs ?? {}
  const deny = opts.deny ?? []
  // One realpath per candidate, not one per deny root:  already resolves the target
  // and caches the roots, so calling it inside the loop cost 13 realpaths per file.
  // The walk refuses a denied directory before entering it, so a walked file can only be denied by
  // being a link into one. lstat is far cheaper than the 200 realpaths an unconditional resolve cost.
  // Only directories reach this now. A denied directory is refused before it is entered, so nothing
  // inside it is ever enumerated; a regular file below an allowed directory cannot be denied.
  const denied = (target: string): boolean => {
    if (deny.length === 0) return false
    try { if (!lstatSync(target).isSymbolicLink()) return false } catch { return false }
    return resolvedInside(target, deny) !== null
  }

  const files: string[] = []
  let reusedDirs = 0
  let scannedDirs = 0
  let truncated = false
  const nextDirs: Record<string, IndexEntry> = {}

  const stack = [...roots]
  while (stack.length > 0) {
    if (performance.now() > deadline || opts.signal?.aborted) { truncated = true; break }
    const dir = stack.pop() as string
    if (denied(dir)) continue
    let mtimeMs: number
    try { mtimeMs = (await fsp.stat(dir)).mtimeMs } catch { continue }
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir
    const cached = prior[key]
    let subdirs: string[]
    let names: string[]
    if (cached && cached.mtimeMs === mtimeMs && Array.isArray(cached.dirs) && Array.isArray(cached.files)) {
      // The index has no owner: a name containing a separator or `..` could lead outside the root.
      subdirs = cached.dirs.filter(safeName)
      names = cached.files.filter(safeName)
      reusedDirs++
    } else {
      let entries
      try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { continue }
      subdirs = []
      names = []
      for (const e of entries) {
        if (e.isDirectory()) { if (!skip.has(e.name)) subdirs.push(e.name); continue }
        if (e.isFile()) names.push(e.name)
      }
      scannedDirs++
    }
    nextDirs[key] = { mtimeMs, dirs: subdirs, files: names }
    for (const name of subdirs) {
      const child = join(dir, name)
      let link = false
      try { link = lstatSync(child).isSymbolicLink() } catch { continue }
      if (link && opts.roots !== undefined && resolvedInside(child, opts.roots) === null) continue
      stack.push(child)
    }
    // `readdir` already told us these are regular files (a link answers `isFile()` false), and the
    // directory they sit in was fenced before it was entered. Asking again cost one lstat per file:
    // 10 000 files meant 10 000 lstat calls, which was 89% of a locate on a large tree.
    for (const name of names) if (exts.has(extname(name).toLowerCase())) files.push(join(dir, name))
  }
  files.sort()

  if (scannedDirs > 0 && !truncated && opts.cache !== false) {
    try {
      writeFileSync(indexOf(roots[0], skipKey), JSON.stringify({ dirs: nextDirs }), { encoding: 'utf8', mode: 0o600 })
    } catch { /* unwritable index falls back to a full scan */ }
  }

  const page = files.slice(offset, offset + cap)
  const more = offset + page.length < files.length
  const cutByDeadline = truncated && !more && page.length > 0
  return {
    files: page,
    total: files.length,
    truncated: truncated || more,
    truncatedBy: cutByDeadline ? 'deadline' : more ? 'page' : null,
    continuation: more || cutByDeadline ? String(offset + page.length) : null,
    reusedDirs,
    scannedDirs,
    ms: Math.round((performance.now() - t0) * 100) / 100,
  }
}

/* ── Fences and reads ── */

const rootRealCache = new Map<string, string | null>()
/** Every other cache here is bounded; this one is keyed by path strings, so it needs a ceiling. */
const ROOT_REAL_LIMIT = 512
/** Exposed so the bound itself can be asserted: a cache that only grows is a leak, not a cache. */
export const rootRealCacheSize = (): number => rootRealCache.size

function realRoots(roots: readonly string[]): Array<string | null> {
  if (rootRealCache.size > ROOT_REAL_LIMIT) rootRealCache.clear()
  return roots.map((root) => {
    if (rootRealCache.has(root)) return rootRealCache.get(root) ?? null
    let real: string | null = null
    try { real = realpathSync.native(root) } catch { /* not a boundary */ }
    rootRealCache.set(root, real)
    return real
  })
}

/** The fence returns the resolved path: judging one path and writing another is a TOCTOU window. */
export function resolvedInside(file: string, roots: readonly string[]): string | null {
  let real: string
  try { real = realpathSync.native(file) } catch { return null }
  for (const base of realRoots(roots)) {
    if (base && (real === base || real.startsWith(base.endsWith(sep) ? base : base + sep))) return real
  }
  return null
}
const anchored = (file: string, roots: readonly string[]): boolean => {
  try { if (!lstatSync(file).isSymbolicLink()) return true } catch { return false }
  return resolvedInside(file, roots) !== null
}

/** Roots must stay inside the declared bounds; otherwise `roots:['..']` is scope:'global' renamed. */
function rootGuard(roots: readonly string[], bounds: readonly string[]): string | null {
  const bases = realRoots(bounds.map((bound) => resolve(bound))).filter((base): base is string => base !== null)
  if (bases.length === 0) return null
  for (const root of roots) {
    if (!existsSync(root)) continue
    let real: string
    try { real = realpathSync.native(root) } catch { continue }
    if (!bases.some((base) => real === base || real.startsWith(base.endsWith(sep) ? base : base + sep))) return root
  }
  return null
}

function readSource(file: string): SourceFile | null {
  let st
  try { st = statSync(file) } catch { return srcOf(file, null, 'E_NOT_FOUND') }
  if (!st.isFile()) return srcOf(file, null, 'E_NOT_FOUND')
  if (st.size > MAX_BYTES) return srcOf(file, null, 'E_TOO_LARGE')
  let buf: Buffer
  try { buf = readFileSync(file) } catch { return srcOf(file, null, 'E_NOT_FOUND') }
  if (buf.includes(0)) return srcOf(file, null, 'E_BINARY')
  try { return srcOf(file, new TextDecoder('utf-8', { fatal: true }).decode(buf)) } catch { return srcOf(file, null, 'E_ENCODING') }
}

const extsOf = (req: { ext?: string[] }): Set<string> =>
  new Set((req.ext ?? EXT_DEFAULT).map((e) => (e.startsWith('.') ? e : '.' + e).toLowerCase()))

/* ── Prefilter ── */

/** Substring prefilter across 32 lanes. Matching text leaves with the candidate and joins the 16 MB cache. */

/* ── Locate ── */

const DEF_KINDS: ReadonlySet<string> = new Set([
  'function_declaration', 'generator_function_declaration', 'function_definition',
  'function_item', 'method_declaration', 'constructor_declaration',
  'class_declaration', 'interface_declaration', 'type_alias_declaration', 'struct_item', 'impl_item',
  'method_definition', 'public_field_definition', 'pair',
])
const FUNC_VALUES: ReadonlySet<string> = new Set(['arrow_function', 'function', 'function_expression', 'generator_function'])

/** One traversal finds definitions: seventeen patterns each ran a full-tree findAll (61% of a
 * locate), so shapes are recognized by kind in a single pre-order walk. */
function locateSymbol(root: NapiRoot, symbol: string, lang: string): NapiNode[] {
  let perRoot = symbolCache.get(root)
  if (!perRoot) { perRoot = new Map(); symbolCache.set(root, perRoot) }
  const cached = perRoot.get(symbol)
  if (cached) return cached
  const hits = new Map<string, NapiNode>()
  const keep = (n: NapiNode): void => { const r = n.range(); hits.set(r.start.index + ':' + r.end.index, n) }
  const visit = (node: NapiNode): void => {
    const kind = kindOf(node)
    if (kind === 'lexical_declaration' || kind === 'variable_declaration') {
      for (const child of node.children()) {
        if (kindOf(child) !== 'variable_declarator') continue
        const name = child.field('name')
        const value = child.field('value')
        if (name && value && name.text() === symbol && FUNC_VALUES.has(kindOf(value))) keep(child)
      }
    } else if (DEF_KINDS.has(kind)) {
      const name = node.field('name') ?? node.field('key')
      if (name && name.text() === symbol) keep(node)
    }
    for (const child of node.children()) visit(child)
  }
  visit(root)
  const result = [...hits.values()].sort((a, b) => a.range().start.index - b.range().start.index)
  if (perRoot.size > 64) perRoot.clear()
  perRoot.set(symbol, result)
  return result
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Longest literal identifier in a pattern: an AST pattern is not a substring, the name it mentions is. */
function literalOf(pattern: string): string | null {
  const words = pattern.replace(/\$(?:\$\$)?[A-Z_][A-Z0-9_]*/g, ' ').match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []
  return words.sort((a, b) => b.length - a.length)[0] ?? null
}

const WORD_BOUNDARY_CACHE = new Map<string, RegExp>()
/**
 * Whole-identifier match, including identifiers JavaScript does not consider words.
 *
 * `\b` is defined on ASCII `\w`, so `\b计算总计\b` never matches and a CJK symbol was silently
 * dropped by the prefilter once the candidate pool passed 32. Lookaround asks the same question for
 * every alphabet.
 */
function wordBoundary(symbol: string): RegExp {
  let re = WORD_BOUNDARY_CACHE.get(symbol)
  if (!re) {
    re = new RegExp(`(?<![\\w$])${escapeRe(symbol)}(?![\\w$])`)
    if (WORD_BOUNDARY_CACHE.size > 64) WORD_BOUNDARY_CACHE.clear()
    WORD_BOUNDARY_CACHE.set(symbol, re)
  }
  return re
}

/** Candidate order: file name hit, then under src/, then smaller file, then path order. */
function rankCandidates(pool: readonly Candidate[], symbol: string): Candidate[] {
  const lower = symbol.toLowerCase()
  const score = (f: string): number => (f.slice(f.lastIndexOf(sep) + 1).toLowerCase().includes(lower) ? -4 : 0)
    + (/[\\/]src[\\/]/.test(f) ? -2 : 0) + (/\.(test|spec)\./.test(f) ? 2 : 0)
  return [...pool].sort((a, b) => score(a.file) - score(b.file) || a.file.length - b.file.length || (a.file < b.file ? -1 : 1))
}

async function candidatesOf(req: LocateRequest, cwd: string, opts: EngineOptions = {}): Promise<{ files: string[]; roots: string[]; discover: DiscoverStats } | { error: string }> {
  // Deduplicate before walking: `['.', './']` is one directory, and resolving it twice made the
  // answer depend on whether the two spellings happened to normalise identically on this platform.
  const roots = [...new Set((req.roots ?? [cwd]).map((r) => resolve(cwd, r)))]
  const outside = rootGuard(roots, opts.bounds ?? [cwd])
  if (outside) return { error: `root ${outside} is outside cwd` }
  if (opts.candidates && opts.candidates.length > 0) {
    const files = opts.candidates.map((f) => resolve(cwd, f))
    return { files, roots, discover: { total: files.length, truncated: false } }
  }
  if (req.file) {
    const named = resolve(cwd, req.file)
    if (opts.deny && opts.deny.length > 0 && resolvedInside(named, opts.deny) !== null) return { error: `${req.file} is a credential location` }
    return { files: [named], roots, discover: { total: 1, truncated: false } }
  }
  const skip = Array.isArray(req.skipDirs) && req.skipDirs.length ? new Set([...SKIP_DIRS, ...req.skipDirs]) : undefined
  const skipKey = skip ? [...skip].sort().join(',') : [...SKIP_DIRS].sort().join(',')
  const d = await discover(roots, extsOf(req), { offset: req.continuation ? Number(req.continuation) : 0, index: opts.cache === false ? null : loadIndex(roots[0], skipKey), skip, deny: opts.deny, cache: opts.cache, signal: opts.signal, roots })
  // A Set, not indexOf: the filter compared every file against every earlier one, which is 50
  // million comparisons on a 10 000-file tree and was 89% of the call.
  const unique = [...new Set(d.files)]
  const { files: _raw, ...stats } = d
  return { files: unique, roots, discover: stats.continuation === null ? { ...stats, continuation: undefined } : stats }
}

/** Shared enumeration gate for both verbs: candidates, root fence, empty result. */
async function openCandidates(req: LocateRequest, cwd: string, opts: EngineOptions = {}): Promise<{ files: string[]; roots: string[]; discover: DiscoverStats } | { error: string; code: string; continuation?: string }> {
  const c = await candidatesOf(req, cwd, opts)
  if ('error' in c) return { error: c.error, code: 'E_ROOT_OUTSIDE' }
  if (c.files.length === 0) return { error: c.discover.truncated ? 'the scan was cancelled or hit its deadline before returning a page' : 'enumeration returned no files (or the continuation is exhausted)', code: 'E_NO_FILES', ...(c.discover.continuation ? { continuation: c.discover.continuation } : {}) }
  return c
}

export async function locate(req: LocateRequest, cwd: string = process.cwd(), opts: EngineOptions = {}): Promise<LocateReceipt> {
  const out: LocateReceipt = { status: 'ok', hits: [] }
  try {
    if (typeof req.symbol !== 'string' || req.symbol.trim() === '') return { ...out, status: 'error', code: 'E_BAD_ARGS', message: 'symbol is required' }
    const limit = Math.min(Math.max(Math.trunc(req.limit ?? 5) || 1, 1), 500)
    const cand = await openCandidates(req, cwd, opts)
    if ('error' in cand) return { ...out, status: 'error', code: cand.code, message: cand.error, ...(cand.continuation ? { continuation: cand.continuation } : {}) }
    const { files, roots, discover: d } = cand
    // Only what a caller acts on: the walk's own bookkeeping (reused dirs, elapsed ms) is noise in
    // a receipt that rides in every conversation turn.
    out.discover = { total: d.total, truncated: d.truncated, ...(d.continuation ? { continuation: d.continuation } : {}) }

    const pool = req.file ? files.map((file) => srcOf(file)) : await prefilterAsync(files, req.symbol, opts.signal)
    const ordered = req.file ? pool : rankCandidates(pool, req.symbol)
    const capped = ordered.length > LOCATE_PARSE_MAX
    const scanning = capped ? ordered.slice(0, LOCATE_PARSE_MAX) : ordered
    if (scanning.length === 0) {
      const next = d.continuation
        ? `; ${files.length}/${d.total} files in this page carry no literal hit, pass continuation=${d.continuation} for the next page`
        : `; none of the ${d.total} files carries a literal hit`
      return { ...out, hits: [], code: 'E_NO_MATCH', message: `no definition of ${req.symbol}${next}`, ...(d.continuation ? { continuation: d.continuation } : {}) }
    }

    // A signature answers "where is it defined"; the whole node is opt-in, because it rides in
    // every later turn of the conversation.
    const wantBody = req.body === true || (typeof req.body === 'number' && req.body > 0)
    const budget = typeof req.body === 'number' && req.body > 0 ? Math.min(req.body, BODY_BUDGET * 4) : BODY_BUDGET
    let used = 0
    for (const c of scanning) {
      if (out.hits.length >= limit) break
      const lang = langFor(c.file)
      if (!lang) continue
      if (!anchored(c.file, roots)) continue
      const doc = c.text === null ? readSource(c.file) : c
      if (!doc || doc.error || doc.text === null || !doc.text.includes(req.symbol)) continue
      if (pool.length > 32 && !wordBoundary(req.symbol).test(doc.text)) continue
      for (const node of locateSymbol(cachedRoot(lang, doc.text), req.symbol, lang)) {
        const r = node.range()
        const text = node.text()
        const hit: SourceHit = { file: relative(cwd, c.file), lang: langLabel(lang), lines: [r.start.line + 1, r.end.line + 1], signature: text.split(/\r?\n/)[0].trim().slice(0, 160) }
        if (wantBody && used + text.length <= budget) { hit.body = text; used += text.length }
        out.hits.push(hit)
        if (out.hits.length >= limit) break
      }
    }
    const stopped = ordered.length > out.hits.length
    if (stopped && out.truncated === undefined) out.truncated = true
    if (out.hits.length === 0) {
      const pruned = capped ? `; ${pool.length} candidates and only the first ${LOCATE_PARSE_MAX} were parsed (pruned), narrow roots or use a fuller name` : ''
      return { ...out, hits: [], code: 'E_NO_MATCH', message: `no definition of ${req.symbol} (${pool.length} candidates after prefilter${pruned})`, ...(capped ? { pruned: true } : {}), ...(d.continuation ? { continuation: d.continuation } : {}) }
    }
    return { ...out, ...(d.continuation ? { continuation: d.continuation } : {}) }
  } catch (e) {
    return { ...out, status: 'error', code: 'E_INTERNAL', message: String((e as Error)?.message ?? e) }
  }
}

/* ── Rewrite ── */

const META = /\$(\$\$)?([A-Z_][A-Z0-9_]*)/g

/** `$X` / `$$$X` in a template expand from real captures; napi's `node.replace()` writes literals. */
function expand(node: NapiNode, template: string, src: string): string {
  return template.replace(META, (whole: string, multi: string | undefined, name: string) => {
    if (multi) {
      const all = node.getMultipleMatches(name)
      if (all.length === 0) return ''
      return src.slice(all[0].range().start.index, all[all.length - 1].range().end.index)
    }
    const one = node.getMatch(name)
    if (!one) throw Object.assign(new Error(`template variable ${whole} is unbound`), { code: 'E_TEMPLATE' })
    return one.text()
  })
}

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n')
/** Fast path: an LF file whose result has no CR skips the regex entirely. */
const withEol = (text: string, eol: string): string => {
  if (eol === '\n' && !text.includes('\r')) return text
  return eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n')
}

function lineDelta(before: string, after: string): { addedLines: number; removedLines: number } {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let e = 0
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++
  return { addedLines: b.length - s - e, removedLines: a.length - s - e }
}

/** ERROR count comes from the native findAll. */
const errorCount = (root: NapiRoot): number => root.findAll({ rule: { kind: 'ERROR' } }).length

/** One traversal yields leaf tokens (formatOnly) or the kind sequence (node counts when detail). */
function walkTree(root: NapiRoot, wantTokens: boolean, status: { truncated: boolean }): string[] {
  const out: string[] = []
  const walk = (node: NapiNode, depth: number): void => {
    if (depth > 4000 || out.length > 200000) { status.truncated = true; return }
    const kids = node.children()
    if (wantTokens && kids.length === 0) out.push(kindOf(node) + '\u0000' + node.text())
    else {
      if (!wantTokens) out.push(kindOf(node))
      for (const k of kids) walk(k, depth + 1)
    }
  }
  walk(root, 0)
  return out
}
const seqEqual = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i])

function auditOf(lang: string, before: string, after: string, beforeRoot?: NapiRoot, detail = false, delta?: { addedLines: number; removedLines: number }): AuditFacts {
  const rootA = beforeRoot ?? cachedRoot(lang, before)
  const rootB = cachedRoot(lang, after)
  const aErrors = errorCount(rootA)
  const bErrors = errorCount(rootB)
  const stripEqual = before === after || before.replace(/\s+/g, '') === after.replace(/\s+/g, '')
  const status = { truncated: false }
  const formatOnly = stripEqual && seqEqual(walkTree(rootA, true, status), walkTree(rootB, true, status))
  const out: AuditFacts = { ...(delta ?? lineDelta(before, after)), formatOnly, ok: bErrors <= aErrors, errorNodesBefore: aErrors, errorNodesAfter: bErrors }
  if (status.truncated) out.nodeScanTruncated = true
  if (detail) {
    const ka = walkTree(rootA, false, status)
    const kb = walkTree(rootB, false, status)
    if (status.truncated) out.nodeScanTruncated = true
    let s = 0
    while (s < ka.length && s < kb.length && ka[s] === kb[s]) s++
    let e = 0
    while (e < ka.length - s && e < kb.length - s && ka[ka.length - 1 - e] === kb[kb.length - 1 - e]) e++
    out.nodesBefore = ka.length
    out.nodesAfter = kb.length
    out.nodesChanged = Math.max(ka.length - s - e, kb.length - s - e)
  }
  return out
}

export async function refactor(req: RefactorRequest, cwd: string = process.cwd(), opts: EngineOptions = {}): Promise<RefactorReceipt> {
  // Default is preview: one missing field must not rewrite a repository. `apply` stays explicit.
  const mode = req.mode === 'apply' ? 'apply' : 'preview'
  const out: RefactorReceipt = { status: 'ok', mode }
  try {
    if (typeof req.pattern !== 'string' || typeof req.rewrite !== 'string') return { ...out, status: 'error', code: 'E_BAD_ARGS', message: 'pattern and rewrite are required' }
    if (req.pattern.length > 4096 || req.rewrite.length > 4096 || (req.symbol ?? '').length > 512) return { ...out, status: 'error', code: 'E_BAD_ARGS', message: 'pattern / rewrite / symbol too long', applied: false }
    // A rewrite means "all of them": the old default of 1 planned a single file and said nothing,
    // so a caller that expected a full rename silently got the first file only.
    const limit = Math.min(Math.max(Math.trunc(req.limit ?? 50) || 1, 1), 500)
    const c = await openCandidates(req, cwd, opts)
    if ('error' in c) return { ...out, status: 'error', code: c.code, message: c.error, applied: false, ...(c.continuation ? { continuation: c.continuation } : {}) }
    const { files, roots, discover: d } = c
    // Only what a caller acts on: the walk's own bookkeeping (reused dirs, elapsed ms) is noise in
    // a receipt that rides in every conversation turn.
    out.discover = { total: d.total, truncated: d.truncated, ...(d.continuation ? { continuation: d.continuation } : {}) }

    /* Phase 1 plans only. Writing as we go leaves an unexplained half-applied tree when file two fails. */
    const plans: Plan[] = []
    const conflicts: Conflict[] = []
    const encSkipped: string[] = []
    let firstMiss: string | null = null

    let matched = 0
    let stopped = false
    for (const cand of await prefilterAsync(files, req.symbol ?? literalOf(req.pattern), opts.signal)) {
      const file = cand.file
      const lang = langFor(file)
      if (!lang || !anchored(file, roots)) continue
      const src = cand.text === null ? readSource(file) : cand
      if (!src || src.error || src.text === null) { if (src?.error === 'E_ENCODING') encSkipped.push(file); continue }
      const root = cachedRoot(lang, src.text)

      let scopes: NapiNode[]
      if (req.symbol) {
        scopes = locateSymbol(root, req.symbol, lang)
        if (scopes.length > 1) { conflicts.push({ file: relative(cwd, file), code: 'E_SYMBOL_AMBIGUOUS', message: `${relative(cwd, file)} has ${scopes.length} definitions named ${req.symbol}` }); continue }
        if (scopes.length === 0) { firstMiss ??= `symbol ${req.symbol} not found in ${relative(cwd, file)}`; continue }
      } else scopes = [root]

      const found = new Map<string, NapiNode>()
      for (const scope of scopes) {
        for (const n of scope.findAll(matcher(lang, req.pattern))) {
          const r = n.range()
          found.set(r.start.index + ':' + r.end.index, n)
        }
      }
      const nodes = [...found.values()].sort((a, b) => a.range().start.index - b.range().start.index)
      if (nodes.length === 0) { firstMiss ??= `pattern matched nothing: ${req.pattern}`; continue }
      // Counting every match before honouring the limit meant walking the whole tree for a one-file
      // rewrite. Stop at the limit and say the rest is unknown rather than measuring it.
      matched++
      if (plans.length >= limit) { stopped = true; break }

      const after = withEol(root.commitEdits(nodes.map((n) => n.replace(expand(n, req.rewrite as string, src.text as string)))), eolOf(src.text))
      const delta = lineDelta(src.text, after)
      const audit = { edits: nodes.length, ...auditOf(lang, src.text, after, root, req.detail === true, delta) }
      if (audit.ok !== true) {
        conflicts.push({ file: relative(cwd, file), code: 'E_AUDIT_BROKEN', message: `${relative(cwd, file)}: the rewrite adds syntax diagnostics (${audit.errorNodesBefore} -> ${audit.errorNodesAfter})`, audit })
        continue
      }
      const target = resolvedInside(file, roots)
      if (!target) { conflicts.push({ file: relative(cwd, file), code: 'E_ROOT_OUTSIDE', message: `${relative(cwd, file)} resolves outside the root` }); continue }
      if (mode === 'apply') {
        // `target` is already resolved, so asking whether it is a link always answers no. The name
        // the caller reached the file through is the one that can be a link.
        try { if (lstatSync(file).isSymbolicLink()) { conflicts.push({ file: relative(cwd, file), code: 'E_NOT_REGULAR', message: `${relative(cwd, file)} is a link, not the file the plan was built against` }); continue } } catch { /* absent: the publisher reports it */ }
      }
      // A write plan is refused at planning time when the target is not writable by this caller.
      if (mode === 'apply' && opts.writeRoots && opts.writeRoots.length > 0 && resolvedInside(target, opts.writeRoots) === null) {
        conflicts.push({ file: relative(cwd, file), code: 'PATH_RESTRICTED', message: `${relative(cwd, file)} is outside the write roots` }); continue
      }
      plans.push({ rel: relative(cwd, file), target, text: src.text, after, delta, audit, edits: nodes.length })
    }

    const totalEdits = plans.reduce((n, p) => n + p.edits, 0)
    const fileSummary: FileDelta[] = plans.slice(0, mode === 'apply' ? 500 : 20).map((p) => ({
      file: p.rel, edits: p.edits, addedLines: p.delta.addedLines, removedLines: p.delta.removedLines,
      ...(mode === 'apply' ? { after: p.after, revision: digest(p.text) } : {}),
    }))

    if (conflicts.length > 0) {
      const first = conflicts[0]
      return { ...out, status: 'error', code: first.code, message: `${conflicts.length} files failed the plan, nothing was written: ${first.message}`, conflicts: conflicts.slice(0, 10), filesTotal: plans.length, applied: false, effectState: 'none' }
    }
    if (plans.length === 0) {
      const enc = encSkipped.length > 0 && firstMiss === null
      return { ...out, status: 'error', code: enc ? 'E_ENCODING' : 'E_NO_MATCH', message: enc ? `${encSkipped.length} candidates are not valid UTF-8 (${encSkipped[0]}), nothing was rewritten` : firstMiss ?? 'no match', ...(d.continuation ? { continuation: d.continuation } : {}) }
    }

    const base: RefactorReceipt = {
      ...out, edits: totalEdits, files: fileSummary, filesTotal: plans.length,
      ...(stopped ? { message: `${matched} file(s) match; only the first ${limit} were ${mode === 'apply' ? 'planned' : 'shown'} — pass a larger limit to include the rest` } : {}),
      matched, planned: plans.length,
      // A stopped walk did not count the rest: `null` is the honest answer, not a measured number.
      remaining: stopped ? null : Math.max(matched - plans.length, 0),
      ...(d.continuation ? { continuation: d.continuation } : {}),
      ...(plans.length === 1 ? { audit: plans[0].audit } : {}),
    }
    // Both modes return a plan. `apply` additionally carries the text to publish, and the caller
    // publishes it: one publication kernel for every tool, not a second one here.
    if (mode !== 'apply') return { ...base, applied: false, effectState: 'none' }
    return { ...base, applied: false, effectState: 'none', pending: plans.length }

  } catch (e) {
    return { ...out, status: 'error', code: (e as { code?: string })?.code ?? 'E_INTERNAL', message: String((e as Error)?.message ?? e), applied: false, effectState: 'none' }
  }
}

/* ── Audit ── */

export function audit(req: AuditRequest, cwd: string = process.cwd(), opts: EngineOptions = {}): AuditReceipt {
  try {
    // Both paths pass the fence; otherwise this is an existence/syntax oracle for any path
    const base = (opts.bounds ?? [cwd]).map((bound) => resolve(bound))
    const beforePath = resolvedInside(resolve(cwd, req.beforeFile ?? ''), base)
    const afterPath = resolvedInside(resolve(cwd, req.file ?? ''), base)
    if (!beforePath || !afterPath) return { status: 'error', code: 'E_ROOT_OUTSIDE', message: 'beforeFile and file must stay inside cwd', addedLines: 0, removedLines: 0, formatOnly: false, errorNodesBefore: 0, errorNodesAfter: 0 }
    const beforeDoc = readSource(beforePath)
    const afterDoc = readSource(afterPath)
    const bad: Array<[string, SourceFile | null]> = [['beforeFile', beforeDoc], ['file', afterDoc]]
    const broken = bad.find(([, d]) => d === null || d.error !== null)
    if (broken) return { status: 'error', code: broken[1] === null ? 'E_NOT_FOUND' : (broken[1].error as string), message: `${broken[0]} is unreadable (missing, over 2 MiB, not UTF-8, or contains NUL)`, addedLines: 0, removedLines: 0, formatOnly: false, errorNodesBefore: 0, errorNodesAfter: 0 }
    const before = (beforeDoc as SourceFile).text as string
    const after = (afterDoc as SourceFile).text as string
    const lang = langFor(afterPath) ?? 'TypeScript'
    return { status: 'ok', file: relative(cwd, afterPath), lang: langLabel(lang), ...auditOf(lang, before, after, undefined, true) }
  } catch (e) {
    return { status: 'error', code: 'E_INTERNAL', message: String((e as Error)?.message ?? e), addedLines: 0, removedLines: 0, formatOnly: false, errorNodesBefore: 0, errorNodesAfter: 0 }
  }
}
