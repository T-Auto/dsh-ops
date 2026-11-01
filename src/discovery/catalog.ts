/** Read-only view of the existing Native discovery pool, never a second registry. */
import { capability } from '../capabilities/registry.js'
import { DISCOVERY_TERMS } from '../capabilities/discovery.js'
import { publicToolName } from '../policy.js'
import type { DiscoverableName } from './config.js'
import type { Provider } from './providers.js'

export interface NativeCatalogEntry {
  readonly name: string
  readonly task: string
  readonly search: string
  readonly state: 'callable' | 'discoverable'
  readonly builtin?: DiscoverableName
  readonly provider?: Provider
}

/** Inputs must already be filtered by scope, configuration, readiness and visibility. */
export function nativeCatalog(builtins: readonly DiscoverableName[], providers: readonly Provider[], callable: ReadonlySet<string> = new Set()): NativeCatalogEntry[] {
  const state = (name: string) => callable.has(name) ? 'callable' as const : 'discoverable' as const
  return [
    ...builtins.flatMap(builtin => {
      const metadata = capability(builtin)
      if (!metadata || !metadata.presentations.some(mode => mode === 'native')) return []
      const description = 'nativeProjection' in metadata && metadata.nativeProjection
        ? metadata.nativeProjection.description : 'description' in metadata ? metadata.description : ''
      const name = publicToolName(builtin)
      return [{ name, task: description, search: DISCOVERY_TERMS[builtin], state: state(name), builtin }]
    }),
    ...providers.map(provider => {
      const { definition, search } = provider.capability
      return { name: definition.name, task: definition.description, search, state: state(definition.name), provider }
    }),
  ]
}
