/**
 * Two run documents → one comparison verdict (issue #205 §六/§七).
 *
 * Pure functions only: a summary or a sealed `run.json` goes in, the structure a
 * report or a panel renders comes out. Nothing here reads a file, spawns a process
 * or prints, so the whole judgement is pinned by a test with no model and no server.
 *
 * The rules this module exists to enforce:
 *
 * 1. **A pass-rate drop outranks any token win.** `pass-drop` is evaluated first and
 *    its reasons come first: cheaper but wrong is not an improvement.
 * 2. **Cost is compared only on pairs that passed on both sides.** Pairing is
 *    `pairMetrics` from `aggregate.mjs` on `(taskId, repeatIndex)`; a pair with a
 *    failed side is excluded from the cost statistics and counted in
 *    `pairing.excluded`, so a run cannot quietly shrink its denominator by skipping
 *    the repeats it would have lost.
 * 3. **A direction must clear the A/A noise floor.** {@link noiseFloor} measures what
 *    "no change" looks like by pairing two baseline runs; when the measured delta
 *    sits inside that band the comparison reports the interval and a `within-noise`
 *    conclusion and refuses a direction. With no noise floor at all it refuses one
 *    too (`noise-floor-unknown`) instead of reading noise as a result.
 * 4. **One task must not launder another's regression.** The regression gate defaults
 *    to `task` scope; `total` is opt-in and `both` enforces the two together, with
 *    the geometric mean of per-task ratios as the scale-free overview.
 *
 * Two input shapes are accepted, because both exist in this repo: #183's summary
 * (`results` is an array of metrics documents) and the sealed `run.json`
 * (`results` is an array of rows carrying `metrics` plus the row's `verify` checks).
 * {@link normalizeResults} lifts either into the metrics documents the rest of the
 * module works on.
 *
 * @module dsh-ops/bench/compare-core
 */

import { CORE_BUCKETS, median, minValue, pairMetrics } from './aggregate.mjs'
import { assertSameCondition } from './condition.mjs'
import { compareEnvironment } from './environment.mjs'

export { median, minValue }

/** The comparison document's format tag. */
export const COMPARE_FORMAT = 'dsh-ops-bench-compare-v1'

/** The noise-floor document's format tag. */
export const NOISE_FORMAT = 'dsh-ops-bench-noise-v1'

/** Statistics a caller may compare on. */
export const AGGREGATES = ['median', 'min']

/** Gate modes a caller may ask for. */
export const FAIL_ON = ['regression', 'pass-drop', 'both', 'none']

/** Which aggregate the `regression` gate judges: one task at a time, the sum, or both. */
export const REGRESSION_SCOPES = ['task', 'total', 'both']

/** A finite number, the only thing a statistic may be. */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Round to a tenth, the module's reporting precision. */
function round1(value) {
  return Math.round(value * 10) / 10
}

/**
 * The sum of the four core buckets, or null when the usage names none of them.
 * @param {object} usage - a usage object.
 * @returns {number|null} the sum, or null.
 */
function sumCoreBuckets(usage) {
  const parts = CORE_BUCKETS.map((bucket) => usage?.[bucket]).filter(isNumber)
  return parts.length === 0 ? null : parts.reduce((sum, value) => sum + value, 0)
}

/**
 * The comparable token total of one metrics document.
 *
 * #183's summary and the sealed `run.json` both carry `usage.grandTotal` (the sealed
 * schema requires it), but a document that predates that requirement may omit it, so
 * the four core buckets are summed when it is absent. `reasoningTokens` is never
 * a term — it is not part of the total either way.
 * @param {object} metrics - a metrics document.
 * @returns {number|null} the total, or null when the document reports nothing.
 */
export function totalTokens(metrics) {
  const usage = metrics?.usage
  if (!usage || typeof usage !== 'object') return null
  if (isNumber(usage.grandTotal)) return usage.grandTotal
  return sumCoreBuckets(usage)
}

/**
 * Did one measurement row pass?
 *
 * #183 stores `verify.passed` on the metrics document; the sealed `run.json` stores
 * the check list on the row. Both are read, and an empty check list is not a pass:
 * "nothing was checked" must never read as "it worked".
 * @param {object} metrics - a metrics document or a run-shaped row.
 * @returns {boolean} true only on an affirmative pass.
 */
export function passed(metrics) {
  if (typeof metrics?.verify?.passed === 'boolean') return metrics.verify.passed
  const checks = Array.isArray(metrics?.verify) ? metrics.verify : null
  if (checks === null) return false
  return checks.length > 0 && checks.every((check) => check?.pass === true)
}

/**
 * Lift one result row of either input shape into a metrics document.
 * @param {object} result - a #183 metrics document or a `run.json` result row.
 * @returns {object|null} the metrics document, or null when the row is unusable.
 */
export function resultMetrics(result) {
  if (!result || typeof result !== 'object') return null
  const inner = result.metrics && typeof result.metrics === 'object' ? result.metrics : result
  const taskId = typeof result.taskId === 'string' && result.taskId !== '' ? result.taskId : inner.taskId
  const repeatIndex = Number.isInteger(result.repeatIndex) ? result.repeatIndex : inner.repeatIndex
  // The sealed schema requires `grandTotal`, but a `#183` summary (or any document from
  // before that requirement) may omit it, so materialize it from the four buckets once,
  // here, and every downstream statistic reads one shape.
  const usage = inner.usage && typeof inner.usage === 'object' ? { ...inner.usage } : inner.usage
  if (usage && !isNumber(usage.grandTotal)) {
    const sum = sumCoreBuckets(usage)
    if (sum !== null) usage.grandTotal = sum
  }
  return { ...inner, usage, taskId, repeatIndex, verify: { ...(inner.verify && typeof inner.verify === 'object' ? inner.verify : {}), passed: passed(result) } }
}

