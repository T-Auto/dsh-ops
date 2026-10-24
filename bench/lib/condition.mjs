/** Explicit, reproducible model routing; unknown historical conditions stay unknown. */
import fs from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'yaml'

export const REASONING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max'])
export class ConditionError extends Error {}
const literal = value => typeof value === 'string' && value.trim() !== '' && !/[\x00-\x1f]/u.test(value)

export function reasoningEffort(value) {
  if (!REASONING_EFFORTS.includes(value)) throw new ConditionError(`--reasoning-effort must be one of ${REASONING_EFFORTS.join(', ')}; got ${JSON.stringify(value)}`)
  return value
}

export function conditionOf(run) {
  const value = Object.hasOwn(run?.meta ?? {}, 'condition') ? run.meta.condition : run?.condition ?? null
  if (value === null) return null
  if (!literal(value.provider) || !literal(value.model)
    || value.reasoningEffort !== null && !REASONING_EFFORTS.includes(value.reasoningEffort)) {
    throw new ConditionError(`Invalid recorded condition: ${JSON.stringify(value)}`)
  }
  return { provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort }
}

export function describeCondition(value) {
  return value === null || value === undefined ? 'unknown' : JSON.stringify(conditionOf({ condition: value }))
}

export function assertSameCondition(base, cand) {
  const left = conditionOf(base), right = conditionOf(cand)
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new ConditionError(`Conditions differ; base=${describeCondition(left)}; ops=${describeCondition(right)}. Cross-condition pairing is refused.`)
  }
  return left
}

/** Refuse to spend tokens when the composed host profile did not apply the requested route. */
export function assertEffectiveCondition(text, expected) {
  if (expected === null || expected === undefined) return
  const rows = parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ expression: value }) }] })
  const entries = Array.isArray(rows) ? rows.filter(row => row?.id === 'agent-default-model' && row.disabled !== true) : []
  const actual = entries.length === 1 ? entries[0].config : null
  if (!actual || actual.provider !== expected.provider || actual.model !== expected.model
    || expected.reasoningEffort !== null && actual.reasoningEffort !== expected.reasoningEffort) {
    throw new ConditionError(`Composed agent-default-model route does not match requested condition ${describeCondition(expected)}; nothing was run.`)
  }
}

/** The overlay's literal route supplies omitted CLI fields; no expression is evaluated. */
export function planConditions(options, patch, read = file => fs.readFileSync(file, 'utf8')) {
  if (!options.models.length && !options.reasoningEfforts.length && options.provider === null) return [null]
  let route = {}
  if (patch !== null) {
    const rows = parse(read(patch), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ expression: value }) }] })
    if (!Array.isArray(rows)) throw new ConditionError('The LLM overlay must be a list of patch entries')
    for (const row of rows) if (row?.id === 'agent-default-model') route = row.config ?? {}
  }
  const provider = options.provider ?? route.provider
  const models = options.models.length ? options.models : [route.model]
  const efforts = options.reasoningEfforts.length ? options.reasoningEfforts : [route.reasoningEffort ?? null]
  if (!literal(provider)) throw new ConditionError('Explicit conditions need a literal provider in the LLM overlay or --provider <id>')
  if (models.some(model => !literal(model))) throw new ConditionError('Explicit conditions need --model <id> or a literal model in the LLM overlay')
  for (const effort of efforts) if (effort !== null) reasoningEffort(effort)
  return [...new Set(models)].flatMap(model => [...new Set(efforts)].map(reasoningEffort => ({ provider, model, reasoningEffort })))
}

/** Both arms receive the identical final patch after the original provider overlay. */
export function writeConditionPatch(dir, condition) {
  if (condition === null) return null
  const { provider, model, reasoningEffort } = conditionOf({ condition })
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, 'condition.patch.yml')
  const text = stringify([{ id: 'agent-default-model', config: {
    provider, model, ...(reasoningEffort === null ? {} : { reasoningEffort }),
  } }])
  fs.writeFileSync(target, text, { flag: 'wx', mode: 0o600 })
  return target
}

export function patchArgs(llmPatch, conditionPatch) {
  return [llmPatch, conditionPatch].filter(Boolean).flatMap(file => ['--patch', file])
}
