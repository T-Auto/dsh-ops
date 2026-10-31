/**
 * `ops_ast_*` — the five AST tools, answered in-process by the built-in engine in `src/ast`.
 *
 * The native worker answers `batch`/`result`. An AST locate/rewrite is a Tree-sitter parse over
 * bytes we already hold, so a subprocess per call costs more than the edit itself: measured on this
 * host, a `locate` CLI round trip is 94 ms against 14 ms in-process.
 *
 * Dispatch shape mirrors the native file worker on purpose — the fences below are the same fences,
 * in the same order, because here too there is no spawn to carry them:
 *
 *   1. session identity and an absolute cwd
 *   2. one authoritative policy resolve, then a whitelist of its mode
 *   3. every caller-named file/root, credential fence BEFORE anchoring
 *   4. write intent requires workspace-write, and the anchor follows
 *
 * The engine has no confinement of its own: outside danger-full-access every named file and every
 * enumeration root must sit under the workspace root or the session cwd.
 *
 * @module dsh-ops/execution/ast-inproc
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Context, SandboxExecutionPolicy, SandboxMode, SandboxPolicyService, ToolRunContext } from '../adapter/dsh/types.js'
import { credentialPath, credentialRefusal } from '../credential-policy.js'
import { inside } from '../authority-paths.js'
import { MODES, credentialDenied } from '../permissions.js'
import { record, errorText } from '../worker-boundary.js'
import { reparseEscape, REPARSE_DENIED } from '../ast/reparse.cjs'

type Engine = typeof import('../ast/index.cjs')['opsPtcAddition']
type Receipt = Record<string, unknown>
type EffectState = 'none' | 'applied' | 'partial' | 'unknown'

/**
 * The engine is loaded on first call, never at host startup.
 *
 * `../ast/index.cjs` pulls `@ast-grep/napi` (a native `.node`) in as soon as it loads. This
 * module hangs off both execution bridges, which the plugin mounts at boot — so requiring the engine
 * here would charge every session, even one that never calls an AST tool, for that native load.
 */
let engine: Engine | null | undefined
async function engineOf(): Promise<Engine | undefined> {
  if (engine === undefined) {
    try { engine = (await import('../ast/index.cjs')).opsPtcAddition }
    catch { engine = null }
  }
  return engine ?? undefined
}

/**
 * Tools that can write when `mode` is not `preview`.
 *
 * `ops_ast_audit` is deliberately absent: it reads a before-image and diffs it against the
 * current file (its only write is a temp dir it removes again), so it has to stay available
 * under `read-only`. Listing it here denied a read-only comparison outright.
 */
const WRITES = new Set(['ops_ast_inproc', 'ops_ast_refactor'])

/**
 * Retry semantics: these codes answer the same way on a second call — the same path always meets
 * the same fence, and the same bad argument is always bad. `PATH_RESTRICTED` and
 * `CREDENTIAL_DENIED` are listed too: retrying only buys the same refusal again.
 */
const NON_RETRYABLE = new Set(['INVALID_ARGUMENT', 'POLICY_DENIED', 'PATH_RESTRICTED', 'CREDENTIAL_DENIED'])

function failure(code: string, message: string, effectState: EffectState = 'none', mode: SandboxMode | 'unknown' = 'unknown') {
  return {
    status: code === 'POLICY_DENIED' ? 'rejected' as const : 'error' as const,
    error: { code, message, phase: 'execute', effectState, retryable: !NON_RETRYABLE.has(code) },
    // mode only has a value once policy resolution succeeded; a fence that fires afterwards must
    // report the real mode, or "which tier stopped me" is lost from the receipt.
    sandbox: { mode, enforcement: 'policy', boundary: 'in-process-ast' },
  }
}

/**
 * Caller-named paths. `beforeFile` belongs here too: `ast_audit` reads it, so leaving it out
 * would name a second path that never meets the credential fence or the workspace anchor.
 */
const PATH_KEYS = ['file', 'beforeFile'] as const
function named(args: Record<string, unknown> | undefined): string[] {
  const roots = Array.isArray(args?.roots) ? args.roots : []
  return [...PATH_KEYS.map(key => args?.[key]), ...roots]
    .filter((value): value is string => typeof value === 'string' && value !== '')
}

/** `required` per tool, read off the engine's own schema so the two cannot drift apart. */
function requiredOf(source: Engine | undefined, full: string): string[] {
  const entry = source?.tools.find(tool => tool.name === full)
  const required = entry?.inputSchema?.required
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === 'string') : []
}
function missing(source: Engine | undefined, full: string, args: Record<string, unknown>): string[] {
  return requiredOf(source, full).filter(key => args[key] === undefined || args[key] === null || args[key] === '')
}

const posix = (value: string): string => value.replace(/\\/g, '/')
/**
 * Receipt paths are reported relative to cwd, in POSIX form.
 *
 * The engine answers in three shapes: `locate` and `find` give absolute paths, `refactor`/`inproc`/
 * `audit` give only a basename. The basename is the dangerous one — `src/inp.ts` comes back as
 * `inp.ts`, the model passes it as the next `file`, it resolves against the cwd root and becomes
 * NOT_FOUND: one successful locate turns into one failure plus one retry.
 */
