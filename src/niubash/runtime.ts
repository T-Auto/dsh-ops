/** Select a pinned payload by its metadata; prepare its runtime copy lazily, once per process. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { NIUBASH_FACES, NIUBASH_WINUXCMD, niubashFacePath } from './faces.js'
import { reclaimPreparedNiubash, retirePreparedNiubash } from './prepared-cache.js'
import {
  NIUBASH_EXECUTION_DIRECTORIES, NIUBASH_HOME_PATH, NIUBASH_PACKAGE_PATH,
  NIUBASH_MANIFEST_SHA256, NIUBASH_PIN, expectNiubashFile, inspectNiubashTree,
} from '../cli/niubash-payload.js'

const UNAVAILABLE = 'EXECUTOR_UNAVAILABLE:'
const unavailable = (detail: string): Error => new Error(`${UNAVAILABLE} Niubash payload is unusable: ${detail}. Restore the complete pinned v1.5.0 portable tree (dsh-ops provision-shells --bash); this is not a user authorization denial. Do not bypass confinement or fall back to another shell.`)
const asUnavailable = (error: unknown): Error => error instanceof Error && error.message.startsWith(UNAVAILABLE)
  ? error : unavailable(error instanceof Error ? error.message : String(error))

export interface NativeShellRuntime { file: string; env: NodeJS.ProcessEnv }
export function isNiubashExecutable(file: string): boolean {
  return path.basename(file).toLowerCase() === 'niu.exe'
}

export function niubashPreparedRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.resolve(home, 'dsh-ops/shells/niubash-prepared', NIUBASH_MANIFEST_SHA256)
}

/** Mount-time selection: synchronous, read-only and content-free, so every mode may ask. */
export function selectNiubash(file: string): string {
  try {
    if (!path.isAbsolute(file) || !isNiubashExecutable(file)) throw Error('expected an absolute niu.exe path')
    return inspectNiubashTree(path.dirname(file))
  } catch (error) { throw asUnavailable(error) }
}

/** A prepared runtime is the payload plus these: argv0 faces of winuxcmd.exe and the shell's state directories. */
const GENERATED_FACES = NIUBASH_FACES.map(niubashFacePath).filter(name => !Object.hasOwn(NIUBASH_PIN.files, name))
const WINUXCMD_SIZE: number = (NIUBASH_PIN.sizes as Readonly<Record<string, number>>)[NIUBASH_WINUXCMD]

/** Metadata-only check of a prepared runtime; files the shell writes are never inspected. */
function inspectPreparedNiubash(target: string): string {
  const file = inspectNiubashTree(target)
  for (const name of GENERATED_FACES) expectNiubashFile(target, name, WINUXCMD_SIZE)
  for (const name of NIUBASH_EXECUTION_DIRECTORIES) {
    if (!fs.lstatSync(path.join(target, name), { throwIfNoEntry: false })?.isDirectory()) throw Error(`Incomplete Niubash state directory: ${name}`)
  }
  return file
}

/** Windows scanners can briefly hold a new executable without delete sharing. Only this
 * publication rename backs off (10 s at most); preparation and commands are never retried.
 * False means a racing preparer published the target first.
 */
export async function publishNiubashVersion(from: string, to: string, {
  platform = process.platform, rename = fs.promises.rename, now = Date.now, wait = sleep,
}: { platform?: NodeJS.Platform; rename?: (from: string, to: string) => Promise<void>; now?: () => number; wait?: (ms: number) => Promise<unknown> } = {}): Promise<boolean> {
  const deadline = now() + 10_000
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    try { await rename(from, to); return true }
    catch (error) {
      if (fs.existsSync(to)) return false
      const remaining = deadline - now()
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || remaining <= 0) {
        throw new Error(`${UNAVAILABLE} Niubash version publication rename failed (${from} -> ${to}): ${error instanceof Error ? error.message : String(error)}`)
      }
      await wait(Math.min(delay, remaining))
    }
  }
}

/** Reuse or build one version outside the package and workspace, sharing no inode with the source.
 * A damaged version is moved aside and rebuilt once. Independent processes publish by directory
 * rename; the loser uses the winner's tree.
 */
