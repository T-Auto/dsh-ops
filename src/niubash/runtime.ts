/** Native shell adapter. The compiled distribution inventory is the only trust anchor. */
import { NIUBASH_FACES } from './faces.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { NIUBASH_PACKAGE_PATH, NIUBASH_HOME_PATH, verifyNiubashTreeAsync, verifyNiubashTree, NIUBASH_EXECUTION_DIRECTORIES, NIUBASH_PIN, niubashExecutionReceipt } from '../cli/niubash-payload.js'

const unavailable = (detail: string): Error => new Error(`EXECUTOR_UNAVAILABLE: Niubash payload verification failed: ${detail}. Restore the complete pinned v1.5.0 portable tree; this is not a user authorization denial. Do not bypass confinement or fall back to another shell.`)

export function isNiubashExecutable(file: string): boolean {
  return path.basename(file).toLowerCase() === 'niu.exe'
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

/** Each call gets a new, verified execution copy: upstream startup must not mutate package/home
 * sources. Precreate only its documented dev/shm directories so read-only startup need not write.
 * No execution copy is reused or trusted after a command. The outer host still owns confinement.
 */
export async function prepareNiubash(file: string, inheritedPath = process.env.PATH ?? process.env.Path ?? '', signal: AbortSignal) {
  signal.throwIfAborted()
  if (!path.isAbsolute(file) || !isNiubashExecutable(file)) throw unavailable('expected an absolute niu.exe path')
  await verifyNiubashTreeAsync(path.dirname(file), false, signal)
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-ops-niu-exec-'))
  const dispose = () => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  try {
    await fs.promises.cp(path.dirname(file), root, { recursive: true, dereference: false,
      filter() { signal.throwIfAborted(); return true } })
    const executable = await verifyNiubashTreeAsync(root, false, signal)
    for (const directory of NIUBASH_EXECUTION_DIRECTORIES) {
      signal.throwIfAborted()
      await fs.promises.mkdir(path.join(root, directory), { recursive: true })
    }
    for (const face of NIUBASH_FACES) {
      signal.throwIfAborted()
      const relative = `winuxcmd/usr/bin/${face}.exe`
      if (!Object.hasOwn(NIUBASH_PIN.files, relative)) await fs.promises.copyFile(path.join(root, 'winuxcmd/usr/bin/winuxcmd.exe'), path.join(root, relative), fs.constants.COPYFILE_EXCL)
    }
    await fs.promises.writeFile(path.join(root, 'execution-provenance.json'), JSON.stringify(niubashExecutionReceipt()), { signal })
    await verifyNiubashTreeAsync(root, true, signal)
    return { file: executable, env: { NIU_ROOT: path.join(root, 'winuxcmd'),
      WINUXCMD_PATH: path.join(root, 'winuxcmd/usr/bin/winuxcmd.exe'), NIU_SKIP_WINUXCMD_ACTIVATION: '1',
      PATH: [root, path.join(root, 'bin'), path.join(root, 'winuxcmd/usr/bin'), path.join(root, 'winuxcmd/bin'), inheritedPath].filter(Boolean).join(path.delimiter) },
      async verify() { await verifyNiubashTreeAsync(path.dirname(file), false, signal); await verifyNiubashTreeAsync(root, true, signal) }, dispose }
  } catch (error) { await dispose().catch(cleanup => console.error(`dsh-ops: Niubash staging cleanup failed: ${cleanup}`)); throw error }
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
