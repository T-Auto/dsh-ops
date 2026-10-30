/**
 * Deprecated `dsh-ops/background` row.
 *
 * The background component (FastCtx-backed `ops_run_background` / `ops_job_*`) was removed.
 * Existing profiles still carry this row, so it keeps loading: it accepts any config without
 * validating it, publishes nothing, and says once that the row can be deleted.
 */
import type { Context } from '../../adapter/dsh/types.js'
import { retired as retiredLegacyRow } from '../../settings/legacy.js'
export const name = "dsh-ops-background"
export const REMOVED_MESSAGE = "dsh-ops: the dsh-ops/background component (FastCtx background jobs) was removed in this version; it publishes no tools. Delete this row from the profile configuration."
export function apply(ctx: Context | null | undefined, _config?: unknown): void {
  if (retiredLegacyRow(ctx, 'background')) return
  const logger = ctx?.logger
  if (typeof logger?.warn === "function") logger.warn(REMOVED_MESSAGE)
  else console.warn(REMOVED_MESSAGE)
}
