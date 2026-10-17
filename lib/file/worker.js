/** Native file worker bridge. The host owns path resolution and DSH authority. */
import path from 'node:path'
import fs from 'node:fs'
import { credentialPath, credentialRefusal, credentialRoots } from '../credential-policy.js'
import { ensureSessionTemp, sessionTempDir } from '../session-temp.js'
import { denied } from '../permissions.js'
import { resolveWorker } from '../ptc/runtime.js'
import { normalizeArguments } from './contract.js'

export { resolveWorker }

/** Reserved audit-store component, matching the worker's own `paths::STORE`. */
export const STORE_DIR = '.dsh-ops'

/**
 * Whether a resolved path names the plugin's reserved audit store.
 *
 * Exported so a suite can assert the rule without standing up a session: the
 * guard is one predicate and all four file tools go through it. Both separators
 * are split on, so the assertion does not depend on the host that ran it.
 * @param {string} target - an absolute, resolved target path.
 * @returns {boolean} true when any path component is the reserved store.
 */
export function refusesReservedStore(target) {
  return String(target).split(/[\\/]+/u).some(segment => segment.toLowerCase() === STORE_DIR)
}

export function failure(code, message, phase = 'preflight', effectState = 'none') {
  return { status: code === 'POLICY_DENIED' ? 'rejected' : 'error', phase,
    changed: 0, matched: 0, skipped: 0, failed: 0, complete: false, omitted: 0,
    error: { code, phase, retryable: false, effectState,
      nextAction: effectState === 'none' ? 'Correct the request or restore host authority.' : 'Inspect the result; do not blindly retry after an unknown effect.', message } }
}

