/**
 * `ops_ast_*` — the three AST tools, answered in-process by `src/ast/engine`.
 *
 * A Tree-sitter parse over bytes already in memory costs less than spawning the native worker, and
 * `@ast-grep/napi` loads on first call only. The engine confines nothing, so these fences run in the
 * native worker's order: session identity and cwd, one policy resolve, a credential fence then an
 * anchor for every named path, and workspace-write for `apply`.
 *
 * @module dsh-ops/execution/ast-inproc
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Context, SandboxExecutionPolicy, SandboxMode, SandboxPolicyService, ToolRunContext } from '../adapter/dsh/types.js'
import { credentialPath, credentialRefusal, credentialRoots } from '../credential-policy.js'
import { canonicalAnchor, inside } from '../authority-paths.js'
import { MODES, credentialDenied } from '../permissions.js'
import { record, errorText } from '../worker-boundary.js'
import { capability } from '../capabilities/registry.js'
import { normalizeArguments } from '../capabilities/arguments.js'
import { publicToolName } from '../policy.js'

import type { AuditReceipt, LocateReceipt, RefactorReceipt } from '../ast/engine.cjs'

type Engine = typeof import('../ast/engine.cjs')
/** The three receipts the engine can return: the bridge narrows on their declared shape. */
type EngineReceipt = LocateReceipt | RefactorReceipt | AuditReceipt
type Receipt = Record<string, unknown>
type EffectState = 'none' | 'applied' | 'partial' | 'unknown'

/** Only an explicit `apply` writes: the engine defaults to preview precisely so absence is safe. */
const writes = (mutates: boolean, args: Record<string, unknown>): boolean => mutates && args.mode === 'apply'

/** Caller-named paths. `beforeFile` is read by `audit`, so it has to meet the same fences. */
const named = (args: Record<string, unknown>): string[] =>
  [args.file, args.beforeFile, ...(Array.isArray(args.roots) ? args.roots : [])].filter((v): v is string => typeof v === 'string' && v !== '')


const BOM = '\ufeff'
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Publish one planned file through its own descriptor.
 *
 * The descriptor is opened once, without following a link, and every byte after that goes through
 * it — so replacing the parent directory with a junction between the plan and the write redirects
 * nothing. That is stronger than comparing paths twice, which only narrows the window.
 *
 * The price is atomicity: a rename would make the file all-old or all-new at every instant, while an
 * in-place write can be interrupted halfway. The original text is kept here and restored if the
 * write fails, and the result is read back and compared before the call reports success.
 *
 * @param target - absolute path the plan was built for
 * @param revision - SHA-256 of the text the plan was built against
 * @param after - the complete replacement text
 * @returns undefined on success, or the code and message of the refusal
 */
function publish(target: string, revision: string, after: string): { code: string; message: string } | undefined {
  // O_NOFOLLOW is a POSIX flag: on Windows it is accepted and ignored, so a link would be followed
  // and its target rewritten. Ask the question the descriptor cannot.
  try { if (fs.lstatSync(target).isSymbolicLink()) return { code: 'E_NOT_REGULAR', message: `${target} is a link; refusing to write through it` } } catch { /* absent: open reports it */ }
  let fd: number
  try { fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW) } catch {
    return { code: 'E_NOT_REGULAR', message: `${target} is not a regular file` }
  }
  try {
    const before = fs.fstatSync(fd)
    const original = Buffer.alloc(before.size)
    let read = 0
    while (read < before.size) {
      const n = fs.readSync(fd, original, read, before.size - read, read)
      if (n <= 0) break
      read += n
    }
    const bytes = original.subarray(0, read)
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return { code: 'E_ENCODING', message: `${target} is not UTF-8` } }
    if (sha256(text) !== revision) return { code: 'E_STALE', message: 'changed while the rewrite was planned; nothing was overwritten' }
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    const next = (bom ? BOM : '') + after
    try {
      const payload = Buffer.from(next, 'utf8')
      let written = 0
      while (written < payload.length) {
        written += fs.writeSync(fd, payload, written, payload.length - written, written)
      }
      fs.ftruncateSync(fd, payload.length)
      fs.fsyncSync(fd)
    } catch (error) {
      // The original bytes are still here: put them back rather than leave a half-written file.
      try {
        const restore = Buffer.from((bom ? BOM : '') + text, 'utf8')
        fs.writeSync(fd, restore, 0, restore.length, 0)
        fs.ftruncateSync(fd, restore.length)
        fs.fsyncSync(fd)
      } catch { /* the restore is best effort; the failure below still reports the truth */ }
      return { code: 'E_WRITE', message: `writing ${target} failed: ${errorText(error).slice(0, 200)}` }
    }
    const check = Buffer.alloc(Buffer.byteLength(next, 'utf8'))
    fs.readSync(fd, check, 0, check.length, 0)
    if (sha256(check.toString('utf8')) !== sha256(next)) return { code: 'E_WRITE', message: `${target} did not read back as written` }
    return undefined
  } finally { try { fs.closeSync(fd) } catch { /* already closed */ } }
}

