/** Frozen native shell adapter. Distribution must copy the entire upstream portable tree unchanged.
 * No receipt inside that writable tree can authorize executable bytes. The inventory digest below
 * is pinned in plugin source, includes directories and every file, and is recomputed on each use.
 * Adding an OPS receipt to the tree changes its identity; keep distribution metadata outside it.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

// Official v1.5.0 win-x64 tar.gz SHA256:
// f1e429b32987052ffeda18872b52f1e4fd399c06d15e14a8d067ee74e5db5b06
export const NIUBASH_TREE_SHA256 = '8668d414fdc6cbf42f0a464a509f1417444f1debf9687bb48d18078d806014a9'
export const NIUBASH_EXE_SHA256 = '8d37b48e6f5694ee2c9f4af53cad2d0921ac5132d3196d86fdd91c7f017c05c4'
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const unavailable = (detail: string): Error => new Error(`EXECUTOR_UNAVAILABLE: Niubash payload verification failed: ${detail}. Restore the complete pinned v1.5.0 portable tree; this is not a user authorization denial. Do not bypass confinement or fall back to another shell.`)

/** Reject links in the supplied path, not just in its canonical spelling. */
function assertPlainAncestors(file: string): void {
  let current = path.resolve(file)
  for (;;) {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unavailable(`linked or non-directory ancestor: ${current}`)
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

/** Generic inventory format: depth-first, sorted names, slash paths; directory entries precede
 * their children. Each file records size and SHA256. No stat-only verification or mutable cache.
 * Hardlinks in the official portable archive are allowed, but their contents are always hashed.
 */
export function nativeShellTreeDigest(root: string): string {
  assertPlainAncestors(root)
  const entries: (string | number)[][] = []
  const walk = (relative: string): void => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const next = relative ? `${relative}/${name}` : name
      const file = path.join(root, next)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) throw unavailable(`linked entry: ${next}`)
      if (stat.isDirectory()) { entries.push([next, 'directory']); walk(next) }
      else if (stat.isFile()) entries.push([next, stat.size, hash(fs.readFileSync(file))])
      else throw unavailable(`unsupported entry: ${next}`)
    }
  }
  walk('')
  return hash(JSON.stringify(entries))
}

export function isNiubashExecutable(file: string): boolean {
  return path.basename(file).toLowerCase() === 'niu.exe'
}

export interface NativeShellRuntime { file: string; env: NodeJS.ProcessEnv }
/** Absolute niu.exe identifies an explicit selection, not permission to trust arbitrary payloads.
 * The outer host sandbox and subprocess Job still own confinement and descendant cancellation.
 * NIU_ROOT and WinuxCmd paths are per-child overrides; ambient process state is never changed.
 */
export function verifiedNiubash(file: string, inheritedPath = process.env.PATH ?? process.env.Path ?? ''): NativeShellRuntime {
  try {
    if (!path.isAbsolute(file) || !isNiubashExecutable(file)) throw unavailable('expected an absolute niu.exe path')
    const root = path.dirname(file)
    if (nativeShellTreeDigest(root) !== NIUBASH_TREE_SHA256) throw unavailable('full-tree SHA256 mismatch')
    return { file, env: { NIU_ROOT: root, PATH: [root, path.join(root, 'bin'), path.join(root, 'winuxcmd', 'usr', 'bin'),
      path.join(root, 'winuxcmd', 'bin'), inheritedPath].filter(Boolean).join(path.delimiter) } }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EXECUTOR_UNAVAILABLE:')) throw error
    throw unavailable(error instanceof Error ? error.message : String(error))
  }
}

/** Layout contract with distribution: no version folder or generated files inside either tree. */
export function niubashCandidates(bundleRoot: string, env: NodeJS.ProcessEnv): { file: string; source: string }[] {
  const home = env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return [
    { file: path.join(home, 'dsh-ops', 'shells', 'niubash', 'niu.exe'), source: 'provisioned' },
    { file: path.join(bundleRoot, 'runtime', 'win32-x64', 'niubash', 'niu.exe'), source: 'bundled' },
  ]
}
