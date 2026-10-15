/** Native file worker bridge. The host owns path resolution and DSH authority. */
import path from 'node:path'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { denied } from '../permissions.js'
import { resolveWorker } from '../ptc/runtime.js'

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

  if (tool === 'replace' && policy.mode === 'read-only') return denied(policy, 'replace', 'workspace-write', 'The user selected read-only; no files were changed.')
  const operationPath = absoluteTarget(args?.path ?? '.', cwd)
  if (!operationPath) return failure('INVALID_ARGUMENT', 'path must be a non-empty path.')
  const canonical = value => { try { return fs.realpathSync.native(value) } catch { return value } }
  const writeRoots = [policy.workspaceRoot, tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])].map(canonical)
  if (tool === 'replace' && policy.mode === 'workspace-write' &&
    !writeRoots.some(root => inside(root, canonical(operationPath)))) {
    return denied(policy, 'replace outside the workspace or DSH temporary areas', 'danger-full-access', 'The user authorized workspace writes only; no files were changed.')
  }

  // Hand the worker a host-resolved path. The worker opens every component with
  // no-follow, so an alias the platform itself introduces into the directory
  // chain (`/var` -> `/private/var`, `/tmp` -> `/private/tmp`) reads as a link
  // and every operation under it is refused before it starts — including the
  // temporary area `writeRoots` deliberately grants. The fence above already
  // compares canonical paths, so fence and worker were disagreeing about the
  // same request; this makes them agree. `root` is canonicalized the same way,
  // by the worker itself.
  //
  // Only the parent chain is resolved, never the entry the caller names: a link
  // at the last component is still refused by the worker, asserted in
  // test/ptc.test.mjs. The trade-off is deliberate: a link in an *ancestor*
  // directory is now resolved rather than refused, and the resolved parent is
  // exactly what the fence authorized. `canonical` passes an unresolved path
  // (one that does not exist yet) through unchanged.
  //
  // The alternative — teaching the hardened Rust worker which host aliases to
  // skip — was rejected: it would put platform-specific knowledge inside the
  // layer whose value is that it has none.
  const workerArgs = { ...args, path: path.join(canonical(path.dirname(operationPath)), path.basename(operationPath)) }
  const input = JSON.stringify({ root: cwd, scope: String(session.id), tool, args: workerArgs, read_only: policy.mode === 'read-only', ...(policy.mode === 'workspace-write' ? { write_roots: writeRoots } : {}) })
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) return failure('OUTPUT_LIMIT', 'Request exceeds the 2 MiB byte budget.')
  let spawned = false
  try {
    // Trusted, fixed file operations follow DSH fs-sandbox's policy fence,
    // not an arbitrary-code runner. The worker accepts data, never shell/code.
    // This is the only file execution path, not a sandbox-failure fallback.
    const argv = [file]
    signal?.throwIfAborted?.()
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
    return { ...value, sandbox: { mode: policy.mode, enforcement: 'policy', boundary: 'trusted-native-file-operations' } }
  } catch (error) {
    return failure(spawned ? 'RESULT_UNKNOWN' : 'EXECUTOR_UNAVAILABLE', `DSH trusted file executor failed; this is not a user authorization denial. ${String(error?.message ?? error)}`, 'execute', spawned ? 'unknown' : 'none')
  }
}
