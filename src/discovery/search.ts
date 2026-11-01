import { DISCOVERY_TERMS } from '../capabilities/discovery.js'
import { ranked } from './ranking.js'
import { migrateRawName } from '../compat/alias.js'
import { TOOL_PREFIX, publicToolName } from '../policy.js'
import type { DiscoverableName } from './config.js'

export interface DiscoveryRequest { query: string, maxResults: number }
export function parseRequest(raw: unknown): DiscoveryRequest | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Expected query and optional max_results.'
  const args = raw as Record<string, unknown>
  for (const key of Object.keys(args)) if (!['query', 'max_results'].includes(key)) return `Unknown discovery argument: ${key}`
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 512) return 'query must contain 1-512 characters.'
  const maxResults = args.max_results === undefined ? 3 : args.max_results
  if (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 5) return 'max_results must be an integer from 1 to 5.'
  return { query: args.query.trim().toLowerCase(), maxResults }
}
export function search(query: string, pool: readonly DiscoverableName[], maximum: number): DiscoverableName[] {
  if (query.startsWith('select:')) {
    const wanted = query.slice(7).trim()
    // Saved prompts and long sessions can still spell a pre-rename public name; migrate before
    // comparing so a selection keeps resolving instead of silently matching nothing.
    const target = wanted.startsWith(TOOL_PREFIX) ? publicToolName(migrateRawName(wanted.slice(TOOL_PREFIX.length))) : wanted
    return pool.filter(name => publicToolName(name) === target).slice(0, maximum)
  }
  return ranked(query, pool, name => publicToolName(name), name => DISCOVERY_TERMS[name], maximum)
}
