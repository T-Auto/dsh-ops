/** Native shell adapter. The compiled distribution inventory is the only trust anchor. */
import { NIUBASH_FACES } from './faces.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  NIUBASH_EXECUTION_DIRECTORIES,
  NIUBASH_HOME_PATH,
  NIUBASH_PACKAGE_PATH,
  NIUBASH_PIN,
  NIUBASH_RECEIPT,
  niubashExecutionReceipt,
  verifyNiubashTree,
  verifyNiubashTreeAsync,
  verifyNiubashTreeStat,
} from '../cli/niubash-payload.js'
import {
  cloneExecutionTree,
  readTree,
  verifyExecutionReceipt,
  verifyTreeStat,
  type TreeExpectation,
} from './execution-tree.js'
import { releaseShared, sealReadOnly, sealShared, sealTree, unsealTree } from './seal.js'

const unavailable = (detail: string): Error => new Error(`EXECUTOR_UNAVAILABLE: Niubash payload verification failed: ${detail}. Restore the complete pinned v1.5.0 portable tree; this is not a user authorization denial. Do not bypass confinement or fall back to another shell.`)

const EXECUTION_RECEIPT = 'execution-provenance.json'
const EXECUTION_ROOT_PREFIX = 'dsh-ops-niu-exec-'
const WINUXCMD_EXECUTABLE = 'winuxcmd/usr/bin/winuxcmd.exe'

/** argv0 faces are hardlinks of winuxcmd.exe; the compiled inventory names only its own members. */
const PINNED_FILES: Readonly<Record<string, string>> = NIUBASH_PIN.files
const EXECUTION_DERIVED: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  NIUBASH_FACES.map(face => `winuxcmd/usr/bin/${face}.exe`)
    .filter(name => !Object.hasOwn(PINNED_FILES, name))
    .map(name => [name, WINUXCMD_EXECUTABLE])))

/** The complete directory set one execution tree may contain. */
const EXECUTION_DIRECTORIES: readonly string[] = Object.freeze(
  [...new Set([...NIUBASH_PIN.directories, ...NIUBASH_EXECUTION_DIRECTORIES])])

/** The verified per-call tree handed to the shell layer. */
export interface NiubashRuntime {
  file: string
  env: NodeJS.ProcessEnv
  /** Stat-only recheck immediately before spawn (full hashes only under NIUBASH_VERIFY=deep). */
  verify(): Promise<void>
  /** Re-apply the read-only seal after a test or an operator unsealed the tree. */
  seal(): Promise<void>
  /** Clear the seal so a caller may inspect or delete the shared inodes. */
  unseal(): Promise<void>
  dispose(): Promise<void>
}

export function isNiubashExecutable(file: string): boolean {
  return path.basename(file).toLowerCase() === 'niu.exe'
}

/** The directory created below a volume root when the temp directory is on another volume. */
const SAME_VOLUME_EXEC_DIRECTORY = 'dsh-ops-exec'

/** A real drive root (`c:\`), the only shape a drive-letter comparison may trust. */
const DRIVE_ROOT = /^[a-z]:[\\/]$/u

/**
 * The root component of a path, lowercased so `C:\` and `c:\` compare equal.
 * On POSIX this is always `/`.
 */
function volumeRoot(pathname: string): string {
  return path.parse(path.resolve(pathname)).root.toLowerCase()
}

/**
 * Compare two already-reduced volume roots.
 *
 * A path can only prove a shared volume when both roots are the same real drive
 * root (or POSIX `/`). A UNC share or an extended-length prefix never matches the
 * drive pattern, so it is treated as same-volume only when the roots are literally
 * identical: that keeps the caller from inventing a root on a network share.
 * Exported so a test can prove the rule with synthetic roots on any platform.
 */
export function sameVolumeRoots(left: string, right: string): boolean {
  if (left !== right) return false
  return path.sep === '/' || DRIVE_ROOT.test(left) || left.startsWith('\\\\')
}

/**
 * Whether two paths share a volume — the precondition `fs.link` needs.
 *
 * A directory mounted from a second volume below the same drive letter still
 * reads as same-volume here; the clone then falls back to `copy`, which costs time
 * but never correctness.
 */
export function sameVolume(left: string, right: string): boolean {
  return sameVolumeRoots(volumeRoot(left), volumeRoot(right))
}

