/** One ranked candidate pool for built-in and externally provided Native capabilities. */
import { nativeCatalog } from './catalog.js'
import { publicToolName, TOOL_PREFIX } from '../policy.js'
import { migrateRawName } from '../compat/alias.js'
import type { DiscoverableName } from './config.js'
import type { Provider } from './providers.js'
import { ranked } from './ranking.js'
export function searchCapabilities(query: string, builtins: readonly DiscoverableName[], providers: readonly Provider[], maximum: number) {
  const candidates = nativeCatalog(builtins, providers)
  let normalized = query
  if (query.startsWith('select:')) {
    const target = query.slice(7).trim()
    normalized = `select:${target.startsWith(TOOL_PREFIX) ? publicToolName(migrateRawName(target.slice(TOOL_PREFIX.length))) : target}`
  }
  const matches = ranked(normalized, candidates, row => row.name, row => row.provider ? `${row.task} ${row.search}` : row.search, maximum)
  return { builtins: matches.flatMap(row => row.builtin ? [row.builtin] : []), providers: matches.flatMap(row => row.provider ? [row.provider] : []) }
}
