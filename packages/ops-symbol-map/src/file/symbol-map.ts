/**
 * `ops_symbol_map` — the one member of FILE_TOOLS that answers in-process.
 *
 * Every other tool in this directory spawns `runtime/<platform>/dsh-ops-file`. A symbol map is a
 * Tree-sitter query over bytes we already hold, so a subprocess would cost more than the work
 * itself. That is also why `invokeTrusted` cannot be reused here: its fences exist to guard a
 * *spawn*, and there is no spawn. The fences are re-established locally, in the same order,
 * because here the order is the security property:
 *
 *   1. session identity and an absolute cwd
 *   2. one authoritative policy resolve, then a whitelist of its mode
 *   3. argument normalisation, then exactly one absolute target path
 *   4. the credential fence — BEFORE anchoring, so a link cannot launder a key file
 *   5. anchor against workspace/cwd/tmp without realpathing the caller's parents
 *
 * Step 4 before step 5 is not stylistic. `anchoredPath` may return a path that does not exist,
 * and `credentialPath` matches the *requested* name; swapping the two would let
 * `project/key -> ~/.ssh` clear the fence and then be read through the anchor.
 *
 * There is no second policy resolve after preparation, unlike `invokeTrusted`, because this
 * branch is fully synchronous from the resolve to the parse: `fs.readFileSync`, the lazily
 * required grammar and the query all run without yielding, so there is no window in which the
 * user could move the selector. If that ever becomes asynchronous, the re-resolve has to come
 * back with it.
 *
 * `invoke()` in `worker.ts` has already bound the result session and the call budget before
 * dispatching here, so nothing in this module re-enters `withResultSession` or `withCallBudget`.
 *
 * @module dsh-ops/file/symbol-map
 */

import fs from 'node:fs'
import path from 'node:path'

import type { Context, SandboxExecutionPolicy, SandboxPolicyService, ToolRunContext } from '../adapter/dsh/types.js'
import type { WorkerInvokeConfig } from '../host/worker-boundary.js'
import { record } from '../host/worker-boundary.js'
import { credentialPath, credentialRefusal } from '../credential-policy.js'
import { anchoredPath, inside, sessionAnchors } from '../authority-paths.js'
import { MODES, credentialDenied } from '../host/permissions.js'
import { describe, encodeSymbol, fail, fileFingerprint, getSymbolMap, normalizeScope, paginate } from '../symbol-map/index.js'
import type { SourceLanguage, SymbolMap, SymbolMapErrorCode, SymbolPage } from '../symbol-map/index.js'
import { reparseEscape, REPARSE_DENIED } from './reparse.js'
import { normalizeArguments } from '../host/contract.js'

const TOOL = 'symbol_map'
const LANGS: readonly SourceLanguage[] = ['typescript', 'tsx', 'javascript']

/**
 * Engine codes are internal; a receipt has to speak the vocabulary `kernel/errors.ts` knows.
 *
 * `UNSUPPORTED_DOCUMENT` is the only pre-existing code that means "this file type is out of
 * scope" and carries the right policy (`error`, never retried); `ERR_INVALID_ENCODING` sits in
 * the table with no producer and would misdescribe a TypeScript file as a bad encoding.
 */
const CODE_MAP: Readonly<Record<SymbolMapErrorCode, string>> = Object.freeze({
  E_ARGS: 'INVALID_ARGUMENT',
  E_NOT_FOUND: 'NOT_FOUND',
  E_NOT_FILE: 'IS_DIRECTORY',
  E_ACCESS: 'ACCESS_DENIED',
  E_READ: 'IO_ERROR',
  E_FILE_TOO_LARGE: 'OUTPUT_LIMIT',
  E_LANG_UNKNOWN: 'UNSUPPORTED_DOCUMENT',
  E_LANG_UNSUPPORTED: 'UNSUPPORTED_DOCUMENT',
  E_ENGINE_UNAVAILABLE: 'EXECUTOR_UNAVAILABLE',
  E_SNAPSHOT: 'INVALID_ARGUMENT',
  E_NO_FILE: 'INVALID_ARGUMENT',
})

/** Codes raised before any bytes are read; everything else failed while reading. */
const PREFLIGHT = new Set(['INVALID_ARGUMENT', 'UNSUPPORTED_DOCUMENT', 'EXECUTOR_UNAVAILABLE', 'PATH_RESTRICTED'])

/**
 * Same shape as `worker.ts`'s `failure`, deliberately not imported from it.
 *
 * `worker.ts` imports this module to dispatch, so importing back would close a cycle for the sake
 * of eight lines. A symbol map is read-only, so every failure here has `effectState: 'none'`.
 */
