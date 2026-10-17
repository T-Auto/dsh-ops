/**
 * Two run summaries → the comparison structure (PLAN.md §6).
 *
 * Pure functions, no filesystem access: `run.mjs` writes summaries, this decides
 * what they mean. Everything numeric a gate touches lives here so a test can pin
 * it without a model, a server, or a Windows box.
 *
 * The three rules the whole module serves:
 *
 * 1. **A token delta needs two complete usage sets.** If either side lost a single
 *    `step_end.usage`, `tokensComparable` is false, the token columns render as
 *    `n/a`, and the `regression` gate degrades to `pass-drop` only — comparing a
 *    known number against an unknown one would be worse than no number.
 * 2. **Cheaper and wrong is not an improvement.** `pass-drop` fails if any task's
 *    pass rate drops, so an optimization that shaves tokens by giving up on a task
 *    cannot pass the gate.
 * 3. **One task must not launder another one's regression.** The `regression` gate
 *    defaults to `task` scope: every task is checked against the tolerance on its
 *    own, and a win on the biggest task can no longer hide a loss on a smaller one
 *    (a sum-weighted TOTAL let exactly that through in the 2026-10-16 sweep).
 *    `total` scope is kept opt-in for comparing whole-corpus cost, and `both`
 *    enforces the two together. The geometric mean of per-task ratios rides along
 *    in `totals.grandTotalGeomeanPct` as the scale-free overall number.
 *
 * @module dsh-ops/bench/compare-core
 */

/** Statistics a caller may compare on. */
export const AGGREGATES = ['median', 'min']

/** Gate modes a caller may ask for. */
export const FAIL_ON = ['regression', 'pass-drop', 'both', 'none']

/** Which aggregate the `regression` gate judges: one task at a time, the sum, or both. */
export const REGRESSION_SCOPES = ['task', 'total', 'both']

/**
 * The median of a number list.
 * @param {number[]} values - the samples.
 * @returns {number|null} the median, or null for an empty list.
 */
export function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The minimum of a number list.
 * @param {number[]} values - the samples.
 * @returns {number|null} the minimum, or null for an empty list.
 */
export function minValue(values) {
  if (!values.length) return null
  return Math.min(...values)
}

/**
 * Aggregate one task's repeat runs into a single side of the comparison.
 * @param {object[]} metricsList - the metrics documents for one task on one side.
 * @returns {object} the per-side aggregate.
 */
export function aggregateTask(metricsList = []) {
  const numeric = (pick) => metricsList.map(pick).filter((value) => typeof value === 'number' && Number.isFinite(value))
  const totals = numeric((metrics) => metrics?.usage?.grandTotal ?? 0)
  const inputs = numeric((metrics) => metrics?.usage?.inputTokens ?? 0)
  const outputs = numeric((metrics) => metrics?.usage?.outputTokens ?? 0)
  const cacheReads = numeric((metrics) => metrics?.usage?.cacheReadTokens ?? 0)
  const cacheWrites = numeric((metrics) => metrics?.usage?.cacheWriteTokens ?? 0)
  const reasonings = numeric((metrics) => metrics?.usage?.reasoningTokens ?? 0)
  const steps = numeric((metrics) => metrics?.steps ?? 0)
  const toolCalls = numeric((metrics) => metrics?.toolCalls ?? 0)
  const toolErrors = numeric((metrics) => metrics?.toolErrors ?? 0)
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
      return typeof total === 'number' && Number.isFinite(total) && count > 0 ? total / count : null
    })
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
  const promptComplete = metricsList.length > 0 && metricsList.every((metrics) => metrics?.prompt?.reported === true)
  const passed = metricsList.filter((metrics) => metrics?.verify?.passed === true).length
  const complete = metricsList.length > 0 && metricsList.every((metrics) => metrics?.usageReported === true)
  // Per-tool counts are summed over the repeats rather than medianed: a tool that is
  // called once in one repeat and never again is a real adoption signal, and a
  // median of zeros would erase it. A tool absent from every repeat is absent here
  // too (the stream only records tools that were actually called).
  const toolCallsByName = {}
  for (const metrics of metricsList) {
    for (const [name, count] of Object.entries(metrics?.toolCallsByName ?? {})) {
      if (typeof count !== 'number' || !Number.isFinite(count)) continue
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
    toolCallsByName,
    toolErrorsMedian: median(toolErrors),
    toolErrorsMin: minValue(toolErrors),
    passRate: metricsList.length === 0 ? 0 : passed / metricsList.length,
    passed,
    usageComplete: complete,
  }
}

