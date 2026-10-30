/**
 * Configuration for a mode row.
 *
 * A mode row carries the file/PTC resolver settings it needs and accepts the
 * compatibility keys older rows used, so one validator owns every accepted key
 * and a malformed row still fails loud and names the offending key.
 */
import { LEGACY_FASTCTX_KEYS, resolveConfig, type ResolvedConfig } from '../config.js'
import { parsePtcConfig, type PtcConfig } from '../ptc/config.js'
import { editable, settingsConfig, type Field } from '../settings/schema.js'
import { configObject } from '../settings/schema.js'
import type { ModeId } from './types.js'

/** One mode row's resolved configuration. */
export interface ModeConfig extends ResolvedConfig {
  allowedTools: PtcConfig['allowedTools']
  alwaysLoaded: PtcConfig['alwaysLoaded']
  /** Publish Bash for this preset's sessions. */
  bash: boolean
  /** Hide the official Windows shell once Bash replaces it. */
  hidePwsh: boolean
  /** Hide the official file tools this mode replaces (gated by the bundle switch). */
  hideOfficialTools: boolean
  /** Publish the discovery entry to this preset's sessions (gated by the bundle switch). */
  dynamicTools: boolean
  /** Publish baseline file tools independently of progressive discovery. */
  residentTools: boolean
}

/** Every key a mode row accepts: the settings each enhanced preset really reads. */
export const MODE_CONFIG_KEYS: readonly string[] = Object.freeze([
  ...LEGACY_FASTCTX_KEYS,
  'binaryPath', 'required', 'denyCredentialReads', 'promptPolicy', 'extraGuidance',
  'bashPath', 'publishBashTool', 'allowSystemShellFallback', 'configUpdateVersion',
  'allowedTools', 'alwaysLoaded',
  'bash', 'hidePwsh', 'hideOfficialTools', 'dynamicTools', 'residentTools',
])

const PTC_KEYS = new Set(['allowedTools', 'alwaysLoaded'])
/** Mode publication switches; enhanced presets default to on. */
const SWITCH_KEYS = new Set(['bash', 'hidePwsh', 'hideOfficialTools', 'dynamicTools', 'residentTools'])

/**
 * Validate one mode row's config.
 * @param rawConfig - the loader row's config value.
 * @param mode - when supplied, enforces Minimal's lack of resident file tools.
 * @returns the resolved configuration.
 * @throws ConfigError naming an unknown or malformed key.
 */
export function resolveModeConfig(rawConfig?: unknown, mode?: ModeId): ModeConfig {
  if (rawConfig !== undefined && rawConfig !== null && (typeof rawConfig !== 'object' || Array.isArray(rawConfig))) {
    throw new Error('config must be an object')
  }
  const raw = (rawConfig ?? {}) as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!MODE_CONFIG_KEYS.includes(key)) {
      throw new Error(`unknown key(s) ${JSON.stringify(key)}; accepted keys are ${MODE_CONFIG_KEYS.map(entry => JSON.stringify(entry)).join(', ')}`)
    }
  }
  const core = Object.fromEntries(Object.entries(raw).filter(([key]) => !PTC_KEYS.has(key) && !SWITCH_KEYS.has(key)))
  const ptc = Object.fromEntries(Object.entries(raw).filter(([key]) => PTC_KEYS.has(key)))
  const switches = Object.fromEntries(Object.entries(raw).filter(([key]) => SWITCH_KEYS.has(key)))
  for (const [key, value] of Object.entries(switches)) {
    if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`)
  }
  const sw = (key: string, fallback: boolean): boolean => (typeof switches[key] === 'boolean' ? switches[key] as boolean : fallback)
  const bash = sw('bash', typeof core.publishBashTool === 'boolean' ? core.publishBashTool : true)
  // `bash` is this surface's name for publishing the shell tool; the legacy key
  // keeps working for saved rows and is owned by the same resolver.
  const resolved = resolveConfig({ ...core, publishBashTool: bash })
  const api = parsePtcConfig(ptc)
  return { ...resolved, allowedTools: api.allowedTools, alwaysLoaded: api.alwaysLoaded,
    bash, hidePwsh: sw('hidePwsh', true),
    hideOfficialTools: sw('hideOfficialTools', true), dynamicTools: sw('dynamicTools', true),
    residentTools: mode !== 'minimal' && sw('residentTools', true) }
}

/**
 * Editable settings fields for one mode row, in the order the host renders them.
 * @param mode - the mode the row enables.
 * @returns field descriptors for the row settings form.
 */
export function modeFields(mode: ModeId): Record<string, Field> {
  // Minimal has no resident file surface; enhanced presets expose its switch.
  // Other accepted keys stay YAML-only to keep the settings page small.
  return {
    ...(mode === 'minimal' ? {} : { residentTools: editable('boolean', 'Publish baseline file tools independently of dynamic loading.') }),
    bash: editable('boolean', 'Publish Bash for authorized sessions.'),
    hidePwsh: editable('boolean', 'Hide the official Windows shell once Bash replaces it.'),
    hideOfficialTools: editable('boolean', 'Hide the official file tools this mode replaces.'),
    dynamicTools: editable('boolean', 'Publish the discovery entry to this mode.'),
  }
}

/**
 * The settings descriptor one mode component exports as `Config`.
 * @param mode - the mode the row enables.
 * @returns a settings descriptor that validates with {@link resolveModeConfig}.
 */
export function modeConfigForm(mode: ModeId) {
  return settingsConfig(value => {
    const raw = configObject(value ?? {})
    const resolved = resolveModeConfig(raw, mode)
    // Keep raw ordinary keys: the host saves individual paths, and the component
    // owns normalization when the row activates.
    return { ...raw, publishBashTool: resolved.publishBashTool, promptPolicy: resolved.promptPolicy }
  }, modeFields(mode))
}
