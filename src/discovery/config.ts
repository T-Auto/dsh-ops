import { ConfigError } from '../config.js'
import { DISCOVERY_TERMS } from '../capabilities/discovery.js'
import { migrateRawNames } from '../compat/alias.js'

export type DiscoverableName = keyof typeof DISCOVERY_TERMS
export interface DiscoveryConfig {
  enabled: boolean
  maxResults: number
  allowedTools: DiscoverableName[]
  alwaysLoaded: DiscoverableName[]
  binaryPath?: string
  required: boolean
  denyCredentialReads: boolean
}
export const DISCOVERABLE_TOOLS = Object.freeze(Object.keys(DISCOVERY_TERMS) as DiscoverableName[])
export const DISCOVERY_CONFIG_KEYS = Object.freeze(['enabled', 'maxResults', 'allowedTools', 'alwaysLoaded', 'binaryPath', 'required', 'denyCredentialReads'] as const satisfies readonly (keyof DiscoveryConfig)[])
export function resolveDiscoveryConfig(raw: unknown = {}): DiscoveryConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('discovery config must be an object')
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!(DISCOVERY_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(`unknown discovery key: ${key}`)
    }
  }
  const boolean = (key: string, fallback: boolean): boolean => {
    if (input[key] === undefined) return fallback
    if (typeof input[key] !== 'boolean') throw new ConfigError(`${key} must be boolean`)
    return input[key]
  }
  const names = (key: string, fallback: readonly DiscoverableName[]): DiscoverableName[] => {
    const list = input[key] === undefined ? fallback : input[key]
    if (!Array.isArray(list)) throw new ConfigError(`${key} must be an array of implemented capability names`)
    const migrated = migrateRawNames(list as string[])
    for (const name of migrated) if (typeof name !== 'string' || !Object.hasOwn(DISCOVERY_TERMS, name)) {
      throw new ConfigError(`${key} contains an unavailable capability: ${JSON.stringify(name)}`)
    }
    return [...new Set(migrated)] as DiscoverableName[]
  }
  const maxResults = input.maxResults === undefined ? 3 : input.maxResults
  if (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 5) throw new ConfigError('maxResults must be an integer from 1 to 5')
  if (input.binaryPath !== undefined && (typeof input.binaryPath !== 'string' || !input.binaryPath.trim())) throw new ConfigError('binaryPath must be a nonempty string')
  const allowedTools = names('allowedTools', DISCOVERABLE_TOOLS)
  const alwaysLoaded = names('alwaysLoaded', [])
  for (const tool of alwaysLoaded) if (!allowedTools.includes(tool)) throw new ConfigError(`alwaysLoaded capability ${tool} must be in allowedTools`)
  return { enabled: boolean('enabled', true), maxResults, allowedTools, alwaysLoaded,
    binaryPath: input.binaryPath as string | undefined, required: boolean('required', false),
    denyCredentialReads: boolean('denyCredentialReads', true) }
}