/**
 * The geometric mean of per-task percent changes — the scale-free "overall
 * effect on this corpus" figure. Unlike the summed TOTAL it weights every task
 * equally, so the biggest task cannot dominate it. Tasks missing on either side,
 * or with an unusable base value (zero or unknown), are skipped; null when none
 * qualify.
 * @param {number[]} pcts - the per-task `grandTotalPct` values.
 * @returns {number|null} the geometric mean percent, or null.
 */
export function geometricMeanPct(pcts) {
  const usable = pcts.filter((value) => typeof value === 'number' && Number.isFinite(value) && value > -100)
  if (usable.length === 0) return null
  const logSum = usable.reduce((sum, value) => sum + Math.log(1 + value / 100), 0)
  return Math.round((Math.exp(logSum / usable.length) - 1) * 1000) / 10
}

/**
 * Compare two run summaries.
 * @param {object} base - the baseline `summary.json` document.
 * @param {object} cand - the candidate `summary.json` document.
 * @param {{aggregate?: 'median'|'min', tolerancePct?: number, failOn?: 'regression'|'pass-drop'|'both'|'none', regressionScope?: 'task'|'total'|'both'}} [options] - comparison options.
 * @returns {object} the §6 comparison structure, including the gate outcome.
 */
export function compareSummaries(base, cand, options = {}) {
  const aggregate = options.aggregate ?? 'median'
  const tolerancePct = Number.isFinite(options.tolerancePct) ? options.tolerancePct : 2
  const failOn = options.failOn ?? 'both'
  const regressionScope = REGRESSION_SCOPES.includes(options.regressionScope) ? options.regressionScope : 'task'

  const baseRuns = groupByTask(base?.results ?? [])
  const candRuns = groupByTask(cand?.results ?? [])
  const ids = [...new Set([...baseRuns.keys(), ...candRuns.keys()])]
  const statKey = aggregate === 'min' ? 'grandTotalMin' : 'grandTotalMedian'
  const stepsKey = aggregate === 'min' ? 'stepsMin' : 'stepsMedian'
  const toolsKey = aggregate === 'min' ? 'toolCallsMin' : 'toolCallsMedian'
  const errorsKey = aggregate === 'min' ? 'toolErrorsMin' : 'toolErrorsMedian'
  const firstPromptKey = aggregate === 'min' ? 'firstRequestPromptMin' : 'firstRequestPromptMedian'
  const promptTotalKey = aggregate === 'min' ? 'promptTotalMin' : 'promptTotalMedian'
  const inputKey = aggregate === 'min' ? 'inputMin' : 'inputMedian'
  const outputKey = aggregate === 'min' ? 'outputMin' : 'outputMedian'
  const cacheReadKey = aggregate === 'min' ? 'cacheReadMin' : 'cacheReadMedian'

  const tasks = ids.map((id) => {
    const baseSide = aggregateTask(baseRuns.get(id) ?? [])
    const candSide = aggregateTask(candRuns.get(id) ?? [])
    const baseValue = baseSide[statKey]
    const candValue = candSide[statKey]
    return {
      id,
      inBase: baseRuns.has(id),
      inCand: candRuns.has(id),
      regressed: false,
      base: baseSide,
      cand: candSide,
      overhead: decomposeOverhead(baseSide, candSide, { firstPromptKey, stepsKey, promptTotalKey, outputKey, cacheReadKey }),
      delta: {
        grandTotalPct: percentChange(baseValue, candValue),
        grandTotalAbs: numberOr(baseValue, 0) === 0 && numberOr(candValue, 0) === 0 ? 0 : numberOr(candValue, 0) - numberOr(baseValue, 0),
        firstRequestPromptAbs: Number.isFinite(baseSide[firstPromptKey]) && Number.isFinite(candSide[firstPromptKey])
          ? candSide[firstPromptKey] - baseSide[firstPromptKey]
          : null,
        firstRequestPromptPct: percentChange(baseSide[firstPromptKey], candSide[firstPromptKey]),
        stepsPct: percentChange(baseSide[stepsKey], candSide[stepsKey]),
        toolCallsPct: percentChange(baseSide[toolsKey], candSide[toolsKey]),
        toolErrorsPct: percentChange(baseSide[errorsKey], candSide[errorsKey]),
        passRateAbs: candSide.passRate - baseSide.passRate,
      },
    }
  })

  const baseTotal = sumStat(tasks, (task) => task.base[statKey])
  const candTotal = sumStat(tasks, (task) => task.cand[statKey])
  const basePasses = tasks.reduce((sum, task) => sum + task.base.passed, 0)
  const baseRunsCount = tasks.reduce((sum, task) => sum + task.base.repeats, 0)
  const candPasses = tasks.reduce((sum, task) => sum + task.cand.passed, 0)
  const candRunsCount = tasks.reduce((sum, task) => sum + task.cand.repeats, 0)

  const warnings = []
  const baseModel = modelKey(base)
  const candModel = modelKey(cand)
  if (baseModel && candModel && baseModel !== candModel) {
    warnings.push(`model-mismatch: ${baseModel} != ${candModel}`)
  }
  if (!usageComplete(base)) warnings.push('usage-incomplete:base')
  if (!usageComplete(cand)) warnings.push('usage-incomplete:cand')
  for (const id of ids) {
    if (!baseRuns.has(id)) warnings.push(`task-missing:base:${id}`)
    if (!candRuns.has(id)) warnings.push(`task-missing:cand:${id}`)
  }
  if (base?.dshVersion && cand?.dshVersion && base.dshVersion !== cand.dshVersion) {
    warnings.push(`dsh-version-mismatch: ${base.dshVersion} != ${cand.dshVersion}`)
  }
  if (baseRunsCount !== candRunsCount) warnings.push(`repeat-count-mismatch: ${baseRunsCount} != ${candRunsCount}`)

  const tokensComparable = usageComplete(base) && usageComplete(cand) && tasks.length > 0
  const gate = {
    failOn,
    tolerancePct,
    aggregate,
    regressionScope,
    tokensComparable,
    regressionFailed: false,
    passDropFailed: false,
    reasons: [],
  }
  if (failOn !== 'none') {
    if (tokensComparable && (failOn === 'regression' || failOn === 'both')) {
      if (regressionScope === 'total' || regressionScope === 'both') {
        const limit = baseTotal * (1 + tolerancePct / 100)
        if (candTotal > limit) {
          gate.regressionFailed = true
          gate.reasons.push(`token regression (TOTAL): ${formatNumber(candTotal)} > ${formatNumber(limit)} (base ${formatNumber(baseTotal)} + ${tolerancePct}%)`)
        }
      }
      if (regressionScope === 'task' || regressionScope === 'both') {
        for (const task of tasks) {
          const baseValue = task.base[statKey]
          const candValue = task.cand[statKey]
          if (typeof baseValue !== 'number' || typeof candValue !== 'number') continue
          if (task.base.repeats === 0 || task.cand.repeats === 0) continue
          if (candValue > baseValue * (1 + tolerancePct / 100)) {
            task.regressed = true
            gate.regressionFailed = true
            gate.reasons.push(`token regression: ${task.id} ${formatNumber(candValue)} > ${formatNumber(baseValue * (1 + tolerancePct / 100))} (base ${formatNumber(baseValue)} + ${tolerancePct}%)`)
          }
        }
      }
    } else if (!tokensComparable && (failOn === 'regression' || failOn === 'both')) {
      gate.reasons.push('token gate skipped: usage incomplete on at least one side')
    }
    if (failOn === 'pass-drop' || failOn === 'both') {
      const dropped = tasks.filter((task) => task.cand.passRate < task.base.passRate)
      for (const task of dropped) {
        gate.passDropFailed = true
        gate.reasons.push(`pass-drop: ${task.id} ${task.base.passed}/${task.base.repeats} -> ${task.cand.passed}/${task.cand.repeats}`)
      }
      if (candRunsCount > 0 && baseRunsCount > 0 && candPasses / candRunsCount < basePasses / baseRunsCount) {
        gate.passDropFailed = true
        gate.reasons.push(`pass-drop: TOTAL ${basePasses}/${baseRunsCount} -> ${candPasses}/${candRunsCount}`)
      }
    }
  }
  gate.fail = gate.regressionFailed || gate.passDropFailed

  return {
    format: 'dsh-ops-bench-compare-v1',
    base: { label: base?.label ?? null, profile: base?.profile ?? null, model: baseModel, dshVersion: base?.dshVersion ?? null },
    cand: { label: cand?.label ?? null, profile: cand?.profile ?? null, model: candModel, dshVersion: cand?.dshVersion ?? null },
    aggregate,
    tasks,
    totals: {
      baseGrandTotal: baseTotal,
      candGrandTotal: candTotal,
      grandTotalPct: percentChange(baseTotal, candTotal),
      grandTotalGeomeanPct: geometricMeanPct(tasks.map((task) => task.delta.grandTotalPct)),
      baseSteps: sumStat(tasks, (task) => task.base[stepsKey]),
      candSteps: sumStat(tasks, (task) => task.cand[stepsKey]),
      baseToolCalls: sumStat(tasks, (task) => task.base[toolsKey]),
      candToolCalls: sumStat(tasks, (task) => task.cand[toolsKey]),
      baseToolErrors: sumStat(tasks, (task) => task.base[errorsKey]),
      candToolErrors: sumStat(tasks, (task) => task.cand[errorsKey]),
      basePasses,
      baseRuns: baseRunsCount,
      candPasses,
      candRuns: candRunsCount,
      basePassRate: baseRunsCount === 0 ? 0 : basePasses / baseRunsCount,
      candPassRate: candRunsCount === 0 ? 0 : candPasses / candRunsCount,
      buckets: bucketDeltas(tasks, { inputKey, outputKey, cacheReadKey, statKey }),
    },
    overhead: rollUpOverhead(tasks),
    gate,
    warnings,
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
 * - `residualTokens`: everything the first-order model does not explain — bigger
 *   tool results carried in the history, context that grew faster or slower, and
 *   steps that were saved. Negative residual means the candidate's history was
 *   leaner than the baseline's, which is the effect a tuning change is usually
 *   actually after.
 *
 * `outputDelta` is reported separately: guessing more or thinking longer is not a
 * context-size effect and must not be read as one.
 * @param {object} baseSide - the aggregated baseline side of one task.
 * @param {object} candSide - the aggregated candidate side of one task.
 * @param {{firstPromptKey: string, stepsKey: string, promptTotalKey: string, outputKey: string, cacheReadKey: string}} keys - the statistic names for this aggregate.
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
  if (!needed.every((value) => typeof value === 'number' && Number.isFinite(value))) {
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
    cacheReadDelta: typeof shape.baseCacheRead === 'number' && typeof shape.candCacheRead === 'number' ? shape.candCacheRead - shape.baseCacheRead : null,
  }
}

/**
 * Sum the per-task decompositions into the corpus-level picture.
 * @param {object[]} tasks - the task rows.
 * @returns {object} the roll-up, with `comparableTasks` of `tasks` carrying numbers.
 */
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

/**
 * The corpus-level delta per usage bucket, and each bucket's share of the total
 * delta. `grandTotal` is the sum of the three, so the shares add up to 100% — which
 * is the point: "the candidate costs 54% more" is a different fact from "89% of the
 * increase is cache reads, which are usually priced an order of magnitude below
 * uncached input". The gate still judges `grandTotal`; this only says what is in it.
 * @param {object[]} tasks - the task rows.
 * @param {{inputKey: string, outputKey: string, cacheReadKey: string, statKey: string}} keys - the statistic names for this aggregate.
 * @returns {{input: object, output: object, cacheRead: object, grandTotal: object, comparable: boolean}} the per-bucket deltas.
 */
function bucketDeltas(tasks, keys) {
  const side = (bucket) => ({
    base: sumStat(tasks, (task) => task.base[bucket]),
    cand: sumStat(tasks, (task) => task.cand[bucket]),
  })
  const total = { base: sumStat(tasks, (task) => task.base[keys.statKey]), cand: sumStat(tasks, (task) => task.cand[keys.statKey]) }
  const totalDelta = typeof total.base === 'number' && typeof total.cand === 'number' ? total.cand - total.base : null
  const withShare = ({ base: baseValue, cand: candValue }) => {
    const delta = typeof baseValue === 'number' && typeof candValue === 'number' ? candValue - baseValue : null
    return {
      base: baseValue,
      cand: candValue,
      delta,
      sharePct: delta === null || totalDelta === null || totalDelta === 0 ? null : Math.round((delta / totalDelta) * 1000) / 10,
    }
  }
  const input = withShare(side(keys.inputKey))
  const output = withShare(side(keys.outputKey))
  const cacheRead = withShare(side(keys.cacheReadKey))
  return {
    comparable: [input, output, cacheRead].every((bucket) => bucket.delta !== null),
    input,
    output,
    cacheRead,
    grandTotal: withShare(total),
  }
}

/**
 * Metrics documents grouped by task id, ordered by first appearance.
 * @param {object[]} results - the summary's `results` array.
 * @returns {Map<string, object[]>} the groups.
 */
export function groupByTask(results) {
  const groups = new Map()
  for (const metrics of results) {
    const id = String(metrics?.taskId ?? '<no-task-id>')
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(metrics)
  }
  return groups
}

/**
 * Did every run on this side report complete usage?
 * @param {object} summary - a run summary.
 * @returns {boolean} true when every run's usage is complete.
 */
export function usageComplete(summary) {
  const results = summary?.results ?? []
  if (results.length === 0) return false
  return results.every((metrics) => metrics?.usageReported === true)
}

/**
 * The `provider/model` identity of a side, for the mismatch warning.
 * @param {object} summary - a run summary.
 * @returns {string|null} the identity, or null when it is unknown.
 */
export function modelKey(summary) {
  const provider = summary?.model?.provider
  const model = summary?.model?.model
  if (!provider && !model) return null
  return `${provider ?? '?'}/${model ?? '?'}`
}

/**
 * Percent change from base to candidate.
 * @param {number|null} base - the baseline value.
 * @param {number|null} cand - the candidate value.
 * @returns {number|null} the signed percent, rounded to a tenth, or null when base is 0 or unknown.
 */
export function percentChange(base, cand) {
  if (typeof base !== 'number' || typeof cand !== 'number') return null
  if (base === 0) return cand === 0 ? 0 : null
  return Math.round(((cand - base) / Math.abs(base)) * 1000) / 10
}

/**
 * Sum a per-task statistic, skipping tasks that never ran on that side.
 * @param {object[]} tasks - the task rows.
 * @param {(task: object) => number|null} pick - the statistic.
 * @returns {number|null} the sum, or null when nothing contributed.
 */
function sumStat(tasks, pick) {
  let sum = 0
  let seen = false
  for (const task of tasks) {
    const value = pick(task)
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    sum += value
    seen = true
  }
  return seen ? sum : null
}

/**
 * A number or a fallback.
 * @param {number|null} value - the candidate.
 * @param {number} fallback - the value when the candidate is unknown.
 * @returns {number} the result.
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Thousands-separated integer rendering.
 * @param {number|null} value - the number.
 * @returns {string} the display form.
 */
export function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return Math.round(value).toLocaleString('en-US')
}
