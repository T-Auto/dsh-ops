/**
 * NDJSON event stream → one run's metrics.
 *
 * The aggregator is a pure sink: feed it the raw lines `dsh --json` printed and it
 * returns the numbers, with no I/O and no clock, so a test can pin its output to an
 * exact object. The runner uses the streaming form (`createAggregator`) because the
 * event file is written as it arrives, but both go through the same per-line code.
 *
 * The one rule that shapes everything here: **never launder a partial usage total
 * into a complete one.** DSH omits `step_end.usage` when any attempt of that step
 * went unreported, so `stepsWithUsage < steps` means the token numbers are a lower
 * bound, and `usageReported: false` tells the comparison to refuse a token verdict
 * rather than compare two unknown-sized halves of the same run. The same honesty
 * applies one level down: `usageBucketsSeen` names the buckets the provider
 * actually reported, so a `0` placeholder for a bucket nobody mentioned is never
 * read as "the provider said zero", and `reasoningTokens` is simply absent until
 * some step reports it.
 *
 * The second thing it keeps is the **shape of the run, not just its total**: every
 * step's prompt size (input + cacheRead + cacheWrite) is recorded alongside the sum,
 * because a run that spends 70k tokens over 4 fat requests and a run that spends 70k
 * over 12 thin ones are the same number and not the same measurement. The first
 * step's prompt is the one that carries no history — system prompt + tool schemas +
 * task text — so its base→candidate delta is the plugin's per-request fixed cost.
 *
 * The third thing it keeps is **where the tokens went**: `stepUsage` records each
 * step's usage next to the tools it called, and `toolUsage` folds that into a
 * per-tool total, splitting a step's usage evenly across the calls made in it. The
 * two views conserve the run's totals exactly (see {@link buildAttribution}), which
 * is what lets a panel show a token-attribution chart that adds up. Pairing two
 * sides by `(taskId, repeatIndex)` is {@link pairMetrics}; it merges and validates
 * only and deliberately decides nothing.
 *
 * @module dsh-ops/bench/aggregate
 */

/** The metrics document format tag; the comparison refuses anything else. */
export const METRICS_FORMAT = 'dsh-ops-bench-metrics-v1'

/** The four mutually exclusive usage buckets whose sum is `grandTotal`. */
export const CORE_BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/** Optional buckets: present only when the provider reported them at least once. */
export const OPTIONAL_BUCKETS = ['reasoningTokens']

/** The non-output buckets: their sum is the prompt that was re-sent on every step. */
export const PROMPT_BUCKETS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/**
 * A fresh streaming aggregator.
 * @param {{label?: string, profile?: string, taskId?: string, repeatIndex?: number}} [context] - identity fields copied into the result.
 * @returns {{push(line: string): void, finish(): object}} the aggregator.
 */
export function createAggregator(context = {}) {
  const state = {
    sessionId: null,
    turns: 0,
    steps: 0,
    stepsWithUsage: 0,
    toolCalls: 0,
    toolErrors: 0,
    textChars: 0,
    thinkingChars: 0,
    finalTextBytes: 0,
    finalSeen: false,
    turnEndReason: null,
    eventCount: 0,
    malformedLines: 0,
    truncatedLines: 0,
    errorEvents: [],
    toolCallsByName: Object.create(null),
    usage: emptyUsage(),
    bucketsSeen: new Set(),
    // The prompt shape of the run. `prompts` is every step that reported a size, in
    // order; `firstPrompt` is set only by the run's **first** step, so a run whose
    // step 1 lost its usage reports an unknown first request instead of silently
    // promoting step 2's smaller, already-warm prompt to "the request with no history".
    prompts: [],
    firstPrompt: null,
    firstStepSeen: false,
    turnFirsts: [],
    // Token attribution: the tools called since the last step_end, the per-step
    // records, and the per-tool fold. `unattributedUsage` is the usage of steps that
    // called no tool at all (the model's own wrap-up turns).
    pendingTools: [],
    pendingTurn: null,
    pendingStep: null,
    stepUsage: [],
    toolUsage: Object.create(null),
    unattributedUsage: emptyUsage(),
    unattributedSeen: new Set(),
  }

  return {
    /**
     * Consume one raw stdout line (blank lines are ignored, not malformed).
     * @param {string} line - the line, with or without its newline.
     * @returns {void}
     */
    push(line) {
      const text = String(line ?? '').replace(/\r?\n$/, '')
      if (text === '') return
      let event
      try {
        event = JSON.parse(text)
      } catch {
        state.malformedLines += 1
        return
      }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
        state.malformedLines += 1
        return
      }
      state.eventCount += 1
      if (event.truncated === true) state.truncatedLines += 1
      applyEvent(state, event)
    },

    /**
     * Freeze the metrics fragment.
     * @returns {object} the aggregated fields, in the metrics-document shape.
     */
    finish() {
      return buildMetrics(state, context)
    },
  }
}

