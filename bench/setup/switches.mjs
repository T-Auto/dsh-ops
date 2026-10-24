import fs from 'node:fs'
import path from 'node:path'
import { OFFICIAL_REPLACEMENTS } from '../../lib/official-tool-catalog.js'
import { LLM_OVERLAY, planEntryPatch } from './profile.mjs'
import { ACTIVATION_KEYS, SWITCH_ROWS, parseRows, switchesFromDump } from '../lib/switches.mjs'

export const SWITCH_USAGE = '  --switch <name>[=value] candidate only; repeat hide-official=all|read,glob,grep|false, ptc, panel, discovery, shell (booleans true/false)'

export function extractSwitches(argv) {
  const rest = [], switches = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--switch' && !argv[i].startsWith('--switch=')) { rest.push(argv[i]); continue }
    const spec = argv[i] === '--switch' ? argv[++i] : argv[i].slice(9)
    if (!spec || spec.startsWith('--')) throw new Error('--switch needs a name')
    const equal = spec.indexOf('='), name = equal < 0 ? spec : spec.slice(0, equal), value = equal < 0 ? 'true' : spec.slice(equal + 1)
    if (!Object.hasOwn(SWITCH_ROWS, name)) throw new Error(`Unknown switch ${name}; available: ${Object.keys(SWITCH_ROWS).join(', ')}`)
    if (Object.hasOwn(switches, name)) throw new Error(`Duplicate switch ${name}`)
    if (name !== 'hide-official') {
      if (!['true', 'false'].includes(value)) throw new Error(`${name} requires true or false`)
      switches[name] = { enabled: value === 'true' }
    } else {
      const names = Object.keys(OFFICIAL_REPLACEMENTS)
      const selected = ['all', 'true'].includes(value) ? names : value === 'false' ? [] : value.split(',')
      if (selected.some(item => !names.includes(item)) || new Set(selected).size !== selected.length) throw new Error(`hide-official requires all, false or a unique list from ${names.join(', ')}`)
      switches[name] = { enabled: value !== 'false', replaceTools: [...selected].sort() }
    }
  }
  return { argv: rest, switches }
}

function literal(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite config needs a manual patch')
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, 'expression')) throw new Error('A dynamic component config needs a manual patch; refusing to rewrite it')
    for (const child of Object.values(value)) literal(child)
  }
  if (value !== null && !['object', 'string', 'boolean', 'number'].includes(typeof value)) throw new Error('Unsupported config value')
  return JSON.stringify(value)
}

