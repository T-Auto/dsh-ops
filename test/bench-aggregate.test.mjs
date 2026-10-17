/**
 * The aggregation gate: `bench/lib/aggregate.mjs`, the one place a raw event stream
 * becomes numbers.
 *
 * Nothing here spawns a process or reads a file — the aggregator is a pure sink, so
 * the suite pins its output to exact objects. The checks are organised around the
 * four promises a later comparison relies on:
 *
 * 1. **The usage arithmetic is honest.** `grandTotal` is exactly the four core
 *    buckets, `reasoningTokens` is an optional bucket that never enters it, and a
 *    bucket nobody reported stays unnamed in `usageBucketsSeen` rather than being
 *    laundered into a reported zero.
 * 2. **A partial run is not a complete one.** One step without usage degrades the
 *    whole run (`usageReported: false`) instead of understating one step.
 * 3. **The two aggregator forms agree.** Streaming (`createAggregator`) and batch
 *    (`aggregateLines`) share one code path; the suite proves it, including CRLF.
 *    Bad and truncated lines are counted and reported, never silently dropped.
 * 4. **Attribution conserves the total.** Per-step and per-tool token attribution
 *    add back up to the run's own bucket totals, exactly, even when a step calls an
 *    odd number of tools.
 *
 * @module dsh-ops/test/bench-aggregate
 */

import { assert, report, test } from './lib/harness.mjs'

import {
  CORE_BUCKETS,
  METRICS_FORMAT,
  OPTIONAL_BUCKETS,
  PROMPT_BUCKETS,
  aggregateLines,
  createAggregator,
  median,
  metricsKey,
  minValue,
  pairMetrics,
} from '../bench/lib/aggregate.mjs'

const LABEL = 'bench-aggregate'

/** Serialize one event as the NDJSON line the aggregator consumes. */
const ev = (event) => JSON.stringify(event)

/** A `step_end` line, with or without a usage object. */
const stepEnd = (usage, extra = {}) => ev({ type: 'status', phase: 'step_end', ...extra, ...(usage ? { usage } : {}) })

/** A metrics-document stand-in for the pairing checks: the join key and the label. */
const row = (taskId, repeatIndex, label) => ({ format: METRICS_FORMAT, taskId, repeatIndex, label })

/** Sum the four core buckets of a usage object, independently of `grandTotal`. */
const coreSum = (usage) => CORE_BUCKETS.reduce((sum, bucket) => sum + usage[bucket], 0)

// ---------------------------------------------------------------- usage arithmetic

