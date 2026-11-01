/**
 * Lazy, dual-anchor resolution of `@ast-grep/napi`.
 *
 * The package is an optional peer, not a declared dependency of `dsh-ops`. A `pnpm install` (or any
 * reinstall) inside the package directory wipes `dsh-ops/node_modules`, and all five `ops_ptc_*`
 * tools turn into `EXECUTOR_UNAVAILABLE` while the package itself is still on disk.
 *
 * So resolution has two anchors: the nested `node_modules` first, then the `vendor/deps` copy that
 * ships with the package. The second one costs nothing at runtime and turns "dependencies were
 * pruned" from a broken feature into a non-event.
 *
 * `napi` is a Proxy: call sites keep writing `napi.parse(...)` unchanged, while resolution is
 * deferred to the first real call — the native `.node` is no longer pulled in at load time.
 *
 * @module dsh-ops/ptc/engine-load
 */

import { createRequire } from 'node:module'
import path from 'node:path'

/** Files used as resolution anchors, in order. Exported so a diagnostic can show the chain. */
export const ANCHORS: readonly string[] = [
  path.join(__dirname, '..', '..', 'package.json'),
  path.join(__dirname, '..', '..', 'vendor', 'deps', 'package.json'),
]

/** The shape this module needs from `@ast-grep/napi`; the rest is passed through untouched. */
export type NapiModule = Record<string, unknown>

let loaded: NapiModule | undefined

/**
 * Resolve `@ast-grep/napi` once, or throw the last anchor's error.
 *
 * The throw carries the real `MODULE_NOT_FOUND` so the refusal message downstream can name the exact
 * package the caller has to install — a synthesized error would lose that.
 */
export function load(): NapiModule {
  if (loaded !== undefined) return loaded
  let last: unknown
  for (const anchor of ANCHORS) {
    try {
      loaded = createRequire(anchor)('@ast-grep/napi') as NapiModule
      return loaded
    } catch (error) {
      last = error
    }
  }
  throw last
}

/**
 * Lazy view of the native module.
 *
 * A method is bound to the module it came from: the napi binding exposes functions that expect their
 * receiver to be the module object, and an unbound function loses that.
 */
export const napi: NapiModule = new Proxy({} as NapiModule, {
  get(_target, key): unknown {
    const mod = load()
    const value = mod[key as string]
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(mod) : value
  },
  has(_target, key): boolean {
    return key in load()
  },
}) as NapiModule
