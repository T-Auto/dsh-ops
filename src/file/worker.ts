/** Native file worker bridge. The host owns path resolution and DSH authority. */
import type { Context } from '../adapter/dsh/types.js'
import type { SubprocessRuntime } from '../adapter/dsh/types.js'
import type { SandboxPolicyService } from '../adapter/dsh/types.js'
import type { ToolRunContext } from '../adapter/dsh/types.js'
import type { FileSystem, FsTarget, FsInfo, FsObservation } from '../adapter/dsh/types.js'
import type { SandboxExecutionPolicy } from '../adapter/dsh/types.js'
import type { EffectState } from '../kernel/outcome.js'
import type { WorkerInvokeConfig } from '../worker-boundary.js'
import { record, errorText } from '../worker-boundary.js'
import { workerEnvelope } from '../worker-protocol.js'
import path from 'node:path'
import { credentialPath, credentialRefusal, credentialRoots } from '../credential-policy.js'
import { ensureSessionTemp, sessionTempDir } from '../session-temp.js'
import { denied, authorityChanged, normalizeNativeDenial, credentialDenied } from '../permissions.js'
import { inside, canonicalAnchor, anchoredPath, sessionAnchors } from '../authority-paths.js'
import { resolveWorker } from '../ptc/runtime.js'
import { FILE_MUTATIONS } from '../policy.js'
import { normalizeArguments } from './contract.js'
import { resolveReadFiles } from './read-files.js'
import { readFilesCompat } from './read-files-compat.js'
import { withCallBudget, CallBudgetError } from '../kernel/call-budget.js'
import { withResultSession } from '../kernel/result-lifecycle.js'
import { resultStorage } from '../kernel/result-storage.js'

export { resolveWorker }

export function failure(code: string, message: string, phase = 'preflight', effectState: EffectState = 'none') {
  return { status: code === 'POLICY_DENIED' ? 'rejected' : 'error', phase,
    changed: 0, matched: 0, skipped: 0, failed: 0, complete: false, omitted: 0,
    error: { code, phase, retryable: false, effectState,
      nextAction: effectState === 'none' ? 'Correct the request or restore host authority.' : 'Inspect the result; do not blindly retry after an unknown effect.', message } }
}

function absoluteTarget(raw: unknown, cwd: string): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) return undefined
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw)
}
type Observation = { target: FsTarget; info: FsInfo | undefined }

/** Host `fs` service, when the deployment has one; observation is skipped without it. */
function hostFs(ctx: Context): FileSystem | undefined {
  try {
    const service = ctx.get('fs')
    return typeof service?.resolve === 'function' && typeof service?.stat === 'function' ? service : undefined
  } catch { return undefined }
}

/** Resolve and stat one path through the host provider, as host read does before reading. */
async function hostObservation(fsService: FileSystem | undefined, file: string, cwd: string, signal: AbortSignal): Promise<Observation | undefined> {
  if (!fsService) return undefined
  try {
    const target = await fsService.resolve(file, { cwd, signal })
    return { target, info: await fsService.stat(target, signal) }
  } catch { return undefined }
}

/** Record an observation in the host's read-before-edit table; best effort, never fails the call. */
function emitObserved(ctx: Context, observed: Observation | undefined, exec: ToolRunContext): void {
  if (!observed) return
  const { target, info } = observed
  const observation: FsObservation | undefined = info === undefined ? { kind: 'absent' }
    : info.type === 'file' && info.version ? { kind: 'present', version: info.version } : undefined
  if (!observation) return
  try { ctx.emit('fs/observed', target, observation, exec) } catch { /* the completed effect stands */ }
}

