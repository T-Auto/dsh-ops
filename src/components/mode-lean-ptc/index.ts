/** Publish the lean OPS tool surface only for sessions of its preset. */
import type { Context } from '../../adapter/dsh/types.js'
import { applyMode } from '../../presets/builtin.js'
import { modeConfigForm } from '../../presets/config.js'
import { retired as retiredLegacyRow } from '../../settings/legacy.js'
export const name = 'dsh-ops-mode-lean-ptc'
export const applyModeId = 'lean-ptc'
export const Config = modeConfigForm('lean-ptc')
export function apply(ctx: Context, config: unknown): void {
  if (retiredLegacyRow(ctx, 'lean-ptc')) return
  applyMode(ctx, config, 'lean-ptc')
}
