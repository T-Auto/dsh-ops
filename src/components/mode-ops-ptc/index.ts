/** One enhanced built-in preset. The row publishes OPS only for sessions of that preset. */
import type { Context } from '../../adapter/dsh/types.js'
import { applyMode } from '../../presets/builtin.js'
import { modeConfigForm } from '../../presets/config.js'
import { retired as retiredLegacyRow } from '../../settings/legacy.js'
export const name = 'dsh-ops-mode-ops-ptc'
export const Config = modeConfigForm('ops-ptc')
export function apply(ctx: Context, config: unknown): void {
  if (retiredLegacyRow(ctx, 'ops-ptc')) return
  applyMode(ctx, config, 'ops-ptc')
}