/**
 * Aggregate a whole stream at once.
 * @param {string[]} lines - the raw NDJSON lines.
 * @param {object} [context] - identity fields copied into the result.
 * @returns {object} the aggregated fields.
 */
export function aggregateLines(lines, context = {}) {
  const aggregator = createAggregator(context)
  for (const line of lines ?? []) aggregator.push(line)
  return aggregator.finish()
}

/**
 * Fold a single parsed event into the accumulator.
 * @param {object} state - the internal accumulator.
 * @param {object} event - the parsed event.
 * @returns {void}
 */
function applyEvent(state, event) {
  switch (event.type) {
    case 'session':
      if (typeof event.sessionId === 'string' && state.sessionId === null) state.sessionId = event.sessionId
      return
    case 'status': {
      if (event.phase === 'turn_start') state.turns += 1
      if (event.phase === 'step_start') {
        state.pendingTurn = stepIndex(event.turn ?? event.data?.turn)
        state.pendingStep = stepIndex(event.step ?? event.data?.step)
      }
      if (event.phase === 'turn_end') {
        const kind = event.reason?.kind
        state.turnEndReason = typeof kind === 'string' ? kind : 'unknown'
      }
      if (event.phase === 'step_end') closeStep(state, event)
      return
    }
    case 'tool_call': {
      state.toolCalls += 1
      const name = toolName(event)
      state.toolCallsByName[name] = (state.toolCallsByName[name] ?? 0) + 1
      toolEntry(state, name).calls += 1
      state.pendingTools.push(name)
      return
    }
    case 'tool_result':
      if (event.status === 'error') state.toolErrors += 1
      return
    case 'text':
      state.textChars += charLength(event.text)
      return
    case 'thinking':
      state.thinkingChars += charLength(event.text)
      return
    case 'final':
      state.finalSeen = true
      state.finalTextBytes = Buffer.byteLength(typeof event.text === 'string' ? event.text : '', 'utf8')
      return
    case 'error':
      state.errorEvents.push({ message: clampMessage(event.message) })
      return
    default:
      // Unknown event types still count as events: a future dsh that adds a
      // telemetry event must not look like a lost line.
      return
  }
}

/**
 * Close one `step_end`: count it, record its label and prompt size, fold its usage
 * into the run totals, and attribute that usage to the tools the step called.
 * @param {object} state - the internal accumulator.
 * @param {object} event - the `step_end` event.
 * @returns {void}
 */
function closeStep(state, event) {
  const firstStep = !state.firstStepSeen
  state.firstStepSeen = true
  state.steps += 1

  const tools = state.pendingTools
  state.pendingTools = []
  const turn = stepIndex(event.turn ?? event.data?.turn) ?? state.pendingTurn
  const step = stepIndex(event.step ?? event.data?.step) ?? state.pendingStep
  for (const name of new Set(tools)) toolEntry(state, name).steps += 1

  const usage = event.usage
  if (!usage || typeof usage !== 'object') {
    // A step that lost its usage is recorded as unknown, never as a zero row: the
    // token it spent is simply not attributable.
    state.stepUsage.push({ turn, step, promptTokens: null, usage: null, tools })
    return
  }

  state.stepsWithUsage += 1
  addUsage(state, usage)

  const totals = emptyUsage()
  const seen = new Set()
  addBuckets(totals, seen, usage)
  const prompt = promptTokens(usage)
  state.stepUsage.push({ turn, step, promptTokens: prompt, usage: freezeUsage(totals, seen), tools })
  attributeStep(state, tools, totals, seen)

  if (prompt !== null) {
    state.prompts.push(prompt)
    if (firstStep) state.firstPrompt = prompt
    const turnIndex = stepIndex(event.turn ?? event.data?.turn)
    if (turnIndex !== null && !state.turnFirsts.some((entry) => entry.turn === turnIndex)) {
      state.turnFirsts.push({ turn: turnIndex, tokens: prompt })
    }
  }
}

