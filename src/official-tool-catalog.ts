/** Reviewed alternatives for explicit per-tool selection.
 * These retain bounded read/search functionality and OPS permission checks,
 * not the host argument/return shape or identical search coverage. In particular
 * OPS glob excludes hidden/link/reparse traversal and takes relative glob arrays.
 * See the paired component references before opting into a different workflow.
 */
import { publicToolName } from './policy.js'
import { componentEnabled } from './components/defaults.js'
import { RAW_OFFICIAL_REPLACEMENTS } from './capabilities/replacements.js'
import type { OfficialReplacement } from './capabilities/replacements.js'
export type { OfficialReplacement } from './capabilities/replacements.js'

// Only reviewed, implemented replacements belong here. A similarly named ops_*
// registration is NOT evidence of equivalent capability. In particular replace
// cannot stand in for write/edit, and background jobs cannot control host jobs.
export const OFFICIAL_REPLACEMENTS = Object.freeze(Object.fromEntries(
  Object.entries(RAW_OFFICIAL_REPLACEMENTS).map(([name, raw]) => [name, publicToolName(raw)]),
) as Record<OfficialReplacement, string>)

export function platformSurface(platform: string = process.platform) {
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error(`Unsupported official-tool hiding platform: ${platform}`)
  return { retainedCommand: platform === 'win32' ? 'pwsh' : 'bash', shellDefaultEnabled: componentEnabled('shell', platform) }
}