/**
 * Where a per-call execution tree goes when the temp directory is on another
 * volume. `rootOf` is injectable so a test can prove the decision with synthetic
 * drive roots instead of depending on the machine's real layout.
 *
 * The directory name is fixed and readable. Separating accounts by name bought
 * nothing: the ownership check already rejects a directory this account does not
 * own, and a hashed account name would only hide a user name the profile path
 * (`C:\Users\<name>`) already shows in plain text — while making the directory
 * unreadable to whoever has to debug a leftover tree.
 */
export function executionRootFor(source: string, temporary: string,
  rootOf: (pathname: string) => string = volumeRoot): string {
  const sourceRoot = rootOf(source)
  return sameVolumeRoots(sourceRoot, rootOf(temporary)) ? temporary : path.join(sourceRoot, SAME_VOLUME_EXEC_DIRECTORY)
}

/**
 * The parent directory the per-call execution tree is created below.
 *
 * `DSH_OPS_EXEC_ROOT` moves it to an antivirus allow-list or a specific volume
 * (issue #715) and always wins when set. Otherwise the OS temporary directory
 * is used — **unless the payload lives on another volume**: `fs.link` then fails
 * with `EXDEV` and the clone silently falls back to copying 786 MiB per call.
 * In that case a private directory on the payload's volume is returned, so the
 * default configuration still takes the hardlink path.
 *
 * Whether the returned directory can actually be created is decided by
 * {@link ensureExecutionRoot}, which falls back to `os.tmpdir()` only when this
 * function derived the root itself.
 */
export function niubashExecutionRootParent(env: NodeJS.ProcessEnv = process.env, source?: string): string {
  const configured = env.DSH_OPS_EXEC_ROOT?.trim()
  if (configured !== undefined && configured !== '') return path.resolve(configured)
  const temporary = os.tmpdir()
  return source === undefined ? temporary : executionRootFor(source, temporary)
}

/** Whether `NIUBASH_VERIFY=deep` asks for the per-call full re-hash escape hatch. */
export function niubashDeepVerification(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NIUBASH_VERIFY === 'deep'
}

/** Resolve a path to its physical form, following links in the ancestors that already exist. */
async function physicalPath(pathname: string): Promise<string> {
  try {
    return await fs.promises.realpath(pathname)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(pathname)
    if (parent === pathname) return pathname
    return path.join(await physicalPath(parent), path.basename(pathname))
  }
}

