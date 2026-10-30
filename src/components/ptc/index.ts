import type { Context } from '../../adapter/dsh/types.js'
import { apply as mount } from '../../publication/ptc.js'
import { resolvePtcConfig } from '../../config.js'
import { editable, settingsConfig } from '../../settings/schema.js'
export const name = 'dsh-ops-ptc'
export const Config = settingsConfig(resolvePtcConfig, {
  allowedTools: editable('array', 'PTC APIs available for SDK selection.', { type: 'string' }),
  alwaysLoaded: editable('array', 'PTC APIs published before SDK selection.', { type: 'string' }),
  required: editable('boolean', 'Fail startup if the native worker is unavailable.'),
  binaryPath: editable('string', 'Optional explicit native worker path.'),
})
export function apply(ctx: Context, config: unknown): void { mount(ctx, config) }
