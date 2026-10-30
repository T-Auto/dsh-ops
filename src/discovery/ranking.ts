/** Shared metadata scoring: all providers compete in one pool before applying the result limit. */
export function ranked<T>(query: string, pool: readonly T[], name: (item: T) => string, text: (item: T) => string, maximum: number): T[] {
  if (query.startsWith('select:')) return pool.filter(item => name(item).toLowerCase() === query.slice(7).trim()).slice(0, maximum)
  const terms = [...new Set(query.match(/[a-z0-9_]+/gu) ?? [])]
  return pool.map((item, order) => {
    const words = `${name(item)} ${text(item)}`.toLowerCase().split(/[\s_.-]+/u)
    return { item, order, score: terms.reduce((sum, term) => sum + Number(words.includes(term)), 0) }
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, maximum).map(row => row.item)
}
