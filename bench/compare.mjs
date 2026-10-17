#!/usr/bin/env node
/**
 * The comparison CLI: two archived run directories in, one verdict out.
 *
 * It reads `bench/runs/<stamp>-<label>/summary.json` on both sides, aggregates each
 * task's repeats (median by default), prints the table the change
 * review reads, archives it in the directory the candidate run lives in — the group,
 * never inside the run archive itself — and turns the two gate rules
 * into an exit code: `regression` for "the candidate burned more tokens than the
 * tolerance allows", `pass-drop` for "the candidate got worse at actually finishing
 * the work". Everything computed here is a pure function from `lib/compare-core.mjs`
 * (PLAN.md §6); this file only resolves paths, renders, and exits.
 *
 * A token delta on its own cannot say *why* the candidate moved, and the reasons need
 * opposite fixes: a bigger prompt on every request is a tool-schema or prompt-policy
 * cost, extra steps are a model-behaviour cost, and a fatter context is a tool-output
 * cost. So the report carries two extra tables — per-task bucket detail and the
 * usage-bucket split — both of them diagnostic. The gate still judges `grandTotal`
 * alone; nothing here can fail a run.
 *
 * @module dsh-ops/bench/compare
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareSummaries, formatNumber, percentChange, AGGREGATES, FAIL_ON, REGRESSION_SCOPES } from './lib/compare-core.mjs'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const RUNS_DIR = path.join(BENCH_DIR, 'runs')

/** The documented CLI shape. */
const USAGE = `usage: node bench/compare.mjs <base-label|dir> <cand-label|dir> [options]

  <label>            a run label, matched against bench/runs/*-<label> and one level
                     of bench/runs/<folder>/*-<label> groups (newest wins)
  <dir>              or the run directory itself, or its summary.json
  --folder <name>    restrict label matching to bench/runs/<name>/ (the group created
                     by run.mjs --folder; one safe directory name)
  --aggregate S      median (default) or min: which statistic the deltas and the gate use
  --tolerance-pct N  token regression tolerance (default 2)
  --fail-on MODE     regression | pass-drop | both (default) | none
  --regression-scope S  task (default: every task is gated against the tolerance on
                     its own, so one big win cannot hide a regression) |
                     total (gate only the summed corpus cost) | both
  --json <out>       also write the comparison structure as JSON
  --runs <dir>       override the runs directory (default bench/runs)
  Output             the report is archived in the candidate run's parent directory,
                     i.e. bench/runs/<folder>/ with --folder and bench/runs/ for the
                     flat layout — never inside a run archive itself
  --help             this text`

/**
 * The parsed command line.
 * @typedef {object} Options
 * @property {string} base - the baseline side.
 * @property {string} cand - the candidate side.
 * @property {'median'|'min'} aggregate - the statistic to compare.
 * @property {number} tolerancePct - the regression tolerance.
 * @property {'regression'|'pass-drop'|'both'|'none'} failOn - the gate.
 * @property {'task'|'total'|'both'} regressionScope - what the regression gate judges.
 * @property {string|null} json - optional JSON output path.
 * @property {string|null} folder - restrict label matching to one group directory.
 * @property {string} runsDir - where run directories live.
 */

/**
 * Parse the command line.
 * @param {string[]} argv - arguments after the script name.
 * @returns {Options} the options.
 */