/**
 * Every result row of a run document, as metrics documents with a join key.
 *
 * A #183 summary has no `repeatIndex`; there the ordinal of that task's appearance
 * on its side is the repeat index, which is exactly how those arrays were written.
 * An explicit index is always kept, and a repeated one is left for `pairMetrics` to
 * report rather than silently renumbered.
 * @param {object} run - a summary or a sealed `run.json`.
 * @returns {object[]} the normalized metrics documents.
 */
export function normalizeResults(run) {
  const results = Array.isArray(run?.results) ? run.results : []
  const ordinals = new Map()
  const rows = []
  for (const raw of results) {
    const metrics = resultMetrics(raw)
    if (!metrics) continue
    const taskId = typeof metrics.taskId === 'string' && metrics.taskId !== '' ? metrics.taskId : '<no-task-id>'
    const seen = ordinals.get(taskId) ?? 0
    const repeatIndex = Number.isInteger(metrics.repeatIndex) && metrics.repeatIndex >= 1
      ? metrics.repeatIndex
      : seen + 1
    ordinals.set(taskId, Math.max(seen, repeatIndex))
    rows.push({ ...metrics, taskId, repeatIndex })
  }
  return rows
}

/**
 * Metrics documents grouped by task id, ordered by first appearance.
 * @param {object[]} results - metrics documents.
 * @returns {Map<string, object[]>} the groups.
 */
export function groupByTask(results) {
  const groups = new Map()
  for (const metrics of results ?? []) {
    const id = String(metrics?.taskId ?? '<no-task-id>')
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(metrics)
  }
  return groups
}

/**
 * Did every run on this side report complete usage?
 * @param {object} run - a summary or a sealed `run.json`.
 * @returns {boolean} true when every row's usage is complete.
 */
export function usageComplete(run) {
  const results = normalizeResults(run)
  if (results.length === 0) return false
  return results.every((metrics) => metrics?.usageReported === true)
}

/**
 * The model identity of a side, for the mismatch warning.
 * @param {object} run - a summary or a sealed `run.json`.
 * @returns {string|null} the identity, or null when it is unknown.
 */
export function modelKey(run) {
  const model = run?.model
  if (model && typeof model === 'object') {
    const provider = model.provider
    const name = model.model
    if (!provider && !name) return null
    return `${provider ?? '?'}/${name ?? '?'}`
  }
  if (typeof model === 'string' && model !== '') return model
  if (typeof run?.meta?.model === 'string' && run.meta.model !== '') return run.meta.model
  return null
}

/** One side's label, from either document shape. */
function sideLabel(run, side) {
  return run?.label ?? run?.arms?.[side]?.label ?? null
}

/** One side's profile name, from either document shape. */
function sideProfile(run, side) {
  return run?.profile ?? run?.arms?.[side]?.profile ?? null
}

/** One side's dsh version, from either document shape. */
function sideDshVersion(run, side) {
  return run?.dshVersion ?? run?.arms?.[side]?.dshVersion ?? run?.meta?.dsh ?? null
}

/**
 * Aggregate one task's repeat runs into a single side of the comparison.
 * @param {object[]} metricsList - the metrics documents for one task on one side.
 * @returns {object} the per-side aggregate.
 */