function shownPath(absolute: string, cwd: string): string {
  const relative = path.relative(cwd, absolute)
  if (relative === '') return posix(absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return posix(absolute)
  return posix(relative)
}
function present(value: Receipt, cwd: string): Receipt {
  const out: Receipt = { ...value }
  if (typeof out.file === 'string') out.file = shownPath(path.resolve(cwd, out.file), cwd)
  if (Array.isArray(out.files)) out.files = out.files.map(entry => typeof entry === 'string' ? shownPath(path.resolve(cwd, entry), cwd) : entry)
  if (Array.isArray(out.hits)) out.hits = out.hits.map(hit => record(hit) && typeof hit.file === 'string'
    ? { ...hit, file: shownPath(path.resolve(cwd, hit.file), cwd) }
    : hit)
  const readHint = out.readHint
  if (record(readHint) && Array.isArray(readHint.files)) {
    out.readHint = { ...readHint, files: readHint.files.map(entry => record(entry) && typeof entry.path === 'string'
      ? { ...entry, path: shownPath(path.resolve(cwd, entry.path), cwd) }
      : entry) }
  }
  return out
}

/**
 * Receipt size gate: 24 KiB.
 *
 * The engine's receipt shape is its own business, and nothing promises it stays small (`locate`
 * now attaches hit bodies, and `refactor` hunk counts have no upper bound). Once a receipt exceeds
 * the context budget the model sees half a JSON document truncated upstream — far worse than an
 * explicit "here is how much is left". Degrade by item, never by chopping bytes:
 *
 *   1. drop bodies first (the only field that can be bought again), plus a single readHint;
 *   2. then cut hits/files/edits to a dense prefix, reporting how many were dropped + nextOffset;
 *   3. finally yield the whole list, leaving counts only.
 */
const MAX_RECEIPT_BYTES = 24 * 1024
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
const LISTS = ['hits', 'files', 'edits'] as const

function trimReceipt(value: Receipt): Receipt {
  if (bytesOf(value) <= MAX_RECEIPT_BYTES) return value
  const out: Receipt = { ...value }
  if (Array.isArray(out.hits) && out.hits.some(hit => record(hit) && typeof hit.body === 'string')) {
    let dropped = 0
    const hits = Array.isArray(out.hits) ? out.hits as unknown[] : []
    out.hits = hits.map(hit => {
      if (!record(hit) || typeof hit.body !== 'string') return hit
      dropped++
      const { body: _body, ...rest } = hit
      return rest
    })
    out.bodyOmitted = Number(out.bodyOmitted ?? 0) + dropped
    const first = (out.hits as unknown[])[0]
    if (record(first) && Array.isArray(first.lines) && out.readHint === undefined) {
      const [start, end] = first.lines as [number, number]
      if (typeof start === 'number' && typeof end === 'number') {
        out.readHint = { tool: 'ops_read_files', files: [{ path: first.file, offset: start, limit: Math.max(1, end - start + 1) }] }
      }
    }
  }
  if (bytesOf(out) <= MAX_RECEIPT_BYTES) return out
  for (const key of LISTS) {
    const list = out[key]
    if (!Array.isArray(list) || list.length <= 1) continue
    let keep = list.length
    while (keep > 1 && bytesOf({ ...out, [key]: list.slice(0, keep) }) > MAX_RECEIPT_BYTES) keep = Math.floor(keep / 2)
    out[key] = list.slice(0, keep)
    out[`${key}Omitted`] = list.length - keep
    out.nextOffset = keep
    if (bytesOf(out) <= MAX_RECEIPT_BYTES) return out
  }
  out.receiptTruncated = true
  if (Array.isArray(out.hits)) {
    out.hitsOmitted = out.hits.length
    delete out.hits
  }
  return out
}

/**
 * The engine answers `status: 'ok' | 'error'` and a flat `{code, stage, message}`; host receipts
 * use the canonical vocabulary every other tool publishes, so a caller never has to branch on
 * which subsystem produced the value. Effects after a write-tool failure stay `unknown` unless the
 * engine proved a rollback — the same rule the native worker applies.
 */
function canonical(value: Receipt, full: string): Receipt {
  if (value.status === 'ok') return { ...value, status: 'completed' }
  if (value.status !== 'error' || record(value.error)) return value
  const message = typeof value.message === 'string' ? value.message : 'The AST engine reported a failure without a message.'
  const effectState: EffectState = WRITES.has(full) && value.rollback !== true ? 'unknown' : 'none'
  return { ...value, status: 'error', error: {
    code: typeof value.code === 'string' ? value.code : 'RESULT_UNKNOWN', message, phase: 'execute', effectState,
    retryable: false,
    nextAction: effectState === 'unknown' ? 'Inspect the file before a new attempt; never blindly retry a possible write.' : 'Correct the request, then retry.',
  } }
}

/**
 * One `lstat`-free realpath probe: the link that hides here, and where the bytes really live.
 *
 * The reparse walk stops at `boundary` — the workspace root the caller's own authority chose — so a
 * workspace reached through system-level parent links is not mistaken for an escape, while a link
 * at or below the boundary is still named.
 */
function reparseProbe(resolved: string, boundary: string | undefined): { link: string | undefined; real: string | undefined } {
  let real: string | undefined
  try { real = fs.realpathSync.native(resolved) } catch { real = undefined }
  return { link: reparseEscape(resolved, boundary), real }
}

/**
 * @param tool - raw name, e.g. `ast_locate`
 * @param ctx - host context; needs `sandboxPolicy`
 * @param args - caller arguments
 * @param exec - execution binding (session + abort signal)
 * @param signal - the call's abort signal
 */
export async function invokeAst(tool: string, ctx: Context, args: unknown, exec: ToolRunContext, signal: AbortSignal): Promise<unknown> {
  try {
    const full = `ops_${tool}`
    const source = await engineOf()
    const handler = source?.handlers[full]
    if (typeof handler !== 'function') return failure('INVALID_ARGUMENT', `${full} is not an AST tool.`)
    const session = exec?.agent?.session
    const cwd = session?.header?.cwd
    if (!session?.id || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      return failure('EXECUTOR_UNAVAILABLE', 'An authoritative session identity and cwd are required.')
    }
    if (!record(args)) return failure('INVALID_ARGUMENT', 'Arguments must be an object.')
    const absent = missing(source, full, args)
    if (absent.length > 0) return failure('INVALID_ARGUMENT', `缺少必填参数: ${absent.join(', ')}`)
    const policyService: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
    if (!policyService?.resolve) return failure('EXECUTOR_UNAVAILABLE', 'DSH policy resolution is required.')
    let policy: SandboxExecutionPolicy
    try { policy = policyService.resolve({ session }) } catch { return failure('EXECUTOR_UNAVAILABLE', 'DSH policy resolution failed.') }
    if (!(MODES as readonly string[]).includes(policy?.mode) || typeof policy.workspaceRoot !== 'string' || !path.isAbsolute(policy.workspaceRoot)) {
      return failure('EXECUTOR_UNAVAILABLE', 'Invalid authoritative DSH policy.')
    }

    // Write intent: apply is the engine default when `mode` is absent, so treat absence as apply.
    const writes = WRITES.has(full) && args.mode !== 'preview'
    if (writes && policy.mode === 'read-only') return failure('POLICY_DENIED', 'This operation requires workspace-write.', 'none', policy.mode)

    const targets = named(args)
    // Credential fence first: it has to see the name the caller asked for, not the anchor result.
    for (const target of targets) {
      const verdict = credentialPath(path.isAbsolute(target) ? target : path.resolve(cwd, target))
      if (verdict.denied) return credentialDenied(credentialRefusal(target, verdict.matched).message)
    }
    // One pass per target: lexical anchor → reparse point → real-path anchor → real-path credential.
    // realpath is paid once, and this pass is the last one before the engine opens the file.
    const roots = [policy.workspaceRoot, cwd]
    const confined = policy.mode !== 'danger-full-access'
    for (const target of targets) {
      const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target)
      if (confined && !roots.some(entry => inside(path.resolve(entry), resolved))) {
        return failure('POLICY_DENIED', 'The in-process AST engine has no confinement of its own; named files and roots must stay inside the workspace or session cwd.', 'none', policy.mode)
      }
      // A lexical fence cannot see through a junction: the name is inside, the bytes are outside.
      // The deepest root that contains the target is the boundary its own authority accepted.
      const boundary = roots.filter(entry => inside(path.resolve(entry), resolved))
        .sort((a, b) => b.length - a.length)[0]
      const probe = reparseProbe(resolved, boundary)
      if (probe.link !== undefined) {
        if (probe.real !== undefined) {
          const verdict = credentialPath(probe.real)
          if (verdict.denied) return credentialDenied(credentialRefusal(probe.real, verdict.matched).message)
        }
        return failure('PATH_RESTRICTED', `${REPARSE_DENIED}: ${probe.real ?? probe.link}`, 'none', policy.mode)
      }
      if (probe.real === undefined) continue // Absent: let the engine report NOT_FOUND / E_NO_FILE.
      const real = probe.real
      if (confined && !roots.some(entry => inside(path.resolve(entry), real))) {
        return failure('PATH_RESTRICTED', `${REPARSE_DENIED}: ${real}`, 'none', policy.mode)
      }
      const verdict = credentialPath(real)
      if (verdict.denied) return credentialDenied(credentialRefusal(real, verdict.matched).message)
    }
    signal?.throwIfAborted?.()

    const value = await handler(args, { cwd, policy, signal: exec?.signal ?? signal } as { cwd?: string })
    if (!record(value)) return failure('RESULT_UNKNOWN', 'AST engine returned no structured receipt.', 'unknown')
    const shown = present(canonical(value, full), cwd)
    return trimReceipt({ ...shown, sandbox: { mode: policy.mode, enforcement: 'policy', boundary: 'in-process-ast' } })
  }
  catch (error) {
    return failure('RESULT_UNKNOWN', `AST engine failed: ${errorText(error).slice(0, 400)}`, 'unknown')
  }
}
