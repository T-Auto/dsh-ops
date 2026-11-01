/**
 * The process boundary: spawn, timeout, output byte cap, EOL helpers, loose JSON, ranged reads.
 *
 * The public contract of this module is exactly `proc.d.cts` as shipped with 2.1.1: `Stage`,
 * `PtcErrorCode`, `PtcConfig`, `ProcResult`, `RunOpts` and the signatures below. The types moved from
 * the declaration into the implementation; behaviour is unchanged.
 *
 * Two decisions worth remembering:
 *
 * · `PtcErrorCode` keeps only the 20 outward codes. The engine also throws `E_INPROC_LOCKED` and
 *   friends; those stay out of the union (widening it would change the published contract) and are
 *   narrowed to `PtcErrorCode` at the throw site.
 * · A timeout rejects with `PtcOutcomeError('E_TIMEOUT')`, it does not resolve to a result carrying a
 *   code: "did not finish" and "finished and failed" have to stay distinguishable.
 *
 * @module dsh-ops/ptc/proc
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, open } from 'node:fs/promises'
import path from 'node:path'

/** One PTC stage; errors and debug lines use it to say which step failed. */
export type Stage = 'everything' | 'sane' | 'astgrep' | 'agentbox' | 'difftastic' | 'inproc' | 'pipeline'

/** The outward error codes. Internal codes are deliberately absent; see the module comment. */
export type PtcErrorCode =
  | 'E_BIN_MISSING' | 'E_TIMEOUT' | 'E_INTERNAL' | 'E_OUTPUT_LIMIT'
  | 'E_EVERYTHING_FAILED' | 'E_EVERYTHING_IPC' | 'E_EVERYTHING_NOT_FOUND'
  | 'E_SANE_UNSUPPORTED_LANG' | 'E_SANE_SYMBOL_NOT_FOUND' | 'E_SANE_AMBIGUOUS'
  | 'E_ASTGREP_FAILED' | 'E_ASTGREP_NO_MATCH' | 'E_ASTGREP_OVERLAP' | 'E_ASTGREP_IDENTITY'
  | 'E_AGENTBOX_REJECTED' | 'E_AGENTBOX_CRASH'
  | 'E_DIFF_FAILED' | 'E_DIFF_EMPTY' | 'E_DIFF_REGRESSION'
  | 'E_BAD_ARGS'

/** Every engine failure is this type: code, stage, a human message and optional raw detail. */
export class PtcOutcomeError extends Error {
  readonly code: PtcErrorCode
  readonly stage: Stage
  readonly detail?: unknown

  constructor(code: PtcErrorCode, stage: Stage, message: string, detail?: unknown) {
    super(message)
    this.code = code
    this.stage = stage
    this.detail = detail
    this.name = 'PtcOutcomeError'
  }

  toOutcome(): { status: 'error', code: PtcErrorCode, stage: Stage, message: string } {
    return { status: 'error', code: this.code, stage: this.stage, message: this.message }
  }
}

/** Everything one engine run needs. `defaultConfig()` seeds it from the environment. */
export interface PtcConfig {
  cwd: string
  esPath: string
  sgPath: string
  difftPath: string
  agentBoxWorker: string
  timeoutMs: number
  maxOutputBytes: number
  /** Byte ratio a single edit may change; above it the change is a regression and is rolled back. */
  maxChangeRatio: number
  /** true = fail when difftastic is unavailable; false = mark degraded and continue. */
  requireAudit: boolean
  allowMulti: boolean
  debug: boolean
}

/** One child-process call. `stdout`/`stderr` stay bytes: callers may not be reading text. */
export interface ProcResult {
  code: number
  stdout: Buffer
  stderr: Buffer
  truncated: boolean
  ms: number
}

/** Options for `run()`. Defaults come from the same environment variables as `defaultConfig()`. */
export interface RunOpts {
  cwd?: string
  stdin?: string | Buffer | null
  timeoutMs?: number
  maxOutputBytes?: number
  /** Extra environment variables, merged over `process.env` without touching the parent. */
  env?: NodeJS.ProcessEnv
}

/**
 * Candidate chain for `es.exe`: explicit config first, then the bundled vendor copy, then the
 * Everything install directories, then PATH.
 *
 * The chain exists because `es.exe` is not a system command: the old `'./es.exe'` default resolved
 * against the process cwd and reported `E_BIN_MISSING` with the binary sitting in the package.
 *
 * The result is the *candidate* list, not filtered by existence — `pickExistingEs` filters, so a
 * caller can still print the whole chain when diagnosing.
 */