const ADVICE = 'Correct the request or restore host authority.'
const UNSETTLED = 'Inspect the result; do not blindly retry after an unknown effect.'

function failure(code: string, message: string, effectState: EffectState = 'none', mode: SandboxMode | 'unknown' = 'unknown'): Receipt {
  return { status: code === 'POLICY_DENIED' ? 'rejected' : 'error',
    error: { code, message, phase: 'execute', effectState, retryable: false,
      nextAction: effectState === 'none' ? ADVICE : UNSETTLED },
    sandbox: { mode, enforcement: 'policy', boundary: 'in-process-ast' } }
}

let engine: Engine | null | undefined
async function engineOf(): Promise<Engine | undefined> {
  if (engine === undefined) try { engine = await import('../ast/engine.cjs') } catch { engine = null }
  return engine ?? undefined
}

/**
 * Engine receipts already carry cwd-relative paths and a flat `{code, message}`. The host vocabulary
 * differs twice: `ok` is `completed`, and a failure names `effectState` — never `none` for a write
 * unless the engine proved nothing was written.
 */
function canonical(value: Receipt, mayWrite: boolean): Receipt {
  if (value.status === 'ok') return { ...value, status: 'completed' }
  if (record(value.error)) return value
  const code = typeof value.code === 'string' ? value.code : 'RESULT_UNKNOWN'
  const effectState: EffectState = typeof value.effectState === 'string'
    ? value.effectState as EffectState
    : mayWrite && value.applied !== false ? 'unknown' : 'none'
  const message = typeof value.message === 'string' ? value.message : 'The AST engine reported a failure without a message.'
  return { ...value, status: 'error', error: { code, message, phase: 'execute', effectState, retryable: false,
    nextAction: effectState === 'none' ? ADVICE : UNSETTLED } }
}

/**
 * @param tool - catalogue name, e.g. `ast_locate`
 * @param ctx - host context; needs `sandboxPolicy`
 * @param args - caller arguments
 * @param exec - execution binding (session + abort signal)
 * @param signal - the call's abort signal
 */