await test('the bucket vocabulary is the four core, one optional and three prompt buckets', () => {
  assert.deepEqual(CORE_BUCKETS, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
  assert.deepEqual(OPTIONAL_BUCKETS, ['reasoningTokens'])
  assert.deepEqual(PROMPT_BUCKETS, ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
  assert.equal(CORE_BUCKETS.includes('reasoningTokens'), false, 'reasoning must never be a grand-total term')
})

await test('a complete stream aggregates exactly and the four core buckets sum to grandTotal', () => {
  const metrics = aggregateLines([
    ev({ type: 'session', sessionId: 'session-abc', cwd: '/tmp/x' }),
    ev({ type: 'status', phase: 'turn_start', turn: 0 }),
    ev({ type: 'thinking', text: 'hmm' }),
    stepEnd({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 5 }, { turn: 0, step: 0 }),
    stepEnd({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, { turn: 0, step: 1 }),
    ev({ type: 'status', phase: 'turn_end', turn: 0, reason: { kind: 'completed' } }),
    ev({ type: 'final', text: 'done' }),
  ], { label: 'cand', profile: 'bench-ops', taskId: 'csv-sum', repeatIndex: 1 })

  assert.equal(metrics.format, METRICS_FORMAT)
  assert.equal(metrics.label, 'cand')
  assert.equal(metrics.profile, 'bench-ops')
  assert.equal(metrics.taskId, 'csv-sum')
  assert.equal(metrics.repeatIndex, 1)
  assert.equal(metrics.sessionId, 'session-abc')
  assert.equal(metrics.usageReported, true)
  assert.equal(metrics.usage.grandTotal, coreSum(metrics.usage))
  assert.equal(metrics.usage.grandTotal, 190)
  assert.equal(metrics.usage.reasoningTokens, 5, 'the optional bucket is reported …')
  assert.notEqual(metrics.usage.grandTotal, 195, '… and is not one of the grand total terms')
  assert.deepEqual(metrics.usageBucketsSeen, ['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'outputTokens', 'reasoningTokens'])
  assert.equal(metrics.steps, 2)
  assert.equal(metrics.turns, 1)
  assert.equal(metrics.turnEndReason, 'completed')
})

await test('a bucket the provider never reported is absent, never laundered into a reported zero', () => {
  const bare = aggregateLines([stepEnd({ inputTokens: 1, outputTokens: 1 })])
  assert.equal(Object.hasOwn(bare.usage, 'cacheReadTokens'), true, 'a core bucket is always a grand-total placeholder …')
  assert.equal(bare.usage.cacheReadTokens, 0)
  assert.equal(bare.usage.cacheWriteTokens, 0)
  assert.equal(Object.hasOwn(bare.usage, 'reasoningTokens'), false, '… but an optional bucket is simply not there')
  assert.deepEqual(bare.usageBucketsSeen, ['inputTokens', 'outputTokens'], 'and only the reported buckets are named')
  assert.equal(bare.usage.grandTotal, 2)

  // The moment any step reports reasoning, the bucket appears — still outside the total.
  const withReasoning = aggregateLines([
    stepEnd({ inputTokens: 1, outputTokens: 1 }),
    stepEnd({ inputTokens: 0, outputTokens: 0, reasoningTokens: 7 }),
  ])
  assert.equal(withReasoning.usage.reasoningTokens, 7)
  assert.equal(withReasoning.usage.grandTotal, 2, 'reasoning tokens never inflate the grand total')
  assert.deepEqual(withReasoning.usageBucketsSeen, ['inputTokens', 'outputTokens', 'reasoningTokens'])
})

await test('usageReported is all-or-nothing and a partial sum is kept, not repaired', () => {
  const partial = aggregateLines([
    stepEnd({ inputTokens: 10, outputTokens: 1 }, { turn: 0, step: 0 }),
    stepEnd(null, { turn: 0, step: 1 }),
  ])
  assert.equal(partial.steps, 2)
  assert.equal(partial.stepsWithUsage, 1)
  assert.equal(partial.usageReported, false, 'one silent step must degrade the whole run')
  assert.equal(partial.usage.grandTotal, 11, 'the partial sum is still recorded, and it is a lower bound')
  assert.equal(partial.stepUsage[1].usage, null, 'the silent step is unknown, not a zero row')

  const noSteps = aggregateLines([ev({ type: 'text', text: 'x' })])
  assert.equal(noSteps.steps, 0)
  assert.equal(noSteps.usageReported, false, 'no steps is not "reported complete"')
  assert.equal(noSteps.usage.grandTotal, 0)

  // Inherited from the ported implementation and pinned here so a change is
  // deliberate: a `usage` object with no recognizable bucket counts as a reported
  // step, so the run reads as complete with an all-zero total. Nothing names a
  // bucket, so `usageBucketsSeen` stays empty — but the "reported" flag does not.
  const emptyUsage = aggregateLines([stepEnd({})])
  assert.equal(emptyUsage.usageReported, true)
  assert.deepEqual(emptyUsage.usageBucketsSeen, [])
  assert.equal(emptyUsage.usage.grandTotal, 0)
})

await test('the streaming form and the batch form agree, including CRLF and blank lines', () => {
  const lines = [
    ev({ type: 'session', sessionId: 's' }),
    ev({ type: 'tool_call', callId: 'c', tool: 'bash', input: {} }),
    stepEnd({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
  ]
  const context = { label: 'base', profile: 'bench-base', taskId: 'csv-sum', repeatIndex: 2 }
  const streaming = createAggregator(context)
  for (const line of lines) streaming.push(`${line}\n`)
  assert.deepEqual(streaming.finish(), aggregateLines(lines, context))

  const crlf = createAggregator(context)
  for (const line of lines) crlf.push(`${line}\r\n`)
  crlf.push('')
  crlf.push('\n')
  assert.deepEqual(crlf.finish(), streaming.finish(), 'line endings and blank lines must not change a number')
})

await test('bad, truncated and untyped lines are counted, never silently dropped', () => {
  const metrics = aggregateLines([
    '{not json',
    '',
    '   ',
    '[1,2]',
    ev({ noType: true }),
    ev({ type: 'error', message: 'x'.repeat(400) }),
    ev({ type: 'text', text: 'cut', truncated: true }),
  ])
  assert.equal(metrics.malformedLines, 4)
  assert.equal(metrics.eventCount, 2)
  assert.equal(metrics.truncatedLines, 1)
  assert.equal(metrics.errorEvents.length, 1)
  assert.equal(metrics.errorEvents[0].message.length, 201, 'clamped to 200 characters plus the ellipsis')
})

await test('median and minValue answer for odd, even and empty samples', () => {
  assert.equal(median([100, 200, 300]), 200)
  assert.equal(median([100, 201]), 150.5, 'an even sample keeps the half token, so a later round can decide')
  assert.equal(median([]), null)
  assert.equal(minValue([3, 1, 2]), 1)
  assert.equal(minValue([]), null)
  // The prompt block rounds its median; the exported median is the unrounded one.
  const metrics = aggregateLines([stepEnd({ inputTokens: 1, outputTokens: 0 }), stepEnd({ inputTokens: 2, outputTokens: 0 })])
  assert.equal(metrics.prompt.median, 2, 'median of [1, 2] is 1.5, rounded for the prompt block')
})

// ---------------------------------------------------------------- attribution

await test('per-step and per-tool attribution conserve every bucket and the grand total', () => {
  const metrics = aggregateLines([
    ev({ type: 'tool_call', callId: 'c1', tool: 'grep', input: {} }),
    ev({ type: 'tool_call', callId: 'c2', tool: 'bash', input: {} }),
    stepEnd({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 3 }, { turn: 0, step: 0 }),
    ev({ type: 'tool_call', callId: 'c3', tool: 'grep', input: {} }),
    stepEnd({ inputTokens: 7, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 0 }, { turn: 0, step: 1 }),
    stepEnd({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 1 }, { turn: 0, step: 2 }),
    ev({ type: 'tool_call', callId: 'c4', tool: 'ops_read', input: {} }),
    stepEnd({ inputTokens: 1, outputTokens: 1 }, { turn: 1, step: 3 }),
    ev({ type: 'tool_call', callId: 'c5', tool: 'bash', input: {} }),
    stepEnd(null, { turn: 1, step: 4 }),
  ])

  // The run's own totals, unaffected by attribution.
  assert.equal(metrics.usageReported, false, 'step 4 reported nothing')
  assert.deepEqual(
    [metrics.usage.inputTokens, metrics.usage.outputTokens, metrics.usage.cacheReadTokens, metrics.usage.cacheWriteTokens, metrics.usage.grandTotal],
    [21, 12, 2, 1, 36],
  )

  // Every step is recorded; the silent one is unknown rather than a zero row.
  assert.equal(metrics.stepUsage.length, 5)
  assert.deepEqual(metrics.stepUsage[0].tools, ['grep', 'bash'])
  assert.equal(metrics.stepUsage[1].promptTokens, 9, 'prompt = input + cache read + cache write, never the output')
  assert.deepEqual(metrics.stepUsage[4], { turn: 1, step: 4, promptTokens: null, usage: null, tools: ['bash'] })

  // A two-call step splits evenly with the remainder on the first call (10/2, 5 → 3+2, 3 → 2+1).
  assert.deepEqual(metrics.toolUsage.grep.usage, { inputTokens: 12, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 2, grandTotal: 21 })
  assert.deepEqual(metrics.toolUsage.bash.usage, { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 1, grandTotal: 7 })
  assert.deepEqual(metrics.toolUsage.ops_read.usage, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, grandTotal: 2 })
  assert.deepEqual(metrics.unattributedUsage, { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 1, grandTotal: 6 })

  // Calls and step-presence stay structural, and cover calls in a step without usage.
  assert.equal(metrics.toolUsage.grep.calls, 2)
  assert.equal(metrics.toolUsage.grep.steps, 2)
  assert.equal(metrics.toolUsage.bash.calls, 2)
  assert.equal(metrics.toolUsage.bash.steps, 2, 'a call in a usage-less step still counts as a step')
  assert.equal(metrics.toolUsage.ops_read.calls, 1)
  assert.equal(metrics.toolUsage.ops_read.steps, 1)
  assert.deepEqual(metrics.toolCallsByName, { grep: 2, bash: 2, ops_read: 1 })

  assert.deepEqual(metrics.attribution, { tools: 30, unattributed: 6, balanced: true })
  assert.equal(metrics.attribution.tools + metrics.attribution.unattributed, metrics.usage.grandTotal)

  // Conservation, bucket by bucket, across the two views plus the unattributed rest.
  for (const bucket of [...CORE_BUCKETS, ...OPTIONAL_BUCKETS]) {
    const perTool = Object.values(metrics.toolUsage).reduce((sum, entry) => sum + (entry.usage[bucket] ?? 0), 0)
    const unattributed = metrics.unattributedUsage[bucket] ?? 0
    assert.equal(perTool + unattributed, metrics.usage[bucket] ?? 0, `${bucket} must conserve`)
  }

  // An absent bucket in a split stays absent for that tool: `ops_read` only ever
  // reported input and output, so its zeros for the rest are placeholders.
  assert.deepEqual(metrics.toolUsage.ops_read.usageBucketsSeen, ['inputTokens', 'outputTokens'])
  assert.equal(metrics.toolUsage.ops_read.usage.cacheReadTokens, 0)
  assert.deepEqual(metrics.toolUsage.grep.usageBucketsSeen, ['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'outputTokens', 'reasoningTokens'])
})

// ---------------------------------------------------------------- pairing primitive

await test('pairMetrics joins on (taskId, repeatIndex) and reports what did not pair', () => {
  const base = [row('csv-sum', 1, 'bench-base'), row('csv-sum', 2, 'bench-base'), row('api-rename', 1, 'bench-base')]
  const cand = [row('csv-sum', 1, 'bench-ops'), row('api-rename', 1, 'bench-ops'), row('log-triage', 1, 'bench-ops')]
  const merged = pairMetrics(base, cand)

  assert.deepEqual(merged.pairs.map((pair) => [pair.taskId, pair.repeatIndex]), [['api-rename', 1], ['csv-sum', 1]], 'pairs are sorted by task then repeat')
  assert.equal(merged.pairs[1].base, base[0], 'the merge returns the caller\'s rows, it does not copy them')
  assert.deepEqual(merged.counts, { base: 3, cand: 3, pairs: 2, missingBase: 1, missingCand: 1, duplicates: 0, labelMismatches: 0, invalid: 0 })
  assert.equal(merged.complete, false)
  assert.deepEqual(merged.missingBase.map((entry) => entry.taskId), ['log-triage'], 'a candidate with no baseline cannot be judged')
  assert.deepEqual(merged.missingCand.map((entry) => [entry.taskId, entry.repeatIndex]), [['csv-sum', 2]])
  assert.equal(merged.pairs[0].base.label, 'bench-base')
  assert.equal(merged.pairs[0].cand.label, 'bench-ops')

  const complete = pairMetrics(base.slice(0, 2), cand.slice(0, 1))
  assert.equal(complete.complete, false, 'one side has an extra repeat')
  const exact = pairMetrics([row('a', 1, 'x')], [row('a', 1, 'x')])
  assert.equal(exact.complete, true, 'a clean one-to-one merge is complete')
  assert.equal(exact.counts.pairs, 1)
})

await test('pairMetrics reports duplicates, label mismatches and invalid join keys', () => {
  const duplicated = pairMetrics(
    [row('a', 1, 'base'), row('a', 1, 'base')],
    [row('a', 1, 'cand')],
    { baseLabel: 'base', candLabel: 'cand' },
  )
  assert.equal(duplicated.counts.pairs, 1, 'the first row of a repeated key is kept')
  assert.deepEqual(duplicated.duplicates, [{ side: 'base', index: 1, taskId: 'a', repeatIndex: 1, keptIndex: 0 }])
  assert.equal(duplicated.complete, false)

  const mislabeled = pairMetrics([row('a', 1, 'base')], [row('a', 1, 'base')], { baseLabel: 'base', candLabel: 'cand' })
  assert.equal(mislabeled.counts.pairs, 0, 'a row on the wrong side is reported, never paired')
  assert.deepEqual(mislabeled.labelMismatches, [{ side: 'cand', index: 0, taskId: 'a', repeatIndex: 1, expected: 'cand', actual: 'base' }])

  const malformed = pairMetrics(
    [row('a', 1, 'base'), { taskId: '', repeatIndex: 1 }, row('b', 0, 'base'), row('c', 1.5, 'base'), null],
    [row('a', 1, 'cand')],
  )
  assert.deepEqual(malformed.invalid.map((entry) => entry.reason), [
    'taskId must be a non-empty string',
    'repeatIndex must be a positive integer',
    'repeatIndex must be a positive integer',
    'not-an-object',
  ])
  assert.equal(malformed.counts.pairs, 1)
  assert.equal(malformed.complete, false)

  // The key is what names the pair, and it refuses to guess a missing half.
  assert.equal(metricsKey('a', 1), 'a\u00001')
  assert.throws(() => metricsKey('', 1), /non-empty string/)
  assert.throws(() => metricsKey('a', 0), /positive integer/)
})

report(LABEL)
