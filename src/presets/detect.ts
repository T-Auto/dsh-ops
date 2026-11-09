/** Built-in preset identities are product defaults, never consumer-registry policy. */
import type { Context, Agent } from '../adapter/dsh/types.js'
import { presetOf, hasPresetRegistry } from '../consumer/identity.js'
import { MODE_IDS, MODE_PRESET, type ModeId } from './types.js'
/**
 * Preset ids this plugin recognizes, including the OPS preset.
 *
 * The OPS preset is its own composition (presets/ops.patch.yml) but it is the
 * PTC surface with the ops tools added, so it must mount the PTC mode row.
 * Without this alias an agent composed from `ops` matches no mode at all and
 * the whole plugin stays inert inside its own preset.
 */
const modes = new Map<string, ModeId>([
  ...MODE_IDS.map(mode => [MODE_PRESET[mode], mode] as [string, ModeId]),
  ['ops', 'ptc'],
])
export function modeOf(ctx: Context, agent: Agent): ModeId | undefined {
  const preset = presetOf(ctx, agent)
  return preset === undefined ? (hasPresetRegistry(ctx) ? undefined : 'standard') : modes.get(preset)
}
