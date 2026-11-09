/**
 * Read-only sealing of the immutable Niubash payload.
 *
 * A per-call execution tree is a hardlink clone: every name in it shares one
 * immutable inode with the source payload. Sealing therefore protects the
 * shared inode, not only the execution names:
 *
 * · `chmod` removes every write bit. On Windows this toggles the READONLY
 *   attribute, the only mode bit Node exposes there; a writable file whose
 *   hardened ACL was cleared still cannot be deleted while READONLY is set.
 * · On Windows one recursive `icacls` invocation additionally denies the write
 *   rights (FILE_WRITE_DATA, FILE_APPEND_DATA, FILE_WRITE_ATTRIBUTES) and the
 *   delete rights (DELETE, FILE_DELETE_CHILD) to Everyone. WRITE_DAC is left
 *   alone, so the owner can always unseal, delete or upgrade. Invoking icacls
 *   once for the tree instead of once per file matters: 313 files would be
 *   thousands of milliseconds of process creation per call.
 *
 * Sealing degrades explicitly. When `icacls` is unavailable or fails, the
 * READONLY attribute is still applied and the caller records the degraded level
 * and the diagnostics in the execution receipt instead of failing silently.
 *
 * Sealing applies to the shared inode, so every removal path must unseal first:
 * {@link removeSealedTree} for disposal and {@link unsealDirectorySync} for
 * provisioning, `--force` replacement, upgrade and uninstall.
 *
 * @module dsh-ops/niubash/seal
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** How strongly an immutable file was sealed. */
export type SealLevel = 'readonly+acl' | 'readonly'

/** The outcome of one sealing pass, recorded in the execution receipt. */
export interface SealResult {
  level: SealLevel
  diagnostics: string[]
}

/** The filesystem calls sealing needs, injectable so a synthetic tree can test it. */
export interface SealFileOps {
  chmod(file: string, mode: number): Promise<void>
  lstat(file: string): Promise<fs.Stats>
}

export const nodeSealOps: SealFileOps = {
  chmod: (file, mode) => fs.promises.chmod(file, mode),
  lstat: (file) => fs.promises.lstat(file),
}

/** Runs one batched icacls invocation; returns its diagnostics (empty on success). */
export type AclRunner = (args: readonly string[]) => Promise<readonly string[]>

export interface SealOptions {
  /** Defaults to `process.platform`; a test can name `win32` to exercise the ACL path. */
  platform?: NodeJS.Platform
  /** Whether to apply the Windows deny ACL. Defaults to true on Windows. */
  acl?: boolean
  ops?: Partial<SealFileOps>
  runAcl?: AclRunner
}

export interface SealTreeRequest extends SealOptions {
  /** The execution root: one recursive deny covers every object below it. */
  root: string
  /** Every immutable file that must lose its write bits. */
  files: readonly string[]
  /** Directories that must stay writable after the recursive deny (state dirs and the root). */
  writableDirectories?: readonly string[]
}

const ACL_PRINCIPAL = '*S-1-1-0'
// FILE_WRITE_ATTRIBUTES is deliberately NOT denied: it lets a later pass re-apply
// READONLY (or unseal) without racing the ACL, and WD/AD/DE/DC already block data
// writes, appends, renames and deletion.
const ACL_DENY_RIGHTS = '(WD,AD,DE,DC)'

/** Whether a mode carries no write bit (the READONLY attribute on Windows). */
export function isSealedMode(mode: number): boolean {
  return (mode & 0o222) === 0
}

function mergeOps(options: SealOptions): SealFileOps {
  return { ...nodeSealOps, ...options.ops }
}

function aclEnabled(options: SealOptions): boolean {
  const platform = options.platform ?? process.platform
  return platform === 'win32' && (options.acl ?? true)
}

function denyArguments(root: string): string[] {
  return [root, '/deny', `${ACL_PRINCIPAL}:${ACL_DENY_RIGHTS}`, '/T', '/C', '/Q']
}

function removeArguments(target: string, recursive: boolean): string[] {
  return [target, '/remove:d', ACL_PRINCIPAL, ...(recursive ? ['/T'] : []), '/C', '/Q']
}

function tail(text: string): string {
  return text.trim().split(/\r?\n/u).filter(Boolean).slice(-2).join(' | ')
}

