/** Explicit host compatibility adapter; no host value imports at plugin load time. */
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from './types.js'
import { service } from './host.js'

export async function cradleEnvironment(ctx: Context): Promise<(extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv> {
  const packages = service<{ resolution?: { entries: { scope: string; name: string; packageDir: string }[] } }>(ctx, 'pluginPackages')
  const entries = packages?.resolution?.entries.filter(entry => entry.scope === 'installation' && entry.name === '@deepseek-ai/dsh-app-boot') ?? []
  if (entries.length !== 1 || !path.isAbsolute(entries[0]!.packageDir)) throw new Error('EXECUTOR_UNAVAILABLE: cradle requires an unambiguous host installation')
  const require = createRequire(path.join(entries[0]!.packageDir, 'package.json'))
  const host = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-subprocess')).href) as {
    scrubbedParentEnv?: () => NodeJS.ProcessEnv
  }
  if (typeof host.scrubbedParentEnv !== 'function') throw new Error('EXECUTOR_UNAVAILABLE: host credential scrub contract is unavailable')
  return extra => {
    // Same explicit-overlay contract as host subprocess. Normalize Windows names exactly once.
    const values = new Map<string, [string, string]>()
    for (const layer of [host.scrubbedParentEnv!(), extra ?? {}]) for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) values.delete(key.toUpperCase())
      else values.set(key.toUpperCase(), [key, value])
    }
    return Object.fromEntries(values.values())
  }
}
