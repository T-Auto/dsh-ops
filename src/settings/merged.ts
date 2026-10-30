/**
 * The one configuration surface of the single `dsh-ops` row.
 *
 * The maintainer's page is deliberately small: bundle-wide switches and mode
 * switches (including resident tools only for enhanced presets). Every other
 * accepted key stays YAML-only, so the page cannot grow into a second settings
 * application. Features keep their own
 * resolver for those keys; this module only owns what the page exposes.
 *
 * Gating, as specified: a mode's "hide official tools" and "dynamic tools" only
 * take effect while the matching bundle-wide switch is on. The mode switch keeps
 * the operator's intent and simply stops applying.
 */
import { ConfigError } from '../config.js'
import { resolveModeConfig, type ModeConfig } from '../presets/config.js'
import { MODE_IDS } from '../presets/types.js'
import { resolveDiscoveryConfig } from '../discovery/config.js'
import { resolvePanelConfig } from '../panel/collect.js'
import { resolveActivityConfig } from '../tui/activity.js'
import { PRESET_SETTINGS } from './preset-schema.js'
import { customPresets, type CustomPreset } from './presets.js'
import { editable, settingsConfig, type Field } from './schema.js'

type DiscoveryConfig = ReturnType<typeof resolveDiscoveryConfig>
type PanelConfig = ReturnType<typeof resolvePanelConfig>
type ActivityConfig = ReturnType<typeof resolveActivityConfig>

/** Preset sections, in page order. */
export const MODES = MODE_IDS
export type ModeKey = typeof MODES[number]
/** Every section the row accepts. */
export const FEATURES = [...MODES, 'discovery', 'panel', 'tui', 'other'] as const
export type Feature = typeof FEATURES[number]

/** Bundle-wide switches; resident publication is deliberately mode-local. */
export interface GlobalSwitches {
  readonly bash: boolean
  readonly hidePwsh: boolean
  readonly hideOfficialTools: boolean
  readonly dynamicTools: boolean
}

/** One section as the row runs it. */
export interface FeatureState<T = Record<string, unknown>> {
  readonly enabled: boolean
  readonly config: T
  /** The section's own keys, when the input still carried them. */
  readonly raw?: Record<string, unknown>
}

/** The resolved configuration of the single row. */
export interface MergedConfig {
  readonly presets: Readonly<Record<string, CustomPreset>>
  readonly global: GlobalSwitches
  readonly minimal: FeatureState<ModeConfig>
  readonly standard: FeatureState<ModeConfig>
  readonly ptc: FeatureState<ModeConfig>
  readonly cordis: FeatureState<ModeConfig>
  readonly discovery: FeatureState<DiscoveryConfig>
  readonly panel: FeatureState<PanelConfig>
  readonly tui: FeatureState<ActivityConfig>
  readonly other: FeatureState<{ pwsh7Link: boolean }>
}

const ENABLED_BY_DEFAULT: Readonly<Record<Feature, boolean>> = Object.freeze({
  minimal: true, standard: true, ptc: true, cordis: true, discovery: true,
  panel: false, tui: false, other: false,
})

function object(name: string, value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`${name} must be an object`)
  return value as Record<string, unknown>
}

function split(name: Feature, value: unknown): { enabled: boolean; rest: Record<string, unknown>; resolved?: unknown } {
  const raw = object(name, value)
  const enabled = raw.enabled ?? ENABLED_BY_DEFAULT[name]
  if (typeof enabled !== 'boolean') throw new ConfigError(`${name}.enabled must be boolean`)
  // A validated section can re-enter as its resolved slice; accepting that shape
  // keeps one validator for both calls instead of a second, drifting one.
  const keys = Object.keys(raw)
  if (keys.includes('config') && keys.every(key => key === 'enabled' || key === 'config' || key === 'raw')) {
    if (raw.raw !== undefined) return { enabled, rest: object(`${name}.raw`, raw.raw) }
    return { enabled, rest: {}, resolved: raw.config }
  }
  const { enabled: _ignored, ...rest } = raw
  return { enabled, rest }
}