/** Run one icacls invocation without ever throwing: failures are diagnostics. */
async function runIcacls(args: readonly string[]): Promise<readonly string[]> {
  return await new Promise((resolve) => {
    let settled = false
    let stderr = ''
    const finish = (value: readonly string[]) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const child = spawn('icacls.exe', [...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error: Error) => finish([`icacls could not run: ${error.message}`]))
    child.once('close', (code: number | null) => finish(code === 0 ? []
      : [`icacls ${args[0] ?? ''} exited with ${code ?? 'signal'}: ${tail(stderr)}`]))
  })
}

/** The synchronous form, for provisioning and uninstall paths that are synchronous today. */
function runIcaclsSync(args: readonly string[]): string | undefined {
  const result = spawnSync('icacls.exe', [...args], { windowsHide: true, encoding: 'utf8' })
  if (result.error !== undefined && result.error !== null) return `icacls could not run: ${result.error.message}`
  if (result.status !== 0) return `icacls ${args[0] ?? ''} exited with ${result.status}: ${tail(String(result.stderr ?? ''))}`
  return undefined
}

/**
 * Make every named file read-only, deduplicated by inode so the 153 argv0 faces
 * sharing `winuxcmd.exe` cost one chmod instead of 153.
 */
export async function sealReadOnly(files: readonly string[], options: SealOptions = {}): Promise<void> {
  const ops = mergeOps(options)
  for (const file of files) {
    let stat = await ops.lstat(file)
    if (!isSealedMode(stat.mode)) {
      await ops.chmod(file, stat.mode & ~0o222)
      stat = await ops.lstat(file)
    }
    if (!isSealedMode(stat.mode)) {
      // One explicit retry: Windows can drop a just-set READONLY attribute when a
      // scanner or another handle is rewriting attributes at the same moment.
      await ops.chmod(file, 0o444)
      if (!isSealedMode((await ops.lstat(file)).mode)) throw Error(`Niubash tree member could not be sealed read-only: ${file}`)
    }
  }
}

/** Give the write bit back to every named file; a file that is already writable is left alone. */
export async function unsealFiles(files: readonly string[], options: SealOptions = {}): Promise<void> {
  const ops = mergeOps(options)
  // No inode-keyed deduplication here, unlike the seal path. Windows `stat.ino`
  // is not unique across distinct files: two unrelated members came back with the
  // same `dev:ino`, so the second was skipped and stayed read-only, which then made
  // the tree undeletable and left it behind in the temp directory. A repeated
  // `chmod` on a shared inode is harmless, so correctness wins over the saving.
  for (const file of files) {
    let stat
    try { stat = await ops.lstat(file) } catch (error) { if (isMissing(error)) continue; throw error }
    if (!isSealedMode(stat.mode)) continue
    await ops.chmod(file, stat.mode | 0o200)
  }
}

/**
 * Seal one execution tree: chmod every immutable file, then (on Windows) deny
 * write and delete rights across the tree in one icacls call and re-open only
 * the writable state directories and the root the receipt is written into.
 */
export async function sealTree(request: SealTreeRequest): Promise<SealResult> {
  const result: SealResult = { level: 'readonly', diagnostics: [] }
  await sealReadOnly(request.files, request)
  if (!aclEnabled(request)) return result
  const run = request.runAcl ?? runIcacls
  const denied = await run(denyArguments(request.root))
  if (denied.length > 0) {
    result.diagnostics.push(...denied)
    return result
  }
  const writable = [request.root, ...(request.writableDirectories ?? [])]
  const failures: string[] = []
  for (const directory of writable) {
    const failed = await run(removeArguments(directory, false))
    if (failed.length > 0) failures.push(...failed)
  }
  if (failures.length > 0) {
    // A deny that leaves a writable state directory closed would break legitimate
    // child writes; remove the whole deny again and report the degraded mode.
    const rolledBack = await run(removeArguments(request.root, true))
    result.diagnostics.push(...failures,
      'Niubash execution ACL could not keep the writable directories open; the deny was rolled back', ...rolledBack)
    return result
  }
  result.level = 'readonly+acl'
  return result
}

/**
 * Remove the deny ACL (when asked) and give every regular file below `directory`
 * its write bit back. Symlinks are never followed and never chmodded. The
 * diagnostics of the ACL step are returned for logging.
 */
