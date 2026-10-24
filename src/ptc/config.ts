import { FILE_TOOLS, PTC_TOOLS, PTC_RESIDENT_TOOLS } from '../capabilities/registry.js'
export { PTC_RESIDENT_TOOLS } from '../capabilities/registry.js'
import type { FileToolName, PtcToolName } from '../capabilities/registry.js'
import { migrateRawNames } from '../compat/alias.js'
export type ApiName = FileToolName | PtcToolName
export const PTC_LOADABLE_TOOLS: readonly ApiName[] = [...FILE_TOOLS, ...PTC_TOOLS].filter(tool => !PTC_RESIDENT_TOOLS.includes(tool))
export interface PtcConfig { binaryPath?: string; required: boolean; allowedTools: ApiName[]; alwaysLoaded: ApiName[] }
export function parsePtcConfig(raw: unknown = {}): PtcConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PTC config must be an object')
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) if (!['binaryPath', 'required', 'allowedTools', 'alwaysLoaded'].includes(key)) throw new Error('Unknown PTC config key: ' + key)
  if (input.binaryPath !== undefined && typeof input.binaryPath !== 'string') throw new Error('binaryPath must be a string')
  if (input.required !== undefined && typeof input.required !== 'boolean') throw new Error('required must be boolean')
  const names = (key: string, fallback: readonly ApiName[]): ApiName[] => {
    const value = input[key] ?? fallback
    if (!Array.isArray(value)) throw new Error(key + ' must be an array of raw API names')
    const migrated = migrateRawNames(value as string[])
    for (const name of migrated) if (typeof name !== 'string' || !PTC_LOADABLE_TOOLS.includes(name as ApiName)) throw new Error(key + ' contains unsupported API: ' + String(name))
    return [...new Set(migrated as ApiName[])]
  }
  return { binaryPath: input.binaryPath, required: input.required ?? false,
    allowedTools: names('allowedTools', PTC_LOADABLE_TOOLS), alwaysLoaded: names('alwaysLoaded', []) }
}
