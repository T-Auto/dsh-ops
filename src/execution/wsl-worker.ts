/** Optional data-only WSL reads. No shell, cache writer, runtime download or arbitrary program. */
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { SubprocessRuntime } from '../adapter/dsh/types.js'
import type { WorkerInvokeConfig } from './boundary.js'
import { record } from './boundary.js'
import { PACKAGE_ROOT, verifyPackagedWorker } from './runtime.js'
import type { RuntimeOptions } from './runtime.js'
import { exchange } from './transport.js'
import { workerEnvelope } from './protocol.js'
import { wslPath, windowsDrive, linuxPath, cursorIdentity, unwrapCursor, wrapCursor, windowsResult, inlineWslResult } from './wsl-paths.js'

type Envelope = ReturnType<typeof workerEnvelope>
type Attempt = { handled: true; value: Record<string, unknown> } | { handled: false; remainingMs: number }
const fail = (code: string, message: string): Attempt => ({ handled: true, value: { status: 'error', complete: false,
  error: { code, message, effectState: 'none', phase: 'execute', retryable: false,
    nextAction: code === 'SEARCH_STALE' ? 'Discard the continuation and start a fresh bounded query.' : 'Restore the WSL backend or start a fresh request; no cross-backend continuation replay was attempted.' } } })