function configMapping(value) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Component config requires a literal mapping; edit it manually')
  literal(value)
  return value
}
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Line-local, atomic planning. Unsupported inline/aliased/multiline target shapes are refused. */
export function planSwitchPatch(text, switches, { force = false, composed = [] } = {}) {
  let next = text
  for (const [name, wanted] of Object.entries(switches)) {
    if (!Object.hasOwn(SWITCH_ROWS, name)) throw new Error(`Unknown switch ${name}`)
    const id = SWITCH_ROWS[name], rows = parseRows(next)
    if (!Array.isArray(rows)) throw new Error('Candidate patch must be a plain top-level list')
    const own = rows.filter(row => row?.id === id)
    if (own.length > 1) throw new Error(`Duplicate row ${id}`)
    const inherited = composed.filter(row => row?.id === id)
    if (inherited.length > 1) throw new Error(`Ambiguous composed row ${id}`)
    const row = own[0]
    if (row?.disabled !== undefined && row.disabled !== !wanted.enabled && !force) throw new Error(`${id}.disabled conflicts; use --force`)
    if (row && row.disabled !== undefined && typeof row.disabled !== 'boolean') throw new Error(`${id}.disabled requires a manual patch`)
    const config = { ...configMapping(inherited[0]?.config), ...configMapping(row?.config) }
    const changes = name === 'hide-official' ? { replaceTools: wanted.replaceTools } : ACTIVATION_KEYS[name] && wanted.enabled ? { [ACTIVATION_KEYS[name]]: true } : {}
    for (const [key, value] of Object.entries(changes)) {
      if (row?.config?.[key] !== undefined && JSON.stringify(row.config[key]) !== JSON.stringify(value) && !force) throw new Error(`${id}.${key} conflicts; use --force`)
      config[key] = value
    }
    // Setting config replaces that entry's config in the host. Preserve every inherited key.
    for (const [key, value] of Object.entries(config)) {
      if (JSON.stringify(row?.config?.[key]) === JSON.stringify(value)) continue
      const lines = next.split(/\r?\n/)
      const start = lines.findIndex(line => line === `- id: ${id}`)
      if (row && start < 0) throw new Error(`${id} requires a plain block row; edit it manually`)
      const end = start < 0 ? -1 : lines.findIndex((line, i) => i > start && /^- /.test(line))
      const body = start < 0 ? [] : lines.slice(start, end < 0 ? lines.length : end)
      if (body.some(line => new RegExp(`^\\s+${escapePattern(key)}:\\s*(?:#.*)?$`).test(line))) throw new Error(`${id}.${key} uses a multiline value; edit it manually`)
      const plan = planEntryPatch(next, { id, config: { [key]: literal(value) } }, { force: true })
      if (!['write', 'noop'].includes(plan.action)) throw new Error(plan.note)
      next = plan.text
    }
    if (!parseRows(next).some(item => item?.id === id)) next = `${next.replace(/^\s*\[\]\s*$/m, '').trimEnd()}\n- id: ${id}\n`
    const lines = next.split(/\r?\n/), start = lines.findIndex(line => line === `- id: ${id}`)
    if (start < 0) throw new Error(`${id} requires a plain block row; edit it manually`)
    let end = lines.findIndex((line, i) => i > start && /^- /.test(line)); if (end < 0) end = lines.length
    const disabled = lines.findIndex((line, i) => i > start && i < end && /^  disabled:/.test(line))
    if (disabled < 0) lines.splice(start + 1, 0, `  disabled: ${!wanted.enabled}`)
    else if (parseRows(next).find(item => item?.id === id).disabled !== !wanted.enabled) lines[disabled] = `  disabled: ${!wanted.enabled}`
    next = lines.join('\n')
  }
  parseRows(next)
  return { text: next, changed: next !== text }
}

export function configureSwitches(options, context, switches) {
  if (!Object.keys(switches).length) return
  const file = path.join(context.home, 'profiles', options.candProfile, 'cordis.patch.yml')
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]\n'
  const args = [...context.prefix, '--profile', options.candProfile]
  const overlay = context.overlay ?? LLM_OVERLAY
  if (fs.existsSync(overlay)) args.push('--patch', overlay)
  const dump = () => {
    const result = context.invoke([...args, '--dump-config'])
    if (result.status !== 0) throw new Error('Candidate --dump-config failed; no sweep was started')
    const rows = parseRows(result.stdout)
    if (!Array.isArray(rows)) throw new Error('Candidate dump is not a component list')
    return { rows, switches: switchesFromDump(result.stdout) }
  }
  const composed = options.dryRun ? [] : dump().rows
  const plan = planSwitchPatch(before, switches, { force: options.force, composed })
  context.log(`  candidate switches: ${JSON.stringify(switches)}`)
  if (options.dryRun) {
    context.log(`  [dry-run] would merge effective component config into ${file}; baseline has no switch writes`)
    context.log('  [dry-run] would verify --dump-config and run a bounded headless readiness turn (may call the configured model)')
    return
  }
  if (plan.changed) fs.writeFileSync(file, plan.text, 'utf8')
  const effective = dump().switches
  for (const [name, wanted] of Object.entries(switches)) {
    if (JSON.stringify(effective[name]) !== JSON.stringify(wanted)) throw new Error(`Composed switch ${name} differs from requested value`)
  }
  const result = context.invoke([...args, '--json', 'Reply only READY. Do not call any tools.'])
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const events = String(result.stdout ?? '').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const turns = events.filter(event => event.type === 'status' && event.phase === 'turn_end')
  if (result.status !== 0 || /READINESS_BLOCKED/.test(output) || events.some(event => event.type === 'error')
    || !turns.length || turns.some(event => event.reason?.kind !== 'completed')) {
    throw new Error('Candidate readiness probe failed; no sweep was started. Check host diagnostics and https://github.com/T-Auto/dsh-ops/issues/207 (READINESS_BLOCKED).')
  }
  context.log('  candidate readiness probe completed; no benchmark task was run')
}
