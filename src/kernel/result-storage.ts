/** Trusted cache metadata comes from the host, never tool arguments or selected operation roots. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { SandboxExecutionPolicy, ConfinedArgv } from '../adapter/dsh/types.js'
import type { WorkerStorage } from '../execution/protocol.js'
import { workerEnvelope } from '../execution/protocol.js'
import { CAPABILITIES } from '../capabilities/registry.js'
import { publicToolName } from '../policy.js'
import { sameAuthority } from '../authority-paths.js'
import { prepareWorkspace } from '../workspace-preparation.js'
import { resultSessionNonce, registerResultCleanup } from './result-lifecycle.js'
import type { ResultSession } from './result-lifecycle.js'
import { markCleanupRootLive, registerCleanupRoot, releaseCleanupRootLive } from './result-cleanup-registry.js'

interface Subprocess {
  spawn(spec: { argv: string[]; cwd: string; stdio: { stdin: { data: string }; stdout: { maxBytes: number }; stderr: { maxBytes: number } }; graceMs: number; signal: AbortSignal }): {
    done: Promise<{ exitCode: number | null; signal?: unknown }>
    collected: { stdout: { readFrom(offset: number): { text: string; lossy?: boolean } } }
  }
}
export interface StorageHost {
  root?: object
  get(name: 'sandbox'): { confine(argv: string[], policy: SandboxExecutionPolicy & { mode: 'read-only' | 'workspace-write' }, signal?: AbortSignal): Promise<ConfinedArgv>; prepareResultStorage?(argv: string[], policy: SandboxExecutionPolicy & { mode: 'workspace-write' }, signal?: AbortSignal): Promise<ConfinedArgv> } | undefined
  get(name: 'sandboxPolicy'): { resolve(input: { session: ResultSession }): SandboxExecutionPolicy } | undefined
  get(name: 'tools'): { schemas(scope: unknown): { name: string }[]; get(name: string, scope: unknown): unknown } | undefined
  get(name: 'subprocess'): Subprocess | undefined
}
type Location = { root: string; windowsWriteSid?: string }
const locations = new WeakMap<object, Map<string, Location>>()
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Parse only the runner's pre-separator contract, not the wrapped program's arguments. */
export function windowsCacheLocation(argv: readonly string[]): Location | undefined {
  const separator = argv.indexOf('--')
  if (separator < 1) return undefined
  const flags = argv.slice(1, separator)
  const one = (flag: string): string | undefined => {
    const index = flags.indexOf(flag)
    return index >= 0 && flags.lastIndexOf(flag) === index ? flags[index + 1] : undefined
  }
  const root = one('--temp'), sid = one('--temp-write-sid')
  const match = /^S-1-4-([1-9][0-9]*)-([1-9][0-9]*)-1$/.exec(sid ?? '')
  if (!root || !path.win32.isAbsolute(root) || root.includes('\0') || !match
    || match.slice(1).some(part => Number(part) > 1073741823)) return undefined
  return { root, windowsWriteSid: sid }
}
/**
 * bwrap gives workspace-write children a private tmpfs over /tmp, which hides the host-created
 * cache below tmpdir(). Re-expose exactly that one private directory; every other runner, and
 * read-only bwrap (no tmpfs), already sees it and is returned unchanged.
 */