export function aggregateTask(metricsList = []) {
  const numeric = (pick) => metricsList.map(pick).filter(isNumber)
  const totals = numeric((metrics) => metrics?.usage?.grandTotal ?? 0)
  const inputs = numeric((metrics) => metrics?.usage?.inputTokens ?? 0)
  const outputs = numeric((metrics) => metrics?.usage?.outputTokens ?? 0)
  const cacheReads = numeric((metrics) => metrics?.usage?.cacheReadTokens ?? 0)
  const cacheWrites = numeric((metrics) => metrics?.usage?.cacheWriteTokens ?? 0)
  const reasonings = numeric((metrics) => metrics?.usage?.reasoningTokens ?? 0)
  const steps = numeric((metrics) => metrics?.steps ?? 0)
  const toolCalls = numeric((metrics) => metrics?.toolCalls ?? 0)
  const toolErrors = numeric((metrics) => metrics?.toolErrors ?? 0)
  // Wall-clock per repeat, aggregated like steps. A failed row records 0 ms (it never
  // ran), which drags the median down exactly the way a 0-steps row does — the pass
  // columns are what tell the reader which rows actually measured something.
  const durations = numeric((metrics) => metrics?.durationMs ?? 0)
  // The prompt shape: the first request (no history yet — system prompt + tool
  // schemas + task text) is the per-request fixed cost, and the per-step average
  // says how much context each subsequent request re-sent. Older archives predate
  // `metrics.prompt`, so every one of these may be empty; the report degrades to a
  // "skipped" note rather than inventing a number.
  const firstPrompts = numeric((metrics) => metrics?.prompt?.firstStep)
  const promptTotals = numeric((metrics) => metrics?.prompt?.total)
  const promptMaxima = numeric((metrics) => metrics?.prompt?.max)
  const promptPerSteps = metricsList
    .map((metrics) => {
      const total = metrics?.prompt?.total
      const count = metrics?.steps ?? 0
      return isNumber(total) && count > 0 ? total / count : null
    })
    .filter(isNumber)
  const promptComplete = metricsList.length > 0 && metricsList.every((metrics) => metrics?.prompt?.reported === true)
  const passedCount = metricsList.filter((metrics) => metrics?.verify?.passed === true).length
  const complete = metricsList.length > 0 && metricsList.every((metrics) => metrics?.usageReported === true)
  // Per-tool counts are summed over the repeats rather than medianed: a tool that is
  // called once in one repeat and never again is a real adoption signal, and a
  // median of zeros would erase it. A tool absent from every repeat is absent here
  // too (the stream only records tools that were actually called).
  const toolCallsByName = {}
  for (const metrics of metricsList) {
    for (const [name, count] of Object.entries(metrics?.toolCallsByName ?? {})) {
      if (!isNumber(count)) continue
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + count
    }
  }

  return {
    repeats: metricsList.length,
    grandTotalMedian: median(totals),
    grandTotalMin: minValue(totals),
    inputMedian: median(inputs),
    inputMin: minValue(inputs),
    outputMedian: median(outputs),
    outputMin: minValue(outputs),
    cacheReadMedian: median(cacheReads),
    cacheReadMin: minValue(cacheReads),
    cacheWriteMedian: median(cacheWrites),
    cacheWriteMin: minValue(cacheWrites),
    reasoningMedian: median(reasonings),
    firstRequestPromptMedian: median(firstPrompts),
    firstRequestPromptMin: minValue(firstPrompts),
    promptTotalMedian: median(promptTotals),
    promptTotalMin: minValue(promptTotals),
    promptPerStepMedian: median(promptPerSteps),
    contextMaxMedian: median(promptMaxima),
    promptComplete,
    stepsMedian: median(steps),
    stepsMin: minValue(steps),
    toolCallsMedian: median(toolCalls),
    toolCallsMin: minValue(toolCalls),
    durationMsMedian: median(durations),
    durationMsMin: minValue(durations),
    toolCallsByName,
    toolErrorsMedian: median(toolErrors),
    toolErrorsMin: minValue(toolErrors),
    passRate: metricsList.length === 0 ? 0 : passedCount / metricsList.length,
    passed: passedCount,
    usageComplete: complete,
  }
}

/**
 * The geometric mean of per-task percent changes — the scale-free "overall effect
 * on this corpus" figure. Unlike the summed TOTAL it weights every task equally, so
 * the biggest task cannot dominate it. Tasks missing on either side, or with an
 * unusable base value (zero or unknown), are skipped; null when none qualify.
 * @param {number[]} pcts - the per-task percent changes.
 * @returns {number|null} the geometric mean percent, or null.
 */
export function geometricMeanPct(pcts) {
  const usable = pcts.filter((value) => isNumber(value) && value > -100)
  if (usable.length === 0) return null
  const logSum = usable.reduce((sum, value) => sum + Math.log(1 + value / 100), 0)
  return round1((Math.exp(logSum / usable.length) - 1) * 100)
}

/**
 * Percent change from base to candidate.
 * @param {number|null} base - the baseline value.
 * @param {number|null} cand - the candidate value.
 * @returns {number|null} the signed percent, rounded to a tenth, or null when base is 0 or unknown.
 */
export function percentChange(base, cand) {
  if (!isNumber(base) || !isNumber(cand)) return null
  if (base === 0) return cand === 0 ? 0 : null
  return round1(((cand - base) / Math.abs(base)) * 100)
}

/**
 * Turn a measured delta plus a noise floor into a verdict about direction.
 *
 * This is the one place "can we read a direction?" is decided, so the panel, the
 * report and the gate cannot disagree. Three outcomes:
 *
 * - no usable delta → `incomparable`;
 * - a delta with no A/A noise floor → `noise-floor-unknown` (report the interval,
 *   never the direction);
 * - a delta inside the floor → `within-noise` (same: the band, not a claim);
 * - otherwise `cheaper` / `costlier`, with `regressed` only when the costlier move
 *   also exceeds the tolerance.
 * @param {number|null} pct - the measured percent change.
 * @param {number|null} floorPct - the A/A noise floor half-width, or null when unknown.
 * @param {number} [tolerancePct] - the acceptable regression percent.
 * @returns {object} the decision, including the band and the conclusion.
 */
export function decideDirection(pct, floorPct, tolerancePct = 2) {
  if (!isNumber(pct)) {
    return { pct: null, direction: null, withinNoise: null, readable: false, conclusion: 'incomparable', noiseFloorPct: isNumber(floorPct) ? floorPct : null, tolerancePct, bandPct: null, exceedsTolerance: false, regressed: false }
  }
  if (!isNumber(floorPct)) {
    return { pct, direction: null, withinNoise: null, readable: false, conclusion: 'noise-floor-unknown', noiseFloorPct: null, tolerancePct, bandPct: null, exceedsTolerance: Math.abs(pct) > tolerancePct, regressed: false }
  }
  const withinNoise = Math.abs(pct) <= floorPct
  const direction = withinNoise || pct === 0 ? null : pct < 0 ? 'cheaper' : 'costlier'
  const exceedsTolerance = Math.abs(pct) > tolerancePct
  return {
    pct,
    direction,
    withinNoise,
    readable: direction !== null,
    conclusion: withinNoise ? 'within-noise' : direction ?? 'no-change',
    noiseFloorPct: floorPct,
    tolerancePct,
    bandPct: { low: -floorPct, high: floorPct },
    exceedsTolerance,
    regressed: direction === 'costlier' && exceedsTolerance,
  }
}

