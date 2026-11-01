/** Explicit single-row consumers. Unknown presets remain untouched unless listed here. */
import { ConfigError } from '../config-error.js'
import { resolveIntegrationConfig, type IntegrationOptions } from '../consumer/options.js'
export interface CustomPreset {
  readonly options: IntegrationOptions
}
export function customPresets(raw: unknown): Readonly<Record<string, CustomPreset>> {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('presets must be an object keyed by preset id')
  return Object.fromEntries(Object.entries(raw).map(([preset, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`presets.${preset} must be an object`)
    if (Object.hasOwn(value, 'preset')) throw new ConfigError(`presets.${preset} uses its map key as identity; omit preset`)
    const options = { ...value, preset } as IntegrationOptions
    resolveIntegrationConfig(options)
    return [preset, { options: structuredClone(options) }]
  }))
}
