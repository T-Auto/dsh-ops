/**
 * The comparison gate: `bench/lib/compare-core.mjs`, the one place two runs become a
 * verdict.
 *
 * Everything here is a pure call — no model, no server, no file — so the checks pin
 * the four rules the issue names:
 *
 * 1. **Pass-rate first.** A cheaper candidate that drops a task fails, and the
 *    pass-drop reason is the first thing the gate says.
 * 2. **Cost only on both-passed pairs.** A failed repeat is excluded and *counted*;
 *    it never silently moves the denominator.
 * 3. **No direction under the A/A noise floor.** A delta inside the band reports the
 *    band and `within-noise`, not a direction — even when it crosses the tolerance.
 * 4. **Scope and shape are explicit.** `task` is the default gate, `total` is opt-in,
 *    the geometric mean rides along, `median`/`min` change which number is compared,
 *    and both input shapes (`summary` and sealed `run.json`) pair the same way.
 *
 * @module dsh-ops/test/bench-compare-core
 */

import { assert, report, test } from './lib/harness.mjs'

import {
  AGGREGATES,
  COMPARE_FORMAT,
  FAIL_ON,
  NOISE_FORMAT,
  REGRESSION_SCOPES,
  compareSummaries,
  geometricMeanPct,
  median,
  minValue,
  noiseFloor,
  noiseFloorPct,
  percentChange,
} from '../bench/lib/compare-core.mjs'

const LABEL = 'bench-compare-core'

/**
 * A #183 summary-shaped metrics document: usage totals live on the document itself.
 * `repeatIndex` is omitted unless asked for, which is how those summaries were
 * written and exercises the ordinal fallback.
 * @param {string} taskId - the task.
 * @param {number} tokens - the grand total.
 * @param {boolean} pass - the verify outcome.
 * @param {object} [extra] - overrides.
 * @returns {object} the metrics document.
 */
function run(taskId, tokens, pass, extra = {}) {
  const input = Math.round(tokens * 0.7)
  return {
    format: 'dsh-ops-bench-metrics-v1',
    taskId,
    repeatIndex: extra.repeatIndex,
    usage: { inputTokens: input, outputTokens: tokens - input, cacheReadTokens: 0, cacheWriteTokens: 0, grandTotal: tokens },
    usageReported: extra.usageReported ?? true,
    steps: extra.steps ?? 4,
    toolCalls: extra.toolCalls ?? 6,
    toolErrors: extra.toolErrors ?? 0,
    toolCallsByName: {},
    verify: { passed: pass, checks: [] },
    exitCode: 0,
    timedOut: false,
  }
}

/** A #183 summary document. */
function summary(label, results) {
  return { format: 'dsh-ops-bench-summary-v1', label, profile: `bench-${label}`, dshVersion: '0.2.0-rc.2', model: { provider: 'bench-server', model: 'tester' }, results }
}

/**
 * A sealed `run.json` result row: the join key and the checks live on the row, the
 * numbers live under `metrics`, and the usage has no `grandTotal` (the schema sums
 * the four core buckets instead).
 * @param {string} taskId - the task.
 * @param {number} repeatIndex - the 1-based repeat.
 * @param {number} tokens - the input-token total.
 * @param {boolean} pass - the check outcome.
 * @returns {object} the row.
 */
function row(taskId, repeatIndex, tokens, pass) {
  return {
    taskId,
    repeatIndex,
    arm: 'bench-base',
    metrics: {
      startedAt: '2026-10-18T00:00:00.000Z',
      durationMs: 1,
      exit: 0,
      timedOut: false,
      steps: 2,
      toolCalls: 1,
      usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      usageReported: true,
      toolCallsByName: {},
      turnEndReason: 'completed',
    },
    verify: [{ type: 'fileExists', pass, detail: pass ? '' : 'missing' }],
    events: { path: 'x.ndjson' },
  }
}

