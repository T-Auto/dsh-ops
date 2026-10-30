/** One ranked candidate pool for built-in and externally provided Native capabilities. */
import { DISCOVERY_TERMS } from '../capabilities/discovery.js'
import { publicToolName, TOOL_PREFIX } from '../policy.js'
import { migrateRawName } from '../compat/alias.js'
import type { DiscoverableName } from './config.js'
import type { Provider } from './providers.js'
import { ranked } from './ranking.js'
type Candidate = { name: string; text: string; builtin?: DiscoverableName; provider?: Provider }
export function searchCapabilities(query: string, builtins: readonly DiscoverableName[], providers: readonly Provider[], maximum: number) {
  const candidates: Candidate[] = [
    ...builtins.map(builtin => ({ name: publicToolName(builtin), text: DISCOVERY_TERMS[builtin], builtin })),
    ...providers.map(provider => ({ name: provider.capability.definition.name,
      text: `${provider.capability.definition.description} ${provider.capability.search}`, provider })),
  ]
  let normalized = query
  if (query.startsWith('select:')) {
    const target = query.slice(7).trim()
    normalized = `select:${target.startsWith(TOOL_PREFIX) ? publicToolName(migrateRawName(target.slice(TOOL_PREFIX.length))) : target}`
  }
  const matches = ranked(normalized, candidates, row => row.name, row => row.text, maximum)
  return { builtins: matches.flatMap(row => row.builtin ? [row.builtin] : []), providers: matches.flatMap(row => row.provider ? [row.provider] : []) }
}
