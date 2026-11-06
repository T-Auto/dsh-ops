/**
 * Package-wide locations: the installed package root and the DSH home.
 *
 * @module dsh-ops/paths
 */

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root (`lib/`'s parent). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The DSH home directory this deployment uses.
 * @param {NodeJS.ProcessEnv} [env] - the environment to read.
 * @returns {string} the absolute DSH home.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env) {
  return env.DSH_HOME && env.DSH_HOME.trim() !== ''
    ? path.resolve(env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')
}

/**
 * The optional index cache directory under the DSH home.
 *
 * The host creates it with mode `0700` only when the operator enabled index
 * caching; the worker treats the resulting `cache_dir` as a hint and walks when
 * the field is absent.
 * @param {string} [home] - the DSH home; defaults to {@link dshHome}.
 * @returns {string} the absolute cache directory path.
 */
export function indexCachePath(home: string = dshHome()) { return path.join(home, 'dsh-ops', 'index-cache') }
