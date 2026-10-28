import type { ToolDefinition } from '../adapter/dsh/types.js'
import { SDK_CAPABILITIES } from '../capabilities/sdk.js'
import { publicToolName } from '../policy.js'
import { migrateRawNames } from '../compat/alias.js'
import { toOutcome } from './projection/outcome.js'
import { outcomeSchema } from './projection/schema.js'
import type { ApiName } from './config.js'
export function sdkDefinition(allowed: readonly ApiName[], execute: ToolDefinition['execute']): ToolDefinition {
  const entry = SDK_CAPABILITIES[0]
  return { name: publicToolName(entry.rawName), description: entry.description + ' Allowed raw names: ' + (allowed.join(', ') || '(none)') + '.',
    parameters: entry.parameters, output: { schema: outcomeSchema(entry.output), render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      let value: unknown
      try { value = await execute(args, exec) }
      catch { value = { status: 'error', error: { code: 'EXECUTOR_UNAVAILABLE', effectState: 'none', message: 'SDK selection is unavailable; no file operation ran.' } } }
      const outcome = toOutcome('load_sdk', args, value)
      // Loader rejections have no execution data: keep its successful receipt schema exact.
      return 'error' in outcome ? { status: outcome.status, error: outcome.error } : outcome
    } }
}
export function requestedApis(args: unknown, allowed: readonly ApiName[]): ApiName[] | string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'SDK arguments must be an object.'
  const input = args as Record<string, unknown>
  for (const key of Object.keys(input)) if (key !== 'tools') return 'Unknown SDK argument: ' + key
  if (!Array.isArray(input.tools) || input.tools.length < 1 || input.tools.length > 5) return 'tools must contain 1-5 exact raw API names.'
  // A model that learnt the pre-rename vocabulary still names a real API; migrate before
  // validating so the request loads the renamed tool instead of failing on spelling.
  const requested = migrateRawNames(input.tools as string[])
  for (const name of requested) if (typeof name !== 'string' || !allowed.includes(name as ApiName)) return 'API is not in this scope’s allowed pool: ' + String(name)
  return [...new Set(requested)] as ApiName[]
}
