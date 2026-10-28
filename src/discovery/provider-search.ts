/** Search external metadata only; selecting never calls availability or authorization actions. */
import type { Provider } from './providers.js'
export function searchProviders(query: string, pool: Provider[], maximum: number): Provider[] {
  if (query.startsWith('select:')) return pool.filter(row => row.capability.definition.name.toLowerCase() === query.slice(7).trim()).slice(0, maximum)
  const terms = [...new Set(query.match(/[a-z0-9_]+/gu) ?? [])]
  return pool.map((row, order) => {
    const words = `${row.capability.definition.name} ${row.capability.definition.description} ${row.capability.search}`.toLowerCase().split(/[\s_.-]+/u)
    return { row, order, score: terms.reduce((sum, term) => sum + Number(words.includes(term)), 0) }
  }).filter(item => item.score).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, maximum).map(item => item.row)
}
