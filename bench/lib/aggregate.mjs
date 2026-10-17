/**
 * NDJSON event stream → one run's metrics (PLAN.md §2.2, §4.4).
 *
 * The aggregator is a pure sink: feed it the raw lines `dsh --json` printed and it
 * returns the numbers, with no I/O and no clock, so a test can pin its output to an
 * exact object. `run.mjs` uses the streaming form (`createAggregator`) because the
 * event file is written as it arrives, but both go through the same per-line code.
 *
 * The one rule that shapes everything here: **never launder a partial usage total
 * into a complete one.** DSH omits `step_end.usage` when any attempt of that step
 * went unreported, so `stepsWithUsage < steps` means the token numbers are a lower
 * bound, and `usageReported: false` tells `compare.mjs` to refuse a token verdict
 * rather than compare two unknown-sized halves of the same run.
 *
 * The second thing it keeps is the **shape of the run, not just its total**: every
 * step's prompt size (input + cacheRead + cacheWrite) is recorded alongside the sum,
 * because a run that spends 70k tokens over 4 fat requests and a run that spends 70k
 * over 12 thin ones are the same number and not the same measurement. The first
 * step's prompt is the one that carries no history — system prompt + tool schemas +
 * task text — so its base→candidate delta is the plugin's per-request fixed cost
 * (`compare.mjs` renders exactly that).
 *
 * @module dsh-ops/bench/aggregate
 */

/** The metrics document format tag; `compare.mjs` refuses anything else. */
export const METRICS_FORMAT = 'dsh-ops-bench-metrics-v1'

/** The four mutually exclusive usage buckets that always appear. */
const CORE_BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/** Optional buckets: present only when the provider reported them at least once. */
const OPTIONAL_BUCKETS = ['reasoningTokens']

/** The non-output buckets: their sum is the prompt that was re-sent on every step. */
const PROMPT_BUCKETS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']

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
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    bucketsSeen: new Set(),
    // The prompt shape of the run. `prompts` is every step that reported a size, in
    // order; `firstPrompt` is set only by the run's **first** step, so a run whose
    // step 1 lost its usage reports an unknown first request instead of silently
    // promoting step 2's smaller, already-warm prompt to "the request with no history".
    prompts: [],
    firstPrompt: null,
    firstStepSeen: false,
    turnFirsts: [],
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
     * @returns {object} the aggregated fields, in the §4.4 shape.
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
      if (event.phase === 'turn_end') {
        const kind = event.reason?.kind
        state.turnEndReason = typeof kind === 'string' ? kind : 'unknown'
      }
      if (event.phase === 'step_end') {
        const firstStep = !state.firstStepSeen
        state.firstStepSeen = true
        state.steps += 1
        const usage = event.usage
        if (usage && typeof usage === 'object') {
          state.stepsWithUsage += 1
          addUsage(state, usage)
          const prompt = promptTokens(usage)
          if (prompt !== null) {
            state.prompts.push(prompt)
            if (firstStep) state.firstPrompt = prompt
            const turn = stepIndex(event.turn ?? event.data?.turn)
            if (turn !== null && !state.turnFirsts.some((entry) => entry.turn === turn)) state.turnFirsts.push({ turn, tokens: prompt })
          }
        }
      }
      return
    }
    case 'tool_call': {
      state.toolCalls += 1
      const name = typeof event.tool === 'string' && event.tool !== '' ? event.tool : '<unknown>'
      state.toolCallsByName[name] = (state.toolCallsByName[name] ?? 0) + 1
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
 * Add one step's usage to the running totals, tracking which buckets appeared.
 * @param {object} state - the internal accumulator.
 * @param {object} usage - the provider-reported usage object.
 * @returns {void}
 */
function addUsage(state, usage) {
  for (const bucket of [...CORE_BUCKETS, ...OPTIONAL_BUCKETS]) {
    const value = usage[bucket]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    state.bucketsSeen.add(bucket)
    state.usage[bucket] += Math.max(0, Math.round(value))
  }
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
    median: medianOf(sizes),
    max: sizes.length > 0 ? Math.max(...sizes) : null,
    total: sizes.length > 0 ? sizes.reduce((sum, value) => sum + value, 0) : null,
    // The first request of each turn: on a multi-turn task this is where the history
    // the model chose to carry shows up, and it separates "asked little" from
    // "kept little" — two runs with the same total and different behaviour.
    perTurn: state.turnFirsts.map((entry) => ({ turn: entry.turn, tokens: entry.tokens })),
  }
}

/**
 * The median of a number list.
 * @param {number[]} values - the samples.
 * @returns {number|null} the median, or null for an empty list.
 */
function medianOf(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * Render the §4.4 metrics fragment from the accumulator state.
 * @param {object} state - the internal accumulator.
 * @param {object} context - identity fields to copy in.
 * @returns {object} the fragment.
 */
function buildMetrics(state, context) {
  const usage = {}
  for (const bucket of CORE_BUCKETS) usage[bucket] = state.usage[bucket]
  for (const bucket of OPTIONAL_BUCKETS) {
    if (state.bucketsSeen.has(bucket)) usage[bucket] = state.usage[bucket]
  }
  usage.grandTotal = CORE_BUCKETS.reduce((sum, bucket) => sum + state.usage[bucket], 0)

  return {
    format: METRICS_FORMAT,
    label: context.label ?? null,
    profile: context.profile ?? null,
    taskId: context.taskId ?? null,
    repeatIndex: context.repeatIndex ?? null,
    sessionId: state.sessionId,
    turnEndReason: state.turnEndReason,
    usage,
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
