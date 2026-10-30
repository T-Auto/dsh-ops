/** Public preset configuration. Normalization never mounts services or publishes tools. */
import { ConfigError, resolveConfig, type ResolvedConfig } from '../config.js'
import { resolveDiscoveryConfig, type DiscoveryConfig } from '../discovery/config.js'
import { NATIVE_RESIDENT_RAW } from '../capabilities/profiles.js'
import { NATIVE_FILE_TOOLS, type FileToolName } from '../capabilities/registry.js'
import { migrateRawNames } from '../compat/alias.js'
import { parsePtcConfig, type PtcConfig } from '../ptc/config.js'

export type IntegrationProfile = 'native' | 'ptc' | 'discovery' | 'shell'
export interface IntegrationOptions {
  preset: string
  enabled?: boolean
  profile?: IntegrationProfile
  files?: boolean
  residentTools?: boolean
  residentNames?: string[]
  hidePwsh?: boolean
  shell?: boolean
  presentation?: 'native' | 'ptc'
  discovery?: boolean
  allowedTools?: string[]
  alwaysLoaded?: string[]
  replaceOfficial?: boolean
  promptPolicy?: boolean
  extraGuidance?: string
  binaryPath?: string
  required?: boolean
  denyCredentialReads?: boolean
  bashPath?: string
  allowSystemShellFallback?: boolean
  externalTools?: string[]
  externalAlwaysLoaded?: string[]
  externalDisabled?: string[]
}
export interface IntegrationConfig {
  preset: string
  enabled: boolean
  files: boolean
  residentTools: boolean
  residentNames: (FileToolName | 'result')[]
  hidePwsh: boolean
  shell: boolean
  presentation: 'native' | 'ptc'
  discovery: boolean
  replaceOfficial: boolean
  core: ResolvedConfig
  native: DiscoveryConfig
  externalTools: string[]
  externalAlwaysLoaded: string[]
  externalDisabled: string[]
  ptc: PtcConfig
}
const keys = ['preset', 'enabled', 'profile', 'files', 'residentTools', 'residentNames', 'hidePwsh', 'shell', 'presentation', 'discovery', 'allowedTools', 'alwaysLoaded',
  'replaceOfficial', 'promptPolicy', 'extraGuidance', 'binaryPath', 'required', 'denyCredentialReads', 'bashPath', 'allowSystemShellFallback',
  'externalTools', 'externalAlwaysLoaded', 'externalDisabled']
const profiles: Record<IntegrationProfile, { files: boolean; shell: boolean; presentation: 'native' | 'ptc'; discovery: boolean }> = {
  native: { files: true, shell: false, presentation: 'native', discovery: true },
  ptc: { files: true, shell: false, presentation: 'ptc', discovery: true },
  discovery: { files: false, shell: false, presentation: 'native', discovery: true },
  shell: { files: false, shell: true, presentation: 'native', discovery: false },
}
export function resolveIntegrationConfig(raw: unknown): IntegrationConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('integration config must be an object')
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new ConfigError(`unknown integration key: ${key}`)
  if (typeof input.preset !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(input.preset)) throw new ConfigError('preset must be a nonempty preset id (1-128 letters, digits, dots, underscores or hyphens)')
  const profile = input.profile ?? 'native'
  if (typeof profile !== 'string' || !Object.hasOwn(profiles, profile)) throw new ConfigError('profile must be native, ptc, discovery or shell')
  const defaults = profiles[profile as IntegrationProfile]
  const boolean = (key: string, fallback: boolean) => {
    if (input[key] === undefined) return fallback
    if (typeof input[key] !== 'boolean') throw new ConfigError(`${key} must be boolean`)
    return input[key]
  }
  const files = boolean('files', defaults.files), shell = boolean('shell', defaults.shell)
  const residentTools = boolean('residentTools', true)
  const residentInput = input.residentNames ?? NATIVE_RESIDENT_RAW
  if (!Array.isArray(residentInput) || residentInput.some(name => typeof name !== 'string')) throw new ConfigError('residentNames must be an array of Native capability names')
  const residentNames = [...new Set(migrateRawNames(residentInput as string[]))]
  if (residentNames.some(name => !(NATIVE_FILE_TOOLS as readonly string[]).includes(name))) throw new ConfigError('residentNames contains an unavailable Native capability')
  const presentation = input.presentation ?? defaults.presentation
  if (presentation !== 'native' && presentation !== 'ptc') throw new ConfigError('presentation must be native or ptc')
  const enabled = boolean('discovery', defaults.discovery)
  const coreKeys = ['promptPolicy', 'extraGuidance', 'binaryPath', 'required', 'denyCredentialReads', 'bashPath', 'allowSystemShellFallback']
  const core = resolveConfig(Object.fromEntries(Object.entries(input).filter(([key]) => coreKeys.includes(key))))
  if (presentation === 'ptc' && input.denyCredentialReads !== undefined) throw new ConfigError('denyCredentialReads is a Native file option; PTC always enforces its credential boundary')
  // Executor selections are retained while Shell is off; they apply only when re-enabled.
  if (presentation === 'ptc' && !files) throw new ConfigError('PTC requires files: true; external PTC providers are not supported')
  if (presentation === 'ptc' && input.extraGuidance !== undefined) throw new ConfigError('extraGuidance currently applies to Native routing only')
  const replaceOfficial = boolean('replaceOfficial', false)
  const hidePwsh = boolean('hidePwsh', replaceOfficial && shell) && shell
  if (input.residentNames !== undefined && presentation === 'ptc') throw new ConfigError('residentNames applies to Native presentation; use alwaysLoaded for PTC APIs')
  // Replacement intent is retained while both publishers are off; no counterpart means no hide.
  const allowedTools = input.allowedTools ?? (enabled ? undefined : [])
  const alwaysLoaded = input.alwaysLoaded ?? []
  const native = presentation === 'native' ? resolveDiscoveryConfig({
    enabled, allowedTools, alwaysLoaded, binaryPath: core.binaryPath, required: core.required, denyCredentialReads: core.denyCredentialReads,
  }) : resolveDiscoveryConfig({ enabled: false, allowedTools: [], alwaysLoaded: [] })
  const ptc = parsePtcConfig(presentation === 'ptc' ? { allowedTools, alwaysLoaded, binaryPath: core.binaryPath, required: core.required } : {})
  if (presentation === 'ptc' && ptc.alwaysLoaded.some(tool => !ptc.allowedTools.includes(tool))) throw new ConfigError('alwaysLoaded must be in allowedTools')
  const externalNames = (key: string): string[] => {
    const value = input[key] ?? []
    if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(name) || name.startsWith('ops_') || name === 'run_code')) throw new ConfigError(`${key} must contain non-reserved external tool names`)
    return [...new Set(value as string[])]
  }
  const externalTools = externalNames('externalTools'), externalAlwaysLoaded = externalNames('externalAlwaysLoaded'), externalDisabled = externalNames('externalDisabled')
  if (externalAlwaysLoaded.some(name => !externalTools.includes(name) || externalDisabled.includes(name))) throw new ConfigError('externalAlwaysLoaded must be allowed and not disabled')
  if (presentation === 'ptc' && externalTools.length) throw new ConfigError('External Native providers cannot be exposed as typed PTC APIs')
  return { preset: input.preset, enabled: boolean('enabled', true), files, residentTools, residentNames: residentNames as (FileToolName | 'result')[], hidePwsh, shell, presentation, discovery: enabled, replaceOfficial, core, native, ptc,
    externalTools, externalAlwaysLoaded, externalDisabled }
}