/**
 * Add one step's usage to the running totals, tracking which buckets appeared.
 * @param {object} state - the internal accumulator.
 * @param {object} usage - the provider-reported usage object.
 * @returns {void}
 */
function addUsage(state, usage) {
  addBuckets(state.usage, state.bucketsSeen, usage)
}

/**
 * Accumulate the numeric buckets of a usage source into a totals object, recording
 * exactly which buckets the source actually named.
 * @param {object} totals - the bucket totals to accumulate into.
 * @param {Set<string>} seen - the set the named buckets are added to.
 * @param {object} source - a provider usage object, or a step's totals keyed by bucket.
 * @returns {void}
 */
function addBuckets(totals, seen, source) {
  for (const bucket of [...CORE_BUCKETS, ...OPTIONAL_BUCKETS]) {
    const value = source[bucket]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    seen.add(bucket)
    totals[bucket] += Math.max(0, Math.round(value))
  }
}

/**
 * Attribute one step's usage to the tools it called: each reported bucket is split
 * evenly across the step's calls, with the integer remainder going to the first
 * calls, so the per-tool totals sum back to the step (and thus to the run) exactly.
 * A step that called no tool lands in the unattributed bucket instead.
 * @param {object} state - the internal accumulator.
 * @param {string[]} tools - the tool names called during the step, in call order.
 * @param {object} totals - the step's bucket totals.
 * @param {Set<string>} seen - the buckets the step actually reported.
 * @returns {void}
 */
function attributeStep(state, tools, totals, seen) {
  if (tools.length === 0) {
    for (const bucket of seen) {
      state.unattributedUsage[bucket] += totals[bucket]
      state.unattributedSeen.add(bucket)
    }
    return
  }
  for (const bucket of seen) {
    const shares = splitEvenly(totals[bucket], tools.length)
    tools.forEach((name, index) => {
      const entry = toolEntry(state, name)
      entry.usage[bucket] += shares[index]
      entry.usageSeen.add(bucket)
    })
  }
}

/**
 * Split a non-negative integer into `parts` integers that sum to it exactly.
 * @param {number} total - the amount to split.
 * @param {number} parts - how many shares.
 * @returns {number[]} the shares, in order.
 */
function splitEvenly(total, parts) {
  const base = Math.floor(total / parts)
  let remainder = total - base * parts
  const shares = []
  for (let index = 0; index < parts; index += 1) {
    shares.push(base + (remainder > 0 ? 1 : 0))
    if (remainder > 0) remainder -= 1
  }
  return shares
}

/**
 * The mutable per-tool attribution entry, created on first sight.
 * @param {object} state - the internal accumulator.
 * @param {string} name - the tool name.
 * @returns {{calls: number, steps: number, usage: object, usageSeen: Set<string>}} the entry.
 */
function toolEntry(state, name) {
  let entry = state.toolUsage[name]
  if (!entry) {
    entry = { calls: 0, steps: 0, usage: emptyUsage(), usageSeen: new Set() }
    state.toolUsage[name] = entry
  }
  return entry
}

/**
 * The tool name of a `tool_call`, matching the per-tool call counts.
 * @param {object} event - the event.
 * @returns {string} the tool name, or `'<unknown>'`.
 */
function toolName(event) {
  return typeof event.tool === 'string' && event.tool !== '' ? event.tool : '<unknown>'
}

/**
 * A fresh all-zero bucket totals object (never handed out to callers directly).
 * @returns {object} the totals.
 */
function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

/**
 * Freeze bucket totals into a usage object: the four core buckets always appear
 * (they are the grand total's terms), an optional bucket appears only when it was
 * reported, and `grandTotal` never includes reasoning tokens.
 * @param {object} totals - the bucket totals.
 * @param {Set<string>} seen - the buckets the source actually reported.
 * @returns {object} the usage object.
 */
