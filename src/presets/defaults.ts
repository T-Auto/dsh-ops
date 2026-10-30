/**
 * What each mode contributes to a session of its preset.
 *
 * This table is the product contract between the four mode rows and the shared
 * publication controllers: resident OPS tools, official tools replaced once
 * their OPS counterpart is visible, and whether the mode consumes the advanced
 * file tools through the discovery entry.
 */
import type { OfficialReplacement } from '../capabilities/replacements.js'
import { publicToolName } from '../policy.js'
import type { ModeId } from './types.js'

import { NATIVE_RESIDENT_RAW, SHELL_OFFICIAL_NAMES } from '../capabilities/profiles.js'
export { NATIVE_RESIDENT_RAW, SHELL_OFFICIAL_NAMES } from '../capabilities/profiles.js'

/** One mode's publication and replacement policy. */
export interface ModePlan {
  /** Publish the resident native file tools for matching Agents. */
  nativeFiles: boolean
  /** Official file tools replaced once their OPS counterpart is visible in the same scope. */
  replacements: readonly OfficialReplacement[]
  /** Replace the official Windows shell with ops_bash when the row is on. */
  shell: boolean
  /** Publish the PTC SDK APIs for matching Agents. */
  ptc: boolean
  /** Progressive discovery population for matching Agents. */
  discovery: 'none' | 'advanced' | 'all'
  /** The mode's routing section suffix; null publishes no routing text. */
  section: string | null
}

const NATIVE_REPLACEMENTS: readonly OfficialReplacement[] = Object.freeze(['read', 'glob', 'grep'])

/** Everything one mode publishes; consumers read this instead of branching on ids. */
export const MODE_PLANS: Readonly<Record<ModeId, ModePlan>> = Object.freeze({
  // Minimal keeps its terse prompts: only the Windows shell is replaced, and
  // advanced tools arrive through the discovery entry when that row is on.
  minimal: Object.freeze({ nativeFiles: false, replacements: [], shell: true, ptc: false, discovery: 'all', section: null }),
  standard: Object.freeze({ nativeFiles: true, replacements: NATIVE_REPLACEMENTS, shell: true, ptc: false, discovery: 'advanced', section: 'standard' }),
  ptc: Object.freeze({ nativeFiles: false, replacements: [], shell: true, ptc: true, discovery: 'none', section: 'ptc' }),
  cordis: Object.freeze({ nativeFiles: true, replacements: NATIVE_REPLACEMENTS, shell: true, ptc: false, discovery: 'advanced', section: 'cordis' }),
})

/**
 * The resident native capability names of one mode.
 * @param mode - the mode to read.
 * @returns public OPS names, or an empty list when the mode publishes no native file tools.
 */
export function residentTools(mode: ModeId): readonly string[] {
  return MODE_PLANS[mode].nativeFiles ? NATIVE_RESIDENT_RAW.map(raw => publicToolName(raw)) : []
}