function flag(container: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = container[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new ConfigError(`${key} must be boolean`)
  return value
}

/**
 * Validate the whole row configuration.
 * @param raw - the Loader row's config.
 * @returns every section, enabled or not, with its own validated slice.
 * @throws ConfigError naming the section and key that failed.
 */
export function resolveMergedConfig(raw?: unknown): MergedConfig {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new ConfigError('config must be an object')
  }
  const input = (raw ?? {}) as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (key !== 'global' && key !== 'presets' && !(FEATURES as readonly string[]).includes(key)) {
      throw new ConfigError(`unknown section ${JSON.stringify(key)}; accepted sections are global, ${FEATURES.join(', ')}`)
    }
  }
  const globalRaw = object('global', input.global)
  for (const key of Object.keys(globalRaw)) {
    if (!['bash', 'hidePwsh', 'hideOfficialTools', 'dynamicTools'].includes(key)) throw new ConfigError(`unknown global key ${JSON.stringify(key)}`)
  }
  const normalized = Object.hasOwn(input, 'presets') && Object.values(object('presets', input.presets)).every(value =>
    value && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, 'options'))
    ? Object.fromEntries(Object.entries(object('presets', input.presets)).map(([id, value]) => {
      const options = (value as CustomPreset).options
      const { preset: _id, ...rest } = options
      return [id, rest]
    })) : input.presets
  return {
    presets: customPresets(normalized),
    global: {
      bash: flag(globalRaw, 'bash', true),
      hidePwsh: flag(globalRaw, 'hidePwsh', true),
      hideOfficialTools: flag(globalRaw, 'hideOfficialTools', true),
      dynamicTools: flag(globalRaw, 'dynamicTools', true),
    },
    minimal: modeState('minimal', input.minimal),
    standard: modeState('standard', input.standard),
    ptc: modeState('ptc', input.ptc),
    cordis: modeState('cordis', input.cordis),
    discovery: discoveryState(input.discovery),
    panel: panelState(input.panel),
    tui: tuiState(input.tui),
    other: otherState(input.other),
  }
}

function modeState(name: ModeKey, value: unknown): FeatureState<ModeConfig> {
  const { enabled, rest, resolved } = split(name, value)
  return resolved === undefined
    ? { enabled, config: resolveModeConfig(rest, name), raw: rest }
    : { enabled, config: { ...resolved as ModeConfig, ...(name === 'minimal' ? { residentTools: false } : {}) }, raw: resolved as Record<string, unknown> }
}

function discoveryState(value: unknown): FeatureState<DiscoveryConfig> {
  const { enabled, rest, resolved } = split('discovery', value)
  return resolved === undefined
    ? { enabled, config: resolveDiscoveryConfig(rest), raw: rest }
    : { enabled, config: resolved as DiscoveryConfig }
}

function panelState(value: unknown): FeatureState<PanelConfig> {
  const { enabled, rest, resolved } = split('panel', value)
  return resolved === undefined
    ? { enabled, config: resolvePanelConfig(rest), raw: rest }
    : { enabled, config: resolved as PanelConfig }
}

function otherState(value: unknown): FeatureState<{ pwsh7Link: boolean }> {
  const raw = object('other', value)
  if (Object.hasOwn(raw, 'config') && Object.keys(raw).every(key => ['config', 'raw', 'enabled'].includes(key))) return otherState(raw.raw ?? raw.config)
  // `enabled` may arrive from the validated shape; this section has no enable switch.
  for (const key of Object.keys(raw)) if (key !== 'pwsh7Link' && key !== 'enabled') throw new ConfigError(`unknown other key ${JSON.stringify(key)}`)
  // Absent keeps detection in charge; only a saved boolean counts as an explicit choice.
  const saved = raw.pwsh7Link
  return { enabled: false, config: { pwsh7Link: typeof saved === 'boolean' ? saved : false },
    raw: typeof saved === 'boolean' ? { pwsh7Link: saved } : {} }
}