function freezeUsage(totals, seen) {
  const usage = {}
  for (const bucket of CORE_BUCKETS) usage[bucket] = totals[bucket]
  for (const bucket of OPTIONAL_BUCKETS) {
    if (seen.has(bucket)) usage[bucket] = totals[bucket]
  }
  usage.grandTotal = CORE_BUCKETS.reduce((sum, bucket) => sum + totals[bucket], 0)
  return usage
}

/**
 * The prompt size of one step: everything the model was re-sent that was not its
 * own output. `totalTokens` is the fallback for a provider that reports only the
 * combined figure (it includes the output tokens, so they are subtracted).
 * @param {object} usage - one step's usage object.
 * @returns {number|null} the prompt token count, or null when nothing usable is there.
 */
function promptTokens(usage) {
  let sum = 0
  let seen = false
  for (const bucket of PROMPT_BUCKETS) {
    const value = usage[bucket]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    sum += Math.max(0, Math.round(value))
    seen = true
  }
  if (seen) return sum
  const total = usage.totalTokens
  const output = usage.outputTokens
  if (typeof total === 'number' && Number.isFinite(total)) {
    return Math.max(0, Math.round(total) - (typeof output === 'number' && Number.isFinite(output) ? Math.round(output) : 0))
  }
  return null
}

/**
 * A turn/step number from an event, or null when the stream did not label it.
 * @param {unknown} value - the raw field.
 * @returns {number|null} the index, or null.
 */