/** The per-aggregate statistic names one comparison reads. */
function statisticKeys(aggregate) {
  const useMin = aggregate === 'min'
  return {
    statKey: useMin ? 'grandTotalMin' : 'grandTotalMedian',
    stepsKey: useMin ? 'stepsMin' : 'stepsMedian',
    toolsKey: useMin ? 'toolCallsMin' : 'toolCallsMedian',
    errorsKey: useMin ? 'toolErrorsMin' : 'toolErrorsMedian',
    firstPromptKey: useMin ? 'firstRequestPromptMin' : 'firstRequestPromptMedian',
    durationKey: useMin ? 'durationMsMin' : 'durationMsMedian',
    promptTotalKey: useMin ? 'promptTotalMin' : 'promptTotalMedian',
    inputKey: useMin ? 'inputMin' : 'inputMedian',
    outputKey: useMin ? 'outputMin' : 'outputMedian',
    cacheReadKey: useMin ? 'cacheReadMin' : 'cacheReadMedian',
  }
}

/** The sum of the usable numbers, or null when there are none. */
function sumNumbers(values) {
  const usable = values.filter(isNumber)
  return usable.length === 0 ? null : usable.reduce((sum, value) => sum + value, 0)
}

/** Sum a per-task statistic, skipping tasks with nothing to contribute. */
function sumStat(tasks, pick) {
  return sumNumbers(tasks.map(pick))
}

/** A number or a fallback. */
function numberOr(value, fallback) {
  return isNumber(value) ? value : fallback
}

/** Paired metrics grouped by task id, ordered by first appearance. */
function groupPairsByTask(pairs) {
  const groups = new Map()
  for (const pair of pairs) {
    if (!groups.has(pair.taskId)) groups.set(pair.taskId, [])
    groups.get(pair.taskId).push(pair)
  }
  return groups
}

/**
 * The cost statistics of one task from its usable pairs, in the chosen aggregate.
 *
 * A pair is usable only when both its sides passed; the caller has already filtered,
 * so this is pure arithmetic over the survivors. `min` compares the cheapest
 * surviving repeat on each side (the #183 meaning of the aggregate), `median`
 * compares the median.
 * @param {object[]} pairs - the usable `{base, cand}` pairs.
 * @param {'median'|'min'} aggregate - which side statistic to compare.
 * @returns {object} the paired statistics, `pct: null` when the side had no numbers.
 */
export function pairedTaskStats(pairs, aggregate = 'median') {
  const baseTotals = pairs.map((pair) => totalTokens(pair.base)).filter(isNumber)
  const candTotals = pairs.map((pair) => totalTokens(pair.cand)).filter(isNumber)
  const useMin = aggregate === 'min'
  const baseMedian = median(baseTotals)
  const candMedian = median(candTotals)
  const baseMin = minValue(baseTotals)
  const candMin = minValue(candTotals)
  const baseValue = useMin ? baseMin : baseMedian
  const candValue = useMin ? candMin : candMedian
  return {
    pairs: pairs.length,
    baseMedian,
    candMedian,
    pctMedian: percentChange(baseMedian, candMedian),
    baseMin,
    candMin,
    pctMin: percentChange(baseMin, candMin),
    baseValue,
    candValue,
    pct: percentChange(baseValue, candValue),
  }
}

/**
 * Count the pairs a cost comparison had to drop, by which side failed.
 * @param {object[]} pairs - every merged pair.
 * @param {string|null} [taskId] - restrict to one task, or null for all.
 * @returns {{baseFailed: number, candFailed: number, bothFailed: number, total: number}} the tally.
 */
export function classifyExcluded(pairs, taskId = null) {
  const counts = { baseFailed: 0, candFailed: 0, bothFailed: 0, total: 0 }
  for (const pair of pairs) {
    if (taskId !== null && pair.taskId !== taskId) continue
    const basePassed = passed(pair.base)
    const candPassed = passed(pair.cand)
    if (basePassed && candPassed) continue
    if (!basePassed && !candPassed) counts.bothFailed += 1
    else if (!basePassed) counts.baseFailed += 1
    else counts.candFailed += 1
    counts.total += 1
  }
  return counts
}

/**
 * The A/A noise floor: what "nothing changed" looks like in this harness.
 *
 * Two baseline runs are paired exactly like a real comparison, and each task's
 * paired percent change is recorded. With no change the true value is zero, so every
 * number here is noise; the band reported is the largest absolute movement seen
 * (`aa-max-abs-task-pct`). That is deliberately the widest reading of the noise: a
 * direction then has to beat the worst thing the harness did while standing still,
 * which is the conservative choice when the alternative is calling noise a result.
 * The per-task rows and the median magnitude ride along so a caller can judge how
 * much of the band came from one jittery task.
 * @param {object} baseA - the first baseline run.
 * @param {object} baseB - the second baseline run (the same baseline, re-measured).
 * @param {{aggregate?: 'median'|'min'}} [options] - comparison options.
 * @returns {object} the noise-floor document; `pct: null` when nothing could be paired.
 */
