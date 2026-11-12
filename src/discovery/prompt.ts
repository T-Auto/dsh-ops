/** Native discovery is keyword-driven; schemas carry selection semantics. */
import { DISCOVERY_TOOL_NAME } from '../capabilities/registry.js'
import { publicToolName } from '../policy.js'
import type { NativeCatalogEntry } from './catalog.js'

/** Native only: callers must verify the actual loader is visible in this assembly. */
export function renderNativeDirectory(catalog: readonly NativeCatalogEntry[]): string {
  return catalog.some(row => row.state === 'discoverable')
    ? `Find on-demand tools with ${publicToolName(DISCOVERY_TOOL_NAME)} using task keywords or "select:exact_tool_name".` : ''
}