export function parseArgs(argv) {
  const positional = []
  const options = { aggregate: 'median', tolerancePct: 2, failOn: 'both', regressionScope: 'task', json: null, folder: null, runsDir: RUNS_DIR }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg : arg.slice(0, eq)
      const inline = eq === -1 ? null : arg.slice(eq + 1)
      const take = () => {
        if (inline !== null) return inline
        i += 1
        if (i >= argv.length) throw new Error(`${name} needs a value`)
        return argv[i]
      }
      if (name === '--aggregate') options.aggregate = take()
      else if (name === '--tolerance-pct') options.tolerancePct = Number(take())
      else if (name === '--fail-on') options.failOn = take()
      else if (name === '--regression-scope') options.regressionScope = take()
      else if (name === '--json') options.json = take()
      else if (name === '--folder') {
        const value = take()
        assertFolderName(value, '--folder')
        options.folder = value
      }
      else if (name === '--runs') options.runsDir = path.resolve(take())
      else throw new Error(`unknown option "${name}"`)
      continue
    }
    if (arg.startsWith('-')) throw new Error(`unknown option "${arg}"`)
    positional.push(arg)
  }
  if (positional.length !== 2) throw new Error('expected exactly two sides: <base> <cand>')
  if (!AGGREGATES.includes(options.aggregate)) throw new Error(`--aggregate must be one of ${AGGREGATES.join(', ')}`)
  if (!FAIL_ON.includes(options.failOn)) throw new Error(`--fail-on must be one of ${FAIL_ON.join(', ')}`)
  if (!REGRESSION_SCOPES.includes(options.regressionScope)) throw new Error(`--regression-scope must be one of ${REGRESSION_SCOPES.join(', ')}`)
  if (!Number.isFinite(options.tolerancePct) || options.tolerancePct < 0) throw new Error('--tolerance-pct must be a non-negative number')
  return { ...options, base: positional[0], cand: positional[1] }
}

/**
 * Print the usage block.
 * @returns {void}
 */
function printUsage() {
  console.log(USAGE)
}

/**
 * A `--folder` name must be one flat, safe directory segment under the runs root
 * (mirrors `run.mjs`'s same-named check; the two CLIs stay independent by design).
 * @param {string} name - the requested folder name.
 * @param {string} flag - the flag it came from, for the error text.
 * @returns {string} the validated name.
 */
function assertFolderName(name, flag) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[\\/]/.test(name) || name.includes(':')) {
    throw new Error(`${flag} must be one safe directory name (no path separators, no "." or ".."), got "${name}"`)
  }
  return name
}

/**
 * Resolve one side of the comparison to its summary document.
 * @param {string} spec - a label, a run directory, or a summary.json path.
 * @param {string} runsDir - the runs root.
 * @param {string|null} [folder] - a group directory under the runs root to search
 *   instead of the root plus one level of groups (the newest stamp wins either way).
 * @returns {{summary: object, dir: string, spec: string}} the resolved side.
 */
export function resolveSide(spec, runsDir, folder = null) {
  const direct = path.resolve(spec)
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
    const file = path.join(direct, 'summary.json')
    if (!fs.existsSync(file)) throw new Error(`${direct} is a directory but has no summary.json`)
    return loadSummary(file, spec)
  }
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return loadSummary(direct, spec)
  // A label matches any run directory ending in "-<label>"; the newest stamp wins,
  // because a comparison is about the latest measured state of each side. With
  // `--folder` the search is that one group; without it the runs root and the
  // group directories directly under it are searched together, so grouped runs
  // stay comparable without flattening the layout back out.
  if (!fs.existsSync(runsDir)) throw new Error(`no runs directory at ${runsDir}; pass a run directory instead of the label "${spec}"`)
  let roots
  if (folder !== null) {
    roots = [path.join(runsDir, folder)]
    if (!fs.existsSync(roots[0]) || !fs.statSync(roots[0]).isDirectory()) throw new Error(`no run folder "${folder}" at ${roots[0]}`)
  } else {
    roots = [runsDir]
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(runsDir, entry.name))
    }
  }
  const matches = []
  for (const root of roots) {
    for (const name of fs.readdirSync(root)) {
      if ((name === spec || name.endsWith(`-${spec}`)) && fs.existsSync(path.join(root, name, 'summary.json'))) {
        matches.push({ name, file: path.join(root, name, 'summary.json') })
      }
    }
  }
  if (matches.length === 0) throw new Error(`"${spec}" is neither a run directory nor a label with an archived summary under ${folder ? path.join(runsDir, folder) : runsDir}`)
  matches.sort((left, right) => (left.name === right.name ? left.file.localeCompare(right.file) : left.name < right.name ? -1 : 1))
  return loadSummary(matches[matches.length - 1].file, spec)
}

/**
 * Read and sanity-check one summary document.
 * @param {string} file - the summary path.
 * @param {string} spec - what the caller asked for, for the error text.
 * @returns {{summary: object, dir: string, spec: string}} the resolved side.
 */