export function noiseFloor(baseA, baseB, options = {}) {
  assertSameCondition(baseA, baseB)
  compareEnvironment(baseA, baseB, options)
  const aggregate = AGGREGATES.includes(options.aggregate) ? options.aggregate : 'median'
  const merged = pairMetrics(normalizeResults(baseA), normalizeResults(baseB))
  const usablePairs = merged.pairs.filter((pair) => passed(pair.base) && passed(pair.cand))
  const byTask = groupPairsByTask(usablePairs)
  const perTask = [...byTask.keys()].sort().map((id) => {
    const stats = pairedTaskStats(byTask.get(id), aggregate)
    return { id, base: stats.baseValue, cand: stats.candValue, pct: stats.pct, pairs: stats.pairs }
  })
  const magnitudes = perTask.map((row) => Math.abs(row.pct)).filter(isNumber)
  const pct = magnitudes.length === 0 ? null : round1(Math.max(...magnitudes))
  return {
    format: NOISE_FORMAT,
    method: 'aa-max-abs-task-pct',
    aggregate,
    pct,
    comparable: pct !== null,
    band: pct === null ? null : { low: -pct, high: pct },
    pairs: usablePairs.length,
    samples: perTask.length,
    excludedPairs: merged.pairs.length - usablePairs.length,
    medianAbsPct: magnitudes.length === 0 ? null : round1(median(magnitudes)),
    perTask,
  }
}

/**
 * The scalar half-width of {@link noiseFloor}, for callers that only want the number.
 * @param {object} baseA - the first baseline run.
 * @param {object} baseB - the second baseline run.
 * @param {object} [options] - comparison options.
 * @returns {number|null} the noise floor in percent, or null when it could not be measured.
 */
export function noiseFloorPct(baseA, baseB, options = {}) {
  return noiseFloor(baseA, baseB, options).pct
}

/**
 * Where the noise floor of one comparison comes from.
 *
 * `options.noiseFloorPct` pins it from outside (a stored A/A number, or `0` to say
 * "treat every measured move as real"); `options.noise` names the two A/A runs and
 * it is measured here. Neither means it is unknown, and an unknown floor withholds
 * every cost direction rather than defaulting to zero.
 * @param {object} options - the comparison options.
 * @param {object} base - the comparison's baseline, used when only one A/A run was named.
 * @param {object} cand - the candidate, used when only one A/A run was named.
 * @returns {object} the noise-floor document.
 */
export function resolveNoiseFloor(options = {}, base = null, cand = null) {
  if (isNumber(options.noiseFloorPct)) {
    return {
      format: NOISE_FORMAT,
      method: 'provided',
      aggregate: AGGREGATES.includes(options.aggregate) ? options.aggregate : 'median',
      pct: options.noiseFloorPct,
      comparable: true,
      band: { low: -options.noiseFloorPct, high: options.noiseFloorPct },
      pairs: 0,
      samples: 0,
      excludedPairs: 0,
      medianAbsPct: null,
      perTask: [],
    }
  }
  const noise = options.noise
  if (noise && typeof noise === 'object' && !Array.isArray(noise) && (noise.base || noise.cand)) {
    assertSameCondition(base, noise.base ?? base)
    assertSameCondition(base, noise.cand ?? base)
    return noiseFloor(noise.base ?? base, noise.cand ?? base, { aggregate: options.aggregate, allowCrossPlatform: options.allowCrossPlatform })
  }
  return {
    format: NOISE_FORMAT,
    method: 'none',
    aggregate: AGGREGATES.includes(options.aggregate) ? options.aggregate : 'median',
    pct: null,
    comparable: false,
    band: null,
    pairs: 0,
    samples: 0,
    excludedPairs: 0,
    medianAbsPct: null,
    perTask: [],
  }
}

/**
 * Split one task's token delta into the three things that can produce it.
 *
 * A run's cost is `Σ(per-step prompt) + Σ(output)`, and the first step's prompt is
 * the only one that carries no history — system prompt + tool schemas + task text.
 * So the delta between two sides is, to first order:
 *
 * - `fixedOverheadTokens`: what the candidate's bigger per-request prompt costs on
 *   **every** step it took. This is the number a plugin's tool schemas and prompt
 *   policy own, and it is silent about how well the model used them.
 * - `extraStepsTokens`: what the candidate's extra steps cost at the *baseline's*
 *   prompt size. A candidate can be cheaper per request and still lose here.
 * - `residualTokens`: everything the first-order model does not explain — bigger tool
 *   results carried in the history, context that grew faster or slower, steps saved.
 * @param {object} baseSide - the aggregated baseline side of one task.
 * @param {object} candSide - the aggregated candidate side of one task.
 * @param {object} keys - the statistic names for this aggregate.
 * @returns {object} the decomposition, with `comparable: false` when a side lacks prompt capture.
 */
function decomposeOverhead(baseSide, candSide, keys) {
  const shape = {
    baseFirstRequest: numberOr(baseSide[keys.firstPromptKey], null),
    candFirstRequest: numberOr(candSide[keys.firstPromptKey], null),
    baseSteps: numberOr(baseSide[keys.stepsKey], null),
    candSteps: numberOr(candSide[keys.stepsKey], null),
    basePromptTotal: numberOr(baseSide[keys.promptTotalKey], null),
    candPromptTotal: numberOr(candSide[keys.promptTotalKey], null),
    baseOutput: numberOr(baseSide[keys.outputKey], null),
    candOutput: numberOr(candSide[keys.outputKey], null),
    baseCacheRead: numberOr(baseSide[keys.cacheReadKey], null),
    candCacheRead: numberOr(candSide[keys.cacheReadKey], null),
  }
  const needed = [shape.baseFirstRequest, shape.candFirstRequest, shape.baseSteps, shape.candSteps, shape.basePromptTotal, shape.candPromptTotal, shape.baseOutput, shape.candOutput]
  if (!needed.every(isNumber)) {
    return { comparable: false, ...shape, fixedOverheadTokens: null, extraStepsTokens: null, residualTokens: null, promptTotalDelta: null, outputDelta: null, totalDelta: null, cacheReadDelta: null }
  }
  const fixedOverheadTokens = (shape.candFirstRequest - shape.baseFirstRequest) * shape.candSteps
  const extraStepsTokens = (shape.candSteps - shape.baseSteps) * shape.baseFirstRequest
  const promptTotalDelta = shape.candPromptTotal - shape.basePromptTotal
  const outputDelta = shape.candOutput - shape.baseOutput
  return {
    comparable: true,
    ...shape,
    fixedOverheadTokens,
    extraStepsTokens,
    promptTotalDelta,
    residualTokens: promptTotalDelta - fixedOverheadTokens - extraStepsTokens,
    outputDelta,
    // A prompt-shaped delta plus the output delta reconstitutes the total, by
    // construction: grandTotal = input + cacheRead + cacheWrite + output.
    totalDelta: promptTotalDelta + outputDelta,
    cacheReadDelta: isNumber(shape.baseCacheRead) && isNumber(shape.candCacheRead) ? shape.candCacheRead - shape.baseCacheRead : null,
  }
}

