/**
 * Resolution of the plugin's Bash runtime; PowerShell stays owned by the host.
 *
 * Together with the probes in `lib/shells/paths.js`, this module is the ONLY
 * place that answers "can this deployment run the plugin's bash / pwsh right
 * now, and where is the executable". A rung that
 * cannot be resolved reports `available: false` with the reason; it never
 * throws, so a missing shell degrades the prompt ladder instead of failing the
 * plugin.
 *
 * Contract: {@link resolveShells} is called synchronously during mount and its
 * result feeds the prompt ladder (`lib/policy.js` renders only the available
 * rungs). The other half of the contract — `publishShellTools`, called inside
 * one `ctx.effect` during mount — lives in `lib/shells/publish.js`.
 *
 * The bash rung's order is explicit config, the provisioned copy, the plugin's
 * own copy, then — only while the deployment allows a system shell — `PATH`
 * and the well-known install locations. On POSIX the machine's own bash IS the
 * rung (see `lib/shells/pins.js` for why there is no pinned POSIX payload), so
 * that gate is skipped there.
 *
 * @module dsh-ops/shells/resolve
 */

import fs from 'node:fs'
import path from 'node:path'
import { PACKAGE_ROOT } from '../paths.js'
import { isNiubashExecutable, niubashCandidates, verifiedNiubash } from '../niubash/runtime.js'
import type { ResolvedConfig } from '../config.js'
import type { BundledCause, ShellResolution } from './paths.js'
import {
  POSIX_BASH_REMEDY,
  bashRemedy,
  bundledShell,
  executableNames,
  fromPath,
  isSpawnableFile,
  isWslBashLauncher,
  provisionedShell,
  wellKnownCandidates,
} from './paths.js'

interface BashProbe {
  configured?: string; provisioned?: { file: string; version: string }; bundled?: string
  bundledDetail?: string; bundledCause?: BundledCause; allowSystemFallback: boolean
  env: NodeJS.ProcessEnv; platform: string; posix?: boolean
}
export interface ShellResolutionOptions { bundleRoot?: string; env?: NodeJS.ProcessEnv; platform?: string; arch?: string }
type ShellConfig = Partial<Pick<ResolvedConfig, 'bashPath' | 'publishBashTool' | 'allowSystemShellFallback'>>

/** The directory this module was loaded from; the resolution root of a checkout. */
const MODULE_ROOT = PACKAGE_ROOT

/**
 * Resolve the bash rung: explicit config, the provisioned copy, the plugin's own
 * copy, then — only while the deployment allows a system shell — PATH and the
 * well-known install locations.
 *
 * A configured path is authoritative: when it is unusable the rung reports
 * `available: false` instead of quietly running a different shell.
 * @param {object} options - resolution inputs.
 * @param {string|undefined} options.configured - the configured executable.
 * @param {{file: string, version: string}|undefined} options.provisioned - the
 *   copy `provision-shells` installed, when the store has one.
 * @param {string|undefined} options.bundled - the plugin's own executable, when it has one.
 * @param {string|undefined} options.bundledDetail - why the plugin's own copy is unusable, when it has none.
 * @param {import('./paths.js').BundledCause|undefined} options.bundledCause - the same reason in machine-readable form;
 *   it decides which remedy the detail ends with.
 * @param {boolean} options.allowSystemFallback - whether system installations may be used.
 * @param {NodeJS.ProcessEnv} options.env - the environment to read.
 * @param {string} options.platform - `process.platform`.
 * @returns {import('./paths.js').ShellResolution} the resolution.
 */
function resolveBash({
  configured,
  provisioned,
  bundled,
  bundledDetail,
  bundledCause,
  allowSystemFallback,
  env,
  platform,
  posix = platform !== 'win32',
}: BashProbe): ShellResolution {
  if (configured !== undefined) {
    return isSpawnableFile(configured)
      ? { available: true, file: configured, source: 'config', detail: 'configured bash executable' }
      : {
        available: false,
        file: undefined,
        source: 'config',
        detail: `the configured bash executable does not exist: ${configured}`,
      }
  }
  if (provisioned !== undefined) {
    return {
      available: true,
      file: provisioned.file,
      source: 'provisioned',
      detail: `the bash this deployment provisioned from upstream (version ${provisioned.version})`,
    }
  }
  if (bundled !== undefined) {
    return {
      available: true,
      file: bundled,
      source: 'bundled',
      detail: "the plugin's own bash",
    }
  }
  // On POSIX the machine's own bash is the rung, not a fallback: there is no pinned payload to
  // prefer it to, and `allowSystemShellFallback` exists to gate reaching *past* one. The gate is
  // therefore skipped there and resolution is PATH -> well-known, in that order.
  if (!allowSystemFallback && !posix) {
    return {
      available: false,
      file: undefined,
      source: 'disabled',
      detail: 'no provisioned or bundled bash and allowSystemShellFallback is false'
        + (bundledDetail === undefined ? '' : ` (${bundledDetail})`)
        + `; ${bashRemedy(bundledCause)}`,
    }
  }
  const onPath = fromPath({
    names: executableNames('bash', platform),
    pathValue: env.PATH ?? env.Path,
    reject: file => isWslBashLauncher(file, env, platform),
  })
  if (onPath !== undefined) {
    return {
      available: true,
      file: onPath,
      source: 'path',
      detail: posix ? "the host distribution's own bash, found on PATH" : 'bash found on PATH',
    }
  }
  for (const candidate of wellKnownCandidates({ kind: 'bash', env, platform })) {
    if (isSpawnableFile(candidate)) {
      return {
        available: true,
        file: candidate,
        source: 'well-known',
        detail: posix ? "the host distribution's own bash, at a well-known location" : 'well-known bash install',
      }
    }
  }
  return {
    available: false,
    file: undefined,
    source: 'missing',
    detail: 'no bash found by config, a provisioned copy, a bundled copy, PATH, or a well-known '
      + 'install location'
      + (bundledDetail === undefined ? '' : ` (${bundledDetail})`)
      + `; ${posix ? POSIX_BASH_REMEDY : bashRemedy(bundledCause)}`,
  }
}