/** A sealed `run.json` document around the given rows. */
function runDoc(side, results) {
  return {
    schemaVersion: 1,
    meta: { benchVersion: '0.0.0', mode: 'ab', platform: 'linux-x64', node: 'v24', argv: [], startedAt: '2026-10-18T00:00:00.000Z', endedAt: null, arms: {}, model: 'bench-server/tester' },
    arms: { base: { label: `${side}-base`, profile: 'bench-base', profileHash: 'h' }, cand: { label: `${side}-cand`, profile: 'bench-ops', profileHash: 'h' } },
    results,
    verify: { checks: 0, passed: 0, failed: 0, degraded: false },
    events: { layout: 'ndjson-per-run', merged: false, files: [] },
    archive: [],
  }
}

await test('the vocabularies and the scalar helpers are pinned', () => {
  assert.deepEqual(AGGREGATES, ['median', 'min'])
  assert.deepEqual(FAIL_ON, ['regression', 'pass-drop', 'both', 'none'])
  assert.deepEqual(REGRESSION_SCOPES, ['task', 'total', 'both'])
  assert.equal(COMPARE_FORMAT, 'dsh-ops-bench-compare-v1')
  assert.equal(NOISE_FORMAT, 'dsh-ops-bench-noise-v1')
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.equal(median([]), null)
  assert.equal(minValue([9, 2, 5]), 2)
  assert.equal(minValue([]), null)
  assert.equal(percentChange(200, 150), -25)
  assert.equal(percentChange(0, 5), null)
  assert.equal(percentChange(0, 0), 0)
})

await test('pass-drop outranks a token win and is the first reason given', () => {
  const base = summary('base', [run('csv-sum', 1000, true), run('csv-sum', 1000, true)])
  const cand = summary('cand', [run('csv-sum', 400, true), run('csv-sum', 400, false)])
  const comparison = compareSummaries(base, cand, { failOn: 'both', noiseFloorPct: 0 })
  assert.equal(comparison.gate.passDropFailed, true)
  assert.equal(comparison.gate.regressionFailed, false, 'a 60% cut is not a token regression')
  assert.equal(comparison.gate.fail, true)
  assert.equal(comparison.gate.primary, 'pass-drop')
  assert.equal(comparison.verdict.pass, false)
  assert.match(comparison.gate.reasons[0], /^pass-drop: csv-sum 2\/2 -> 1\/2/, 'the failure mode is named before the cost number')
  assert.equal(comparison.totals.grandTotalPct, -60, 'the cost is still reported, just not trusted')
})

await test('cost is computed only from pairs that passed on both sides, and the rest are counted', () => {
  const base = summary('base', [run('csv-sum', 1000, true), run('csv-sum', 1000, true), run('csv-sum', 1000, true)])
  const cand = summary('cand', [
    run('csv-sum', 500, true),
    run('csv-sum', 100, false),
    run('csv-sum', 200, false),
  ])
  const comparison = compareSummaries(base, cand, { failOn: 'pass-drop', noiseFloorPct: 0 })
  const task = comparison.tasks[0]
  assert.equal(task.paired.pairs, 1, 'only the pair whose candidate passed is a cost sample')
  assert.equal(task.paired.baseValue, 1000)
  assert.equal(task.paired.candValue, 500)
  assert.equal(task.paired.pct, -50, 'the failed repeats must not drag the delta to -73%')
  assert.deepEqual(task.paired.excluded, { baseFailed: 0, candFailed: 2, bothFailed: 0, total: 2 })
  assert.equal(task.paired.considered, 3)
  assert.equal(comparison.pairing.excluded.total, 2)
  assert.equal(comparison.gate.excludedPairs, 2)
  assert.ok(comparison.warnings.includes('cost-pairs-excluded: 2 (base 0, cand 2, both 0)'), comparison.warnings.join('\n'))
  assert.equal(comparison.totals.grandTotalPct, -50)

  // The baseline side is excluded on the same rule, and a both-failed pair is its
  // own bucket rather than being folded into either side.
  const flipped = compareSummaries(
    summary('base', [run('csv-sum', 1000, false), run('csv-sum', 1000, true)]),
    summary('cand', [run('csv-sum', 500, true), run('csv-sum', 500, true)]),
    { failOn: 'none', noiseFloorPct: 0 },
  )
  assert.deepEqual(flipped.tasks[0].paired.excluded, { baseFailed: 1, candFailed: 0, bothFailed: 0, total: 1 })
  assert.equal(flipped.tasks[0].paired.pct, -50)

  const both = compareSummaries(summary('base', [run('a', 1000, false)]), summary('cand', [run('a', 500, false)]), { failOn: 'none', noiseFloorPct: 0 })
  assert.deepEqual(both.tasks[0].paired.excluded, { baseFailed: 0, candFailed: 0, bothFailed: 1, total: 1 })
  assert.equal(both.tasks[0].paired.pct, null)
  assert.equal(both.gate.costComparable, false)
  assert.equal(both.tasks[0].cost.conclusion, 'incomparable')
})

