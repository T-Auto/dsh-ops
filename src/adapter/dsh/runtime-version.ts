/** On-demand version facts from the host's installation, never OPS dependencies or environment. */
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from './types.js'
import { service } from './host.js'

export interface RuntimeVersion {
  runtimeVersion: string
  runtimeVersionSource?: 'host:app-boot/getDshRuntimeVersion'
}

export async function runtimeVersion(ctx: Context): Promise<RuntimeVersion> {
  try {
    const packages = service<import('@deepseek-ai/dsh-app-boot').PluginPackages>(ctx, 'pluginPackages')
    const entries = packages?.resolution?.entries.filter(entry =>
      entry.scope === 'installation' && entry.name === '@deepseek-ai/dsh-app-boot') ?? []
    // An ambiguous or absent host installation cannot establish which runtime serves this session.
    if (entries.length !== 1 || !path.isAbsolute(entries[0]!.packageDir)) return { runtimeVersion: 'unknown' }
    const require = createRequire(path.join(entries[0]!.packageDir, 'package.json'))
    const file = realpathSync.native(require.resolve('@deepseek-ai/dsh-app-boot'))
    const relative = path.relative(realpathSync.native(entries[0]!.packageDir), file)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { runtimeVersion: 'unknown' }
    const boot = await import(pathToFileURL(file).href) as {
      getDshRuntimeVersion?: () => unknown
    }
    const version = boot.getDshRuntimeVersion?.()
    if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(version)) {
      return { runtimeVersion: version, runtimeVersionSource: 'host:app-boot/getDshRuntimeVersion' }
    }
  } catch { /* Optional host authority unavailable: do not infer a version from another source. */ }
  return { runtimeVersion: 'unknown' }
}