function tuiState(value: unknown): FeatureState<ActivityConfig> {
  const { enabled, rest, resolved } = split('tui', value)
  return resolved === undefined
    ? { enabled, config: resolveActivityConfig(rest), raw: rest }
    : { enabled, config: resolved as ActivityConfig }
}

/**
 * One mode's slice with the bundle gates applied.
 * @param state - the mode's own section.
 * @param global - the bundle-wide switches.
 * @returns keys safe to hand the component module.
 */
export function effectiveMode(state: FeatureState<ModeConfig>, global: GlobalSwitches, pwsh7Link = false): Record<string, unknown> {
  const raw = state.raw ?? {}
  return {
    ...raw,
    residentTools: state.config.residentTools,
    bash: flag(raw, 'bash', true) && global.bash,
    // The companion plugin replaces pwsh 5.1 only while the host shell stays visible.
    hidePwsh: flag(raw, 'hidePwsh', true) && global.hidePwsh && !pwsh7Link,
    hideOfficialTools: flag(raw, 'hideOfficialTools', true) && global.hideOfficialTools,
    dynamicTools: flag(raw, 'dynamicTools', true) && global.dynamicTools,
  }
}

/** Whether this mode's sessions receive the discovery entry. */
export function dynamicForMode(state: FeatureState<ModeConfig>, global: GlobalSwitches): boolean {
  return global.dynamicTools && flag(state.raw ?? {}, 'dynamicTools', true)
}

const boolean = (description: string): Field => editable('boolean', description)

const MODE_SWITCHES: Record<string, Field> = {
  bash: boolean('Publish Bash for authorized sessions.'),
  hidePwsh: boolean('Hide the official Windows shell; off leaves it visible to the model.'),
  hideOfficialTools: boolean('Hide the official file tools this mode replaces (bundle switch must be on).'),
  dynamicTools: boolean('Publish the discovery entry to this mode (bundle switch must be on).'),
}

function modeSection(mode: ModeKey): Field {
  return { type: 'object', dict: { enabled: boolean('Apply this mode to its sessions.'),
    ...(mode === 'minimal' ? {} : { residentTools: boolean('Publish baseline file tools independently of dynamic loading.') }),
    ...MODE_SWITCHES } }
}

/**
 * The row's own keys, as the Loader hands them to apply.
 * @param value - a raw or already-validated row config.
 * @returns the config with every section's keys preserved.
 */
export function hostConfig(value: unknown): Record<string, unknown> {
  const merged = resolveMergedConfig(value)
  const out: Record<string, unknown> = { global: { ...merged.global } }
  if (Object.keys(merged.presets).length) out.presets = Object.fromEntries(Object.entries(merged.presets).map(([id, row]) => {
    const { preset: _identity, ...options } = row.options
    return [id, options]
  }))
  for (const feature of FEATURES) {
    const state = merged[feature]
    out[feature] = state.raw === undefined ? { enabled: state.enabled } : { enabled: state.enabled, ...state.raw }
  }
  return out
}

/** The host settings descriptor of the single row. */
export const Config = settingsConfig(hostConfig, {
  presets: PRESET_SETTINGS,
  global: { type: 'object', dict: {
    bash: boolean('Bundle switch: allow presets to publish Bash.'),
    hidePwsh: boolean('Bundle switch: allow presets to hide the official Windows shell.'),
    hideOfficialTools: boolean('Bundle switch: allow presets to hide the official file tools.'),
    dynamicTools: boolean('Bundle switch: allow presets to publish the discovery entry.'),
  } },
  minimal: modeSection('minimal'), standard: modeSection('standard'), ptc: modeSection('ptc'), cordis: modeSection('cordis'),
  // Only the switch is editable; capture limits, PTC pools, routing text, worker
  // paths and the credential fence stay YAML-only by design.
  panel: { type: 'object', dict: { enabled: boolean('Capture OPS activity for developer diagnosis.') } },
  tui: { type: 'object', dict: { enabled: boolean('Link OPS into dsh-tui when both plugins are installed.') } },
  other: { type: 'object', dict: { pwsh7Link: boolean('With dsh-win-pwsh7, keep the host pwsh visible so the plugin can point it at pwsh 7.') } },
})
