/** Importable declaration checks, shared by the release gate and drift regressions. */
import { isDeepStrictEqual } from 'node:util'
import { COMPONENTS, componentEntry, componentEnabled } from '../../lib/components/defaults.js'
import { CAPABILITIES } from '../../lib/capabilities/registry.js'
import { publicToolName } from '../../lib/policy.js'
import { platformSurface } from '../../lib/official-tool-catalog.js'
import { residentTools } from '../../lib/modes/plan.js'

export function defaultChecks(component, config, resolve) {
  const defaults = resolve({})
  return Object.entries(config ?? {}).map(([key, value]) => [
    isDeepStrictEqual(value, defaults[key]), `${component}.${key} patch default matches its resolver`,
  ])
}

/** Components that need the native runtime target matrix declared. */
const RUNTIME_COMPONENTS = new Set(['mode-minimal', 'mode-standard', 'mode-ptc', 'mode-cordis', 'discovery', 'panel'])

/** The tool names one component declaration advertises for its shipped surface. */
function declaredTools(component) {
  if (component === 'discovery') return DISCOVERY_CAPABILITIES.map(entry => publicToolName(entry.rawName))
  if (component === 'panel' || component === 'tui') return []
  if (component === 'mode-minimal') return ['ops_bash']
  if (component === 'mode-standard' || component === 'mode-cordis') {
    return [...residentTools(component === 'mode-standard' ? 'standard' : 'cordis'), 'ops_bash'].sort()
  }
  return undefined
}

export function componentChecks(components, platform = process.platform) {
  const checks = [], check = (...value) => checks.push(value)
  // One declaration now covers every feature; its tool list is the union of the
  // per-feature surfaces this package still ships.
  check(components.length === 1, 'the manifest declares exactly one row')
  const row = components[0]
  check(row?.id === 'dsh-ops' && row?.entry === 'dsh-ops', 'the declaration uses the package entry')
  check(row?.defaultEnabled === true, 'the declaration ships enabled')
  const expected = [...new Set([...CAPABILITIES.map(entry => publicToolName(entry.rawName)), 'ops_load_sdk', 'ops_bash'])].sort()
  check(isDeepStrictEqual([...(row?.tools ?? [])].sort(), expected), 'tool declaration matches the catalogue projection')
  check(Array.isArray(row?.targets) && row.targets.length > 0, 'target declaration covers a runtime matrix')
  void platform
  return checks
}

