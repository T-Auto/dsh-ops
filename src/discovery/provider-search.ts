import type { Provider } from './providers.js'
import { ranked } from './ranking.js'
export function searchProviders(query: string, pool: Provider[], maximum: number): Provider[] {
  return ranked(query, pool, row => row.capability.definition.name, row => `${row.capability.definition.description} ${row.capability.search}`, maximum)
}