export async function invokeAst(tool: string, ctx: Context, args: unknown, exec: ToolRunContext, signal: AbortSignal): Promise<unknown> {
  try {
    // The catalogue decides which names exist and what they require; this bridge owns no list.
    const entry = capability(tool)
    // The component narrows `entry` to the schema-bearing AST shape; files.ts already chose us.
    if (!entry || entry.component !== 'ast') return failure('INVALID_ARGUMENT', `${publicToolName(tool)} is not an AST tool.`)
    const source = await engineOf()
    if (!source) return failure('EXECUTOR_UNAVAILABLE', 'The in-process AST engine is unavailable: @ast-grep/napi did not load.')

    const session = exec?.agent?.session
    const cwd = session?.header?.cwd
    if (!session?.id || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      return failure('EXECUTOR_UNAVAILABLE', 'An authoritative session identity and cwd are required.')
    }
    if (!record(args)) return failure('INVALID_ARGUMENT', 'Arguments must be an object.')
    // The catalogue schema decides which optional fields exist; the engine must not see empty ones.
    const input = normalizeArguments(tool, args) as Record<string, unknown>
    const absent = entry.parameters.required.filter((key) => input[key] === undefined || input[key] === null || input[key] === '')
    if (absent.length > 0) return failure('INVALID_ARGUMENT', `missing required argument(s): ${absent.join(', ')}`)

    const policyService: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
    if (!policyService?.resolve) return failure('EXECUTOR_UNAVAILABLE', 'DSH policy resolution is required.')
    let policy: SandboxExecutionPolicy
    try { policy = policyService.resolve({ session }) } catch { return failure('EXECUTOR_UNAVAILABLE', 'DSH policy resolution failed.') }
    if (!(MODES as readonly string[]).includes(policy?.mode) || typeof policy.workspaceRoot !== 'string' || !path.isAbsolute(policy.workspaceRoot)) {
      return failure('EXECUTOR_UNAVAILABLE', 'Invalid authoritative DSH policy.')
    }

    const mayWrite = writes(entry.mutates, input)
    if (mayWrite && policy.mode === 'read-only') return failure('POLICY_DENIED', 'This operation requires workspace-write.', 'none', policy.mode)

    // Credential fence first: it must see the name the caller asked for, not the anchor result.
    const roots = [canonicalAnchor(policy.workspaceRoot), canonicalAnchor(cwd)]
    // The first pass compares the names before anything resolves, so it has to compare against the
    // same kind of name. Comparing a realpathed root with a lexical target rejected a session whose
    // cwd is a link — the target's spelling never matched the resolved root's.
    const lexicalRoots = [path.resolve(policy.workspaceRoot), path.resolve(cwd)]
    // A read scope is not a write grant: a cwd outside the workspace must not authorise a commit.
    const writeRoots = [canonicalAnchor(policy.workspaceRoot)]
    const confined = policy.mode !== 'danger-full-access'
    for (const target of named(input)) {
      const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target)
      const lexical = credentialPath(resolved)
      if (lexical.denied) return credentialDenied(credentialRefusal(target, lexical.matched).message)
      if (confined && !lexicalRoots.some((entry) => inside(entry, resolved))) {
        return failure('POLICY_DENIED', 'Named files and roots must stay inside the workspace or session cwd.', 'none', policy.mode)
      }
      // A junction inside the workspace can point outside and only the real path shows it — the
      // same escape the engine refuses internally.
      let real: string
      try { real = fs.realpathSync.native(resolved) } catch { continue } // absent: let the engine say NOT_FOUND
      if (confined && !roots.some((entry) => inside(entry, real))) {
        return failure('PATH_RESTRICTED', `${resolved} resolves outside the workspace: ${real}`, 'none', policy.mode)
      }
      const anchored = credentialPath(real)
      if (anchored.denied) return credentialDenied(credentialRefusal(real, anchored.matched).message)
    }
    signal?.throwIfAborted?.()

    const handler = source[tool.slice('ast_'.length) as 'locate' | 'refactor' | 'audit'] as unknown as (request: unknown, base: string, opts: { bounds?: readonly string[]; deny?: readonly string[]; cache?: boolean; signal?: AbortSignal; writeRoots?: readonly string[] }) => Promise<unknown> | unknown
    // Scope is the bridge's call: full access lifts the bound, enumeration always skips credentials.
    const bounds = policy.mode === 'danger-full-access' ? undefined : [policy.workspaceRoot, cwd]
    const value = await handler(input, cwd, { bounds, deny: credentialRoots(), cache: policy.mode !== 'read-only', signal, writeRoots })
    if (record(value) && value.status === 'ok' && tool === 'ast_refactor' && input.mode === 'apply' && Array.isArray(value.files)) {
      const applied: string[] = []
      for (const item of value.files) {
        if (!record(item) || typeof item.file !== 'string' || typeof item.after !== 'string' || typeof item.revision !== 'string') continue
        if (signal?.aborted) return { ...value, status: 'error', applied: applied.length > 0, effectState: applied.length > 0 ? 'partial' : 'none', filesApplied: applied,
          error: { code: 'ABORTED', phase: 'execute', effectState: applied.length > 0 ? 'partial' : 'none', retryable: false,
            message: 'cancelled before every planned file was published', nextAction: 'Inspect filesApplied before retrying.' } }
        const refused = publish(path.resolve(cwd, item.file), item.revision, item.after)
        if (refused) return { ...value, status: 'error', applied: applied.length > 0, effectState: applied.length > 0 ? 'partial' : 'none', filesApplied: applied,
          error: { code: refused.code, phase: 'execute', effectState: applied.length > 0 ? 'partial' : 'none', retryable: false, message: refused.message,
            nextAction: applied.length > 0 ? 'Inspect filesApplied before retrying.' : ADVICE } }
        applied.push(item.file)
      }
      value.applied = true
      value.effectState = 'applied'
      value.filesApplied = applied
      value.pending = 0
    }
    if (!record(value)) return failure('RESULT_UNKNOWN', 'AST engine returned no structured receipt.', mayWrite ? 'unknown' : 'none')
    // Authority can be narrowed while the rewrite runs: never report an applied write as settled.
    const confirmed = policyService.resolve({ session })
    if (confirmed?.mode === 'read-only' && (value.effectState === 'applied' || value.effectState === 'partial')) {
      return { ...value, status: 'error', error: { code: 'POLICY_CHANGED', phase: 'execute', effectState: value.effectState, retryable: false,
        message: 'The sandbox was narrowed to read-only while this call was running. Files listed in filesApplied are already committed.',
        nextAction: 'Inspect filesApplied before retrying; the rewrite is not fully applied.' },
        }
    }
    return canonical(value, mayWrite)
  } catch (error) {
    return failure('RESULT_UNKNOWN', `AST engine failed: ${errorText(error).slice(0, 400)}`, 'unknown')
  }
}