/** Refresh host observations for files a completed replace wrote (#17). */
async function observeReplaced(ctx: Context, fsService: FileSystem | undefined, value: Record<string, unknown>, cwd: string, exec: ToolRunContext, signal: AbortSignal): Promise<void> {
  if (!fsService || value?.status !== 'completed' || value.dryRun || !(Number(value.changed) > 0) || !Array.isArray(value.items)) return
  for (const item of value.items) {
    if (!record(item) || typeof item.path !== 'string') continue
    const observed = await hostObservation(fsService, item.path, cwd, signal)
    // A size mismatch means another writer landed after our publish; leave the host to report stale.
    if ((item.removed && observed && observed.info === undefined) || (observed?.info?.type === 'file' && observed.info.size === item.bytesAfter)) emitObserved(ctx, observed, exec)
  }
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
    return failure('EXECUTOR_UNAVAILABLE', 'DSH file authority or preparation is unavailable; no unrestricted fallback was attempted.')
  }
}
async function invokeTrusted(ctx: Context, file: string, tool: string, args: unknown, exec: ToolRunContext, signal: AbortSignal, config?: WorkerInvokeConfig): Promise<unknown> {
  const session = exec?.agent?.session
  const cwd = session?.header?.cwd
  if (!session?.id || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return failure('EXECUTOR_UNAVAILABLE', 'An authoritative session identity and cwd are required.')
  const policyService: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
  const subprocess: SubprocessRuntime | undefined = ctx.get('subprocess')
  // `read_files` is answered in-process, so it needs the policy but not a subprocess service.
  if (!policyService?.resolve || (tool !== 'read_files' && !subprocess?.spawn)) return failure('EXECUTOR_UNAVAILABLE', 'DSH policy and subprocess services are required.')
  let policy: SandboxExecutionPolicy
  try { policy = policyService.resolve({ session }) } catch { return failure('EXECUTOR_UNAVAILABLE', 'DSH policy resolution failed.') }
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode)
    || typeof policy.workspaceRoot !== 'string' || !path.isAbsolute(policy.workspaceRoot)) return failure('EXECUTOR_UNAVAILABLE', 'Invalid authoritative DSH policy.')

  args = normalizeArguments(tool, args)
  if (!record(args)) return failure('INVALID_ARGUMENT', 'Arguments must be an object.')
  const mutates = (FILE_MUTATIONS as readonly string[]).includes(tool)
  const reads = tool === 'read_files' ? resolveReadFiles(args, cwd) : undefined
  if (reads && 'error' in reads) return failure('INVALID_ARGUMENT', reads.error)
  const operationPath = absoluteTarget(args?.path ?? '.', cwd)
  if (!operationPath) return failure('INVALID_ARGUMENT', 'path must be a non-empty path.')
  // Credential locations are refused before the worker is spawned, so no read of one ever reaches a
  // result. On by default; a row can turn the fence off for itself (report: credential fence).
  if ((config?.denyCredentialReads ?? true) !== false) {
    for (const target of reads ? reads.files.map(file => file.path) : [operationPath]) {
      const verdict = credentialPath(target)
      if (verdict.denied) {
        const refusal = credentialRefusal(target, verdict.matched)
        return credentialDenied(refusal.message)
      }
    }
  }
  const destination = ['copy', 'move'].includes(tool) ? absoluteTarget(args?.to, cwd) : undefined
  if (['copy', 'move'].includes(tool) && !destination) return failure('INVALID_ARGUMENT', 'to must be a non-empty path.')
  if (destination && (config?.denyCredentialReads ?? true) !== false) {
    const verdict = credentialPath(destination)
    if (verdict.denied) {
      const refusal = credentialRefusal(destination, verdict.matched)
      return credentialDenied(refusal.message)
    }
  }
  // The temporary root is the session's OWN directory, not the shared system temp: the host sandbox
  // grants `/tmp` to workspace-write on Linux, so endorsing the whole directory here would let one
  // session replace another session's temporary files. The kernel still allows more than this fence
  // does; the fence is deliberately the narrower of the two.
  const privateTemp = sessionTempDir(session.id)
  const anchors = sessionAnchors(policy, cwd)
  const trustedPath = (value: string): string => anchoredPath(value, anchors)
  const writeRoots = [canonicalAnchor(policy.workspaceRoot), trustedPath(privateTemp)]
  const writeTargets = tool === 'copy' && destination ? [destination] : [operationPath, ...(destination ? [destination] : [])]
  const requiredMode = (current: SandboxExecutionPolicy): 'workspace-write' | 'danger-full-access' => {
    const roots = [canonicalAnchor(current.workspaceRoot), anchoredPath(privateTemp, sessionAnchors(current, cwd))]
    return writeTargets.every(target => roots.some(root => inside(root, anchoredPath(target, sessionAnchors(current, cwd)))))
      ? 'workspace-write' : 'danger-full-access'
  }
  if (mutates && policy.mode === 'read-only') return denied(policy, tool, requiredMode(policy), 'The user selected read-only; no files were changed.')
  if (mutates && policy.mode === 'workspace-write') {
    for (const target of writeTargets) {
      const identity = trustedPath(target)
      if (!writeRoots.some(root => inside(root, identity))) {
        return denied(policy, `${tool} outside the workspace or this session's temporary directory`, 'danger-full-access', 'The user authorized workspace writes only; no files were changed.')
      }
      if (inside(writeRoots[1], identity)) {
        const created = ensureSessionTemp(writeRoots[1])
        if (!created.ok) return failure('EXECUTOR_UNAVAILABLE', created.message)
      }
    }
  }

  // Do NOT realpath the caller's parents here: that would erase a symlink/junction before
  // the no-follow native traversal could reject it (especially on create-only writes).
  const workerArgs = reads
    ? { ...args, files: reads.files.map(file => ({ ...file, path: trustedPath(file.path) })) }
    : { ...args, path: trustedPath(operationPath), ...(destination ? { to: trustedPath(destination) } : {}) }
  // Traversals skip credential directories by identity, so a glob or grep cannot even name a private
  // key that sits below one.
  const denyRoots = (config?.denyCredentialReads ?? true) !== false ? credentialRoots() : []
  const storage = await resultStorage(ctx, session, exec.agent, file, tool, policy, denyRoots,
    (config?.denyCredentialReads ?? true) !== false, signal).catch(() => undefined)
  const envelope = workerEnvelope('file', { root: trustedPath(cwd), scope: String(session.id), tool, args: workerArgs, read_only: policy.mode === 'read-only', deny_roots: denyRoots, deny_credential_names: (config?.denyCredentialReads ?? true) !== false, ...(policy.mode === 'workspace-write' ? { write_roots: writeRoots } : {}) }, config?.toolCallTimeoutMs, storage)
  const input = JSON.stringify(envelope)
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) return failure('OUTPUT_LIMIT', 'Request exceeds the 2 MiB byte budget.')
  let spawned = false
  try {
    // Trusted, fixed file operations follow DSH fs-sandbox's policy fence,
    // not an arbitrary-code runner. The worker accepts data, never shell/code.
    // This is the only file execution path, not a sandbox-failure fallback.
    const argv = [file]
    signal?.throwIfAborted?.()
    const fsService = hostFs(ctx)
    // Stat before reading, like host read: a concurrent change records the older version and fails stale later.
    const readObservation = ['inspect_local_file', 'stat'].includes(tool) ? await hostObservation(fsService, operationPath, cwd, signal) : undefined
    const readObservations = reads ? await Promise.all(reads.files.map(file => hostObservation(fsService, file.path, cwd, signal))) : []
    signal?.throwIfAborted?.()
    const current = policyService.resolve({ session })
    if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(current?.mode) || !path.isAbsolute(current?.workspaceRoot ?? '')) return failure('EXECUTOR_UNAVAILABLE', 'Invalid authoritative DSH policy after preparation.')
      const required = mutates ? requiredMode(current) : undefined
      if (mutates && (current.mode === 'read-only' || (current.mode === 'workspace-write' && required === 'danger-full-access'))) return denied(current, tool, required, 'Authority changed during preparation; no files were changed.')
      return authorityChanged(current, tool)
    }
    // `read_files` is answered in-process: the pool, the per-file deadline and every read gate
    // live in `parallel-read.ts`; the receipt is folded back into the native item shape by
    // `read-files-compat.ts`. The fences above (policy, credential, anchoring) and the
    // observations below are unchanged — only the process spawn in the middle is gone.
    if (reads) {
      const files = reads.files.map(item => ({
        path: trustedPath(item.path),
        ...(typeof item.offset === 'number' ? { offset: item.offset } : {}),
        ...(typeof item.limit === 'number' ? { limit: item.limit } : {}),
      }))
      const value = await readFilesCompat(files, { signal })
      if (signal?.aborted) return failure('RESULT_UNKNOWN', 'Read interrupted; inspect postconditions.', 'execute', 'unknown')
      if (record(value) && Array.isArray(value.items)) {
        for (const [index, item] of value.items.entries()) {
          if (record(item) && item.status === 'completed') emitObserved(ctx, readObservations[index], exec)
        }
      }
      const normalized = normalizeNativeDenial(record(value) ? value : {}, policy, tool, 'workspace-write')
      return { ...normalized, sandbox: { mode: policy.mode, enforcement: 'policy', boundary: 'in-process-parallel-read' } }
    }
    const runtime = subprocess
    if (!runtime?.spawn) return failure('EXECUTOR_UNAVAILABLE', 'DSH subprocess service is required for this tool.')
    const handle = runtime.spawn({ argv, cwd, stdio: { stdin: { data: input }, stdout: { maxBytes: envelope.budget.maxBytes }, stderr: { maxBytes: 16 * 1024 } }, graceMs: 1000, signal })
    spawned = true
    const outcome = await handle.done
    if (!handle.collected.stdout || !handle.collected.stderr) return failure('RESULT_UNKNOWN', 'Worker output readers are unavailable; inspect postconditions.', 'verify', 'unknown')
    const stdout = handle.collected.stdout.readFrom(0)
    const stderr = handle.collected.stderr.readFrom(0)
    if (signal?.aborted || outcome.signal) return failure('RESULT_UNKNOWN', 'Worker interrupted; inspect postconditions.', 'execute', 'unknown')
    if (stdout.lossy) return failure('OUTPUT_LIMIT', 'Worker output exceeded the byte budget; operation facts may have changed.', 'verify', 'unknown')
    if (outcome.exitCode !== 0) return failure('RESULT_UNKNOWN', `Worker did not return a settled result: ${stderr.text.slice(0, 500)}`, 'execute', 'unknown')
    let value: unknown
    try { value = JSON.parse(stdout.text) } catch { return failure('RESULT_UNKNOWN', 'Worker returned invalid JSON; inspect postconditions.', 'verify', 'unknown') }
    if (!record(value)) return failure('RESULT_UNKNOWN', 'Worker returned a non-object result; inspect postconditions.', 'verify', 'unknown')
    // Report reads/writes to the host's read-before-edit table, exactly like host read/edit. (#17)
    if (['inspect_local_file', 'stat'].includes(tool) && value?.status === 'completed') emitObserved(ctx, readObservation, exec)
    if (reads && Array.isArray(value?.items)) {
      for (const [index, item] of value.items.entries()) {
        if (record(item) && item.status === 'completed') emitObserved(ctx, readObservations[index], exec)
      }
    }
    if (mutates) await observeReplaced(ctx, fsService, value, cwd, exec, signal)
    const normalized = normalizeNativeDenial(value, policy, tool, mutates ? requiredMode(policy) : 'workspace-write')
    return { ...normalized, sandbox: { mode: policy.mode, enforcement: 'policy', boundary: 'trusted-native-file-operations' } }
  } catch (error) {
    return failure(spawned ? 'RESULT_UNKNOWN' : 'EXECUTOR_UNAVAILABLE', `DSH trusted file executor failed; this is not a user authorization denial. ${errorText(error)}`, 'execute', spawned ? 'unknown' : 'none')
  }
}
