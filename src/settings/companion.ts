/** The installed version of the companion plugin, read from the profile's package tree. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-win-pwsh7'
const SELF = 'dsh-ops'
let cached: { at: number; value: string | undefined } | undefined

/**
 * The `node_modules` roots on the way up from a loaded module.
 *
 * The package is installed as `<profile>/node_modules/dsh-ops/lib/...`, so
 * walking up from its own module URL names the profile that holds the row. This
 * runs in the host process, where the launcher sets no `DSH_PROFILE_DIR` (it
 * passes that only to shell calls), so an environment-only lookup silently
 * answered "not installed" while the page showed the link as on.
 *
 * @param from - a module URL or a path inside the installed package.
 * @returns candidate `node_modules` directories, nearest first.
 */
function moduleRoots(from: string): string[] {
  let dir: string
  try { dir = from.startsWith('file:') ? path.dirname(fileURLToPath(from)) : path.dirname(from) } catch { return [] }
  const roots: string[] = []
  // Bounded: a package deeper than this is not a profile install, and the
  // environment and profile roots still cover it.
  for (let depth = 0; depth < 8; depth += 1) {
    if (path.basename(dir) !== 'node_modules') roots.push(path.join(dir, 'node_modules'))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return roots
}

/** The `.dsh` directory this process belongs to: the launcher's home, else the user's. */
function home(env: NodeJS.ProcessEnv): string {
  const configured = env.DSH_HOME?.trim()
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.dsh')
}

/** Every profile directory under this home, or none when the tree is absent. */
function profiles(env: NodeJS.ProcessEnv): string[] {
  try { return fs.readdirSync(path.join(home(env), 'profiles')).map(name => path.join(home(env), 'profiles', name)) } catch { return [] }
}

/** The package root of this module: the nearest ancestor manifest named `dsh-ops`. */
function selfRoot(from: string | undefined): string | undefined {
  if (from === undefined) return undefined
  let dir: string
  try { dir = from.startsWith('file:') ? path.dirname(fileURLToPath(from)) : path.dirname(from) } catch { return undefined }
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }
      if (manifest.name === SELF) return dir
    } catch { /* keep walking */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * The profile that mounts this exact package.
 *
 * A `link:` development install lives outside every profile, so walking up from
 * the module never reaches the profile that owns the row. Matching `node_modules/dsh-ops`
 * by realpath names that profile without guessing: a profile mounting a different
 * copy — or not mounting this package at all — does not match.
 *
 * @param env - the process environment, for the home directory.
 * @param from - this module's URL, to identify its own package root.
 * @returns the profile's `node_modules`, or undefined when no profile mounts it.
 */
function mountingRoot(env: NodeJS.ProcessEnv, from: string | undefined): string | undefined {
  const self = selfRoot(from)
  if (self === undefined) return undefined
  // Both sides are resolved: a profile or checkout reached through a symlinked
  // parent (macOS /var, some Linux homes) would otherwise never compare equal.
  let resolvedSelf: string
  try { resolvedSelf = fs.realpathSync(self) } catch { return undefined }
  for (const profile of profiles(env)) {
    const modules = path.join(profile, 'node_modules')
    try { if (fs.realpathSync(path.join(modules, SELF)) === resolvedSelf) return modules } catch { /* not this profile */ }
  }
  return undefined
}

/** Candidate node_modules roots: explicit environment, the loaded package, the mounting profile, then a sweep. */
function roots(env: NodeJS.ProcessEnv, sweep: boolean, from: string | undefined): string[] {
  const list: string[] = []
  if (env.DSH_PROFILE_DIR !== undefined) list.push(path.join(env.DSH_PROFILE_DIR, 'node_modules'))
  if (env.DSH_PROFILE !== undefined) list.push(path.join(home(env), 'profiles', env.DSH_PROFILE, 'node_modules'))
  if (from !== undefined) list.push(...moduleRoots(from))
  const mounting = mountingRoot(env, from)
  if (mounting !== undefined) list.push(mounting)
  if (sweep) for (const profile of profiles(env)) list.push(path.join(profile, 'node_modules'))
  return [...new Set(list)]
}

/**
 * The companion plugin's installed version, or undefined when it is not installed.
 * @param options - environment, clock, module origin and sweep, injectable for tests.
 * @returns the version string from the package manifest.
 */
export function companionVersion(options: { env?: NodeJS.ProcessEnv; now?: () => number; sweep?: boolean; from?: string } = {}): string | undefined {
  const env = options.env ?? process.env
  const now = options.now?.() ?? Date.now()
  if (cached !== undefined && now - cached.at < 60_000) return cached.value
  let value: string | undefined
  for (const root of roots(env, options.sweep !== false, options.from ?? import.meta.url)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, NAME, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (manifest.name === NAME && typeof manifest.version === 'string') { value = manifest.version; break }
    } catch { /* not installed in this root */ }
  }
  cached = { at: now, value }
  return value
}
