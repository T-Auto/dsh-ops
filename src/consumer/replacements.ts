/** Reviewed replacement policy independent of consumer identity. */
import { OFFICIAL_REPLACEMENTS } from '../official-tool-catalog.js'
import { SHELL_OFFICIAL_NAMES } from '../capabilities/profiles.js'
import { BASH_TOOL } from '../policy.js'
export function replacementTargets(files: boolean, shell: boolean, platform = process.platform): ReadonlyMap<string, string> {
  const targets = new Map<string, string>()
  if (files) for (const [name, replacement] of Object.entries(OFFICIAL_REPLACEMENTS)) targets.set(name, replacement)
  if (shell && platform === 'win32') for (const name of SHELL_OFFICIAL_NAMES) targets.set(name, BASH_TOOL)
  return targets
}
