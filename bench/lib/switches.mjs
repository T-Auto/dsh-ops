import { parse } from 'yaml'

export const SWITCH_ROWS = Object.freeze(Object.fromEntries(['hide-official', 'ptc', 'panel', 'discovery', 'shell'].map(name => [name, `dsh-ops-${name}`])))
export const ACTIVATION_KEYS = Object.freeze({ discovery: 'enabled', panel: 'capture', shell: 'publishBashTool' })
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
    const activation = row.config?.[ACTIVATION_KEYS[name]]
    const enabled = row.disabled === true || activation === false ? false
      : knownConfig && (row.disabled === undefined || row.disabled === false) && (activation === undefined || activation === true) ? true : null
    switches[name] = { enabled }
    if (name === 'hide-official') switches[name].replaceTools = Array.isArray(row.config?.replaceTools)
      && row.config.replaceTools.every(value => typeof value === 'string') ? [...row.config.replaceTools].sort() : null
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