export async function tryWslRead(subprocess: SubprocessRuntime, file: string, envelope: Envelope, cwd: string,
  signal: AbortSignal, sameAuthority: () => boolean, config?: WorkerInvokeConfig, options: RuntimeOptions = {}): Promise<Attempt> {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT, env = options.env ?? process.env
  const request = envelope.request, tool = String(request.tool), args = request.args
  const continuation = record(args) ? args.continuation : undefined
  const pinned = typeof continuation === 'string' && continuation.startsWith('w1:')
  const fallback = (remainingMs = envelope.budget.timeoutMs): Attempt => pinned
    ? fail('EXECUTOR_UNAVAILABLE', 'The WSL backend for this continuation is unavailable.') : { handled: false, remainingMs }
  if (!['glob', 'grep', 'read_files'].includes(tool) || !record(args) || (options.platform ?? process.platform) !== 'win32') return fallback()
  if (env.DSH_OPS_WSL_READS !== '1') return fallback()
  if (continuation !== undefined && !pinned) return fallback() // Existing Windows cursors remain Windows cursors.
  const root = typeof request.root === 'string' ? wslPath(request.root) : undefined
  if (!root) return pinned ? fail('SEARCH_STALE', 'The WSL continuation no longer has the same workspace backend.') : fallback()
  const packaged = path.join(packageRoot, 'runtime', 'win32-x64', 'dsh-ops-worker.exe')
  if (config?.binaryPath !== undefined || env.DSH_OPS_WORKER_BIN !== undefined
    || path.resolve(file).toLowerCase() !== packaged.toLowerCase()) return fallback()
  const payload = path.join(packageRoot, 'runtime', 'linux-x64', 'dsh-ops-worker')
  let digest: string
  try { digest = verifyPackagedWorker(payload, packageRoot, 'linux', 'x64') } catch { return fallback() }
  const identity = cursorIdentity(root.distro, digest), inner = pinned ? unwrapCursor(continuation, identity) : undefined
  if (pinned && !inner) return fail('SEARCH_STALE', 'The WSL continuation belongs to another distribution, payload or path policy.')
  const files = tool === 'read_files' && Array.isArray(args.files) ? args.files : undefined
  const targets = files ? files.map(item => record(item) && typeof item.path === 'string' ? item.path : '') : [String(args.path)]
  if (targets.some(target => wslPath(target)?.distro.toLowerCase() !== root.distro.toLowerCase())) return fallback()
  const denyRoots = Array.isArray(request.deny_roots) ? request.deny_roots : []
  const writes = Array.isArray(request.write_roots) ? request.write_roots : undefined
  const paths = [payload, ...denyRoots, ...(writes ?? [])]
  if (paths.some(value => typeof value !== 'string' || (!windowsDrive(value) && wslPath(value)?.distro.toLowerCase() !== root.distro.toLowerCase()))) return fallback()
  const deadline = performance.now() + envelope.budget.timeoutMs
  const remaining = () => Math.max(0, Math.ceil(deadline - performance.now()))
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
  const timer = setTimeout(() => controller.abort(), remaining()); timer.unref?.()
  const executable = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
  const prefix = [executable, '--distribution', root.distro, '--exec']
  let authorityLost = false
  const guard = () => {
    combined.throwIfAborted()
    if (remaining() === 0) { controller.abort(); combined.throwIfAborted() }
    if (!sameAuthority()) { authorityLost = true; throw new Error('Host authority changed') }
  }
  const probe = async (argv: string[]): Promise<string> => {
    guard()
    const handle = subprocess.spawn({ argv: [...prefix, ...argv], cwd, stdio: { stdin: { data: '' }, stdout: { maxBytes: 8192 }, stderr: { maxBytes: 4096 } }, graceMs: 1000, signal: combined })
    const done = await handle.done, output = handle.collected.stdout?.readFrom(0)
    if (done.exitCode !== 0 || done.signal || !output || output.lossy || combined.aborted) throw new Error('WSL preparation unavailable')
    return output.text.trim()
  }
  try {
    // Mount mappings are live authority, not a cache keyed only by a drive letter.
    const drives = new Map<string, string>()
    for (const drive of new Set(paths.map(value => windowsDrive(String(value))).filter((value): value is string => Boolean(value)))) {
      const mapped = await probe(['/usr/bin/wslpath', '-u', `${drive}\\`])
      if (!mapped.startsWith('/') || mapped.includes('\n') || mapped.includes('\0')) throw new Error('WSL drive mapping unavailable')
      drives.set(drive, mapped)
    }
    const worker = linuxPath(payload, root.distro, drives)
    if (!worker || !(await probe(['/usr/bin/sha256sum', '--', worker])).startsWith(`${digest} `)) throw new Error('WSL payload mismatch')
    const convert = (value: string): string => {
      const mapped = linuxPath(value, root.distro, drives)
      if (!mapped) throw new Error('WSL authority mapping unavailable')
      return mapped
    }
    const mappedArgs = { ...args, ...(files ? { files: files.map(item => ({ ...item as Record<string, unknown>, path: convert(String((item as Record<string, unknown>).path)) })) } : { path: convert(String(args.path)) }),
      ...(pinned ? { continuation: inner } : {}) }
    guard()
    const delegated = { ...envelope, budget: { ...envelope.budget, timeoutMs: Math.max(1, remaining()) },
      request: { ...request, args: mappedArgs, root: root.file, windows_paths: true, deny_roots: denyRoots.map(value => convert(String(value))),
        ...(writes ? { write_roots: writes.map(value => convert(String(value))) } : {}) } }
    // Cache ownership stays with the Windows worker. A speculative read never receives storage.
    delete delegated.storage
    const input = JSON.stringify(delegated)
    guard()
    const result = await exchange(subprocess, { argv: [...prefix, worker], cwd,
      stdio: { stdin: { data: input }, stdout: { maxBytes: envelope.budget.maxBytes }, stderr: { maxBytes: 4096 } }, graceMs: 1000, signal: combined })
    if (combined.aborted || remaining() === 0 || result.exitCode === 124) return fail(signal.aborted ? 'CANCELLED' : 'TIMEOUT', 'The WSL read was cancelled or exceeded the original call budget; it was not replayed.')
    if (result.interrupted) return fail('RESULT_UNKNOWN', 'The WSL read was interrupted; it was not replayed.')
    if (!sameAuthority()) return fail('AUTHORITY_CHANGED', 'Host authority changed during the WSL read; no result was published.')
    if (!result.value || !result.readers || result.lossy || result.exitCode !== 0) return fail('RESULT_UNKNOWN', 'The WSL read did not return a complete transport result; it was not replayed.')
    let value = windowsResult(result.value, root.root, tool)
    if (typeof value.continuation === 'string') value = { ...value, continuation: wrapCursor(value.continuation, identity) }
    if (value.error && record(value.error) && value.error.code !== 'OUTPUT_LIMIT') return { handled: true, value }
    if (inlineWslResult(value, tool, envelope.budget.maxBytes)) return { handled: true, value }
    if (pinned) return fail('OUTPUT_LIMIT', 'This WSL continuation needs Windows-owned result storage; start a fresh bounded request instead of changing backends.')
    return fallback(remaining())
  } catch {
    if (authorityLost) return fail('AUTHORITY_CHANGED', 'Host authority changed during WSL preparation; no result was published.')
    if (combined.aborted || remaining() === 0) return fail(signal.aborted ? 'CANCELLED' : 'TIMEOUT', 'The WSL read was cancelled or exhausted its original call budget; it was not replayed.')
    return fallback(remaining())
  } finally { clearTimeout(timer) }
}