export function exposePosixCache(argv: readonly string[], storage: WorkerStorage | undefined): string[] {
  const separator = argv.indexOf('--')
  if (!storage || storage.windowsWriteSid !== undefined || separator < 1 || path.basename(argv[0]) !== 'bwrap'
    || !argv.slice(1, separator).some(option => option === '--tmpfs' || option.startsWith('--tmpfs='))
    || !path.isAbsolute(storage.root)) return [...argv]
  return [...argv.slice(0, separator), '--bind', storage.root, storage.root, ...argv.slice(separator)]
}
function posixCacheLocation(key: string, create: boolean): Location | undefined {
  const parent = fs.realpathSync(tmpdir()), root = path.join(parent, `dsh-ops-results-${key}`)
  // Only one fresh leaf under the canonical temp root. No recursive mkdir through caller paths.
  if (create) {
    try { fs.mkdirSync(root, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  if (!fs.existsSync(root)) return undefined
  const info = fs.lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (process.getuid && info.uid !== process.getuid())) throw new Error('Result cache parent must be private and owned')
  return { root }
}
function currentTools(ctx: StorageHost, scope: unknown, tool: string): string[] {
  const tools = ctx.get('tools'), visible = new Set(tools?.schemas(scope).map(item => item.name) ?? [])
  return CAPABILITIES.filter(item => item.rawName === tool
    || (visible.has(publicToolName(item.rawName)) && tools?.get(publicToolName(item.rawName), scope)))
    .map(item => item.rawName)
}
async function purge(ctx: StorageHost, session: ResultSession, file: string, storage: WorkerStorage,
  original: SandboxExecutionPolicy): Promise<void> {
  const policyService = ctx.get('sandboxPolicy'), subprocess = ctx.get('subprocess')
  const policy = policyService?.resolve({ session })
  if (!policy || !subprocess || policy.mode === 'read-only' || !sameAuthority(policy, original)
    || (process.platform === 'win32' && policy.sessionId !== session.id)) throw new Error('Cleanup authority unavailable')
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000)
  timer.unref?.()
  try {
    let argv = [file]
    if (policy.mode !== 'danger-full-access') {
      const sandbox = ctx.get('sandbox')
      const confined = process.platform === 'win32' && sandbox?.prepareResultStorage
        ? await sandbox.prepareResultStorage(argv, { ...policy, mode: 'workspace-write' }, controller.signal)
        : await sandbox?.confine(argv, { ...policy, mode: 'workspace-write' }, controller.signal)
      if (!confined || !['full', 'partial'].includes(confined.enforcement) || !confined.argv.length) throw new Error('Cleanup confinement unavailable')
      if (process.platform === 'win32') {
        const location = windowsCacheLocation(confined.argv)
        if (location?.root !== storage.root || location?.windowsWriteSid !== storage.windowsWriteSid) throw new Error('Cleanup cache grant changed')
      }
      argv = exposePosixCache(confined.argv, storage)
    }
    const latest = policyService?.resolve({ session })
    if (!latest || !sameAuthority(latest, policy)
      || (process.platform === 'win32' && latest?.sessionId !== session.id)) throw new Error('Cleanup authority changed')
    const envelope = workerEnvelope('ptc', { root: policy.workspaceRoot, scope: session.id, tool: 'result', args: { action: 'purge' }, read_only: false }, 5000, storage)
    const handle = subprocess.spawn({ argv, cwd: policy.workspaceRoot, stdio: { stdin: { data: JSON.stringify(envelope) }, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1000, signal: controller.signal })
    const outcome = await handle.done, output = handle.collected.stdout.readFrom(0)
    const value: unknown = JSON.parse(output.text)
    if (outcome.exitCode !== 0 || outcome.signal || output.lossy || !value || typeof value !== 'object'
      || !('status' in value) || value.status !== 'completed') throw new Error('Cache purge did not complete')
  } finally { clearTimeout(timer) }
}
export async function resultStorage(ctx: StorageHost, session: ResultSession, scope: unknown, file: string,
  tool: string, policy: SandboxExecutionPolicy, denyRoots: string[], denyNames: boolean,
  signal?: AbortSignal, confined?: ConfinedArgv, admission?: () => boolean): Promise<WorkerStorage | undefined> {
  if (admission && !admission()) return undefined
  const nonce = resultSessionNonce(ctx, session), key = digest([session.id, policy.workspaceRoot, nonce])
  const owner = ctx.root ?? ctx
  let cache = locations.get(owner)
  if (!cache) { cache = new Map(); locations.set(owner, cache) }
  let location = cache.get(key)
  if (process.platform === 'win32') {
    if (!location && policy.mode !== 'read-only') {
      if (policy.sessionId !== session.id) return undefined
      // A cache-only host capability may prepare private temp storage in full access.
      // Legacy confinement also changes workspace ACLs, so it is never a cache fallback there.
      const cachePolicy = { ...policy, mode: 'workspace-write' as const }
      if (!confined) {
        const sandbox = ctx.get('sandbox')
        if (!sandbox) return undefined
        if (admission && !admission()) return undefined
        if (sandbox.prepareResultStorage) confined = await sandbox.prepareResultStorage([file], cachePolicy, signal)
        else {
          // DSH 0.2.2 exposes session temp grants through confine(), not a cache-only API.
          // Never narrow a full-access request merely to acquire cache storage.
          if (policy.mode === 'danger-full-access' || (policy.additionalWritableRoots?.length ?? 0) > 0) return undefined
          await prepareWorkspace(cachePolicy)
          if (admission && !admission()) return undefined
          confined = await sandbox.confine([file], cachePolicy, signal)
        }
        if (admission && !admission()) return undefined
      }
      if (!['full', 'partial'].includes(confined.enforcement)) return undefined
      location = windowsCacheLocation(confined.argv)
    }
  } else {
    if (admission && !admission()) return undefined
    // An external reclaimer or the result-cache sweep may have removed the root since the last
    // call; never hand a stale path to the worker. A read-only call simply loses the cache.
    if (location !== undefined && !fs.existsSync(location.root)) { location = undefined; cache.delete(key) }
    location ??= posixCacheLocation(key, policy.mode !== 'read-only')
  }
  if (admission && !admission()) return undefined
  if (!location) return undefined
  if (process.platform === 'win32' && confined && policy.mode !== 'read-only') {
    const current = windowsCacheLocation(confined.argv)
    if (current?.root !== location.root || current?.windowsWriteSid !== location.windowsWriteSid) throw new Error('Session cache grant changed')
  }
  const known = cache.has(key)
  cache.set(key, location)
  const root = location.root
  // Register the root in the durable ledger before any caller can use it: a crash between the
  // create above and this write would still leave a reclaimable directory, and a cleanup that
  // fails later must not lose the only name that can address it (#714 mechanism 3). A root that
  // was recreated after an external removal is registered again.
  if (!known) {
    registerCleanupRoot(root, { sessionHeading: digest(session.id), workspaceRoot: policy.workspaceRoot })
    markCleanupRootLive(root)
  }
  const storage: WorkerStorage = { ...location, authorityId: digest([nonce, policy.mode, policy.workspaceRoot, policy.additionalWritableRoots ?? [], denyRoots, denyNames]), allowedTools: currentTools(ctx, scope, tool) }
  registerResultCleanup(ctx, session, key, async () => {
    try { await purge(ctx, session, file, storage, policy) }
    finally { cache.delete(key); releaseCleanupRootLive(root) }
  }, root)
  return storage
}
