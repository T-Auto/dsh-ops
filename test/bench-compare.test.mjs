/**
 * The report layer: `bench/compare.mjs`, the slice that turns two archived runs into
 * the timestamped report a change review reads.
 *
 * The judgement itself is `compare-core.mjs` and is pinned by its own suite; what is
 * pinned here is the rendering and the wiring around it:
 *
 * 1. **Rendering is stable, and the layout is fixed.** The same comparison and sources
 *    render byte-identical text twice — no clock, no random order — so a report is
 *    diffable; the title is a constant, the conclusion is the report's last section, and
 *    every percent is painted by its sign (a drop or no change green, a rise red, in
 *    `panel.html`'s palette).
 * 2. **The closing conclusion has three wordings.** A delta beyond the A/A band reads a
 *    direction, a delta inside it reports the band only, and a comparison with no floor
 *    abstains (`noise-floor-unknown`) instead of reading noise as a result. The core's
 *    conclusion names travel verbatim into the text.
 * 3. **Excluded pairs are visible.** Pairs a failed side forced out of the cost
 *    statistics are counted, per task and in total.
 * 4. **`--fail-on` maps to exit codes.** `both`/`pass-drop`/`regression`/`none` each
 *    gate what they say, and a gate that could not run abstains at exit 0.
 * 5. **`--json` is the core document.** It is what `compareSummaries` returned, not a
 *    re-derived shape.
 * 6. **All three input forms resolve.** A label, a run directory, a `run.json` path
 *    (and the older `summary.json`) reach the same comparison.
 *
 * Every fixture passes a noise floor on purpose: without one the new rule makes every
 * cost conclusion `noise-floor-unknown`, which is the case the "no floor" check owns.
 *
 * @module dsh-ops/test/bench-compare
 */

import fs from 'node:fs'
import path from 'node:path'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

import { EXIT, main, parseArgs, renderReport, reportFileName, reportStamp, resolveSide } from '../bench/compare.mjs'
import { COMPARE_FORMAT, compareSummaries } from '../bench/lib/compare-core.mjs'

const LABEL = 'bench-compare'

/**
 * A #183-summary-shaped metrics document.
 * @param {string} taskId - the task.
 * @param {number} tokens - the grand total.
 * @param {boolean} pass - the verify outcome.
 * @param {object} [extra] - `{repeatIndex, prompt}` overrides.
 * @returns {object} the metrics document.
 */
function metrics(taskId, tokens, pass, extra = {}) {
  const input = Math.round(tokens * 0.7)
  const doc = {
    format: 'dsh-ops-bench-metrics-v1',
    taskId,
    repeatIndex: extra.repeatIndex,
    usage: { inputTokens: input, outputTokens: tokens - input, cacheReadTokens: 0, cacheWriteTokens: 0, grandTotal: tokens },
    usageReported: true,
    steps: extra.steps ?? 4,
    toolCalls: extra.toolCalls ?? 6,
    toolErrors: extra.toolErrors ?? 0,
    durationMs: extra.durationMs ?? 60_000,
    toolCallsByName: extra.toolCallsByName ?? { ops_read: 2, bash: 1 },
    verify: { passed: pass, checks: [] },
    exitCode: 0,
    timedOut: false,
  }
  if (extra.prompt !== false) doc.prompt = { reported: true, firstStep: extra.firstStep ?? 500, total: extra.total ?? 2000, max: 900 }
  return doc
}

/** A #183 summary document. */
function summary(label, results) {
  return { format: 'dsh-ops-bench-summary-v1', label, profile: label, dshVersion: '0.2.0', model: { provider: 'bench-server', model: 'tester' }, results }
}

/**
 * A sealed `run.json` result row: the join key and the checks live on the row, the
 * numbers live under `metrics`, and the usage has no `grandTotal`.
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
    events: { format: 'inline', count: 0 },
  }
}

/** A sealed `run.json` document around the given rows. */
function sealedRun(label, results) {
  return {
    schemaVersion: 1,
    meta: {
      benchVersion: '0.3.1',
      mode: 'ab',
      platform: 'linux-x64',
      node: 'v24',
      dsh: '0.3.1',
      model: 'bench-server/tester',
      gitSha: null,
      gitBranch: null,
      argv: [],
      startedAt: '2026-10-18T00:00:00.000Z',
      endedAt: '2026-10-18T00:10:00.000Z',
      arms: {},
    },
    arms: { base: { label, profile: label, profileHash: 'h' }, cand: { label, profile: label, profileHash: 'h' } },
    results,
    verify: { checks: 0, passed: 0, failed: 0, degraded: false, notes: [] },
    events: { layout: 'ndjson-per-run', merged: true, mergedAt: null, files: [] },
    archive: [],
  }
}