function loadSummary(file, spec) {
  let summary
  try {
    summary = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: not readable as JSON (${error.message})`)
  }
  if (summary.format !== 'dsh-ops-bench-summary-v1') throw new Error(`${file}: unexpected format "${summary.format}"`)
  return { summary, dir: path.dirname(file), spec }
}

/**
 * Render the comparison as the Markdown table the change review reads.
 * @param {object} comparison - the structure from `compareSummaries`.
 * @param {{baseFile: string, candFile: string}} sources - the two summary paths.
 * @returns {string} the report text.
 */
export function renderMarkdown(comparison, sources) {
  const statKey = comparison.aggregate === 'min' ? 'grandTotalMin' : 'grandTotalMedian'
  const tokens = comparison.gate.tokensComparable
  const deltaCell = (baseValue, candValue) => `${short(baseValue)}→${short(candValue)} (${percentText(percentChange(baseValue, candValue))})`
  const rows = comparison.tasks.map((task) => {
    const tokenCell = tokens
      ? `${formatNumber(task.base[statKey])} → ${formatNumber(task.cand[statKey])} (${percentText(task.delta.grandTotalPct)})`
      : 'n/a (usage incomplete)'
    return `| ${task.id} | ${tokenCell} | ${deltaCell(task.base.stepsMedian, task.cand.stepsMedian)} | ${deltaCell(task.base.toolCallsMedian, task.cand.toolCallsMedian)} | ${short(task.base.toolErrorsMedian)}→${short(task.cand.toolErrorsMedian)} | ${task.base.passed}/${task.base.repeats}→${task.cand.passed}/${task.cand.repeats} |`
  })
  const totals = comparison.totals
  const totalTokens = tokens
    ? `${formatNumber(totals.baseGrandTotal)} → ${formatNumber(totals.candGrandTotal)} (${percentText(totals.grandTotalPct)})`
    : 'n/a (usage incomplete)'
  const geomeanTokens = tokens
    ? `${percentText(totals.grandTotalGeomeanPct)} (per-task median ratios, equally weighted)`
    : 'n/a (usage incomplete)'

  // Tool adoption is a count question, not a median one: a tool called once in one
  // repeat and never again is still evidence it was published and reached for, so
  // the column sums every archived run on each side (the shape §5a of the test03
  // retro reads). Tools only one side ever called get a 0 on the other, which is
  // exactly the "published vs never called" contrast the table exists to show. The
  // plugin's own tools sort first (their adoption is what the report is for), then
  // the rest, each group by the Ops count.
  const toolTotals = new Map()
  for (const task of comparison.tasks) {
    for (const side of ['base', 'cand']) {
      for (const [name, count] of Object.entries(task[side].toolCallsByName ?? {})) {
        const entry = toolTotals.get(name) ?? { base: 0, cand: 0 }
        entry[side] += count
        toolTotals.set(name, entry)
      }
    }
  }
  const ownTool = (name) => name.startsWith('ops')
  // A built-in tool the candidate kept reaching for is the number this table wants a
  // reader to notice, so it is red; the plugin's own tools (ops_*) stay plain.
  const opsCountCell = (name, count) => (!ownTool(name) && count > 0
    ? `<span style="color:red">${short(count)}</span>`
    : short(count))
  const toolRows = [...toolTotals.entries()]
    .sort((left, right) => (Number(ownTool(right[0])) - Number(ownTool(left[0])))
      || (right[1].cand - left[1].cand)
      || left[0].localeCompare(right[0]))
    .map(([name, counts]) => `| ${name} | ${short(counts.base)} | ${opsCountCell(name, counts.cand)} |`)

  const bucketKeys = comparison.aggregate === 'min'
    ? { input: 'inputMin', output: 'outputMin', cacheRead: 'cacheReadMin' }
    : { input: 'inputMedian', output: 'outputMedian', cacheRead: 'cacheReadMedian' }
  const bucketCell = (baseValue, candValue) => `${formatNumber(baseValue)} → ${formatNumber(candValue)} (${percentText(percentChange(baseValue, candValue))})`
  const bucketRow = (label, baseSide, candSide) => `| ${label} | ${bucketCell(baseSide[bucketKeys.input], candSide[bucketKeys.input])} | ${bucketCell(baseSide[bucketKeys.output], candSide[bucketKeys.output])} | ${bucketCell(baseSide[bucketKeys.cacheRead], candSide[bucketKeys.cacheRead])} |`
  const totalsBuckets = comparison.totals?.buckets
  const totalBucketRow = totalsBuckets?.comparable
    ? `| **TOTAL** | ${bucketCell(totalsBuckets.input.base, totalsBuckets.input.cand)} | ${bucketCell(totalsBuckets.output.base, totalsBuckets.output.cand)} | ${bucketCell(totalsBuckets.cacheRead.base, totalsBuckets.cacheRead.cand)} |`
    : null
  const tokenBuckets = tokenBucketsSection(comparison, tokens)

  const lines = [
    `# bench compare: ${comparison.base.label ?? 'base'} → ${comparison.cand.label ?? 'cand'}`,
    '',
    `Aggregate: **${comparison.aggregate}**, tolerance ${comparison.gate.tolerancePct}%, gate \`--fail-on ${comparison.gate.failOn}\` (regression scope \`${comparison.gate.regressionScope ?? 'task'}\`).`,
    `Base: ${comparison.base.profile} · ${comparison.base.model ?? 'model unknown'} · dsh ${comparison.base.dshVersion ?? '?'}`,
    `Ops: ${comparison.cand.profile} · ${comparison.cand.model ?? 'model unknown'} · dsh ${comparison.cand.dshVersion ?? '?'}`,
    '',
    `| task | tokens ${comparison.aggregate} base→ops (Δ%) | steps base→ops (Δ%) | tool calls base→ops (Δ%) | tool errors | pass |`,
    '|------|----------------------------------------|----------------------|-------------------------|-------------|------|',
    ...rows,
    `| **TOTAL** | ${totalTokens} | ${deltaCell(totals.baseSteps, totals.candSteps)} | ${deltaCell(totals.baseToolCalls, totals.candToolCalls)} | ${formatNumber(totals.baseToolErrors)}→${formatNumber(totals.candToolErrors)} | ${totals.basePasses}/${totals.baseRuns}→${totals.candPasses}/${totals.candRuns} |`,
    `| **GEOMEAN Δ** | ${geomeanTokens} | — | — | — | — |`,
    '',
    toolRows.length > 0
      ? ['## Tool calls (summed over every archived run on each side)',
        '',
        '| tool | base | ops |',
        '|------|------|------|',
        ...toolRows].join('\n')
      : '## Tool calls\n\nSkipped: neither side recorded a `toolCallsByName` breakdown.',
    '',
    tokens
      ? [`## Bucket detail (${comparison.aggregate} per task)`,
        '',
        '| task | input base→ops (Δ%) | output base→ops (Δ%) | cache read base→ops (Δ%) |',
        '|------|--------------------|----------------------|--------------------------|',
        ...comparison.tasks.map((task) => bucketRow(task.id, task.base, task.cand)),
        ...(totalBucketRow ? [totalBucketRow] : []),
      ].join('\n')
      : '## Bucket detail\n\nSkipped: at least one side lost a `step_end.usage`, so the per-bucket\nmedians below the total would be lower bounds presented as measurements.',
    '',
    ...(tokenBuckets ? [tokenBuckets, ''] : []),
    `Sources: ${sources.baseFile}`,
    `         ${sources.candFile}`,
    '',
  ]
  return `${lines.join('\n')}`
}

