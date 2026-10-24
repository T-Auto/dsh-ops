/** Importable declaration checks, shared by the release gate and drift regressions. */
import { isDeepStrictEqual } from 'node:util'
import { COMPONENTS, componentEntry, componentEnabled } from '../../lib/components/defaults.js'
import { DISCOVERY_CAPABILITIES } from '../../lib/capabilities/registry.js'
import { publicToolName } from '../../lib/policy.js'
import { platformSurface } from '../../lib/official-tool-catalog.js'

export function defaultChecks(component, config, resolve) {
  const defaults = resolve({})
  return Object.entries(config ?? {}).map(([key, value]) => [
    isDeepStrictEqual(value, defaults[key]), `${component}.${key} patch default matches its resolver`,
  ])
}

export function componentChecks(components, platform = process.platform) {
  const checks = [], check = (...value) => checks.push(value)
  const ptc = components.find(row => row.id === 'dsh-ops-ptc')
  check(components.length === COMPONENTS.length && new Set(components.map(row => row.id)).size === COMPONENTS.length, 'component declarations are complete and unique')
  for (const component of COMPONENTS) {
    const row = components.find(value => value.id === `dsh-ops-${component}`)
    check(row?.entry === componentEntry(component), `${component} declaration uses its exported entry`)
    check(row?.defaultEnabled === componentEnabled(component, platform), `${component} declaration matches its enablement default`)
    const hasRuntimeTarget = ['ptc', 'shell', 'file', 'discovery', 'panel'].includes(component)
    check(isDeepStrictEqual(row?.targets, hasRuntimeTarget ? ptc?.targets : undefined), `${component} target declaration matches its runtime requirements`)
    const tools = component === 'discovery' ? DISCOVERY_CAPABILITIES.map(entry => publicToolName(entry.rawName))
      : ['panel', 'tui'].includes(component) ? [] : undefined
    if (component !== 'ptc') check(isDeepStrictEqual(row?.tools, tools), `${component} tool declaration matches its catalogue projection`)
  }
  const retained = Object.fromEntries(['win32', 'linux', 'darwin'].map(platform => [platform, platformSurface(platform).retainedCommand]))
  check(isDeepStrictEqual(components.find(row => row.id === 'dsh-ops-hide-official')?.retainedOfficialCommand, retained), 'retained official commands match platform policy')
  return checks
}