export const esCandidates = (explicit?: string, cwd?: string): string[] => {
  const list: string[] = []
  if (explicit) list.push(explicit)
  if (cwd) list.push(path.resolve(cwd, 'vendor', 'es.exe'), path.resolve(cwd, 'es.exe'))
  list.push(
    path.join(__dirname, '..', '..', 'vendor', 'es.exe'),
    'C:/Program Files/Everything/es.exe',
    'C:/Program Files (x86)/Everything/es.exe',
    'es.exe',
    'es',
  )
  return [...new Set(list)]
}

const RE_ANY_SEP = /[\\/]/

/**
 * Resolve the Everything CLI once, at config time.
 *
 * A bare command name (`es`, `es.exe`) is left untouched so PATH lookup still works; only real paths
 * are checked for existence. When nothing exists the explicit value is returned as-is, so the error
 * the caller eventually sees still names what they configured.
 */
const pickExistingEs = (explicit?: string, cwd?: string): string | undefined => {
  for (const candidate of esCandidates(explicit, cwd)) {
    if (!RE_ANY_SEP.test(candidate)) continue
    try {
      if (existsSync(candidate)) return candidate
    } catch { /* unreadable counts as absent; try the next candidate */ }
  }
  return explicit
}

/**
 * Build the default config.
 *
 * `agentBoxWorker` points at the bundled `runtime/ptc/agentbox.worker.cjs`: it is a spawnable runtime
 * asset, not source, and `scripts/build.mjs` only allows TypeScript under `src/`.
 */
export const defaultConfig = (over: Partial<PtcConfig> = {}): PtcConfig => ({
  cwd: process.cwd(),
  esPath: pickExistingEs(process.env.PTC_ES, over.cwd ?? process.cwd()) ?? '',
  sgPath: process.env.PTC_SG ?? 'ast-grep',
  difftPath: process.env.PTC_DIFFT ?? 'difft',
  agentBoxWorker: process.env.PTC_AGENTBOX ?? path.join(__dirname, '..', '..', 'runtime', 'ptc', 'agentbox.worker.cjs'),
  timeoutMs: Number(process.env.PTC_TIMEOUT_MS ?? 20_000),
  maxOutputBytes: Number(process.env.PTC_MAX_OUTPUT ?? 8 << 20),
  maxChangeRatio: Number(process.env.PTC_MAX_CHANGE_RATIO ?? 0.2),
  requireAudit: process.env.PTC_REQUIRE_DIFFT === '1',
  allowMulti: process.env.PTC_ALLOW_MULTI === '1',
  debug: process.env.PTC_DEBUG === '1',
  ...over,
})

/** Debug output goes to stderr and costs nothing when `cfg.debug` is off. */
export const dbg = (cfg: PtcConfig, ...a: unknown[]): void => {
  if (!cfg.debug) return
  const text = a.map(x => (typeof x === 'string' ? x : safeStr(x))).join(' ')
  process.stderr.write(`[ptc] ${text}\n`)
}

function safeStr(x: unknown): string {
  try {
    return JSON.stringify(x) ?? String(x)
  } catch {
    return String(x)
  }
}

/**
 * Run one child process and collect its output.
 *
 * Three gates, all of them rejections: spawn failure, timeout, and the combined output cap. A partial
 * result would be read as "the command finished", which is the more dangerous answer.
 */