function stepIndex(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The prompt-size summary of a run: the first request, the per-turn first requests,
 * and the distribution of every step's prompt. All nulls when no step reported usage.
 * @param {object} state - the internal accumulator.
 * @returns {object} the `prompt` block of the metrics document.
 */
function buildPrompt(state) {
  const sizes = state.prompts
  return {
    reported: state.steps > 0 && state.stepsWithUsage === state.steps && sizes.length === state.steps,
    firstStep: state.firstPrompt,
    median: roundOrNull(median(sizes)),
    max: sizes.length > 0 ? Math.max(...sizes) : null,
    total: sizes.length > 0 ? sizes.reduce((sum, value) => sum + value, 0) : null,
    // The first request of each turn: on a multi-turn task this is where the history
    // the model chose to carry shows up, and it separates "asked little" from
    // "kept little" — two runs with the same total and different behaviour.
    perTurn: state.turnFirsts.map((entry) => ({ turn: entry.turn, tokens: entry.tokens })),
  }
}

/**
 * The per-tool attribution document: call count, the number of steps that called it,
 * its attributed usage, and the buckets that usage actually came from.
 * @param {object} state - the internal accumulator.
 * @returns {object} tool name → attribution entry, in sorted name order.
 */
function buildToolUsage(state) {
  const out = {}
  for (const name of Object.keys(state.toolUsage).sort()) {
    const entry = state.toolUsage[name]
    out[name] = {
      calls: entry.calls,
      steps: entry.steps,
      usage: freezeUsage(entry.usage, entry.usageSeen),
      usageBucketsSeen: [...entry.usageSeen].sort(),
    }
  }
  return out
}

/**
 * The conservation rollup of the attribution views: what the tools were charged,
 * what no tool was charged for, and whether the two reconstitute the run.
 * @param {object} state - the internal accumulator.
 * @returns {{tools: number, unattributed: number, balanced: boolean}} the rollup.
 */
function buildAttribution(state) {
  let tools = 0
  for (const name of Object.keys(state.toolUsage)) {
    tools += CORE_BUCKETS.reduce((sum, bucket) => sum + state.toolUsage[name].usage[bucket], 0)
  }
  const unattributed = CORE_BUCKETS.reduce((sum, bucket) => sum + state.unattributedUsage[bucket], 0)
  const total = CORE_BUCKETS.reduce((sum, bucket) => sum + state.usage[bucket], 0)
  return { tools, unattributed, balanced: tools + unattributed === total }
}

/**
 * Render the metrics fragment from the accumulator state.
 * @param {object} state - the internal accumulator.
 * @param {object} context - identity fields to copy in.
 * @returns {object} the fragment.
 */
function buildMetrics(state, context) {
  return {
    format: METRICS_FORMAT,
    label: context.label ?? null,
    profile: context.profile ?? null,
    taskId: context.taskId ?? null,
    repeatIndex: context.repeatIndex ?? null,
    sessionId: state.sessionId,
    turnEndReason: state.turnEndReason,
    usage: freezeUsage(state.usage, state.bucketsSeen),
    // "Usage complete" is all-or-nothing on purpose: one silent step is enough to
    // make a token delta meaningless, so it degrades the whole run instead of
    // quietly understating one step.
    usageReported: state.steps > 0 && state.stepsWithUsage === state.steps,
    prompt: buildPrompt(state),
    usageBucketsSeen: [...state.bucketsSeen].sort(),
    steps: state.steps,
    stepsWithUsage: state.stepsWithUsage,
    turns: state.turns,
    toolCalls: state.toolCalls,
    toolErrors: state.toolErrors,
    toolCallsByName: { ...state.toolCallsByName },
    // Token attribution, for the panel's per-step and per-tool views and for P11's
    // paired comparison. Conservation is exact and checked by `attribution.balanced`.
    stepUsage: state.stepUsage,
    toolUsage: buildToolUsage(state),
    unattributedUsage: freezeUsage(state.unattributedUsage, state.unattributedSeen),
    attribution: buildAttribution(state),
    textChars: state.textChars,
    thinkingChars: state.thinkingChars,
    finalTextBytes: state.finalTextBytes,
    finalSeen: state.finalSeen,
    eventCount: state.eventCount,
    malformedLines: state.malformedLines,
    truncatedLines: state.truncatedLines,
    errorEvents: state.errorEvents,
  }
}

/**
 * The median of a number list.
 * @param {number[]} values - the samples.
 * @returns {number|null} the median, or null for an empty list.
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null
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
  if (!Array.isArray(values) || values.length === 0) return null
  return Math.min(...values)
}

/**
 * Round a median, preserving the null-for-empty case.
 * @param {number|null} value - the median.
 * @returns {number|null} the rounded median.
 */
function roundOrNull(value) {
  return value === null ? null : Math.round(value)
}

/**
 * The join key of one measurement row: the task it measured and which repeat of
 * that task it is. Both halves are required — a row without a repeat index cannot
 * be paired, and guessing one would compare the wrong two runs.
 * @param {string} taskId - the task id.
 * @param {number} repeatIndex - the 1-based repeat number.
 * @returns {string} the key.
 */
export function metricsKey(taskId, repeatIndex) {
  if (typeof taskId !== 'string' || taskId === '') throw new TypeError('metricsKey: taskId must be a non-empty string')
  if (!Number.isInteger(repeatIndex) || repeatIndex < 1) throw new TypeError('metricsKey: repeatIndex must be a positive integer')
  return `${taskId}\u0000${repeatIndex}`
}

/**
 * Merge two sides' metrics documents into `(taskId, repeatIndex)` pairs.
 *
 * This is the whole of the pairing primitive: it sorts the two lists into one
 * deterministic row order, records what could not be paired (one side missing, a
 * repeated index, a mislabeled or structurally invalid row), and reports whether
 * the merge was complete. It deliberately decides nothing — no tolerance, no gate,
 * no direction; that judgement belongs to the comparison layer.
 * @param {object[]} baseMetrics - the baseline side's metrics documents.
 * @param {object[]} candMetrics - the candidate side's metrics documents.
 * @param {{baseLabel?: string|null, candLabel?: string|null}} [options] - expected arm labels; when given, a row whose `label` differs is reported instead of paired.
 * @returns {object} `{pairs, missingBase, missingCand, duplicates, labelMismatches, invalid, counts, complete}`.
 */
export function pairMetrics(baseMetrics, candMetrics, options = {}) {
  const base = indexSide(baseMetrics, 'base', options.baseLabel ?? null)
  const cand = indexSide(candMetrics, 'cand', options.candLabel ?? null)

  const rows = []
  for (const key of new Set([...base.entries.keys(), ...cand.entries.keys()])) {
    const left = base.entries.get(key) ?? null
    const right = cand.entries.get(key) ?? null
    const source = left ?? right
    rows.push({ taskId: source.taskId, repeatIndex: source.repeatIndex, base: left, cand: right })
  }
  rows.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.repeatIndex - b.repeatIndex))

  const pairs = []
  const missingBase = []
  const missingCand = []
  for (const row of rows) {
    if (row.base && row.cand) pairs.push({ taskId: row.taskId, repeatIndex: row.repeatIndex, base: row.base.metrics, cand: row.cand.metrics })
    else if (row.base) missingCand.push({ taskId: row.taskId, repeatIndex: row.repeatIndex, base: row.base.metrics })
    else missingBase.push({ taskId: row.taskId, repeatIndex: row.repeatIndex, cand: row.cand.metrics })
  }

  const duplicates = [...base.duplicates, ...cand.duplicates]
  const labelMismatches = [...base.labelMismatches, ...cand.labelMismatches]
  const invalid = [...base.invalid, ...cand.invalid]
  return {
    pairs,
    missingBase,
    missingCand,
    duplicates,
    labelMismatches,
    invalid,
    counts: {
      base: Array.isArray(baseMetrics) ? baseMetrics.length : 0,
      cand: Array.isArray(candMetrics) ? candMetrics.length : 0,
      pairs: pairs.length,
      missingBase: missingBase.length,
      missingCand: missingCand.length,
      duplicates: duplicates.length,
      labelMismatches: labelMismatches.length,
      invalid: invalid.length,
    },
    // Complete means every input row was paired on both sides exactly once. Any
    // other outcome is something a caller must handle, not smooth over.
    complete: duplicates.length === 0 && labelMismatches.length === 0 && invalid.length === 0
      && missingBase.length === 0 && missingCand.length === 0,
  }
}