/** Sum the per-task decompositions into the corpus-level picture. */
function rollUpOverhead(tasks) {
  const usable = tasks.map((task) => task.overhead).filter((overhead) => overhead?.comparable === true)
  const sum = (pick) => (usable.length === 0 ? null : usable.reduce((total, overhead) => total + pick(overhead), 0))
  return {
    comparable: usable.length > 0,
    tasks: tasks.length,
    comparableTasks: usable.length,
    fixedOverheadTokens: sum((overhead) => overhead.fixedOverheadTokens),
    extraStepsTokens: sum((overhead) => overhead.extraStepsTokens),
    residualTokens: sum((overhead) => overhead.residualTokens),
    promptTotalDelta: sum((overhead) => overhead.promptTotalDelta),
    outputDelta: sum((overhead) => overhead.outputDelta),
    totalDelta: sum((overhead) => overhead.totalDelta),
    cacheReadDelta: sum((overhead) => overhead.cacheReadDelta ?? 0),
  }
}

/** One bucket's paired totals over the usable pairs, or nulls when nothing reported it. */
function pairedBucket(usablePairs, pick) {
  const base = sumNumbers(usablePairs.map((pair) => pick(pair.base)))
  const cand = sumNumbers(usablePairs.map((pair) => pick(pair.cand)))
  return { base, cand, delta: base === null || cand === null ? null : cand - base, comparable: base !== null && cand !== null }
}

/**
 * The corpus-level delta per usage bucket over the usable pairs, and each bucket's
 * share of the total delta. `grandTotal` is the sum of the three, so the shares add
 * up to 100% — "the candidate costs 54% more" is a different fact from "89% of the
 * increase is cache reads, usually priced an order of magnitude below uncached
 * input". The gate still judges `grandTotal`; this only says what is in it.
 * @param {object[]} usablePairs - the pairs both sides passed.
 * @returns {object} the per-bucket deltas.
 */
function bucketDeltas(usablePairs) {
  const grandTotal = pairedBucket(usablePairs, (metrics) => totalTokens(metrics))
  const withShare = (entry) => ({
    ...entry,
    sharePct: entry.delta === null || grandTotal.delta === null || grandTotal.delta === 0
      ? null
      : round1((entry.delta / grandTotal.delta) * 100),
  })
  const input = withShare(pairedBucket(usablePairs, (metrics) => metrics?.usage?.inputTokens ?? null))
  const output = withShare(pairedBucket(usablePairs, (metrics) => metrics?.usage?.outputTokens ?? null))
  const cacheRead = withShare(pairedBucket(usablePairs, (metrics) => metrics?.usage?.cacheReadTokens ?? null))
  return {
    comparable: [input, output, cacheRead].every((bucket) => bucket.comparable),
    input,
    output,
    cacheRead,
    grandTotal: withShare(grandTotal),
  }
}

/**
 * Thousands-separated integer rendering. Shared with `observe.mjs` so the live
 * narration and the report cannot disagree about how a count reads.
 * @param {number|null} value - the number.
 * @returns {string} the display form, `n/a` when it is not a finite number.
 */
export function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return Math.round(value).toLocaleString('en-US')
}

/**
 * Compare two run documents.
 *
 * The verdict order is fixed: pass-drop first, then the paired cost gate. Cost is
 * only read from pairs that passed on both sides, and only when the noise floor lets
 * a direction be read at all.
 * @param {object} base - the baseline summary or sealed `run.json`.
 * @param {object} cand - the candidate summary or sealed `run.json`.
 * @param {object} [options] - comparison options.
 * @param {'median'|'min'} [options.aggregate] - which statistic to compare (default `median`).
 * @param {number} [options.tolerancePct] - acceptable regression percent (default 2).
 * @param {'regression'|'pass-drop'|'both'|'none'} [options.failOn] - which gates run (default `both`).
 * @param {'task'|'total'|'both'} [options.regressionScope] - regression granularity (default `task`).
 * @param {number} [options.noiseFloorPct] - an externally measured A/A noise floor.
 * @param {{base?: object, cand?: object}} [options.noise] - two A/A runs to measure the floor from.
 * @returns {object} the comparison structure, including the gate and the verdict.
 */