await test('a delta inside the A/A noise floor gets the band, not a direction', () => {
  const base = summary('base', [run('csv-sum', 1000, true)])
  const cand = summary('cand', [run('csv-sum', 975, true)])
  const comparison = compareSummaries(base, cand, { tolerancePct: 2, failOn: 'both', noiseFloorPct: 3.1 })
  const task = comparison.tasks[0]
  assert.equal(task.cost.pct, -2.5)
  assert.equal(task.cost.withinNoise, true)
  assert.equal(task.cost.direction, null, 'inside the band there is no direction to report')
  assert.equal(task.cost.conclusion, 'within-noise')
  assert.deepEqual(task.cost.bandPct, { low: -3.1, high: 3.1 })
  assert.equal(task.cost.exceedsTolerance, true, 'it crossed the tolerance…')
  assert.equal(task.cost.regressed, false, '…but not the noise floor, so it is not a regression')
  assert.equal(comparison.gate.regressionFailed, false, 'tolerance alone must not manufacture a direction')
  assert.equal(comparison.verdict.cost.conclusion, 'within-noise')
  assert.equal(comparison.noiseFloor.method, 'provided')
})

await test('a delta beyond the noise floor reports a direction, and only then can it regress', () => {
  const base = summary('base', [run('csv-sum', 1000, true)])
  const cheaper = compareSummaries(base, summary('cand', [run('csv-sum', 926, true)]), { failOn: 'both', noiseFloorPct: 3.1 })
  assert.equal(cheaper.tasks[0].cost.pct, -7.4)
  assert.equal(cheaper.tasks[0].cost.direction, 'cheaper')
  assert.equal(cheaper.tasks[0].cost.withinNoise, false)
  assert.equal(cheaper.tasks[0].cost.conclusion, 'cheaper')
  assert.equal(cheaper.gate.fail, false)

  const costlier = compareSummaries(base, summary('cand', [run('csv-sum', 1050, true)]), { failOn: 'both', noiseFloorPct: 3.1 })
  assert.equal(costlier.tasks[0].cost.pct, 5)
  assert.equal(costlier.tasks[0].cost.direction, 'costlier')
  assert.equal(costlier.tasks[0].cost.regressed, true)
  assert.equal(costlier.gate.regressionFailed, true)
  assert.equal(costlier.verdict.primary, 'regression')
  assert.match(costlier.gate.reasons.join(' '), /noise ±3\.1%/, 'the reason names both thresholds it had to clear')
})

await test('without a noise floor the cost gate abstains instead of reading noise as a result', () => {
  const base = summary('base', [run('csv-sum', 1000, true)])
  const cand = summary('cand', [run('csv-sum', 1500, true)])
  const comparison = compareSummaries(base, cand, { failOn: 'both' })
  assert.equal(comparison.tasks[0].cost.pct, 50)
  assert.equal(comparison.tasks[0].cost.direction, null)
  assert.equal(comparison.tasks[0].cost.conclusion, 'noise-floor-unknown')
  assert.equal(comparison.gate.regressionFailed, false, 'a +50% move is not a verdict without a floor')
  assert.match(comparison.gate.reasons.join(' '), /no A\/A noise floor/)
  assert.equal(comparison.noiseFloor.pct, null)

  // …and it can be measured in-call from two A/A runs.
  const measured = compareSummaries(base, cand, { noise: { base: summary('aa-1', [run('csv-sum', 1000, true)]), cand: summary('aa-2', [run('csv-sum', 1040, true)]) } })
  assert.equal(measured.gate.noiseFloorPct, 4)
  assert.equal(measured.gate.regressionFailed, true, '+50% clears a measured 4% floor')
})