export function run(bin: string, args: string[], stage: Stage, opts: RunOpts = {}): Promise<ProcResult> {
  const {
    cwd,
    stdin = null,
    timeoutMs = Number(process.env.PTC_TIMEOUT_MS ?? 20_000),
    maxOutputBytes = 8 << 20,
    env,
  } = opts

  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new PtcOutcomeError('E_BAD_ARGS', stage, 'maxOutputBytes must be a positive safe integer'))
  }

  const t0 = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)

  return new Promise<ProcResult>((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, {
        cwd,
        shell: false,
        windowsHide: true,
        signal: ac.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env,
      })
    } catch (error) {
      clearTimeout(timer)
      reject(new PtcOutcomeError('E_BIN_MISSING', stage, `${bin} failed to start`, String(error)))
      return
    }

    const out: Buffer[] = []
    const err: Buffer[] = []
    let outputBytes = 0
    let outputError: PtcOutcomeError | undefined

    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      if (outputError) return
      if (chunk.length > maxOutputBytes - outputBytes) {
        outputError = new PtcOutcomeError('E_OUTPUT_LIMIT', stage, `${bin} stdout/stderr exceeded the combined cap of ${maxOutputBytes} bytes`)
        clearTimeout(timer)
        child.kill()
        reject(outputError)
        return
      }
      outputBytes += chunk.length
      chunks.push(chunk)
    }

    // stdio is ['pipe','pipe','pipe']; the spawn overload does not carry that into the type, so the
    // optional chain here matches the runtime shape rather than fighting the signature.
    child.stdout?.on('data', (chunk: Buffer) => collect(out, chunk))
    child.stderr?.on('data', (chunk: Buffer) => collect(err, chunk))
    child.stdin?.on('error', () => { /* writing to a child that already exited is EPIPE, not a crash */ })

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (error.name === 'AbortError') reject(new PtcOutcomeError('E_TIMEOUT', stage, `${bin} timed out after ${timeoutMs}ms`))
      else if (error.code === 'ENOENT') reject(new PtcOutcomeError('E_BIN_MISSING', stage, `executable not found: ${bin}`))
      else reject(new PtcOutcomeError('E_BIN_MISSING', stage, `${bin} failed: ${error.message}`))
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (outputError) return
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err), truncated: false, ms: Date.now() - t0 })
    })

    try {
      child.stdin?.end(stdin ?? undefined)
    } catch { /* same as above: the child is already gone */ }
  })
}

/**
 * Find a real executable on PATH by name, covering the ast-grep / ast-grep.exe / sg spellings.
 *
 * Windows needs all three extensions tried: the ast-grep npm package can land any of them.
 */
export async function pickBin(candidates: string[]): Promise<string> {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const candidate of candidates) {
    if (!candidate) continue
    if (candidate.includes('/') || candidate.includes('\\')) {
      try {
        await access(candidate)
        return candidate
      } catch {
        continue
      }
    }
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue
      for (const ext of exts) {
        const full = path.join(dir, candidate + ext)
        try {
          await access(full)
          return full
        } catch { /* this extension is absent; try the next */ }
      }
    }
  }
  throw new PtcOutcomeError('E_BIN_MISSING', 'everything', `no candidate executable exists: ${candidates.join(' | ')}`)
}

/** Strip a leading BOM; Windows tooling emits one often enough to matter. */
export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

const RE_LINE = /\r?\n/
const RE_CR = /\r/g
const RE_CRLF_G = /\r\n/g
const RE_LF_G = /\n/g

/** es.exe output to clean paths: CRLF, trailing spaces, blank lines and a BOM, all in one pass. */
export function toLines(buf: Buffer): string[] {
  return stripBom(buf.toString('utf8'))
    .split(RE_LINE)
    .map(line => line.replace(RE_CR, '').trim())
    .filter(line => line.length > 0)
}

/** The file's dominant EOL, so a patch can be rewritten in that style instead of reflowing the file. */
export function detectEol(buf: Buffer): '\r\n' | '\n' {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 10) continue
    if (i > 0 && buf[i - 1] === 13) crlf += 1
    else lf += 1
  }
  return crlf > lf ? '\r\n' : '\n'
}

export const normalizeEol = (s: string, eol: '\r\n' | '\n'): string =>
  s.replace(RE_CRLF_G, '\n').replace(RE_LF_G, eol)

/**
 * Parse JSON leniently, line by line: try the whole text first, then keep the lines that start with
 * `{` or `[`.
 *
 * External tools (ast-grep, difftastic) mix progress output into stdout; this is written for that.
 * It returns `unknown[]` on purpose — the shape is narrowed by the caller, not guessed here.
 */
export function parseLooseJson(text: string): unknown[] {
  const trimmed = stripBom(text).trim()
  if (!trimmed) return []
  try {
    const value: unknown = JSON.parse(trimmed)
    return Array.isArray(value) ? value : [value]
  } catch { /* not JSON as a whole; fall through to per-line */ }
  const out: unknown[] = []
  for (const line of trimmed.split(RE_LINE)) {
    const candidate = line.trim()
    if (!candidate || (candidate[0] !== '{' && candidate[0] !== '[')) continue
    try {
      out.push(JSON.parse(candidate))
    } catch { /* a half-written line, skip it */ }
  }
  return out
}

/** Read `[start, end)` bytes of a file; a range past the end returns only what exists. */
export async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const length = Math.max(0, end - start)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
