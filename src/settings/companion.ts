/** The installed version of the companion plugin, read from the profile's package tree. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NAME = 'dsh-win-pwsh7'
let cached: { at: number; value: string | undefined } | undefined

/** Candidate node_modules roots: the active profile first, then this user's profiles. */
function roots(env: NodeJS.ProcessEnv, sweep: boolean): string[] {
  const list: string[] = []
  if (env.DSH_PROFILE_DIR !== undefined) list.push(path.join(env.DSH_PROFILE_DIR, 'node_modules'))
  if (env.DSH_PROFILE !== undefined) list.push(path.join(os.homedir(), '.dsh', 'profiles', env.DSH_PROFILE, 'node_modules'))
  if (sweep) try {
    for (const entry of fs.readdirSync(path.join(os.homedir(), '.dsh', 'profiles'))) list.push(path.join(os.homedir(), '.dsh', 'profiles', entry, 'node_modules'))
  } catch { /* no profiles directory: nothing to read */ }
  return list
}

/**
 * The companion plugin's installed version, or undefined when it is not installed.
 * @param options - platform, environment and clock, injectable for tests.
 * @returns the version string from the package manifest.
 */
export function companionVersion(options: { env?: NodeJS.ProcessEnv; now?: () => number; sweep?: boolean } = {}): string | undefined {
  const env = options.env ?? process.env
  const now = options.now?.() ?? Date.now()
  if (cached !== undefined && now - cached.at < 60_000) return cached.value
  let value: string | undefined
  for (const root of roots(env, options.sweep !== false)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, NAME, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (manifest.name === NAME && typeof manifest.version === 'string') { value = manifest.version; break }
    } catch { /* not installed in this root */ }
  }
  cached = { at: now, value }
  return value
}