await test('noiseFloor measures the band from two baseline runs, pairing the same way', () => {
  const a = summary('aa-a', [run('csv-sum', 1000, true), run('api-rename', 500, true)])
  const b = summary('aa-b', [run('csv-sum', 1000, true), run('api-rename', 520, true)])
  const floor = noiseFloor(a, b)
  assert.equal(floor.format, NOISE_FORMAT)
  assert.equal(floor.method, 'aa-max-abs-task-pct')
  assert.equal(floor.comparable, true)
  assert.equal(floor.pct, 4, 'the widest no-change movement is the band')
  assert.equal(floor.medianAbsPct, 2)
  assert.deepEqual(floor.band, { low: -4, high: 4 })
  assert.deepEqual(floor.perTask.map((entry) => entry.id), ['api-rename', 'csv-sum'])
  assert.equal(noiseFloorPct(a, b), 4)

  // A side that failed is no more usable as noise than as cost.
  const excluded = noiseFloor(a, summary('aa-c', [run('csv-sum', 300, false), run('api-rename', 520, true)]))
  assert.equal(excluded.pairs, 1)
  assert.equal(excluded.excludedPairs, 1)
  assert.equal(excluded.pct, 4)

  // Nothing pairable means no floor, never a zero floor.
  const none = noiseFloor(summary('x', []), summary('y', []))
  assert.equal(none.pct, null)
  assert.equal(none.comparable, false)
  assert.equal(none.band, null)
  assert.equal(noiseFloorPct(undefined, undefined), null)
})

await test('task scope is the default, total scope is the hole it closes, and geomean is the overview', () => {
  const base = summary('base', [run('csv-sum', 300000, true), run('big-file-paging', 50000, true)])
  const cand = summary('cand', [run('csv-sum', 100000, true), run('big-file-paging', 130000, true)])
  const asTask = compareSummaries(base, cand, { tolerancePct: 2, failOn: 'both', regressionScope: 'task', noiseFloorPct: 0 })
  assert.equal(asTask.totals.grandTotalPct, -34.3, 'the sum says 34% cheaper overall …')
  assert.equal(asTask.gate.regressionFailed, true, '… and the per-task gate still says no')
  assert.equal(asTask.tasks.find((task) => task.id === 'big-file-paging').regressed, true)
  assert.equal(asTask.tasks.find((task) => task.id === 'csv-sum').regressed, false)
  assert.match(asTask.gate.reasons.join(' '), /token regression: big-file-paging/)
  assert.equal(asTask.totals.grandTotalGeomeanPct, -7, 'equal-weight overview: +160% and -66.7% average to about -7%')

  const asTotal = compareSummaries(base, cand, { tolerancePct: 2, failOn: 'both', regressionScope: 'total', noiseFloorPct: 0 })
  assert.equal(asTotal.gate.regressionFailed, false, 'total scope is exactly the masking this default closes')
  const both = compareSummaries(base, cand, { tolerancePct: 2, failOn: 'both', regressionScope: 'both', noiseFloorPct: 0 })
  assert.equal(both.gate.regressionFailed, true)
  // When the sum itself regresses, its reason is labelled as such — the same run
  // fails both scopes independently.
  const worseTotal = compareSummaries(
    summary('worse', [run('csv-sum', 1000, true)]),
    summary('better', [run('csv-sum', 1500, true)]),
    { tolerancePct: 2, failOn: 'regression', regressionScope: 'both', noiseFloorPct: 0 },
  )
  assert.match(worseTotal.gate.reasons.join(' '), /token regression \(TOTAL\)/)
  assert.match(worseTotal.gate.reasons.join(' '), /token regression: csv-sum/)

  assert.equal(geometricMeanPct([100, -50]), 0)
  assert.equal(geometricMeanPct([-100]), null, 'a -100% ratio has no logarithm')
  assert.equal(geometricMeanPct([null, -25, null]), -25)
  assert.equal(geometricMeanPct([]), null)
})