/**
 * The usage-bucket split: how the TOTAL delta divides between uncached input,
 * output, and cache reads. Diagnostic only — the gate judges `grandTotal` — but a
 * delta that sits in cache reads is a very different bill from the same delta in
 * uncached input, so the buckets are printed side by side. A partial usage set has no
 * honest split, so it degrades to a "Skipped" note instead of presenting lower bounds
 * as measurements.
 * @param {object} comparison - the structure from `compareSummaries`.
 * @param {boolean} tokens - whether the token columns are comparable at all.
 * @returns {string} the section text, or '' when there is nothing to show.
 */
function tokenBucketsSection(comparison, tokens) {
  if (!tokens) {
    return [
      '## Token buckets',
      '',
      'Skipped: at least one side lost a `step_end.usage`, so per-bucket deltas',
      'would be lower bounds presented as measurements.',
    ].join('\n')
  }
  const buckets = comparison.totals?.buckets
  if (!buckets?.comparable) return ''
  const row = (label, bucket) => `| ${label} | ${short(bucket.base)} | ${short(bucket.cand)} | ${signed(bucket.delta)} (${percentText(percentChange(bucket.base, bucket.cand))}) |`
  return [
    `## Token buckets (TOTAL, ${comparison.aggregate})`,
    '',
    'The three buckets sum to the total. A delta that sits in cache read is a very',
    'different bill from the same delta in uncached input, because cache reads are',
    'normally priced far below it. The gate judges the total.',
    '',
    '| bucket | base | ops | Δ (Δ%) |',
    '|--------|------|------|-------|',
    row('uncached input', buckets.input),
    row('output', buckets.output),
    row('cache read', buckets.cacheRead),
    row('**TOTAL**', buckets.grandTotal),
  ].join('\n')
}

