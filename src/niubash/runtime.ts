/** Select a frozen payload once; commands execute it in place through the host sandbox. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { NIUBASH_FACES } from './faces.js'
import {
  NIUBASH_EXECUTION_DIRECTORIES, NIUBASH_HOME_PATH, NIUBASH_PACKAGE_PATH,
  NIUBASH_MANIFEST_SHA256, NIUBASH_PIN, NIUBASH_RECEIPT, verifyNiubashTree,
} from '../cli/niubash-payload.js'

const unavailable = (detail: string): Error => new Error(`EXECUTOR_UNAVAILABLE: Niubash payload verification failed: ${detail}. Restore the complete pinned v1.5.0 portable tree; this is not a user authorization denial. Do not bypass confinement or fall back to another shell.`)

export interface NativeShellRuntime { file: string; env: NodeJS.ProcessEnv }
export function isNiubashExecutable(file: string): boolean {
  return path.basename(file).toLowerCase() === 'niu.exe'
}

export function niubashPreparedRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.resolve(home, 'dsh-ops/shells/niubash-prepared', NIUBASH_MANIFEST_SHA256)
}

/** Windows scanners can temporarily hold new executable files without delete sharing.
 * Atomics.wait blocks the thread only on this one-time Windows rename path.
 * Retry only that publication rename, never preparation, verification or execution.
 * False means a racing preparer published a target that the caller must verify.
 */
export function publishNiubashVersion(from: string, to: string, {
  platform = process.platform, rename = fs.renameSync, now = Date.now,
  wait = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
}: { platform?: NodeJS.Platform; rename?: typeof fs.renameSync; now?: () => number; wait?: (ms: number) => void } = {}): boolean {
  const deadline = now() + 10_000
  let delay = 50
  for (;;) {
    try { rename(from, to); return true }
    catch (error) {
      if (fs.existsSync(to)) return false
      const remaining = deadline - now()
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || remaining <= 0) {
        throw new Error(`EXECUTOR_UNAVAILABLE: Niubash version publication rename failed (${from} -> ${to}): ${error instanceof Error ? error.message : String(error)}`)
      }
      wait(Math.min(delay, remaining))
      delay = Math.min(delay * 2, 1000)
    }
  }
}

/** Build a version once, without sharing any inode with the package or workspace.
 * Independent processes publish by directory rename: the loser uses the winner's complete tree.
 */
export function prepareNiubashVersion(source: string, target = niubashPreparedRoot()): string {
  verifyNiubashTree(source)
  let previousFailure: Error | undefined
  let broken: string | undefined
  try {
    if (fs.existsSync(target)) {
      try { return verifyNiubashTree(target, true) }
      catch (error) {
        previousFailure = error instanceof Error ? error : new Error(String(error))
        const aside = `${target}.broken-${randomUUID()}`
        try {
          if (!publishNiubashVersion(target, aside)) throw Error(`Could not move damaged prepared version aside: ${target}`)
          broken = aside
        } catch (renameError) {
          // Another repair can retire the same bad version before this preparer gets here.
          if (fs.existsSync(target)) throw renameError
        }
      }
    }
    return buildNiubashVersion(source, target)
  } catch (error) {
    if (previousFailure) throw new Error(`EXECUTOR_UNAVAILABLE: Niubash prepared runtime repair failed: existing version: ${previousFailure.message}; fresh preparation: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  } finally {
    if (broken) {
      try { fs.rmSync(broken, { recursive: true, force: true }) }
      catch (error) { console.error(`dsh-ops: could not remove damaged Niubash prepared version ${broken}: ${error}`) }
    }
  }
}

function buildNiubashVersion(source: string, target: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const scratch = fs.mkdtempSync(`${target}.stage-`)
  try {
    for (const name of [...NIUBASH_PIN.directories, ...NIUBASH_EXECUTION_DIRECTORIES]) {
      fs.mkdirSync(path.join(scratch, name), { recursive: true })
    }
    for (const name of [...Object.keys(NIUBASH_PIN.files), NIUBASH_RECEIPT]) {
      fs.copyFileSync(path.join(source, name), path.join(scratch, name))
    }
    const winuxcmd = path.join(scratch, 'winuxcmd/usr/bin/winuxcmd.exe')
    for (const face of NIUBASH_FACES) {
      const name = `winuxcmd/usr/bin/${face}.exe`
      if (Object.hasOwn(NIUBASH_PIN.files, name)) continue
      try { fs.linkSync(winuxcmd, path.join(scratch, name)) }
      catch { fs.copyFileSync(winuxcmd, path.join(scratch, name)) }
    }
    if (!publishNiubashVersion(scratch, target)) return verifyNiubashTree(target, true)
    return path.join(target, NIUBASH_PIN.executable)
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }) }
    catch (error) { console.error(`dsh-ops: could not remove Niubash preparation scratch ${scratch}: ${error}`) }
  }
}

function runtime(file: string, inheritedPath: string): NativeShellRuntime {
  const root = path.dirname(file)
  return { file, env: { NIU_ROOT: path.join(root, 'winuxcmd'),
    WINUXCMD_PATH: path.join(root, 'winuxcmd/usr/bin/winuxcmd.exe'), NIU_SKIP_WINUXCMD_ACTIVATION: '1',
    PATH: [root, path.join(root, 'bin'), path.join(root, 'winuxcmd/usr/bin'), path.join(root, 'winuxcmd/bin'), inheritedPath].filter(Boolean).join(path.delimiter) } }
}

/** The frozen-manifest hash check remains at selection, never on the command path. */
export function verifiedNiubash(file: string, inheritedPath = process.env.PATH ?? process.env.Path ?? '', env: NodeJS.ProcessEnv = process.env): NativeShellRuntime {
  try {
    if (!path.isAbsolute(file) || !isNiubashExecutable(file)) throw Error('expected an absolute niu.exe path')
    const root = path.dirname(file)
    const target = niubashPreparedRoot(env)
    const selected = path.resolve(root) === target ? verifyNiubashTree(root, true) : prepareNiubashVersion(root, target)
    return runtime(selected, inheritedPath)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EXECUTOR_UNAVAILABLE:')) throw error
    throw unavailable(error instanceof Error ? error.message : String(error))
  }
}

function inside(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Host workspace labeling must never label an executable payload Low via a junction. */
export async function prepareNiubash(file: string, inheritedPath = process.env.PATH ?? process.env.Path ?? '', signal: AbortSignal,
  options: { workspaceRoot?: string } = {}): Promise<NativeShellRuntime> {
  signal.throwIfAborted()
  if (!path.isAbsolute(file) || !isNiubashExecutable(file)) throw unavailable('expected an absolute niu.exe path')
  if (options.workspaceRoot) {
    const root = path.dirname(file), workspace = options.workspaceRoot
    if (inside(path.resolve(root), path.resolve(workspace)) || inside(await fs.promises.realpath(root), await fs.promises.realpath(workspace))) {
      throw unavailable('the prepared payload must be outside the session workspace; move DSH_HOME outside the workspace')
    }
  }
  signal.throwIfAborted()
  return runtime(file, inheritedPath)
}

export function niubashCandidates(bundleRoot: string, env: NodeJS.ProcessEnv): { file: string; source: string }[] {
  const home = env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return [
    { file: path.join(home, NIUBASH_HOME_PATH, 'niu.exe'), source: 'provisioned' },
    { file: path.join(bundleRoot, NIUBASH_PACKAGE_PATH, 'niu.exe'), source: 'bundled' },
  ]
}