await test('the min aggregate compares the cheapest surviving pair on each side', () => {
  const base = summary('base', [run('csv-sum', 100, true), run('csv-sum', 900, true), run('csv-sum', 900, true)])
  const cand = summary('cand', [run('csv-sum', 80, true), run('csv-sum', 900, true), run('csv-sum', 900, true)])
  const asMedian = compareSummaries(base, cand, { aggregate: 'median', noiseFloorPct: 0 })
  const asMin = compareSummaries(base, cand, { aggregate: 'min', noiseFloorPct: 0 })
  assert.equal(asMedian.totals.baseGrandTotal, 900)
  assert.equal(asMedian.totals.candGrandTotal, 900)
  assert.equal(asMin.totals.baseGrandTotal, 100)
  assert.equal(asMin.totals.candGrandTotal, 80)
  assert.equal(asMin.tasks[0].paired.pctMin, -20)
  assert.equal(asMin.tasks[0].paired.pctMedian, 0)
  assert.equal(asMin.gate.regressionFailed, false, 'on minima the candidate is still cheaper')
})

await test('empty input, one-sided tasks and duplicate repeats are reported, never smoothed over', () => {
  const empty = compareSummaries(undefined, undefined)
  assert.deepEqual(empty.tasks, [])
  assert.equal(empty.gate.tokensComparable, false)
  assert.equal(empty.gate.costComparable, false)
  assert.equal(empty.gate.fail, false, 'nothing measured is not a failure')
  assert.equal(empty.verdict.cost.conclusion, 'incomparable')
  assert.equal(empty.totals.grandTotalGeomeanPct, null)

  const oneSided = compareSummaries(
    summary('base', [run('csv-sum', 1000, true), run('only-base', 500, true)]),
    summary('cand', [run('csv-sum', 1000, true)]),
    { failOn: 'none', noiseFloorPct: 0 },
  )
  assert.equal(oneSided.pairing.counts.missingCand, 1)
  assert.ok(oneSided.warnings.includes('pair-missing-cand: 1'), oneSided.warnings.join('\n'))
  assert.ok(oneSided.warnings.includes('task-missing:cand:only-base'))
  const onlyBase = oneSided.tasks.find((task) => task.id === 'only-base')
  assert.equal(onlyBase.inBase, true)
  assert.equal(onlyBase.inCand, false)
  assert.equal(onlyBase.paired.pct, null, 'a task with no candidate repeat has no paired cost')

  const duplicated = compareSummaries(
    summary('base', [run('a', 1000, true, { repeatIndex: 1 }), run('a', 1000, true, { repeatIndex: 1 })]),
    summary('cand', [run('a', 500, true, { repeatIndex: 1 })]),
    { failOn: 'none', noiseFloorPct: 0 },
  )
  assert.equal(duplicated.pairing.counts.duplicates, 1)
  assert.equal(duplicated.pairing.complete, false)
  assert.ok(duplicated.warnings.includes('pair-duplicate-key: 1'))
  assert.equal(duplicated.pairing.counts.pairs, 1)
})

await test('a sealed run.json pairs like a summary: keys from the row, totals from the buckets', () => {
  const base = runDoc('base', [row('csv-sum', 1, 700, true), row('csv-sum', 2, 700, true)])
  const cand = runDoc('cand', [row('csv-sum', 1, 500, true), row('csv-sum', 2, 900, false)])
  const comparison = compareSummaries(base, cand, { failOn: 'both', noiseFloorPct: 0 })
  assert.equal(comparison.base.label, 'base-base', 'the label comes from arms.base.label')
  assert.equal(comparison.cand.label, 'cand-cand')
  assert.equal(comparison.base.model, 'bench-server/tester', 'meta.model is the identity when there is no model object')
  assert.equal(comparison.gate.tokensComparable, true)
  assert.equal(comparison.tasks[0].base.grandTotalMedian, 700, 'usage without grandTotal sums the four core buckets')
  assert.equal(comparison.tasks[0].paired.pairs, 1, 'the failed candidate repeat is excluded')
  assert.equal(comparison.tasks[0].paired.pct, -28.6)
  assert.equal(comparison.pairing.excluded.candFailed, 1)
  assert.equal(comparison.gate.passDropFailed, true, 'and the failed repeat is still a pass drop')
})

report(LABEL)