/** Write one archived run directory below `root` and return its directory. */
function writeRun(root, name, doc, fileName = 'run.json') {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(doc, null, 2))
  return dir
}

/** A CLI invocation with the report and the diagnostics captured apart. */
function invoke(argv, extra = {}) {
  const out = []
  const err = []
  return {
    run: () => main(argv, { out: (line) => out.push(line), err: (line) => err.push(line), ...extra }),
    text: () => out.join('\n'),
    err: () => err.join('\n'),
  }
}

/** A literal path, escaped so it can be matched against a regex. */
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The two spans the report paints every percent with: green for a drop, red for a rise. */
const green = (text) => `<span style="color:#3fb950">${text}</span>`
const red = (text) => `<span style="color:#f85149">${text}</span>`

/** The report is English-only: no CJK character may reach a generated artifact. */
const assertEnglish = (text) => assert.doesNotMatch(text, /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/, 'the report must not contain CJK characters')

await test('the same comparison renders byte-identical text twice: tables first, Evidence last, no verdict prose', () => {
  const base = summary('bench-base', [metrics('csv-sum', 1000, true), metrics('csv-sum', 1000, true)])
  const cheaper = summary('bench-ops', [metrics('csv-sum', 926, true, { durationMs: 55_000 }), metrics('csv-sum', 926, true, { durationMs: 55_000 })])
  const beyond = compareSummaries(base, cheaper, { noiseFloorPct: 3.1, failOn: 'both' })
  const text = renderReport(beyond)
  assert.equal(renderReport(beyond), text, 'rendering is a pure function of its inputs')
  assertEnglish(text)
  assert.match(text, /^# DSH-OPS Benchmark Report \(beta\)\n\nPlatform: base=unknown; cand=unknown\./, 'the title states environment evidence before the data')
  assert.match(text, /^## Per-task pairs$/m)
  assert.match(text, /^\| task \| base \| ops \(Δ%\) \| steps: base→ops \(Δ%\) \| tool calls: base→ops \(Δ%\) \| time: base→ops \(Δ%\) \| tool errors \| pass \|$/m, 'the first table carries cost, behaviour, wall-clock evidence and pass: no pairs, exclusion or direction column')
  assert.ok(text.includes(`| csv-sum | 1,000 | 926 (${green('\u22127.4%')}) | 4 → 4 (${green('0.0%')}) | 6 → 6 (${green('0.0%')}) | 60.0s → 55.0s (${green('\u22128.3%')}) | 0 → 0 | 2/2→2/2 |`), 'each cell keeps its own Δ% in parentheses, painted like every other percent — time included')
  assert.doesNotMatch(text, /geomean/, 'the table ends at TOTAL: the geomean row is gone')
  assert.doesNotMatch(text, /## Excluded pairs|## A\/A noise band|## Token attribution/, 'the report keeps to cost, calls and the verdict: the three diagnostic sections are gone')
  assert.doesNotMatch(text, /^## (Per-task pairs|Tool calls|Per-task bucket detail|Per-request overhead)\n\n(?!\|)/m, 'a table heading leads straight into its table: no explanatory line')
  const headings = text.split('\n').filter((line) => line.startsWith('## '))
  assert.equal(headings[headings.length - 1], '## Per-request overhead (what every request costs before any work)', 'the overhead table closes the report')
  assert.doesNotMatch(text, /## Conclusion|## Warnings|## Evidence|## Usage split|## steps and tool calls|Direction:|noise floor \(A\/A\)|- gate:/, 'no verdict, warning or evidence prose: the verdict lives in the exit code and the comparison document')
  assert.doesNotMatch(text, /Time is reported/, 'the report is tables and nothing else')

  // The gate still judges even though the report no longer prints a conclusion: a
  // costlier delta fails the comparison document, and the CLI maps it to exit 1.
  const worse = compareSummaries(base, summary('bench-ops', [metrics('csv-sum', 1050, true), metrics('csv-sum', 1050, true)]), { noiseFloorPct: 3.1, failOn: 'both' })
  const worseText = renderReport(worse)
  assert.ok(worseText.includes(`| csv-sum | 1,000 | 1,050 (${red('+5.0%')}) | 4 → 4 (${green('0.0%')}) | 6 → 6 (${green('0.0%')}) | 60.0s → 60.0s (${green('0.0%')}) | 0 → 0 | 2/2→2/2 |`))
  assert.equal(worse.gate.fail, true, 'the gate verdict stays in the comparison document')
  assert.equal(worse.gate.primary, 'regression')
  assertEnglish(worseText)
})

await test('the first table reads the aggregate its flag names: medians, min, halved medians and raw error counts', () => {
  const base = summary('bench-base', [metrics('csv-sum', 1000, true, { steps: 5 }), metrics('csv-sum', 1000, true, { steps: 3 })])
  const cand = summary('bench-ops', [metrics('csv-sum', 900, true, { steps: 3 }), metrics('csv-sum', 900, true, { steps: 3 })])
  const text = renderReport(compareSummaries(base, cand, { noiseFloorPct: 3.1, failOn: 'both' }))
  assertEnglish(text)
  assert.ok(text.includes(`| csv-sum | 1,000 | 900 (${green('\u221210.0%')}) | 4 → 3 (${green('\u221225.0%')}) | 6 → 6 (${green('0.0%')}) | 60.0s → 60.0s (${green('0.0%')}) | 0 → 0 | 2/2→2/2 |`), 'the steps and tool-call cells carry the medians with their Δ%')

  const minText = renderReport(compareSummaries(base, cand, { noiseFloorPct: 3.1, failOn: 'both', aggregate: 'min' }))
  assert.ok(minText.includes(`| 3 → 3 (${green('0.0%')}) | 6 → 6 (${green('0.0%')}) |`), '`min` moves the cells, not only the title')

  // An even repeat count halves the median: the cell has to show 12.5, not round it
  // into "13 → 13 (+4.0%)", which contradicts its own Δ%.
  const halfBase = summary('bench-base', [metrics('csv-sum', 1000, true, { toolCalls: 13 }), metrics('csv-sum', 1000, true, { toolCalls: 12 })])
  const halfCand = summary('bench-ops', [metrics('csv-sum', 900, true, { toolCalls: 13 }), metrics('csv-sum', 900, true, { toolCalls: 13 })])
  const halfText = renderReport(compareSummaries(halfBase, halfCand, { noiseFloorPct: 3.1, failOn: 'both' }))
  assert.ok(halfText.includes(`| 12.5 → 13 (${red('+4.0%')}) |`), 'a halved median shows 12.5, not a rounded 13')

  // Tool errors are raw counts in the first table, not a median ratio: 2 → 0.
  const errBase = summary('bench-base', [metrics('csv-sum', 1000, true, { toolErrors: 2 })])
  const errCand = summary('bench-ops', [metrics('csv-sum', 900, true, { toolErrors: 0 })])
  const errText = renderReport(compareSummaries(errBase, errCand, { noiseFloorPct: 3.1, failOn: 'both' }))
  assert.ok(errText.includes(`| 60.0s → 60.0s (${green('0.0%')}) | 2 → 0 | 1/1→1/1 |`), 'tool errors are counted, not percentaged')
})

await test('the per-request overhead table prices the first request and degrades without prompt data', () => {
  const base = summary('bench-base', [
    metrics('csv-sum', 1000, true, { steps: 6, firstStep: 6249, total: 15186 }),
    metrics('csv-sum', 1000, true, { steps: 6, firstStep: 6249, total: 15186 }),
  ])
  const cand = summary('bench-ops', [
    metrics('csv-sum', 1000, true, { steps: 6, firstStep: 8032, total: 23628 }),
    metrics('csv-sum', 1000, true, { steps: 6, firstStep: 8032, total: 23628 }),
  ])
  const text = renderReport(compareSummaries(base, cand, { noiseFloorPct: 3.1, failOn: 'both' }))
  assertEnglish(text)
  assert.match(text, /^## Per-request overhead \(what every request costs before any work\)$/m)
  assert.ok(text.includes(`| csv-sum | 6,249 → 8,032 (+1,783, ${red('+28.5%')}) |`), 'the row carries only the first-request delta, abs and painted pct')
  assert.doesNotMatch(text, /prompt \/ step|Fixed per-request cost|The first request of a run carries no history/)

  const noPrompt = renderReport(compareSummaries(
    summary('bench-base', [metrics('csv-sum', 1000, true, { prompt: false })]),
    summary('bench-ops', [metrics('csv-sum', 1000, true, { prompt: false })]),
  ))
  assert.match(noPrompt, /Skipped: neither side recorded `metrics\.prompt`/, 'no prompt data ⇒ the section says so instead of inventing numbers')
  assert.doesNotMatch(noPrompt, /first request: base→ops/)
})

await test('the tool table keeps the per-side totals, splits them by task, and colours adoption', () => {
  const base = summary('bench-base', [metrics('csv-sum', 1000, true, { toolCallsByName: { ops_read: 2, bash: 1, write: 4 } })])
  const cand = summary('bench-ops', [metrics('csv-sum', 900, true, { toolCallsByName: { ops_read: 3, bash: 2, write: 4 } })])
  const text = renderReport(compareSummaries(base, cand, { noiseFloorPct: 3.1, failOn: 'both' }))
  assert.match(text, /^## Tool calls$/m)
  const headings = text.split('\n').filter((line) => line.startsWith('## '))
  assert.equal(headings[1], '## Tool calls', 'the tool table sits directly under the per-task pair table: it is the first explanation of where the token Δ went')
  assert.match(text, /^\| tool \| base \| ops \| csv-sum \|$/m, 'the base/ops totals stay, and each task adds a column')
  assert.ok(text.includes(`| ops_read | 2 | ${green('3')} | 2 → ${green('3')} |`), 'an ops tool rising is green: the plugin replaced a built-in')
  assert.ok(text.includes(`| bash | 1 | ${red('2')} | 1 → ${red('2')} |`), 'a built-in rising is red: the candidate reached past the plugin')
  assert.ok(text.includes('| write | 4 | 4 | 4 → 4 |'), 'equal counts are not painted')

  // Falling is green for a built-in and red for an ops tool: adoption, not the sign.
  const closed = summary('bench-ops', [metrics('csv-sum', 900, true, { toolCallsByName: { ops_read: 3 } })])
  const closedText = renderReport(compareSummaries(base, closed, { noiseFloorPct: 3.1, failOn: 'both' }))
  assert.ok(closedText.includes(`| bash | 1 | ${green('0')} | 1 → ${green('0')} |`), 'a built-in the candidate stopped calling is green')
  assert.ok(closedText.includes(`| write | 4 | ${green('0')} | 4 → ${green('0')} |`))

  const declined = compareSummaries(
    summary('bench-base', [metrics('csv-sum', 1000, true, { toolCallsByName: { ops_read: 5 } })]),
    summary('bench-ops', [metrics('csv-sum', 900, true, { toolCallsByName: { ops_read: 2 } })]),
    { noiseFloorPct: 3.1, failOn: 'both' },
  )
  assert.ok(renderReport(declined).includes(`| ops_read | 5 | ${red('2')} | 5 → ${red('2')} |`), 'an ops tool falling is red: adoption moved backwards')

  // Each task keeps its own column; a tool nobody used in a task reads as a dash.
  const twoTasks = compareSummaries(
    summary('bench-base', [metrics('csv-sum', 1000, true, { toolCallsByName: { ops_read: 1 } }), metrics('api-rename', 1000, true, { toolCallsByName: { ops_read: 2 } })]),
    summary('bench-ops', [metrics('csv-sum', 900, true, { toolCallsByName: { ops_read: 3 } }), metrics('api-rename', 900, true, { toolCallsByName: { ops_read: 4 } })]),
    { noiseFloorPct: 3.1, failOn: 'both' },
  )
  const twoText = renderReport(twoTasks)
  assert.match(twoText, /^\| tool \| base \| ops \| csv-sum \| api-rename \|$/m)
  assert.ok(twoText.includes(`| ops_read | 3 | ${green('7')} | 1 → ${green('3')} | 2 → ${green('4')} |`), 'the count belongs to the task that made the call')
})

await test('excluded pairs leave the report body but stay in the warnings, and the pair table prices only usable pairs', () => {
  const base = summary('bench-base', [metrics('csv-sum', 1000, true), metrics('csv-sum', 1000, true), metrics('csv-sum', 1000, true)])
  const cand = summary('bench-ops', [metrics('csv-sum', 500, true), metrics('csv-sum', 100, false), metrics('csv-sum', 200, false)])
  const comparison = compareSummaries(base, cand, { noiseFloorPct: 3.1, failOn: 'pass-drop' })
  const text = renderReport(comparison)
  assertEnglish(text)
  assert.doesNotMatch(text, /## Excluded pairs/, 'the section is gone; the counts must not vanish with it')
  assert.ok(text.includes(`| csv-sum | 1,000 | 500 (${green('\u221250.0%')}) |`), 'the pair table still prices the one usable pair')
  assert.ok(text.includes('| 3/3→1/3 |'), 'the pass column counts every repeat, not only the usable pairs')
  assert.doesNotMatch(text, /pairs usable\/counted/, 'the usable/considered split no longer has a column')
  assert.ok(comparison.warnings.includes('cost-pairs-excluded: 2 (base 0, cand 2, both 0)'), 'the comparison document still carries how many pairs the cost statistics lost')

  const clean = compareSummaries(base, summary('bench-ops', base.results.map((entry) => ({ ...entry, usage: { ...entry.usage } }))), { noiseFloorPct: 3.1, failOn: 'none' })
  assert.deepEqual(clean.warnings, [], 'nothing excluded means nothing to warn about')
  assertEnglish(text)
})

await test('--fail-on gates individually, and a gate that cannot run abstains at exit 0', async () => {
  await withTempDir('bench-compare-gate', async (root) => {
    const runs = path.join(root, 'runs')
    const cheaperButWorse = writeRun(runs, '2026-10-18-0001-bench-ops', sealedRun('bench-ops', [row('csv-sum', 1, 500, true), row('csv-sum', 2, 500, false)]))
    const baseline = writeRun(runs, '2026-10-18-0000-bench-base', sealedRun('bench-base', [row('csv-sum', 1, 1000, true), row('csv-sum', 2, 1000, true)]))
    const costlier = writeRun(runs, '2026-10-18-0002-bench-ops-worse', sealedRun('bench-ops', [row('csv-sum', 1, 1100, true), row('csv-sum', 2, 1100, true)]))

    // Pass drop: cheaper overall, one repeat lost. `regression` alone lets it through.
    for (const [mode, expected] of [['both', EXIT.failure], ['pass-drop', EXIT.failure], ['regression', EXIT.ok], ['none', EXIT.ok]]) {
      const cli = invoke([baseline, cheaperButWorse, '--noise-floor-pct', '0', '--out', '-', '--fail-on', mode])
      assert.equal(await cli.run(), expected, `--fail-on ${mode}`)
      if (expected === EXIT.failure) assert.match(cli.err(), /GATE FAILED/)
      else assert.doesNotMatch(cli.err(), /GATE FAILED/)
    }

    // Cost regression: every repeat passed, the candidate burns 10%.
    for (const [mode, expected] of [['both', EXIT.failure], ['regression', EXIT.failure], ['pass-drop', EXIT.ok], ['none', EXIT.ok]]) {
      const cli = invoke([baseline, costlier, '--noise-floor-pct', '0', '--out', '-', '--fail-on', mode])
      assert.equal(await cli.run(), expected, `--fail-on ${mode} on a cost regression`)
    }

    // No noise floor: the same +10% is measured but not judged — abstain, exit 0.
    const abstain = invoke([baseline, costlier, '--out', '-', '--fail-on', 'both'])
    assert.equal(await abstain.run(), EXIT.ok)
    assert.match(abstain.err(), /noise floor unknown ⇒ cost direction withheld/)
    assert.match(abstain.err(), /noise-floor-unknown/, 'the abstaining gate says so on stderr — the report prints no verdict prose')
  })
})

await test('--json prints the compare-core document itself, not a re-derived shape', async () => {
  await withTempDir('bench-compare-json', async (root) => {
    const baseDir = writeRun(root, 'base', sealedRun('bench-base', [row('csv-sum', 1, 700, true), row('csv-sum', 2, 700, true)]))
    const candDir = writeRun(root, 'cand', sealedRun('bench-ops', [row('csv-sum', 1, 500, true), row('csv-sum', 2, 520, true)]))
    const cli = invoke([baseDir, candDir, '--json', '--noise-floor-pct', '3.1'])
    assert.equal(await cli.run(), EXIT.ok)
    const doc = JSON.parse(cli.text())
    assert.equal(doc.format, COMPARE_FORMAT)
    assert.equal(doc.gate.noiseFloorPct, 3.1)
    assert.deepEqual(Object.keys(doc.verdict).sort(), ['cost', 'pass', 'primary'])
    assert.equal(doc.verdict.cost.basis, 'paired-both-passed')
    assert.equal(doc.tasks[0].paired.pairs, 2)
    assert.ok(Array.isArray(doc.warnings))
    const expected = compareSummaries(
      JSON.parse(fs.readFileSync(path.join(baseDir, 'run.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(candDir, 'run.json'), 'utf8')),
      { noiseFloorPct: 3.1 },
    )
    assert.deepEqual(doc, JSON.parse(JSON.stringify(expected)), 'the JSON is the core document verbatim')
    assert.equal(fs.readdirSync(candDir).sort().join(), 'run.json', 'JSON mode writes no markdown unless --out names a file')

    // …and --out writes the JSON where asked.
    const target = path.join(root, 'out', 'comparison.json')
    const written = invoke([baseDir, candDir, '--json', '--out', target, '--noise-floor-pct', '3.1'])
    assert.equal(await written.run(), EXIT.ok)
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), doc)
  })
})

await test('the default artifact lands in the sweep folder, named by the write instant', async () => {
  assert.equal(reportStamp(new Date('2026-10-20T12:36:38.123Z')), '2026-10-20T12-36-38Z', 'the name carries a filesystem-safe UTC stamp')
  assert.equal(reportFileName(new Date('2026-10-20T12:36:38.123Z')), 'DSH-OPS Benchmark Report 2026-10-20T12-36-38Z.md')
  await withTempDir('bench-compare-out', async (root) => {
    const runs = path.join(root, 'runs')
    const group = path.join(runs, 'benchmark-test-07')
    const baseDir = writeRun(group, '2026-10-18T00-00-00Z-bench-base', sealedRun('bench-base', [row('csv-sum', 1, 700, true)]))
    const candDir = writeRun(group, '2026-10-18T00-00-01Z-bench-ops', sealedRun('bench-ops', [row('csv-sum', 1, 500, true)]))
    const instant = Date.parse('2026-10-20T12:36:38.123Z')
    const sides = ['bench-base', 'bench-ops', '--runs', runs, '--folder', 'benchmark-test-07', '--noise-floor-pct', '3.1']
    const cli = invoke(sides, { now: () => instant })
    assert.equal(await cli.run(), EXIT.ok)
    const reportFile = path.join(group, 'DSH-OPS Benchmark Report 2026-10-20T12-36-38Z.md')
    assert.ok(fs.existsSync(reportFile), 'the report lands in the sweep folder, not inside the arm that measured half of it')
    assert.equal(fs.readdirSync(candDir).sort().join(), 'run.json', 'the arm directory keeps its own evidence only')
    assert.equal(fs.readFileSync(reportFile, 'utf8'), cli.text())
    assert.match(cli.err(), new RegExp(`compare: wrote ${literal(reportFile)}`))

    // A second comparison is a second artifact: the instant in the name stops one sweep
    // from overwriting the report of another that ran a second earlier.
    const later = invoke(sides, { now: () => instant + 1000 })
    assert.equal(await later.run(), EXIT.ok)
    assert.ok(fs.existsSync(reportFile) && fs.existsSync(path.join(group, 'DSH-OPS Benchmark Report 2026-10-20T12-36-39Z.md')))

    // The same placement holds when the sides are given as directories rather than labels.
    const byDir = invoke([baseDir, candDir, '--runs', runs, '--noise-floor-pct', '3.1'], { now: () => instant + 2000 })
    assert.equal(await byDir.run(), EXIT.ok)
    assert.ok(fs.existsSync(path.join(group, 'DSH-OPS Benchmark Report 2026-10-20T12-36-40Z.md')), 'a run directory inside a sweep folder is promoted too')

    // A run directory directly under the runs root has no sweep folder to promote to.
    const flatDir = writeRun(runs, '2026-10-18T00-00-02Z-bench-ops', sealedRun('bench-ops', [row('csv-sum', 1, 500, true)]))
    assert.equal(await invoke([baseDir, flatDir, '--runs', runs, '--noise-floor-pct', '3.1'], { now: () => instant }).run(), EXIT.ok)
    assert.ok(fs.existsSync(path.join(flatDir, 'DSH-OPS Benchmark Report 2026-10-20T12-36-38Z.md')), 'no group folder ⇒ the report stays beside run.json')

    const stdoutOnly = invoke([baseDir, candDir, '--noise-floor-pct', '3.1', '--out', '-'], { now: () => instant })
    assert.equal(await stdoutOnly.run(), EXIT.ok)
    assert.equal(fs.readdirSync(candDir).sort().join(), 'run.json', '--out - writes nothing')

    const explicit = path.join(root, 'elsewhere', 'r.md')
    assert.equal(await invoke([baseDir, candDir, '--noise-floor-pct', '3.1', '--out', explicit], { now: () => instant }).run(), EXIT.ok)
    assert.equal(fs.readFileSync(explicit, 'utf8'), stdoutOnly.text())
  })
})

await test('label, directory and file forms resolve to the same comparison', async () => {
  await withTempDir('bench-compare-forms', async (root) => {
    const runs = path.join(root, 'runs')
    const group = path.join(runs, 'benchmark-test-01')
    const baseDir = writeRun(group, '2026-10-18-0000-bench-base', sealedRun('bench-base', [row('csv-sum', 1, 1000, true), row('api-rename', 1, 500, true)]))
    const candDir = writeRun(group, '2026-10-18-0001-bench-ops', sealedRun('bench-ops', [row('csv-sum', 1, 926, true), row('api-rename', 1, 620, true)]))
    const common = ['--noise-floor-pct', '3.1', '--out', '-', '--fail-on', 'none']
    const byLabel = invoke(['bench-base', 'bench-ops', '--runs', runs, '--folder', 'benchmark-test-01', ...common])
    const byDir = invoke([baseDir, candDir, ...common])
    const byFile = invoke([path.join(baseDir, 'run.json'), path.join(candDir, 'run.json'), ...common])
    for (const cli of [byLabel, byDir, byFile]) assert.equal(await cli.run(), EXIT.ok)
    // The report carries no side paths, so the three resolution forms render
    // byte-identically: nothing anywhere echoes how each side was named.
    assert.equal(byLabel.text(), byDir.text())
    assert.equal(byFile.text(), byDir.text(), 'all three forms reach the same comparison')
    assert.ok(byDir.text().includes(`api-rename | 500 | 620 (${red('+24.0%')}) | 2 → 2 (${green('0.0%')}) | 1 → 1 (${green('0.0%')}) | 0.0s → 0.0s (${green('0.0%')}) | 0 → 0 | 1/1→1/1 |`))

    // A group is searched with --folder; the flat root is searched without it.
    assert.equal((await invoke(['bench-base', 'bench-ops', '--runs', runs, ...common]).run()), EXIT.ok)
    const missingFolder = invoke(['bench-base', 'bench-ops', '--runs', runs, '--folder', 'benchmark-test-99', ...common])
    assert.equal(await missingFolder.run(), EXIT.usage)
    assert.match(missingFolder.err(), /no run folder "benchmark-test-99"/)

    // The older summary.json is a side too, and reports itself as such.
    const legacyDir = writeRun(runs, 'legacy-bench-base', summary('bench-base', [metrics('csv-sum', 700, true)]), 'summary.json')
    const resolved = resolveSide(legacyDir, { runsDir: runs })
    assert.equal(resolved.kind, 'summary')
    assert.equal(resolved.file, path.join(legacyDir, 'summary.json'))
  })
})

await test('a bad command line exits 2 with the usage, and --help exits 0', async () => {
  await withTempDir('bench-compare-usage', async (root) => {
    const baseDir = writeRun(root, 'base', sealedRun('bench-base', [row('csv-sum', 1, 700, true)]))
    const cases = [
      [[], /expected exactly two sides/],
      [['only-one'], /expected exactly two sides/],
      [[baseDir, baseDir, '--bogus'], /unknown option "--bogus"/],
      [[baseDir, baseDir, '--fail-on', 'sometimes'], /--fail-on must be one of/],
      [[baseDir, baseDir, '--aggregate', 'mean'], /--aggregate must be one of/],
      [[baseDir, baseDir, '--regression-scope', 'file'], /--regression-scope must be one of/],
      [[baseDir, baseDir, '--tolerance-pct', '-1'], /--tolerance-pct must be a non-negative number/],
      [[baseDir, baseDir, '--noise-floor-pct', 'x'], /--noise-floor-pct must be a non-negative number/],
      [[baseDir, baseDir, '--noise', 'a'], /--noise needs two sides/],
      [[baseDir, baseDir, '--json=1'], /--json takes no value/],
      [['/does/not/exist.json', baseDir, '--runs', root], /is neither a run directory, a run\.json\/summary\.json path, nor a label/],
      [[path.join(root, 'base'), path.join(root, 'base'), '--folder', 'a/b'], /--folder must be one safe directory name/],
    ]
    for (const [argv, expected] of cases) {
      const cli = invoke(argv)
      assert.equal(await cli.run(), EXIT.usage, JSON.stringify(argv))
      assert.match(cli.err(), expected, JSON.stringify(argv))
      assert.match(cli.err(), /^usage: node bench\/compare\.mjs|^compare: /)
    }
    // A command line that cannot even be parsed gets the usage block; a side that
    // cannot be resolved gets the message alone (the flag syntax was fine).
    for (const argv of [[], [baseDir, baseDir, '--bogus'], [baseDir, baseDir, '--folder', 'a/b']]) {
      const cli = invoke(argv)
      assert.equal(await cli.run(), EXIT.usage)
      assert.match(cli.err(), /^usage: node bench\/compare\.mjs/, JSON.stringify(argv))
    }
    const help = invoke(['--help'])
    assert.equal(await help.run(), EXIT.ok)
    assert.match(help.text(), /--noise-floor-pct N/)
    assert.match(help.text(), /Exit codes: 0 ok/)
    assert.throws(() => parseArgs(['--runs']), /--runs needs a value/)
  })
})

await test('--noise measures the floor in the call, and a missing prompt degrades attribution instead of inventing it', async () => {
  await withTempDir('bench-compare-noise', async (root) => {
    const runs = path.join(root, 'runs')
    const withPrompt = (tokens, pass) => sealedRun('bench-base', [row('csv-sum', 1, tokens, pass)])
    const baseDir = writeRun(runs, 'base', withPrompt(1000, true))
    const candDir = writeRun(runs, 'cand', withPrompt(1500, true))
    const aaA = writeRun(runs, 'aa-a', withPrompt(1000, true))
    const aaB = writeRun(runs, 'aa-b', withPrompt(1040, true))
    const cli = invoke([baseDir, candDir, '--noise', aaA, aaB, '--out', '-', '--json'])
    assert.equal(await cli.run(), EXIT.failure, 'a measured floor turns the +50% into a real regression')
    const doc = JSON.parse(cli.text())
    assert.equal(doc.noiseFloor.method, 'aa-max-abs-task-pct')
    assert.equal(doc.noiseFloor.pct, 4, '+50% clears the measured 4% floor')
    assert.equal(doc.gate.regressionFailed, true)

    // A row with no prompt capture cannot support attribution: the core records that,
    // and the report has no attribution section left to hedge in.
    const bare = compareSummaries(summary('bench-base', [metrics('csv-sum', 1000, true, { prompt: false })]), summary('bench-ops', [metrics('csv-sum', 900, true, { prompt: false })]), { noiseFloorPct: 3.1 })
    assert.equal(bare.overhead.comparable, false, 'the core marks the split incomparable')
    const text = renderReport(bare)
    assert.doesNotMatch(text, /Token attribution|fixed overhead per request/)
    assertEnglish(text)
  })
})

report(LABEL)
