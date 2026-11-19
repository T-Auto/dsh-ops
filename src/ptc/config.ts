import { FILE_TOOLS, PTC_TOOLS, PTC_RESIDENT_TOOLS } from '../capabilities/registry.js'
export { PTC_RESIDENT_TOOLS } from '../capabilities/registry.js'
import type { FileToolName, PtcToolName } from '../capabilities/registry.js'
import { migrateRawNames } from '../compat/alias.js'
export type ApiName = FileToolName | PtcToolName
export const PTC_LOADABLE_TOOLS: readonly ApiName[] = [...FILE_TOOLS, ...PTC_TOOLS].filter(tool => !PTC_RESIDENT_TOOLS.includes(tool))
/** The explicit first-round disclosure tier of a PTC row (#986/#979). */
export type DisclosurePolicy = 'on-demand' | 'full'
export interface PtcConfig { binaryPath?: string; required: boolean; allowedTools: ApiName[]; alwaysLoaded: ApiName[]; disclosurePolicy?: DisclosurePolicy }
// parsePtcConfig always fills disclosurePolicy; a slice that omits the key keeps
// the legacy on-demand default. The builtin plan carries the parsed value since
// D3; the custom integration path passes the key through since D4 (#988).
export function parsePtcConfig(raw: unknown = {}): PtcConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PTC config must be an object')
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) if (!['binaryPath', 'required', 'allowedTools', 'alwaysLoaded', 'disclosurePolicy'].includes(key)) throw new Error('Unknown PTC config key: ' + key)
  if (input.binaryPath !== undefined && typeof input.binaryPath !== 'string') throw new Error('binaryPath must be a string')
  if (input.required !== undefined && typeof input.required !== 'boolean') throw new Error('required must be boolean')
  // The default 'on-demand' is the legacy path; 'full' is a distinct explicit
  // opt-in (#979 §4) — no upgrade, save or switch may pick it for the user.
  const policy = input.disclosurePolicy
  if (policy !== undefined && (typeof policy !== 'string' || (policy !== 'on-demand' && policy !== 'full'))) {
    throw new Error('disclosurePolicy must be "on-demand" or "full"; got ' + (JSON.stringify(policy) ?? String(policy)) + ' (' + typeof policy + ')')
  }
  const names = (key: string, fallback: readonly ApiName[]): ApiName[] => {
    const value = input[key] ?? fallback
    if (!Array.isArray(value)) throw new Error(key + ' must be an array of raw API names')
    const migrated = migrateRawNames(value as string[])
    for (const name of migrated) if (typeof name !== 'string' || !PTC_LOADABLE_TOOLS.includes(name as ApiName)) throw new Error(key + ' contains unsupported API: ' + String(name))
    return [...new Set(migrated as ApiName[])]
  }
  return { binaryPath: input.binaryPath, required: input.required ?? false,
    allowedTools: names('allowedTools', PTC_LOADABLE_TOOLS), alwaysLoaded: names('alwaysLoaded', []),
    disclosurePolicy: policy === 'full' ? 'full' : 'on-demand' }
}