export async function prepareNiubashVersion(source: string, target: string, { retireOthers = true }: { retireOthers?: boolean } = {}): Promise<string> {
  inspectNiubashTree(source)
  let damage: Error | undefined, broken: string | undefined, scratch: string | undefined, file: string | undefined
  try {
    if (fs.existsSync(target)) {
      try { return file = inspectPreparedNiubash(target) }
      catch (error) {
        damage = error instanceof Error ? error : new Error(String(error))
        const aside = `${target}.broken-${randomUUID()}`
        try {
          if (!await publishNiubashVersion(target, aside)) throw Error(`Could not move damaged prepared version aside: ${target}`)
          broken = aside
        } catch (renameError) {
          // A concurrent repair may already have retired the same damaged version.
          if (fs.existsSync(target)) throw renameError
        }
      }
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    scratch = await fs.promises.mkdtemp(`${target}.stage-`)
    return file = await buildNiubashVersion(source, target, scratch)
  } catch (error) {
    if (damage) throw new Error(`${UNAVAILABLE} Niubash prepared runtime repair failed: existing version: ${damage.message}; fresh preparation: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  } finally {
    if (file && retireOthers) reclaimPreparedNiubash(target)
    else {
      if (scratch && fs.existsSync(scratch) && !retirePreparedNiubash(scratch)) console.error(`dsh-ops: could not retire Niubash preparation scratch ${scratch}`)
      if (broken && !retirePreparedNiubash(broken)) console.error(`dsh-ops: could not retire damaged Niubash prepared version ${broken}`)
    }
  }
}

async function buildNiubashVersion(source: string, target: string, scratch: string): Promise<string> {
  try {
    for (const name of [...NIUBASH_PIN.directories, ...NIUBASH_EXECUTION_DIRECTORIES]) {
      await fs.promises.mkdir(path.join(scratch, name), { recursive: true })
    }
    for (const name of Object.keys(NIUBASH_PIN.files)) await fs.promises.copyFile(path.join(source, name), path.join(scratch, name))
    const winuxcmd = path.join(scratch, NIUBASH_WINUXCMD)
    for (const name of GENERATED_FACES) {
      try { await fs.promises.link(winuxcmd, path.join(scratch, name)) } catch { await fs.promises.copyFile(winuxcmd, path.join(scratch, name)) }
    }
    if (!await publishNiubashVersion(scratch, target)) return inspectPreparedNiubash(target)
    return path.join(target, NIUBASH_PIN.executable)
  } catch (error) {
    // A winning preparer can retire our unfinished scratch after publishing the same version.
    if (fs.existsSync(target)) return inspectPreparedNiubash(target)
    throw error
  }
}

/** One preparation per target per process; later calls cost one existence check. */
const versions = new Map<string, { ready: boolean; work: Promise<string> }>()
function preparedVersion(source: string, target: string): Promise<string> {
  const known = versions.get(target)
  if (known && (!known.ready || fs.existsSync(path.join(target, NIUBASH_PIN.executable)))) return known.work
  // Profiles with different pins share DSH_HOME: one may retire ours. Recover without evicting theirs.
  const retireOthers = known === undefined
  // A bashPath naming the prepared root itself has no separate source to rebuild from.
  const work = path.resolve(source) === target
    ? Promise.resolve().then(() => { const file = inspectPreparedNiubash(target); if (retireOthers) reclaimPreparedNiubash(target); return file })
    : prepareNiubashVersion(source, target, { retireOthers })
  const entry = { ready: false, work }
  entry.work.then(() => { entry.ready = true }, () => { if (versions.get(target) === entry) versions.delete(target) })
  versions.set(target, entry)
  return entry.work
}

function runtime(file: string, inheritedPath: string): NativeShellRuntime {
  const root = path.dirname(file)
  return { file, env: { NIU_ROOT: path.join(root, 'winuxcmd'),
    WINUXCMD_PATH: path.join(root, NIUBASH_WINUXCMD), NIU_SKIP_WINUXCMD_ACTIVATION: '1',
    PATH: [root, path.join(root, 'bin'), path.join(root, 'winuxcmd/usr/bin'), path.join(root, 'winuxcmd/bin'), inheritedPath].filter(Boolean).join(path.delimiter) } }
}

function inside(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Resolve missing prepared roots through their existing parent for the workspace boundary. */
async function physicalPath(file: string): Promise<string> {
  try { return await fs.promises.realpath(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(file)
    return parent === file ? file : path.join(await physicalPath(parent), path.basename(file))
  }
}

/** Command-time runtime for a selected payload. Host workspace labeling must never reach an
 * executable through the workspace or a junction into it, so the prepared root is checked first.
 */
export async function prepareNiubash(selected: string, inheritedPath = process.env.PATH ?? process.env.Path ?? '', signal: AbortSignal,
  { workspaceRoot, env = process.env }: { workspaceRoot?: string; env?: NodeJS.ProcessEnv } = {}): Promise<NativeShellRuntime> {
  signal.throwIfAborted()
  if (!path.isAbsolute(selected) || !isNiubashExecutable(selected)) throw unavailable('expected an absolute niu.exe path')
  const source = path.dirname(selected), target = niubashPreparedRoot(env)
  if (workspaceRoot && (inside(target, path.resolve(workspaceRoot)) || inside(await physicalPath(target), await physicalPath(workspaceRoot)))) {
    throw unavailable('the prepared payload must be outside the session workspace; move DSH_HOME outside the workspace')
  }
  let file: string
  try { file = await preparedVersion(source, target) } catch (error) { throw asUnavailable(error) }
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