/**
 * Index one side's metrics by join key, reporting every row that cannot be indexed.
 * @param {object[]} metricsList - the side's metrics documents.
 * @param {'base'|'cand'} side - which side this is.
 * @param {string|null} expectedLabel - the label every row must carry, or null to skip the check.
 * @returns {{entries: Map<string, object>, duplicates: object[], labelMismatches: object[], invalid: object[]}} the index.
 */
function indexSide(metricsList, side, expectedLabel) {
  const entries = new Map()
  const duplicates = []
  const labelMismatches = []
  const invalid = []
  const list = Array.isArray(metricsList) ? metricsList : []
  list.forEach((metrics, index) => {
    if (!metrics || typeof metrics !== 'object') {
      invalid.push({ side, index, reason: 'not-an-object' })
      return
    }
    if (typeof metrics.taskId !== 'string' || metrics.taskId === '') {
      invalid.push({ side, index, reason: 'taskId must be a non-empty string' })
      return
    }
    if (!Number.isInteger(metrics.repeatIndex) || metrics.repeatIndex < 1) {
      invalid.push({ side, index, reason: 'repeatIndex must be a positive integer' })
      return
    }
    if (expectedLabel !== null && metrics.label !== expectedLabel) {
      labelMismatches.push({ side, index, taskId: metrics.taskId, repeatIndex: metrics.repeatIndex, expected: expectedLabel, actual: metrics.label ?? null })
      return
    }
    const row = { index, taskId: metrics.taskId, repeatIndex: metrics.repeatIndex, metrics }
    const key = metricsKey(row.taskId, row.repeatIndex)
    if (entries.has(key)) {
      duplicates.push({ side, index, taskId: row.taskId, repeatIndex: row.repeatIndex, keptIndex: entries.get(key).index })
      return
    }
    entries.set(key, row)
  })
  return { entries, duplicates, labelMismatches, invalid }
}

/**
 * Length of a text payload, tolerating a missing one.
 * @param {unknown} text - the payload.
 * @returns {number} the character count.
 */
function charLength(text) {
  return typeof text === 'string' ? text.length : 0
}

/**
 * Clamp an error message for the metrics document.
 * @param {unknown} message - the raw message.
 * @returns {string} at most 200 characters.
 */
function clampMessage(message) {
  const text = typeof message === 'string' ? message : JSON.stringify(message ?? null)
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`
}