/** The host owns PowerShell selection. Legacy OPS copies are never automatically activated. */
function resolvePwsh(): ShellResolution {
  return { available: false, file: undefined, source: 'host',
    detail: 'PowerShell is managed by the host; OPS does not supply or override its executable. Use dsh-ops upgrade-host-pwsh on Windows, then restart DSH. An explicit host pwshPath remains authoritative.' }
}

/**
 * Resolve both shell rungs for this configuration.
 *
 * Synchronous, side-effect free, and total: every failure mode becomes a
 * resolution with `available: false`, never a throw, because this runs during
 * mount where an exception would take the whole plugin down.
 * @param {import('../config.js').ResolvedConfig} config - the plugin configuration.
 * @param {object} [options] - resolution overrides, for tests and for a host
 *   resolving against a different root. Production callers pass none.
 * @param {string} [options.bundleRoot] - the plugin package root.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to probe.
 * @param {string} [options.platform] - `process.platform`.
 * @param {string} [options.arch] - `process.arch`.
 * @returns {{bash: import('./paths.js').ShellResolution, pwsh: import('./paths.js').ShellResolution}} one resolution per rung.
 */
export function resolveShells(config: ShellConfig | undefined, options: ShellResolutionOptions = {}): { bash: ShellResolution; pwsh: ShellResolution } {
  const bundleRoot = options.bundleRoot ?? MODULE_ROOT
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const allowSystemFallback = config?.allowSystemShellFallback === true
  // A POSIX host answers with its own bash: that is the deployment truth for the shell component
  // and for `dsh-ops ladder`.
  const posix = platform !== 'win32'
  const probe = { bundleRoot, env, platform, arch }
  const pwsh = resolvePwsh()

  if (config?.publishBashTool === false) {
    return {
      bash: {
        available: false,
        file: undefined,
        source: 'disabled',
        detail: 'publishBashTool is false',
      },
      pwsh,
    }
  }

  // Explicit custom Bash stays authoritative; an invalid selected Niubash tree never falls
  // through to MSYS or PATH. Presence of an incomplete distribution is also fail-closed.
  if (platform === 'win32') {
    const candidates = config?.bashPath !== undefined
      ? (isNiubashExecutable(config.bashPath) ? [{ file: config.bashPath, source: 'config' }] : [])
      : arch === 'x64' ? niubashCandidates(bundleRoot, env).filter(candidate => {
        try { fs.lstatSync(path.dirname(candidate.file)); return true }
        catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
      }) : []
    const candidate = candidates[0]
    if (candidate) {
      try {
        if (arch !== 'x64') throw new Error('Niubash requires Windows x64')
        const runtime = verifiedNiubash(candidate.file)
        return { bash: { available: true, file: runtime.file, source: candidate.source,
          detail: 'verified complete Niubash v1.5.0 portable runtime' }, pwsh }
      } catch (error) {
        return { bash: { available: false, source: candidate.source,
          detail: error instanceof Error ? error.message : String(error) }, pwsh }
      }
    }
    if (config?.bashPath === undefined) return { bash: { available: false, source: 'missing',
      detail: 'Pinned complete Niubash v1.5.0 is missing or unsupported. Run dsh-ops provision-shells --bash to restore it, or configure an explicit absolute bashPath. No automatic Git Bash or system shell fallback.' }, pwsh }
  }
  const bashBundled = bundledShell({ kind: 'bash', ...probe })
  return {
    bash: resolveBash({
      configured: config?.bashPath,
      provisioned: provisionedShell({ kind: 'bash', env, platform, arch }),
      bundled: bashBundled.file,
      bundledDetail: bashBundled.detail,
      bundledCause: bashBundled.cause,
      allowSystemFallback,
      env,
      platform,
      posix,
    }),
    pwsh,
  }
}