function failure(code: string, message: string) {
  const phase = PREFLIGHT.has(code) ? 'preflight' : 'execute'
  return {
    status: code === 'POLICY_DENIED' || code === 'CREDENTIAL_DENIED' ? 'rejected' as const : 'error' as const,
    phase, changed: 0, matched: 0, skipped: 0, failed: 0, complete: false, omitted: 0,
    error: {
      code, phase, retryable: false, effectState: 'none' as const,
      nextAction: code === 'EXECUTOR_UNAVAILABLE'
        ? 'Install the optional grammar packages next to dsh-ops, then retry. No file was read and nothing was changed.'
        : 'Correct the request. A symbol map only reads, so nothing was changed.',
      message,
    },
  }
}

function mapFailure(code: SymbolMapErrorCode, message: string): unknown {
  return failure(CODE_MAP[code], message)
}

/** `worker.ts` keeps its `absoluteTarget` private; this is the same two-line contract. */
function absoluteTarget(raw: unknown, cwd: string): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) return undefined
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw)
}

/**
 * The receipt's `file` is relative to the session cwd, the way `ops_stat` reports it.
 *
 * The engine computes its own `file` from `process.cwd()`, which is the plugin host's working
 * directory and not necessarily the session's. Two tools describing one file by two different
 * relative paths is exactly the kind of detail a model reasons wrongly about, so this overrides
 * the engine value instead of forwarding it.
 */
function shownPath(absolute: string, cwd: string): string {
  const relative = path.relative(cwd, absolute)
  if (relative === '') return absolute
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return absolute
  return relative
}

/** A paging argument that is not a number is a caller mistake, not a silent default. */
function count(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    fail('E_ARGS', `${field} must be a number; got ${JSON.stringify(raw)}.`)
  }
  return raw
}

/** `undefined` means "infer from the extension"; anything else outside the enum is refused. */
function language(raw: unknown): SourceLanguage | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'string' && (LANGS as readonly string[]).includes(raw)) return raw as SourceLanguage
  fail('E_LANG_UNSUPPORTED', `lang must be one of ${LANGS.join(', ')}; got ${JSON.stringify(raw)}.`)
}

/**
 * 指纹只加信息，不许把一次成功的解析变成失败。
 *
 * 解析与哈希之间文件可能被删/被独占：此时 `revision`（已解析字节的 SHA-256）仍然有效，
 * 直接回退成它，并把 scope 标成 `full` —— 宁可少一个"头尾"标记，也不能因为一次
 * 额外 IO 就把整张符号表判成 IO_ERROR。
 */
function fingerprintOf(absolute: string, map: SymbolMap): { hash: string; scope: 'full' | 'head+tail'; bytes: number } {
  try {
    return fileFingerprint(absolute, map.bytes, map.revision)
  } catch {
    return { hash: map.revision, scope: 'full', bytes: map.bytes }
  }
}

function receipt(map: SymbolMap, page: SymbolPage, policy: SandboxExecutionPolicy, cwd: string, trusted: string) {
  const value: Record<string, unknown> = {
    status: page.complete ? 'completed' : 'partial',
    file: shownPath(trusted, cwd),
    lang: map.lang,
    revision: map.revision,
    hash: map.hash,
    bytes: map.bytes,
    partial: map.partial,
    // The page count, not the file count: with `name` set the caller's set IS the filtered set,
    // and reporting `map.total` made "1 hit / 50 more pages" a coherent-sounding lie.
    total: page.total,
    offset: page.offset,
    symbols: page.symbols.map(encodeSymbol),
    omitted: page.omitted,
    complete: page.complete,
    sandbox: { mode: policy.mode, enforcement: 'policy', boundary: 'in-process-symbol-map' },
  }
  if (map.syntaxErrors !== undefined) value.syntaxErrors = map.syntaxErrors
  // 变更指纹放在最外层，独立于 symbols 分页：分页翻到第 5 页时，调用方仍然只凭这一个字段
  // 就能判断"文件还是不是刚才那份"。≤100 KiB 的文件复用 revision，零额外 IO。
  const fingerprint = fingerprintOf(trusted, map)
  value.fileHash = fingerprint.hash
  if (fingerprint.scope !== 'full') value.fileHashScope = fingerprint.scope
  if (fingerprint.bytes !== map.bytes) value.fileHashBytes = fingerprint.bytes
  if (page.nextOffset !== undefined) value.nextOffset = page.nextOffset
  if (page.truncatedBy !== undefined) value.truncatedBy = page.truncatedBy
  return value
}

