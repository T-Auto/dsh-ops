/**
 * Retired-row guard for saved overrides of the pre-merge component rows.
 *
 * A profile written for the eight-row bundle keeps patch entries whose ids the
 * merged bundle no longer inserts. The Loader composes such an entry as its own
 * row (it carries a `name`), which would mount a second copy of a feature the
 * single row already manages. Each legacy component therefore checks the shipped
 * bundle once and, when the bundle is the merged one-row layout, states this and
 * does nothing.
 */
import { readFileSync } from 'node:fs'
import type { Context } from '../adapter/dsh/types.js'

let merged: boolean | undefined
let mounting = false

/** Whether this package ships the merged single-row bundle. */
export function mergedBundle(): boolean {
  if (merged !== undefined) return merged
  try {
    const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
    merged = /- id: dsh-ops\s*\n\s+name: dsh-ops/.test(patch)
  } catch { merged = false }
  return merged
}

/** Mark the window in which the merged row mounts its own features. */
export function beginMergedRow(): void { mounting = true }
/** Close that window. */
export function endMergedRow(): void { mounting = false }

/**
 * Refuse a retired legacy row, once per activation.
 * @param ctx - the legacy row's context.
 * @param name - the component the saved row names.
 * @returns true when this row must stay inert.
 */
export function retired(ctx: Context | null | undefined, name: string): boolean {
  // `DSH_OPS_LEGACY_ROWS=1` keeps a retired module usable for verification of the
  // pre-merge behaviour; nothing in a normal profile sets it.
  if (ctx === null || ctx === undefined || mounting || !mergedBundle() || process.env.DSH_OPS_LEGACY_ROWS === '1') return false
  ctx.logger?.warn?.(`dsh-ops: the saved "${name}" row is retired; the single dsh-ops row configures it. Remove that patch entry.`)
  return true
}
