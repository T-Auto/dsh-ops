import { parse } from 'yaml'

// Keep in sync with the component roster in src/components/defaults.ts.
const COMPONENTS = ['mode-minimal', 'mode-standard', 'mode-ptc', 'mode-cordis', 'discovery', 'compat', 'panel', 'tui']

/** Read configuration facts, never evaluate an expression or infer publication readiness. */
export function componentFacts(text) {
  const facts = Object.fromEntries(COMPONENTS.map(name => [name, 'unknown']))
  let rows
  try { rows = parse(text) } catch { return facts }
  if (!Array.isArray(rows)) return facts
  for (const name of COMPONENTS) {
    const found = rows.filter(row => row?.id === `dsh-ops-${name}`)
    if (!found.length) facts[name] = 'absent'
    else if (found.length === 1) {
      const row = found[0]
      if (row.disabled === true || row.config?.enabled === false) facts[name] = 'disabled'
      else if ((row.disabled === undefined || row.disabled === false) && (row.config?.enabled === undefined || row.config.enabled === true)) facts[name] = 'enabled'
    }
  }
  return facts
}

export function platformOf(run) {
  const value = run?.meta?.platform ?? run?.platform
  return typeof value === 'string' && value.trim() ? value : 'unknown'
}

/** Old unknown/unknown archives remain readable; a known/unknown pair needs the override too. */
export function compareEnvironment(base, cand, options = {}) {
  const platforms = { base: platformOf(base), cand: platformOf(cand) }
  const crossPlatform = platforms.base !== platforms.cand
  if (crossPlatform && options.allowCrossPlatform !== true) {
    throw new Error(`platform mismatch: base=${platforms.base}, cand=${platforms.cand}; use --allow-cross-platform only for diagnostics (not a plugin effect)`)
  }
  return { platforms, crossPlatform, components: {
    base: base?.components ?? base?.arms?.base?.components ?? null,
    cand: cand?.components ?? cand?.arms?.cand?.components ?? null,
  } }
}

export function environmentLines(environment) {
  if (!environment?.crossPlatform) return []
  return ['WARNING: cross-platform diagnostic; differences are not a plugin effect.', '']
}