function absoluteTarget(raw, cwd) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) return undefined
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw)
}
function inside(root, target) {
  const base = path.resolve(root)
  const candidate = path.resolve(target)
  const relative = path.relative(base, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Host `fs` service, when the deployment has one; observation is skipped without it. */
function hostFs(ctx) {
  try {
    const service = ctx.get('fs')
    return typeof service?.resolve === 'function' && typeof service?.stat === 'function' ? service : undefined
  } catch { return undefined }
}

/** Resolve and stat one path through the host provider, as host read does before reading. */
async function hostObservation(fsService, file, cwd, signal) {
  if (!fsService) return undefined
  try {
    const target = await fsService.resolve(file, { cwd, signal })
    return { target, info: await fsService.stat(target, signal) }
  } catch { return undefined }
}

/** Record an observation in the host's read-before-edit table; best effort, never fails the call. */
function emitObserved(ctx, observed, exec) {
  if (!observed) return
  const { target, info } = observed
  const observation = info === undefined ? { kind: 'absent' }
    : info.type === 'file' && info.version ? { kind: 'present', version: info.version } : undefined
  if (!observation) return
  try { ctx.emit('fs/observed', target, observation, exec) } catch { /* the completed effect stands */ }
}

/** Refresh host observations for files a completed replace wrote (#17). */
async function observeReplaced(ctx, fsService, value, cwd, exec, signal) {
  if (!fsService || value?.status !== 'completed' || value.dryRun || !(value.changed > 0) || !Array.isArray(value.items)) return
  for (const item of value.items) {
    if (typeof item?.path !== 'string') continue
    const observed = await hostObservation(fsService, item.path, cwd, signal)
    // A size mismatch means another writer landed after our publish; leave the host to report stale.
    if (observed?.info?.type === 'file' && observed.info.size === item.bytesAfter) emitObserved(ctx, observed, exec)
  }
}

export async function invoke(ctx, file, tool, args, exec, signal, config) {
  const session = exec?.agent?.session
  const cwd = session?.header?.cwd
  if (!session?.id || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return failure('POLICY_DENIED', 'An authoritative session identity and cwd are required.')
  const policyService = ctx.get('sandboxPolicy')
  const subprocess = ctx.get('subprocess')
  if (!policyService?.resolve || !subprocess?.spawn) return failure('EXECUTOR_UNAVAILABLE', 'DSH policy and subprocess services are required.')
  let policy
  try { policy = policyService.resolve({ session }) } catch (error) { return failure('POLICY_DENIED', String(error?.message ?? error)) }
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode)
    || typeof policy.workspaceRoot !== 'string' || !path.isAbsolute(policy.workspaceRoot)) return failure('POLICY_DENIED', 'Invalid authoritative DSH policy.')

  args = normalizeArguments(tool, args)
  if (tool === 'replace' && policy.mode === 'read-only') return denied(policy, 'replace', 'workspace-write', 'The user selected read-only; no files were changed.')
  const operationPath = absoluteTarget(args?.path ?? '.', cwd)
  if (!operationPath) return failure('INVALID_ARGUMENT', 'path must be a non-empty path.')
  // Credential locations are refused before the worker is spawned, so no read of one ever reaches a
  // result. On by default; a row can turn the fence off for itself (report: credential fence).
  if ((config?.denyCredentialReads ?? true) !== false) {
    const verdict = credentialPath(operationPath)
    if (verdict.denied) return failure('POLICY_DENIED', credentialRefusal(operationPath, verdict.matched).message)
  }
  // The audit store is reserved: every batch operation refuses a path containing this
  // component, and a traversal skips it, but the file tools resolve their own paths — so a
  // read or a replace could reach the records a batch call just wrote. Same rule, same
  // place, host side, before the worker is spawned. Windows spellings are compared
  // case-insensitively, exactly as the worker's own component check does.
  if (refusesReservedStore(operationPath)) {
    return failure('POLICY_DENIED', STORE_DIR + " is the plugin's reserved audit store; the file tools neither read nor write it.")
  }
  const canonical = value => { try { return fs.realpathSync.native(value) } catch { return value } }
  // The temporary root is the session's OWN directory, not the shared system temp: the host sandbox
  // grants `/tmp` to workspace-write on Linux, so endorsing the whole directory here would let one
  // session replace another session's temporary files. The kernel still allows more than this fence
  // does; the fence is deliberately the narrower of the two.
  const privateTemp = sessionTempDir(session.id)
  // Roots and targets are canonicalized the same way: a host temporary directory can itself be
  // reached through a link (`/tmp` on Linux), and an uncanonicalized root would reject a legitimate
  // in-root target.
  const writeRoots = [policy.workspaceRoot, privateTemp].map(canonical)
  if (tool === 'replace' && policy.mode === 'workspace-write') {
    if (!writeRoots.some(root => inside(root, canonical(operationPath)))) {
      return denied(policy, "replace outside the workspace or this session's temporary directory", 'danger-full-access', 'The user authorized workspace writes only; no files were changed.')
    }
    if (inside(canonical(privateTemp), canonical(operationPath))) {
      const created = ensureSessionTemp(privateTemp)
      if (!created.ok) return failure('EXECUTOR_UNAVAILABLE', created.message)
    }
  }

  const workerArgs = { ...args, path: path.join(canonical(path.dirname(operationPath)), path.basename(operationPath)) }
  // Traversals skip credential directories by identity, so a glob or grep cannot even name a private
  // key that sits below one.
  const denyRoots = (config?.denyCredentialReads ?? true) !== false ? credentialRoots() : []
  const input = JSON.stringify({ root: cwd, scope: String(session.id), tool, args: workerArgs, read_only: policy.mode === 'read-only', deny_roots: denyRoots, deny_credential_names: (config?.denyCredentialReads ?? true) !== false, ...(policy.mode === 'workspace-write' ? { write_roots: writeRoots } : {}) })
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
    const readObservation = tool === 'inspect_local_file' ? await hostObservation(fsService, operationPath, cwd, signal) : undefined
    const current = policyService.resolve({ session })
    if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) return failure('POLICY_DENIED', 'Authority changed during preparation.')
    const handle = subprocess.spawn({ argv, cwd, stdio: { stdin: { data: input }, stdout: { maxBytes: 128 * 1024 }, stderr: { maxBytes: 16 * 1024 } }, graceMs: 1000, signal })
    spawned = true
    const outcome = await handle.done
    const stdout = handle.collected.stdout.readFrom(0)
    const stderr = handle.collected.stderr.readFrom(0)
    if (signal?.aborted || outcome.signal) return failure('RESULT_UNKNOWN', 'Worker interrupted; inspect postconditions.', 'execute', 'unknown')
    if (stdout.lossy) return failure('OUTPUT_LIMIT', 'Worker output exceeded the byte budget; operation facts may have changed.', 'verify', 'unknown')
    if (outcome.exitCode !== 0) return failure('RESULT_UNKNOWN', `Worker did not return a settled result: ${stderr.text.slice(0, 500)}`, 'execute', 'unknown')
    let value
    try { value = JSON.parse(stdout.text) } catch { return failure('RESULT_UNKNOWN', 'Worker returned invalid JSON; inspect postconditions.', 'verify', 'unknown') }
    // Report reads/writes to the host's read-before-edit table, exactly like host read/edit. (#17)
    if (tool === 'inspect_local_file' && value?.status === 'completed') emitObserved(ctx, readObservation, exec)
    if (tool === 'replace') await observeReplaced(ctx, fsService, value, cwd, exec, signal)
    return { ...value, sandbox: { mode: policy.mode, enforcement: 'policy', boundary: 'trusted-native-file-operations' } }
  } catch (error) {
    return failure(spawned ? 'RESULT_UNKNOWN' : 'EXECUTOR_UNAVAILABLE', `DSH trusted file executor failed; this is not a user authorization denial. ${String(error?.message ?? error)}`, 'execute', spawned ? 'unknown' : 'none')
  }
}