export async function unsealTree(directory: string, options: SealOptions = {}): Promise<string[]> {
  const diagnostics: string[] = []
  try { await fs.promises.lstat(directory) } catch (error) { if (isMissing(error)) return diagnostics; throw error }
  if (aclEnabled(options)) diagnostics.push(...await (options.runAcl ?? runIcacls)(removeArguments(directory, true)))
  const files: string[] = []
  const collect = async (current: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await collect(file)
      else if (entry.isFile()) files.push(file)
    }
  }
  await collect(directory)
  await unsealFiles(files, options)
  return diagnostics
}

/**
 * Unseal and delete one execution tree, retrying once after a fresh unseal pass
 * when the first removal fails (a Windows handle or an antivirus scanner can
 * hold a name for a moment). A missing tree is a successful cleanup.
 */
export async function removeSealedTree(directory: string, options: SealOptions = {}): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await unsealTree(directory, options)
      await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      return
    } catch (error) {
      if (isMissing(error)) return
      failure = error
    }
  }
  throw failure instanceof Error ? failure : new Error(String(failure))
}

/**
 * Synchronous best-effort unseal, for the provisioning/uninstall paths that must
 * clear the shared inode's read-only attribute before replacing or deleting a
 * payload. Failures surface through the subsequent rm/rename error.
 */
export function unsealDirectorySync(directory: string, options: { platform?: NodeJS.Platform } = {}): void {
  let stat: fs.Stats
  try { stat = fs.lstatSync(directory) } catch (error) { if (isMissing(error)) return; throw error }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return
  if ((options.platform ?? process.platform) === 'win32') runIcaclsSync(removeArguments(directory, true))
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { walk(file); continue }
      if (!entry.isFile()) continue
      try {
        const stats = fs.lstatSync(file)
        if (isSealedMode(stats.mode)) fs.chmodSync(file, stats.mode | 0o200)
      } catch (error) { if (!isMissing(error)) throw error }
    }
  }
  walk(directory)
}

/**
 * One in-process reference count per immutable payload.
 *
 * Every execution tree shares the source inodes, so unsealing one tree also
 * unseals every other live tree for the same payload. Disposal therefore defers
 * the unseal and the removal until the last concurrent tree for that payload is
 * released: a full-access command must never get a writable window back through
 * a hardlink while a sibling command is still running. Operations are serialized
 * per payload so a seal cannot interleave with a release.
 *
 * The registry is per process. Two separate DSH hosts running the same payload
 * are not coordinated; the next call rebuilds a fresh clone and re-seals it, and
 * a privileged process can still clear the attribute. See the docs for that
 * residual boundary.
 */
const sharedSeals = new Map<string, { roots: Set<string>; pending: string[] }>()
const sealChains = new Map<string, Promise<unknown>>()

function serializeSeal<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = sealChains.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  sealChains.set(key, next.then(() => undefined, () => undefined))
  return next
}

/** Reserve a tree before cloning so sibling disposal cannot unseal it mid-preparation. */
export function retainShared(key: string, root: string): Promise<void> {
  return serializeSeal(key, async () => {
    const state = sharedSeals.get(key) ?? { roots: new Set<string>(), pending: [] }
    state.roots.add(root)
    sharedSeals.set(key, state)
  })
}

/** Seal one execution tree and count it against the shared payload's live trees. */
export function sealShared(key: string, request: SealTreeRequest): Promise<SealResult> {
  return serializeSeal(key, async () => {
    const result = await sealTree(request)
    const state = sharedSeals.get(key) ?? { roots: new Set<string>(), pending: [] }
    state.roots.add(request.root)
    sharedSeals.set(key, state)
    return result
  })
}

/** Release one execution tree; the last release unseals and removes every deferred tree. */
export function releaseShared(key: string, root: string, options: SealOptions = {}): Promise<void> {
  return serializeSeal(key, async () => {
    const state = sharedSeals.get(key)
    if (state === undefined) {
      // Even an unregistered tree (a preparation that failed before sealing) is
      // removed through the chain: its hardlinks may share the payload inodes, so
      // an uncoordinated unseal could race a sibling's seal or verification.
      await removeSealedTree(root, options)
      return
    }
    state.pending.push(root)
    // A clone that failed before sealShared registered it must not consume a
    // live sibling's reference or unseal its shared payload.
    state.roots.delete(root)
    if (state.roots.size > 0) return
    sharedSeals.delete(key)
    let failure: unknown
    for (const pending of state.pending) {
      try { await removeSealedTree(pending, options) } catch (error) { failure ??= error }
    }
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure))
  })
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}