function isInside(relative: string): boolean {
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Reject an execution root inside the payload: it would pollute the package tree
 * it verifies. Both the written path and its physical resolution are compared, so
 * a junction/symlink root cannot hide the payload directory inside it.
 */
async function assertExecutionRoot(parent: string, source: string): Promise<void> {
  const physicalParent = await physicalPath(parent)
  const physicalSource = await physicalPath(source)
  for (const [candidate, base] of [[parent, source], [physicalParent, physicalSource],
    [physicalParent, source], [parent, physicalSource]] as const) {
    if (isInside(path.relative(base, candidate))) {
      throw new Error(`DSH_OPS_EXEC_ROOT must not be inside the Niubash payload: ${parent}`)
    }
  }
}

/**
 * Reject an execution root below the session workspace.
 *
 * On Windows the sandbox's workspace-write grant writes an inheritable Low
 * mandatory label on the workspace root, and Windows propagates it to the
 * existing subtree. A clone created there therefore marks the payload's shared
 * inodes Low (hardlink clone) or inherits the label itself (copy clone), and
 * Windows launches a process at its image's mandatory label: every later
 * `niu.exe` taken from that payload runs at Low integrity, where writes to
 * Medium-integrity paths — the workspace's own siblings included — are refused.
 * The clone must stay outside the workspace. Both the written path and its
 * physical resolution are compared, as for the payload check.
 */
async function assertOutsideWorkspace(parent: string, workspace: string): Promise<void> {
  const physicalParent = await physicalPath(parent)
  const physicalWorkspace = await physicalPath(workspace)
  // Windows compares paths case-insensitively; `path.relative` alone would let
  // `C:\Work` and `c:\work` name two different trees.
  const windows = process.platform === 'win32'
  for (const [candidate, base] of [[parent, workspace], [physicalParent, physicalWorkspace],
    [physicalParent, workspace], [parent, physicalWorkspace]] as const) {
    const relative = windows ? path.relative(base.toLowerCase(), candidate.toLowerCase()) : path.relative(base, candidate)
    if (isInside(relative)) {
      throw new Error(`the Niubash execution root must not be inside the session workspace (the workspace-write grant labels that subtree; set DSH_OPS_EXEC_ROOT outside it): ${parent}`)
    }
  }
}

/**
 * Reject a directory that is not a real directory, and — unless the platform or
 * the caller says otherwise — one this account does not own.
 *
 * A clone below a volume root is only as private as that root: a pre-created
 * junction, or a directory another account owns, would expose or redirect it.
 * Windows exposes no cheap owner check (`lstat().uid` is always 0 there), so the
 * type and link checks are the whole boundary on that platform; POSIX compares
 * the owner directly. `requireOwner` is false only for the OS temp directory,
 * which belongs to root on POSIX and is handed out by the platform on purpose.
 */
async function assertPrivateExecutionRoot(directory: string, requireOwner = true, acceptShared = false): Promise<void> {
  const info = await fs.promises.lstat(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) throw Error(`The execution root must be a real directory, not a link or a file: ${directory}`)
  if (!requireOwner || process.platform === 'win32' || process.getuid === undefined) return
  if (info.uid === process.getuid()) return
  // An operator-configured root the platform already shares — a 1777 `/tmp` or
  // `/dev/shm` — is used as-is. Failing it instead would reject the documented way
  // to point the clone at a tmpfs, and the operator named that directory on
  // purpose. Every other foreign owner still fails closed.
  if (acceptShared && (info.mode & 0o002) !== 0) return
  throw Error(`The execution root must be owned by the current account: ${directory}`)
}

/** Fallback roots already reported, so a permanently unusable volume root warns once. */
const reportedRootFallbacks = new Set<string>()

/**
 * Whether two paths name the same directory, folding case on Windows.
 *
 * `realpath` is consulted first because a symbolic link is enough to hide the
 * identity: macOS reports its temp directory as `/var/folders/...` while `/var`
 * links to `/private/var`, so a string comparison would call the very same
 * directory two different roots.
 */
export async function isSameDirectory(left: string, right: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> => {
    try { return await fs.promises.realpath(value) } catch { return path.resolve(value) }
  }
  const [a, b] = await Promise.all([canonical(left), canonical(right)])
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Create the execution-root parent and return the directory actually used.
 *
 * A same-volume root below a volume root is not always writable, and the payload
 * volume may be read-only. An **automatically derived** root falls back to the OS
 * temporary directory, where the clone copies instead of linking; that fallback is
 * reported because it costs ~786 MiB per call. An **operator-configured** root
 * never falls back: silently ignoring `DSH_OPS_EXEC_ROOT` would move the clone
 * into the temporary directory the configuration exists to avoid (#715). The
 * containment check sits inside the same try so a derived root that overlaps the
 * payload also recovers instead of failing the whole call. A root below the
 * session workspace is refused the same way — operator-configured loudly, a
 * derived one by falling back — because the workspace-write grant labels that
 * subtree and would mark the payload Low.
 */
async function ensureExecutionRoot(parent: string, source: string, configured: boolean, workspaceRoot?: string): Promise<string> {
  const temporary = os.tmpdir()
  const parentIsOsTemp = await isSameDirectory(parent, temporary)
  // The Low label is a Windows mandatory-integrity mechanism; POSIX has no
  // equivalent, so a workspace check there would reject harmless roots.
  const guardedWorkspace = process.platform === 'win32' ? workspaceRoot : undefined
  try {
    await assertExecutionRoot(parent, source)
    if (guardedWorkspace !== undefined) await assertOutsideWorkspace(parent, guardedWorkspace)
    await fs.promises.mkdir(parent, { recursive: true })
    // The OS temp directory keeps the platform's own owner — POSIX `/tmp` belongs
    // to root — so only its shape can be checked there. Every other root, an
    // operator-configured one included, must also be owned by this account; only a
    // deliberately shared system directory the operator named stays usable.
    await assertPrivateExecutionRoot(parent, !parentIsOsTemp, configured)
    return parent
  } catch (error) {
    if (configured || parentIsOsTemp) throw error
    // One warning per root, capped: a permanently unusable volume root must not
    // turn into one stderr line per shell command, and the set must not grow
    // without bound across a long-lived host.
    if (!reportedRootFallbacks.has(parent)) {
      if (reportedRootFallbacks.size >= 8) reportedRootFallbacks.clear()
      reportedRootFallbacks.add(parent)
      console.error(`dsh-ops: could not use the same-volume execution root ${parent}: ${error instanceof Error ? error.message : String(error)}; falling back to ${temporary}, where the clone copies the payload instead of linking it`)
    }
    // A temp directory that still contains the payload cannot host the clone;
    // that is a broken installation, not a reason to keep guessing.
    await assertExecutionRoot(temporary, source)
    if (guardedWorkspace !== undefined) {
      // Falling back into a workspace that already rejected the derived root
      // would poison the payload the same way; there is no safe root left.
      try { await assertOutsideWorkspace(temporary, guardedWorkspace) }
      catch {
        throw new Error(`no safe Niubash execution root: the OS temporary directory ${temporary} is also inside the session workspace ${guardedWorkspace}; set DSH_OPS_EXEC_ROOT to a directory outside the workspace, on another volume if necessary`)
      }
    }
    await fs.promises.mkdir(temporary, { recursive: true })
    return temporary
  }
}

/** Stat-only or deep source verification, with the deep escape hatch applied consistently. */
async function verifySourceTree(source: string, deep: boolean, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (deep) await verifyNiubashTreeAsync(source, signal)
  else await verifyNiubashTreeStat(source, signal)
}

/** Deep-mode complement: rehash every payload byte of the execution clone, faces included. */
async function verifyExecutionTreeDeep(root: string, sizes: Record<string, number>, signal: AbortSignal): Promise<void> {
  const { files } = await readTree(root, { signal })
  for (const [name, stat] of files) {
    signal.throwIfAborted()
    if (name === EXECUTION_RECEIPT || name === NIUBASH_RECEIPT) continue
    const expected = Object.hasOwn(PINNED_FILES, name) ? PINNED_FILES[name]
      : Object.hasOwn(EXECUTION_DERIVED, name) ? PINNED_FILES[WINUXCMD_EXECUTABLE] : undefined
    if (expected === undefined || stat.size !== sizes[name]) throw Error(`Niubash execution tree checksum mismatch: ${name}`)
    const actual = createHash('sha256').update(await fs.promises.readFile(path.join(root, name), { signal })).digest('hex')
    if (actual !== expected) throw Error(`Niubash execution tree checksum mismatch: ${name}`)
  }
}

export interface NativeShellRuntime { file: string; env: NodeJS.ProcessEnv }
/** Verify the immutable source on every selection and invocation, never an mtime cache or receipt. */
export function verifiedNiubash(file: string, inheritedPath = process.env.PATH ?? process.env.Path ?? ''): NativeShellRuntime {
  try {
    if (!path.isAbsolute(file) || !isNiubashExecutable(file)) throw unavailable('expected an absolute niu.exe path')
    const root = path.dirname(file)
    verifyNiubashTree(root)
    return { file, env: { NIU_ROOT: path.join(root, 'winuxcmd'), PATH: [root, path.join(root, 'bin'), path.join(root, 'winuxcmd', 'usr', 'bin'),
      path.join(root, 'winuxcmd', 'bin'), inheritedPath].filter(Boolean).join(path.delimiter) } }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EXECUTOR_UNAVAILABLE:')) throw error
    throw unavailable(error instanceof Error ? error.message : String(error))
  }
}

/** Inputs the shell layer supplies that the payload path alone cannot answer. */
export interface PrepareNiubashOptions {
  /**
   * The session workspace root. The execution tree is never created below it:
   * the host's workspace-write grant writes an inheritable Low mandatory label
   * there, and a clone below that label would mark the payload's inodes Low.
   */
  workspaceRoot?: string
}

/**
 * Each call gets a new, verified execution clone: upstream startup must not
 * mutate package/home sources. The clone is hardlinked from the immutable
 * payload (zero copied data bytes) and sealed read-only while the command runs;
 * only the six documented state directories are writable. Verification before
 * spawn is stat-only unless `NIUBASH_VERIFY=deep` explicitly asks for hashes.
 * No execution copy is reused or trusted after a command. The outer host still
 * owns confinement.
 */
export async function prepareNiubash(file: string, inheritedPath = process.env.PATH ?? process.env.Path ?? '',
  signal: AbortSignal, options: PrepareNiubashOptions = {}): Promise<NiubashRuntime> {
  signal.throwIfAborted()
  if (!path.isAbsolute(file) || !isNiubashExecutable(file)) throw unavailable('expected an absolute niu.exe path')
  const source = path.dirname(file)
  const deep = niubashDeepVerification()
  await verifySourceTree(source, deep, signal)
  const configuredRoot = process.env.DSH_OPS_EXEC_ROOT?.trim()
  const parent = niubashExecutionRootParent(process.env, source)
  const root = await fs.promises.mkdtemp(path.join(
    await ensureExecutionRoot(parent, source, configuredRoot !== undefined && configuredRoot !== '',
      options.workspaceRoot === undefined ? undefined : path.resolve(options.workspaceRoot)), EXECUTION_ROOT_PREFIX))
  // Sealing is per inode, so concurrent calls for the same payload share one
  // reference count; disposal of the first must not unseal a sibling's tree.
  let released = false
  const dispose = async () => {
    if (released) return
    released = true
    await releaseShared(source, root)
  }
  try {
    const clone = await cloneExecutionTree({ source, root, signal,
      files: NIUBASH_PIN.sizes, derived: EXECUTION_DERIVED,
      directories: NIUBASH_PIN.directories, stateDirectories: NIUBASH_EXECUTION_DIRECTORIES, extra: [NIUBASH_RECEIPT] })
    const immutable = Object.keys(clone.sizes).map(name => path.join(root, name))
    const writable = [...NIUBASH_EXECUTION_DIRECTORIES.map(directory => path.join(root, directory)), root]
    const sealReadOnlyNow = () => sealTree({ root, files: immutable, writableDirectories: writable })
    const receiptFile = path.join(root, EXECUTION_RECEIPT)
    // The receipt names the seal that protects the payload; it is written after the
    // tree is sealed and then sealed itself with the same read-only rule.
    const sealed = await sealShared(source, { root, files: immutable, writableDirectories: writable })
    const receipt = niubashExecutionReceipt({ mode: clone.mode, seal: sealed.level, diagnostics: sealed.diagnostics,
      ...(clone.fallback === undefined ? {} : { cloneFallback: clone.fallback }) })
    const receiptText = JSON.stringify(receipt)
    await fs.promises.writeFile(receiptFile, receiptText)
    await sealReadOnly([receiptFile])
    const sizes = { ...clone.sizes, [EXECUTION_RECEIPT]: Buffer.byteLength(receiptText) }
    const links = { ...clone.links, [EXECUTION_RECEIPT]: (await fs.promises.lstat(receiptFile)).nlink }
    const expectation: TreeExpectation = { sizes, links, directories: EXECUTION_DIRECTORIES, sealed: true }
    const verifyNow = async () => {
      await verifySourceTree(source, deep, signal)
      // Defence in depth: re-apply the read-only seal immediately before the stat
      // check, so a sibling's late disposal (or any external attribute reset)
      // cannot make a live tree look unsealed. The ACL already blocks writes.
      await sealReadOnly([...immutable, receiptFile])
      await verifyTreeStat({ root, ...expectation, signal })
      await verifyExecutionReceipt(root, EXECUTION_RECEIPT, receipt)
      if (deep) await verifyExecutionTreeDeep(root, sizes, signal)
    }
    await verifyNow()
    return {
      file: path.join(root, NIUBASH_PIN.executable),
      env: { NIU_ROOT: path.join(root, 'winuxcmd'), WINUXCMD_PATH: path.join(root, WINUXCMD_EXECUTABLE),
        NIU_SKIP_WINUXCMD_ACTIVATION: '1',
        PATH: [root, path.join(root, 'bin'), path.join(root, 'winuxcmd/usr/bin'), path.join(root, 'winuxcmd/bin'), inheritedPath].filter(Boolean).join(path.delimiter) },
      verify: verifyNow,
      seal: async () => { await sealReadOnlyNow(); await sealReadOnly([receiptFile]) },
      unseal: async () => { await unsealTree(root) },
      dispose,
    }
  } catch (error) {
    await dispose().catch(cleanup => console.error(`dsh-ops: Niubash staging cleanup failed: ${cleanup}`))
    throw error
  }
}

/** Cleanup is diagnostic only: it must never replace a command's outcome. */
export async function disposeNiubash(dispose: (() => Promise<void>) | undefined, warn: (message: string) => void) {
  try { await dispose?.() } catch (error) { warn(`Niubash cleanup failed: ${error}`) }
}

/** Immutable distribution locations; generated execution state lives only in per-call temp trees. */
export function niubashCandidates(bundleRoot: string, env: NodeJS.ProcessEnv): { file: string; source: string }[] {
  const home = env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return [
    { file: path.join(home, NIUBASH_HOME_PATH, 'niu.exe'), source: 'provisioned' },
    { file: path.join(bundleRoot, NIUBASH_PACKAGE_PATH, 'niu.exe'), source: 'bundled' },
  ]
}