/**
 * A signed, thousands-separated delta for a table cell.
 * @param {number|null} value - the delta.
 * @returns {string} the text.
 */
function signed(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded).toLocaleString('en-US')}`
}

/**
 * A percent rendered with its sign and a colour: green when the candidate spent no
 * more than the baseline (≤ 0, what a benchmark wants) and red when it spent more.
 * A missing value stays plain text — colouring it would imply a measurement.
 * @param {number|null} value - the percent.
 * @returns {string} the text.
 */
function percentText(value) {
  if (value === null || value === undefined) return 'n/a'
  const text = `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
  const colour = value > 0 ? 'red' : 'green'
  return `<span style="color:${colour}">${text}</span>`
}

/**
 * A short number for a table cell.
 * @param {number|null} value - the number.
 * @returns {string} the text.
 */
function short(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return Math.round(value).toLocaleString('en-US')
}

/**
 * Where the report is archived: one level *above* the candidate run directory.
 * A run directory is the immutable archive of one sweep (summary.json, results/,
 * runner.log, meta.json); the comparison is a *relation between* two archives, so
 * it belongs beside them — in `bench/runs/<folder>/` for a `--folder` round, in
 * `bench/runs/` for the flat layout. Same label pair in the same group is the same
 * file, so re-running a comparison updates the round's report instead of scattering
 * copies into run archives. Falls back to the run directory itself only when there
 * is no parent to write to (a filesystem root).
 * @param {{dir: string}} cand - the resolved candidate side.
 * @returns {string} the directory to write the report into.
 */
export function reportDir(cand) {
  const parent = path.dirname(cand.dir)
  return parent === cand.dir ? cand.dir : parent
}

/**
 * The comparator's main.
 * @param {string[]} argv - the arguments after the script name.
 * @returns {Promise<number>} the process exit code.
 */
export async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    printUsage()
    console.error(`compare: ${String(error?.message ?? error)}`)
    return 2
  }

  let base
  let cand
  try {
    base = resolveSide(options.base, options.runsDir, options.folder)
    cand = resolveSide(options.cand, options.runsDir, options.folder)
  } catch (error) {
    console.error(`compare: ${String(error?.message ?? error)}`)
    return 2
  }

  const comparison = compareSummaries(base.summary, cand.summary, {
    aggregate: options.aggregate,
    tolerancePct: options.tolerancePct,
    failOn: options.failOn,
    regressionScope: options.regressionScope,
  })
  const markdown = renderMarkdown(comparison, { baseFile: path.join(base.dir, 'summary.json'), candFile: path.join(cand.dir, 'summary.json') })
  console.log(markdown)

  const outDir = reportDir(cand)
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `comparison-${base.summary.label ?? 'base'}-vs-${cand.summary.label ?? 'cand'}.md`)
  fs.writeFileSync(outFile, `${markdown}\n`, 'utf8')
  console.error(`compare: wrote ${outFile}`)
  if (options.json) {
    fs.mkdirSync(path.dirname(path.resolve(options.json)), { recursive: true })
    fs.writeFileSync(path.resolve(options.json), `${JSON.stringify(comparison, null, 2)}\n`, 'utf8')
    console.error(`compare: wrote ${path.resolve(options.json)}`)
  }
  if (comparison.gate.fail) {
    console.error(`compare: GATE FAILED (${options.failOn}) — ${comparison.gate.reasons.join('; ')}`)
    return 1
  }
  if (!comparison.gate.tokensComparable && options.failOn !== 'none') {
    console.error('compare: token gate did not run (usage incomplete on at least one side); pass-drop only')
  }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2))
