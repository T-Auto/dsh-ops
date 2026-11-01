/** Built-in preset identities are product defaults, never consumer-registry policy. */
import type { Context, Agent } from '../adapter/dsh/types.js'
import { presetOf, hasPresetRegistry } from '../consumer/identity.js'
import { MODE_IDS, MODE_PRESET, type ModeId } from './types.js'
const modes = new Map<string, ModeId>(MODE_IDS.map(mode => [MODE_PRESET[mode], mode]))
export function modeOf(ctx: Context, agent: Agent): ModeId | undefined {
  const preset = presetOf(ctx, agent)
  return preset === undefined ? (hasPresetRegistry(ctx) ? undefined : 'standard') : modes.get(preset)
}