export function compareSummaries(base, cand, options = {}) {
  const condition = assertSameCondition(base, cand)
  const environment = compareEnvironment(base, cand, options)
  if (options.noise) compareEnvironment(base, options.noise.base, options)
  const aggregate = AGGREGATES.includes(options.aggregate) ? options.aggregate : 'median'
  const tolerancePct = isNumber(options.tolerancePct) ? options.tolerancePct : 2
  const failOn = FAIL_ON.includes(options.failOn) ? options.failOn : 'both'
  const regressionScope = REGRESSION_SCOPES.includes(options.regressionScope) ? options.regressionScope : 'task'

  const baseRows = normalizeResults(base)
  const candRows = normalizeResults(cand)
  const merged = pairMetrics(baseRows, candRows)
  const noise = resolveNoiseFloor(options, base, cand)
  const usablePairs = merged.pairs.filter((pair) => passed(pair.base) && passed(pair.cand))
  const usableByTask = groupPairsByTask(usablePairs)
  const excluded = classifyExcluded(merged.pairs)
  const keys = statisticKeys(aggregate)

  const baseRuns = groupByTask(baseRows)
  const candRuns = groupByTask(candRows)
  const ids = [...new Set([...baseRuns.keys(), ...candRuns.keys()])]

  const tasks = ids.map((id) => {
    const baseSide = aggregateTask(baseRuns.get(id) ?? [])
    const candSide = aggregateTask(candRuns.get(id) ?? [])
    const stats = pairedTaskStats(usableByTask.get(id) ?? [], aggregate)
    const taskExcluded = classifyExcluded(merged.pairs, id)
    const cost = decideDirection(stats.pct, noise.pct, tolerancePct)
    return {
      id,
      inBase: baseRuns.has(id),
      inCand: candRuns.has(id),
      regressed: cost.regressed,
      base: baseSide,
      cand: candSide,
      paired: { ...stats, considered: stats.pairs + taskExcluded.total, excluded: taskExcluded },
      cost,
      overhead: decomposeOverhead(baseSide, candSide, keys),
      delta: {
        grandTotalPct: cost.pct,
        grandTotalPctAllRepeats: percentChange(baseSide[keys.statKey], candSide[keys.statKey]),
        grandTotalAbs: numberOr(baseSide[keys.statKey], 0) === 0 && numberOr(candSide[keys.statKey], 0) === 0
          ? 0
          : numberOr(stats.candValue, 0) - numberOr(stats.baseValue, 0),
        direction: cost.direction,
        withinNoise: cost.withinNoise,
        noiseFloorPct: cost.noiseFloorPct,
        firstRequestPromptAbs: isNumber(baseSide[keys.firstPromptKey]) && isNumber(candSide[keys.firstPromptKey])
          ? candSide[keys.firstPromptKey] - baseSide[keys.firstPromptKey]
          : null,
        firstRequestPromptPct: percentChange(baseSide[keys.firstPromptKey], candSide[keys.firstPromptKey]),
        stepsPct: percentChange(baseSide[keys.stepsKey], candSide[keys.stepsKey]),
        toolCallsPct: percentChange(baseSide[keys.toolsKey], candSide[keys.toolsKey]),
        toolErrorsPct: percentChange(baseSide[keys.errorsKey], candSide[keys.errorsKey]),
        durationPct: percentChange(baseSide[keys.durationKey], candSide[keys.durationKey]),
        passRateAbs: candSide.passRate - baseSide.passRate,
      },
    }
  })

  const baseGrandTotal = sumStat(tasks, (task) => task.paired.baseValue)
  const candGrandTotal = sumStat(tasks, (task) => task.paired.candValue)
  const totalCost = decideDirection(percentChange(baseGrandTotal, candGrandTotal), noise.pct, tolerancePct)
  const basePasses = tasks.reduce((sum, task) => sum + task.base.passed, 0)
  const baseRunsCount = tasks.reduce((sum, task) => sum + task.base.repeats, 0)
  const candPasses = tasks.reduce((sum, task) => sum + task.cand.passed, 0)
  const candRunsCount = tasks.reduce((sum, task) => sum + task.cand.repeats, 0)

  const tokensComparable = usageComplete(base) && usageComplete(cand) && merged.counts.pairs > 0
  const costComparable = tokensComparable && usablePairs.length > 0

  const warnings = []
  const baseModel = modelKey(base)
  const candModel = modelKey(cand)
  if (baseModel && candModel && baseModel !== candModel) warnings.push(`model-mismatch: ${baseModel} != ${candModel}`)
  if (!usageComplete(base)) warnings.push('usage-incomplete:base')
  if (!usageComplete(cand)) warnings.push('usage-incomplete:cand')
  for (const id of ids) {
    if (!baseRuns.has(id)) warnings.push(`task-missing:base:${id}`)
    if (!candRuns.has(id)) warnings.push(`task-missing:cand:${id}`)
  }
  const baseDsh = sideDshVersion(base, 'base')
  const candDsh = sideDshVersion(cand, 'cand')
  if (baseDsh && candDsh && baseDsh !== candDsh) warnings.push(`dsh-version-mismatch: ${baseDsh} != ${candDsh}`)
  if (baseRunsCount !== candRunsCount) warnings.push(`repeat-count-mismatch: ${baseRunsCount} != ${candRunsCount}`)
  // Everything pairing could not use is named, so no measurement disappears quietly.
  if (merged.counts.missingBase > 0) warnings.push(`pair-missing-base: ${merged.counts.missingBase}`)
  if (merged.counts.missingCand > 0) warnings.push(`pair-missing-cand: ${merged.counts.missingCand}`)
  if (merged.counts.duplicates > 0) warnings.push(`pair-duplicate-key: ${merged.counts.duplicates}`)
  if (merged.counts.labelMismatches > 0) warnings.push(`pair-label-mismatch: ${merged.counts.labelMismatches}`)
  if (merged.counts.invalid > 0) warnings.push(`pair-invalid-row: ${merged.counts.invalid}`)
  if (excluded.total > 0) warnings.push(`cost-pairs-excluded: ${excluded.total} (base ${excluded.baseFailed}, cand ${excluded.candFailed}, both ${excluded.bothFailed})`)

  const gate = {
    failOn,
    tolerancePct,
    aggregate,
    regressionScope,
    noiseFloorPct: noise.pct,
    costBasis: 'paired-both-passed',
    tokensComparable,
    costComparable,
    usablePairs: usablePairs.length,
    excludedPairs: excluded.total,
    passDropFailed: false,
    regressionFailed: false,
    fail: false,
    primary: null,
    reasons: [],
  }

  // Pass-rate first, always: a token win must never be able to buy a failed task.
  if (failOn === 'pass-drop' || failOn === 'both') {
    for (const task of tasks) {
      if (task.cand.passRate < task.base.passRate) {
        gate.passDropFailed = true
        gate.reasons.push(`pass-drop: ${task.id} ${task.base.passed}/${task.base.repeats} -> ${task.cand.passed}/${task.cand.repeats}`)
      }
    }
    if (baseRunsCount > 0 && candRunsCount > 0 && candPasses / candRunsCount < basePasses / baseRunsCount) {
      gate.passDropFailed = true
      gate.reasons.push(`pass-drop: TOTAL ${basePasses}/${baseRunsCount} -> ${candPasses}/${candRunsCount}`)
    }
  }

  // Then cost, and only if a direction can be read at all.
  if (failOn === 'regression' || failOn === 'both') {
    if (!tokensComparable) {
      gate.reasons.push('token gate skipped: usage incomplete on at least one side')
    } else if (!costComparable) {
      gate.reasons.push(`token gate skipped: no pair passed on both sides (${excluded.total} pair(s) excluded)`)
    } else if (!isNumber(noise.pct)) {
      gate.reasons.push('token gate skipped: no A/A noise floor; pass noiseFloorPct or noise:{base,cand} to read a direction')
    } else {
      if (regressionScope === 'total' || regressionScope === 'both') {
        if (totalCost.regressed) {
          gate.regressionFailed = true
          gate.reasons.push(`token regression (TOTAL): ${formatNumber(candGrandTotal)} > ${formatNumber(baseGrandTotal * (1 + tolerancePct / 100))} (base ${formatNumber(baseGrandTotal)} + ${tolerancePct}%; noise ±${noise.pct}%)`)
        }
      }
      if (regressionScope === 'task' || regressionScope === 'both') {
        for (const task of tasks) {
          if (!task.cost.regressed) continue
          gate.regressionFailed = true
          gate.reasons.push(`token regression: ${task.id} ${formatNumber(task.paired.candValue)} > ${formatNumber(task.paired.baseValue * (1 + tolerancePct / 100))} (base ${formatNumber(task.paired.baseValue)} + ${tolerancePct}%; noise ±${noise.pct}%)`)
        }
      }
    }
  }

  gate.fail = gate.passDropFailed || gate.regressionFailed
  gate.primary = gate.passDropFailed ? 'pass-drop' : gate.regressionFailed ? 'regression' : null

  return {
    format: COMPARE_FORMAT,
    condition,
    environment,
    base: { label: sideLabel(base, 'base'), profile: sideProfile(base, 'base'), model: baseModel, dshVersion: sideDshVersion(base, 'base') },
    cand: { label: sideLabel(cand, 'cand'), profile: sideProfile(cand, 'cand'), model: candModel, dshVersion: sideDshVersion(cand, 'cand') },
    aggregate,
    tolerancePct,
    pairing: {
      counts: merged.counts,
      complete: merged.complete,
      usablePairs: usablePairs.length,
      excluded,
      missingBase: merged.missingBase,
      missingCand: merged.missingCand,
      duplicates: merged.duplicates,
      labelMismatches: merged.labelMismatches,
      invalid: merged.invalid,
    },
    noiseFloor: noise,
    tasks,
    totals: {
      baseGrandTotal,
      candGrandTotal,
      grandTotalPct: totalCost.pct,
      grandTotalGeomeanPct: geometricMeanPct(tasks.map((task) => task.paired.pct)),
      cost: totalCost,
      baseSteps: sumStat(tasks, (task) => task.base[keys.stepsKey]),
      candSteps: sumStat(tasks, (task) => task.cand[keys.stepsKey]),
      baseToolCalls: sumStat(tasks, (task) => task.base[keys.toolsKey]),
      candToolCalls: sumStat(tasks, (task) => task.cand[keys.toolsKey]),
      baseToolErrors: sumStat(tasks, (task) => task.base[keys.errorsKey]),
      candToolErrors: sumStat(tasks, (task) => task.cand[keys.errorsKey]),
      baseDurationMs: sumStat(tasks, (task) => task.base[keys.durationKey]),
      candDurationMs: sumStat(tasks, (task) => task.cand[keys.durationKey]),
      basePasses,
      baseRuns: baseRunsCount,
      candPasses,
      candRuns: candRunsCount,
      basePassRate: baseRunsCount === 0 ? 0 : basePasses / baseRunsCount,
      candPassRate: candRunsCount === 0 ? 0 : candPasses / candRunsCount,
      buckets: bucketDeltas(usablePairs),
    },
    overhead: rollUpOverhead(tasks),
    gate,
    verdict: {
      pass: !gate.fail,
      primary: gate.primary,
      cost: { ...totalCost, basis: 'paired-both-passed', pairs: usablePairs.length, excludedPairs: excluded.total },
    },
    warnings,
  }
}
