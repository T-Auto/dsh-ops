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

/**
 * The parent directory the per-call execution tree is created below.
 *
 * `DSH_OPS_EXEC_ROOT` moves it to an antivirus allow-list or a specific volume
 * (issue #715); the default stays the OS temporary directory. The value is
 * resolved against the process working directory and created on demand.
 */
export function niubashExecutionRootParent(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_OPS_EXEC_ROOT?.trim()
  return configured === undefined || configured === '' ? os.tmpdir() : path.resolve(configured)
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

/**
 * Each call gets a new, verified execution clone: upstream startup must not
 * mutate package/home sources. The clone is hardlinked from the immutable
 * payload (zero copied data bytes) and sealed read-only while the command runs;
 * only the six documented state directories are writable. Verification before
 * spawn is stat-only unless `NIUBASH_VERIFY=deep` explicitly asks for hashes.
 * No execution copy is reused or trusted after a command. The outer host still
 * owns confinement.
 */
export async function prepareNiubash(file: string, inheritedPath = process.env.PATH ?? process.env.Path ?? '', signal: AbortSignal): Promise<NiubashRuntime> {
  signal.throwIfAborted()
  if (!path.isAbsolute(file) || !isNiubashExecutable(file)) throw unavailable('expected an absolute niu.exe path')
  const source = path.dirname(file)
  const deep = niubashDeepVerification()
  await verifySourceTree(source, deep, signal)
  const parent = niubashExecutionRootParent()
  await assertExecutionRoot(parent, source)
  await fs.promises.mkdir(parent, { recursive: true })
  const root = await fs.promises.mkdtemp(path.join(parent, EXECUTION_ROOT_PREFIX))
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