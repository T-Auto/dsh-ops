/** Native file worker bridge. The host owns path resolution and DSH authority. */
import path from 'node:path'
import fs from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { denied } from '../permissions.js'
import { resolveWorker } from '../ptc/runtime.js'
import { normalizeArguments } from './contract.js'

export { resolveWorker }

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
/** The target as the filesystem sees it, so a symlink or junction cannot carry a path past the fence. */
const canonical = value => { try { return fs.realpathSync.native(value) } catch { return value } }

/**
 * The canonical roots a session may touch: its workspace plus the platform
 * temporary areas no wider than the user's own authorization. A candidate that is
 * a filesystem root or that contains the home directory is dropped (a temporary
 * directory at `$HOME` authorized the whole home directory, #76), and an unusable
 * home directory drops every candidate rather than trusting one. Reads and writes
 * ask this one question, so the two cannot disagree about what a session reaches.
 * @param {{workspaceRoot: string}} policy - the resolved DSH policy.
 * @param {{platform?: string, tmpdir?: string, homedir?: string}} [environment] - host facts; injectable so the filter is testable.
 */
export function authorizedRoots(policy, environment = {}) {
  const platform = environment.platform ?? process.platform
  const temporary = environment.tmpdir ?? tmpdir()
  let home = environment.homedir
  if (home === undefined) { try { home = homedir() } catch { home = '' } }
  const roots = [canonical(policy.workspaceRoot)]
  if (typeof home !== 'string' || !path.isAbsolute(home)) return roots
  for (const candidate of [temporary, ...(platform === 'win32' ? [] : ['/tmp'])]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue
    const normalized = path.normalize(candidate)
    if (path.parse(normalized).root === normalized || inside(candidate, home)) continue
    roots.push(canonical(candidate))
  }
  return roots
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

export async function invoke(ctx, file, tool, args, exec, signal) {
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
  // One check for every file tool, against the roots the worker is also handed:
  // reaching outside them is the same denial for a read as for a write.
  const roots = authorizedRoots(policy)
  if (policy.mode !== 'danger-full-access' && !roots.some(root => inside(root, canonical(operationPath)))) {
    return denied(policy, `${tool} outside the workspace or DSH temporary areas`, 'danger-full-access',
      tool === 'replace' ? 'The user authorized workspace writes only; no files were changed.' : 'The user authorized workspace access only; nothing was read or changed.')
  }

  const workerArgs = { ...args, path: operationPath }
  const input = JSON.stringify({ root: cwd, scope: String(session.id), tool, args: workerArgs, read_only: policy.mode === 'read-only', ...(policy.mode === 'workspace-write' ? { write_roots: roots } : {}) })
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
