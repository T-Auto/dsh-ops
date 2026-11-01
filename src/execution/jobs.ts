/** Native worker bridge. Every execution uses DSH policy, confinement and process governance. */
import type { Context } from '../adapter/dsh/types.js'
import type { SubprocessRuntime } from '../adapter/dsh/types.js'
import type { SandboxPolicyService } from '../adapter/dsh/types.js'
import type { ToolRunContext } from '../adapter/dsh/types.js'
import type { SandboxExecutionPolicy, ConfinedArgv, RunnerFailureRule } from '../adapter/dsh/types.js'
import type { EffectState } from '../kernel/outcome.js'
import type { WorkerInvokeConfig } from './boundary.js'
import { record, errorText } from './boundary.js'
import { exchange } from './transport.js'
import { workerEnvelope } from './protocol.js'
import { withCallBudget, CallBudgetError } from '../kernel/call-budget.js'
import { withResultSession } from '../kernel/result-lifecycle.js'
import { exposePosixCache, resultStorage } from '../kernel/result-storage.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { credentialPath, credentialRefusal, credentialRoots } from '../credential-policy.js'
import { sessionTempDir } from '../session-temp.js'
import { denied, authorityChanged, executionRestriction, normalizeNativeDenial, credentialDenied } from '../permissions.js'
import { inside, canonicalAnchor } from '../authority-paths.js'
import { prepareWorkspace } from '../workspace-preparation.js'
export { resolveWorker } from './runtime.js'
export function failure(code: string, message: string, effectState: EffectState = 'none') {
  return { status: 'error', error: { code, phase: effectState === 'none' ? 'preflight' : 'execute', retryable: false, effectState,
    nextAction: effectState === 'none' ? 'Correct the request or restore host authority.' : 'Inspect the persistent job manifest; never blindly rerun an interrupted batch.', message } }
}
// For fresh batches these validation failures precede Store::save in ops-batch::run.
// Later path/credential checks become per-item errors in an existing job summary.
// Store::save serializes a typed Job with the already-validated host-generated id.
const BEFORE_AUDIT_ERRORS = new Set(['INVALID_ARGUMENT', 'PATH_RESTRICTED', 'CREDENTIAL_DENIED', 'REFERENCE_EXPIRED'])
function rejectedBeforeAudit(value: Record<string, unknown>): boolean {
  const error = value.error
  // phase/effectState alone do not establish whether an audit exists: persistence
  // IO/quota/conflict failures can report preflight/none after a plan was saved.
  return record(error) && error.phase === 'preflight' && error.effectState === 'none'
    && typeof error.code === 'string' && BEFORE_AUDIT_ERRORS.has(error.code)
}
export async function invoke(ctx: Context, file: string, tool: string, args: unknown, exec: ToolRunContext, signal?: AbortSignal, config?: WorkerInvokeConfig): Promise<unknown> {
  try {
    const session = exec?.agent?.session
    if (!session?.id) return failure('EXECUTOR_UNAVAILABLE', 'An authoritative session identity is required.')
    return await withResultSession(ctx, session, signal, currentSignal =>
      withCallBudget(ctx.root ?? ctx, String(session.id), currentSignal,
        () => invokeTrusted(ctx, file, tool, args, exec, currentSignal, config)))
  }
  catch (error) {
    if (error instanceof CallBudgetError) {
      const value = failure(error.code, error.message)
      value.error.nextAction = error.message
      return value
    }
    return failure('EXECUTOR_UNAVAILABLE', 'DSH authority or execution services are unavailable; no unrestricted fallback was attempted.')
  }
}
async function invokeTrusted(ctx: Context, file: string, tool: string, args: unknown, exec: ToolRunContext, signal: AbortSignal, config?: WorkerInvokeConfig): Promise<unknown> {
  const session = exec?.agent?.session
  if (!session?.id) return failure('EXECUTOR_UNAVAILABLE', 'An authoritative session identity is required.')
  const policyService: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
  const subprocess: SubprocessRuntime | undefined = ctx.get('subprocess')
  if (!policyService?.resolve || !subprocess?.spawn) return failure('EXECUTOR_UNAVAILABLE', 'DSH policy and subprocess services are required.')
  if (!record(args)) return failure('INVALID_ARGUMENT', 'Arguments must be an object.')
  const newJob = tool === 'batch' && (args.action === 'run' || args.action === 'plan')
  const jobId = tool === 'batch' ? (newJob ? `j-${randomUUID()}` : args.id) : undefined
  let confined: ConfinedArgv | undefined, spawned = false
  const errorResult = (code: string, message: string, effect: EffectState = 'none') => ({ ...failure(code, message, effect),
    ...(jobId && (!newJob || spawned) ? { detailsRef: jobId } : {}) })
  try {
    const policy: SandboxExecutionPolicy = policyService.resolve({ session })
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode)
      || !path.isAbsolute(policy?.workspaceRoot ?? '')) return failure('EXECUTOR_UNAVAILABLE', 'Invalid authoritative DSH policy; no worker was started.')
    // Model root is a selection, never an authority override. The DSH sandbox
    // retains the original workspaceRoot even when operations select another root.
    if (args?.root !== undefined && (typeof args.root !== 'string' || !path.isAbsolute(args.root))) return failure('INVALID_ARGUMENT', 'root must be an absolute path.')
    const operationRoot = args?.root ?? policy.workspaceRoot
    const { root: _selectedRoot, ...workerArgs } = args ?? {}
    if (tool === 'result' && args?.action === 'purge') return failure('INVALID_ARGUMENT', 'purge is reserved for trusted session cleanup.')
    const readOnly = policy.mode === 'read-only'
    if (readOnly && !(tool === 'result' && args?.action === 'page')) return denied(policy, `${tool} ${args?.action ?? ''}`, 'workspace-write', 'The user selected read-only. Only existing result pages are permitted; no audit or business data was written.')
    // A batch root can reach a credential file through a copy, a move or a result snapshot, so the
    // credential fence covers the root as well as a read path (report: credential fence).
    if ((config?.denyCredentialReads ?? true) !== false) {
      const verdict = credentialPath(operationRoot)
      if (verdict.denied) return credentialDenied(credentialRefusal(operationRoot, verdict.matched).message)
    }
    // Comparison only: never rewrite the selected root passed to the native worker.
    const requiredMode = (current: SandboxExecutionPolicy): 'workspace-write' | 'danger-full-access' => [current.workspaceRoot, sessionTempDir(session.id)]
      .some(root => inside(canonicalAnchor(root), fs.realpathSync.native(operationRoot))) ? 'workspace-write' : 'danger-full-access'
    if (policy.mode === 'workspace-write' && requiredMode(policy) === 'danger-full-access') {
      return denied(policy, `${tool} outside the workspace and session temporary directory`, 'danger-full-access', 'The selected root is outside the user-authorized workspace.')
    }
    const denyRoots = (config?.denyCredentialReads ?? true) !== false ? credentialRoots() : []
    if (Buffer.byteLength(JSON.stringify(workerArgs)) > 2 * 1024 * 1024) return failure('OUTPUT_LIMIT', 'Request exceeds the 2 MiB byte budget.')
    let argv = [file]
    if (policy.mode !== 'danger-full-access') {
      const sandbox = ctx.get('sandbox')
      if (!sandbox?.confine) return failure('EXECUTOR_UNAVAILABLE', 'No DSH process confinement provider; refusing unconfined execution.')
      await prepareWorkspace(policy)
      confined = await sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)
      if (!['full', 'partial'].includes(confined?.enforcement) || !Array.isArray(confined.argv) || !confined.argv.length) {
        return failure('EXECUTOR_UNAVAILABLE', 'Invalid DSH confinement result; refusing unconfined execution.')
      }
      argv = confined.argv
    }
    const storage = await resultStorage(ctx, session, exec.agent, file, tool, policy, denyRoots,
      (config?.denyCredentialReads ?? true) !== false, signal, confined).catch(() => undefined)
    if (tool === 'result' && (args?.action === 'put' || String(args?.id ?? '').startsWith('ref://')) && !storage) {
      return failure('EXECUTOR_UNAVAILABLE', 'Session result storage is unavailable under current host authority.')
    }
    if (confined) argv = exposePosixCache(argv, storage)
    const envelope = workerEnvelope('ptc', { root: operationRoot, scope: String(session.id), tool, args: workerArgs, read_only: readOnly, deny_roots: denyRoots, deny_credential_names: (config?.denyCredentialReads ?? true) !== false, ...(jobId ? { job_id: jobId } : {}) }, undefined, storage)
    const input = JSON.stringify(envelope)
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) return failure('OUTPUT_LIMIT', 'Request exceeds the 2 MiB byte budget.')
    signal?.throwIfAborted?.()
    // Authority may change during asynchronous sandbox preparation.
    const current = policyService.resolve({ session })
    if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(current?.mode) || !path.isAbsolute(current?.workspaceRoot ?? '')) return failure('EXECUTOR_UNAVAILABLE', 'Invalid authoritative DSH policy after preparation.')
      const operation = `${tool} ${args?.action ?? ''}`.trim()
      const required = requiredMode(current)
      if ((current.mode === 'read-only' && !(tool === 'result' && args?.action === 'page')) || (current.mode === 'workspace-write' && required === 'danger-full-access')) return denied(current, operation, required)
      return authorityChanged(current, operation)
    }
    const result = await exchange(subprocess, { argv, cwd: policy.workspaceRoot,
      stdio: { stdin: { data: input }, stdout: { maxBytes: envelope.budget.maxBytes }, stderr: { maxBytes: 16 * 1024 } },
      graceMs: 1000, signal }, () => { spawned = true })
    if (!result.readers) return errorResult('RESULT_UNKNOWN', 'Worker output readers are unavailable; inspect audit records.', 'unknown')
    if (result.interrupted) return errorResult('RESULT_UNKNOWN', 'Worker interrupted; durable write-ahead records preserve possible effects.', 'unknown')
    if (confined && runnerFailure(result.exitCode, result.stderr, confined.runnerFailureRules ?? [])) {
      return failure('EXECUTOR_UNAVAILABLE', 'DSH confinement runner failed before executing the worker.')
    }
    if (result.lossy) return errorResult('OUTPUT_LIMIT', 'Worker output exceeded the byte budget; operation facts remain in the audit store.', 'unknown')
    if (result.exitCode !== 0) {
      const denied = confined?.denialSignatures?.some(s => result.stderr.toLowerCase().includes(s.toLowerCase()))
      if (denied) {
        const value = { status: 'error', error: executionRestriction(`${tool} ${args?.action ?? ''} file effects`) }
        return { ...value, ...(jobId ? { detailsRef: jobId } : {}) }
      }
      return errorResult('RESULT_UNKNOWN', 'Worker did not return a settled result; inspect audit records.', 'unknown')
    }
    if (result.invalid === 'json') return errorResult('RESULT_UNKNOWN', 'Worker returned invalid JSON; inspect audit records.', 'unknown')
    if (!result.value) return errorResult('RESULT_UNKNOWN', 'Worker returned a non-object result; inspect audit records.', 'unknown')
    const value = result.value
    const normalized = normalizeNativeDenial(value, policy, `${tool} ${args?.action ?? ''}`.trim(), 'workspace-write')
    const recoverableId = normalized.status === 'error' && jobId && normalized.detailsRef === undefined
      && (!newJob || !rejectedBeforeAudit(normalized))
    return { ...normalized, ...(tool === 'batch' ? { root: operationRoot } : {}), ...(recoverableId ? { detailsRef: jobId } : {}), sandbox: { mode: policy.mode, ...(confined ? { enforcement: confined.enforcement } : {}) } }
  } catch (error) {
    return errorResult(spawned ? 'RESULT_UNKNOWN' : 'EXECUTOR_UNAVAILABLE',
      `DSH execution infrastructure failed, not a user authorization denial: ${errorText(error)}`, spawned ? 'unknown' : 'none')
  }
}
function runnerFailure(exitCode: number | null, stderr: string, rules: readonly RunnerFailureRule[]): boolean {
  if (exitCode === 0 || exitCode == null) return false
  return rules.some(rule => (!rule.allowedExitCodes || rule.allowedExitCodes.includes(exitCode))
    && stderr.split(/\r?\n/).some(line => !(rule.informationalLines ?? []).some(s => s.toLowerCase() === line.toLowerCase())
      && (rule.fatalSignatures ?? []).some(s => line.toLowerCase().includes(s.toLowerCase()))))
}
