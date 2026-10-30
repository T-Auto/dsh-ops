import { parse } from 'yaml'

// Feature switches live under named sections of the sole dsh-ops bundle row.
export const SWITCH_ROWS = Object.freeze(Object.fromEntries([
  'minimal', 'standard', 'ptc', 'cordis', 'discovery', 'panel', 'tui',
].map(name => [name, 'dsh-ops'])))
// Feature-specific activation flags must also permit an explicitly enabled section.
export const ACTIVATION_KEYS = Object.freeze({ discovery: 'enabled', panel: 'capture' })
export const SWITCH_SECTIONS = Object.freeze({ minimal: 'minimal', standard: 'standard', ptc: 'ptc', cordis: 'cordis', discovery: 'discovery', panel: 'panel', tui: 'tui' })
export const parseRows = text => parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ expression: value }) }] })

/** Configuration facts only; readiness is established separately by setup's host probe. */
export function switchesFromDump(text) {
  const rows = parseRows(text)
  if (!Array.isArray(rows)) return null
  const switches = {}
  for (const [name, id] of Object.entries(SWITCH_ROWS)) {
    const matches = rows.filter(row => row?.id === id)
    if (!matches.length) continue
    if (matches.length !== 1) throw new Error(`Ambiguous component row ${id}`)
    const row = matches[0]
    const knownConfig = row.config === undefined || (row.config !== null && typeof row.config === 'object'
      && !Array.isArray(row.config) && !Object.hasOwn(row.config, 'expression'))
    const section = row.config?.[SWITCH_SECTIONS[name]]
    const knownSection = section === undefined || (section !== null && typeof section === 'object' && !Array.isArray(section) && !Object.hasOwn(section, 'expression'))
    const activation = section?.enabled
    const legacyActivation = section?.[ACTIVATION_KEYS[name]]
    const fallback = !['panel', 'tui'].includes(name)
    const enabled = row.disabled === true ? false
      : knownConfig && knownSection && (row.disabled === undefined || row.disabled === false)
        && (activation === undefined || typeof activation === 'boolean')
        && (legacyActivation === undefined || typeof legacyActivation === 'boolean')
        ? (activation ?? fallback) && legacyActivation !== false : null
    switches[name] = { enabled }
  }
  return switches
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export function candidateSwitches(run) {
  return run?.candidateSwitches ?? run?.arms?.cand?.switches ?? null
}

/** Both summaries in one A/B carry the same candidate set; baseline {} is not compared to it. */
export function assertSameSwitches(base, cand) {
  const left = candidateSwitches(base), right = candidateSwitches(cand)
  if (JSON.stringify(canonical(left)) !== JSON.stringify(canonical(right))) {
    throw new Error(`Candidate switches differ: base=${JSON.stringify(left)}; cand=${JSON.stringify(right)}; incompatible sweeps cannot be paired`)
  }
  return left
}
