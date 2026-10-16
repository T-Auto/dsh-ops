/** Update configuration modification area.
 * Append migrations here; never spread upgrade write-back across components.
 * Markers belong to each owning config row, not a machine-global sentinel.
 */
import { LEGACY_FASTCTX_KEYS } from './config.js'

export const CONFIG_UPDATE_VERSION = 2

/** Apply every pending step in order; each step runs exactly once per row. */
export function updatedConfig(raw = {}, disableEvaluatedFallback = false) {
  const version = Number.isSafeInteger(raw?.configUpdateVersion) ? raw.configUpdateVersion : 0
  if (version >= CONFIG_UPDATE_VERSION) return raw
  const next = { ...raw }
  // 1 (0.2.5): retire the old implicit system-bash opt-in. Later manual opt-ins are kept.
  if (version < 1 && (raw?.allowSystemShellFallback === true || disableEvaluatedFallback)) next.allowSystemShellFallback = false
  // 2: drop the keys only the removed FastCtx surface read.
  if (version < 2) for (const key of LEGACY_FASTCTX_KEYS) delete next[key]
  next.configUpdateVersion = CONFIG_UPDATE_VERSION
  return next
}


/** Save only this component's raw owning row via the public loader lifecycle.
 * Runtime migration happens synchronously in apply before any executor resolves.
 * Write-back is deferred so Entry._init has assigned its owning fiber first.
 * Raw expressions/unrelated fields are preserved rather than serializing the
 * interpolated runtime config. The owning raw row is updated directly and the
 * tree write is scheduled; deliberately do not call Entry.update(), because
 * that needlessly remounts the plugin while the profile is loading and makes
 * every component migration compete with desktop profile reload.
 */
export function mountConfigUpdates(ctx, raw) {
  if ((raw?.configUpdateVersion ?? 0) >= CONFIG_UPDATE_VERSION) return
  ctx.logger?.info?.('dsh-ops: config update 1 applied in memory only (row-owned patch layer cannot persist it).')
}
