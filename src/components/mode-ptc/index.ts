/** One enhanced built-in preset. The row publishes OPS only for sessions of that preset. */
import type { Context } from '../../adapter/dsh/types.js'
import { applyMode } from '../../modes/apply.js'
import { modeConfigForm } from '../../modes/config.js'
import { retired as retiredLegacyRow } from '../../settings/legacy.js'
export const name = 'dsh-ops-mode-ptc'
export const Config = modeConfigForm('ptc')
export function apply(ctx: Context, config: unknown): void {
  if (retiredLegacyRow(ctx, 'ptc')) return
  applyMode(ctx, config, 'ptc')
}