function run(ctx: Context, args: unknown, exec: ToolRunContext, signal: AbortSignal, config?: WorkerInvokeConfig): unknown {
  const session = exec?.agent?.session
  const cwd = session?.header?.cwd
  if (!session?.id || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return failure('EXECUTOR_UNAVAILABLE', 'An authoritative session identity and cwd are required.')
  }

  const policyService: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
  if (!policyService?.resolve) return failure('EXECUTOR_UNAVAILABLE', 'DSH policy resolution is required.')

  let policy: SandboxExecutionPolicy
  try { policy = policyService.resolve({ session }) }
  catch { return failure('EXECUTOR_UNAVAILABLE', 'DSH policy resolution failed.') }
  if (!MODES.includes(policy?.mode) || typeof policy.workspaceRoot !== 'string' || !path.isAbsolute(policy.workspaceRoot)) {
    return failure('EXECUTOR_UNAVAILABLE', 'Invalid authoritative DSH policy.')
  }

  args = normalizeArguments(TOOL, args)
  if (!record(args)) return failure('INVALID_ARGUMENT', 'Arguments must be an object.')

  const target = absoluteTarget(args.path, cwd)
  if (target === undefined) return failure('INVALID_ARGUMENT', 'path must be a non-empty path.')

  // Credential fence first: it has to see the name the caller asked for, not the anchor result.
  if ((config?.denyCredentialReads ?? true) !== false) {
    const verdict = credentialPath(target)
    if (verdict.denied) return credentialDenied(credentialRefusal(target, verdict.matched).message)
  }

  const trusted = anchoredPath(target, sessionAnchors(policy, cwd))
  // The anchor is lexical: it decides where the path is spelled, not where the OS will read.
  // A symlink or junction below the anchor passes both fences above and is resolved by the
  // kernel at open time, so the chain is walked with `lstat` here — the same refusal the native
  // worker's `open_nofollow` gets from the kernel.
  const link = reparseEscape(trusted, sessionAnchors(policy, cwd))
  if (link !== undefined) {
    if ((config?.denyCredentialReads ?? true) !== false) {
      let real: string | undefined
      try {
        real = fs.realpathSync.native(link)
      } catch {
        real = undefined
      }
      if (real !== undefined) {
        const verdict = credentialPath(real)
        if (verdict.denied) return credentialDenied(credentialRefusal(real, verdict.matched).message)
      }
    }
    return failure('PATH_RESTRICTED', `${REPARSE_DENIED}: ${shownPath(link, cwd)}`)
  }
  // Narrow-window recheck: `reparseEscape` walks lstat, but the read itself is resolved by the
  // kernel at open, so the leaf can still be swapped in between. One realpath folds "what will
  // actually be read" back to a real path and the containment/credential tests run on that.
  {
    let real: string | undefined
    try {
      real = fs.realpathSync.native(trusted)
    } catch {
      real = undefined // missing target is the engine's NOT_FOUND to report, not our verdict
    }
    if (real !== undefined) {
      if (!sessionAnchors(policy, cwd).some(root => inside(path.resolve(root), real)))
        return failure('PATH_RESTRICTED', `${REPARSE_DENIED}: ${shownPath(real, cwd)}`)
      if ((config?.denyCredentialReads ?? true) !== false) {
        const verdict = credentialPath(real)
        if (verdict.denied) return credentialDenied(credentialRefusal(real, verdict.matched).message)
      }
    }
  }
  signal?.throwIfAborted?.()

  const scope = normalizeScope(args.scope)
  const lang = language(args.lang)
  const offset = count(args.offset, 'offset')
  const limit = count(args.limit, 'limit')

  const map = getSymbolMap(trusted, {
    ...(scope === undefined ? {} : { scope }),
    ...(lang === undefined ? {} : { lang }),
    ...(args.extended === true ? { extended: true } : {}),
  })
  const page = paginate(map, {
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
    ...(typeof args.name === 'string' && args.name !== '' ? { name: args.name } : {}),
  })
  return receipt(map, page, policy, cwd, trusted)
}

/**
 * Dispatch point used by `file/worker.ts`. Errors are values: `invoke()`'s catch would otherwise
 * turn a wrong `scope` into `EXECUTOR_UNAVAILABLE` and blame the host for a caller mistake.
 */
export async function invokeSymbolMap(ctx: Context, args: unknown, exec: ToolRunContext, signal: AbortSignal, config?: WorkerInvokeConfig): Promise<unknown> {
  try { return run(ctx, args, exec, signal, config) }
  catch (error) {
    const described = describe(error, 'E_READ')
    return mapFailure(described.code, described.message)
  }
}
