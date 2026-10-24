#!/usr/bin/env node
/**
 * The comparison report: two archived runs in, one timestamped markdown file out.
 *
 * The artifact lands where a reviewer looks for a sweep, not inside the arm directory
 * that measured half of it: a run in `bench/runs/<group>/<stamp>-<label>` writes
 * `bench/runs/<group>/DSH-OPS Benchmark Report <UTC>.md`, and a run with no group folder
 * above it keeps the report in its own directory. The file name carries the write
 * instant (the same UTC shape as a run directory) so a second comparison never
 * overwrites the first; the rendered text stays clock-free and diffable.
 *
 * The verdict is *not* computed here. `lib/compare-core.mjs` owns every rule — pass
 * rate first, cost only over pairs that passed on both sides, and a direction only
 * when the measured delta clears the A/A noise floor — and this file only resolves
 * the two sides, calls it, and renders what it returned. With no noise floor the
 * report says so and abstains from every cost direction (`noise-floor-unknown`).
 *
 * The report opens with its fixed title and then the data a reviewer works
 * through — the per-task paired table, the tool table and the diagnostic sections
 * (per-task bucket detail, per-request overhead) which say
 * *why* the number moved. It prints no verdict prose and no side paths: the gate's
 * verdict travels through the exit code and the comparison document, not the markdown.
 *
 * Durations are displayed like any other metric (the per-task table's time column);
 * the verdict's cost basis remains paired tokens.
 *
 * @module dsh-ops/bench/compare
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGGREGATES,
  FAIL_ON,
  REGRESSION_SCOPES,
  compareSummaries,
  formatNumber,
  percentChange,
} from './lib/compare-core.mjs'
import { RUNS_DIR } from './lib/next-folder.mjs'

/** The sealed contract document inside a run directory. */
const SEALED_RUN = 'run.json'
/** #183's older summary document, still accepted as a side. */
const LEGACY_SUMMARY = 'summary.json'
/** The summary document's format tag. */
const SUMMARY_FORMAT = 'dsh-ops-bench-summary-v1'
/** The report's fixed title, marked (beta); the two sides are named in Evidence, not in the heading. */
const REPORT_TITLE = '# DSH-OPS Benchmark Report (beta)'
/** The file name stem: the title's words, so the artifact is recognizable in a folder listing. */
const REPORT_STEM = 'DSH-OPS Benchmark Report'
/** The panel's palette: the report and `panel.html` must agree on what green and red mean. */
const GREEN = '#3fb950'
const RED = '#f85149'

/**
 * Exit codes, kept in step with `EXIT` in `bench/cli.mjs` (which forwards whatever
 * `main` returns): the A/B comparison's exit code *is* its verdict.
 */
export const EXIT = { ok: 0, failure: 1, usage: 2 }

const USAGE = `usage: node bench/compare.mjs <base> <cand> [options]

  <base> <cand>      each side is one of:
                       <label>   a run label, matched against bench/runs/*-<label>
                                 and one level of bench/runs/<folder>/*-<label>
                                 groups (the newest stamp wins)
                       <dir>     a run directory (run.json, else summary.json)
                       <file>    a run.json or summary.json path
  --folder <name>    restrict label matching to bench/runs/<name>/
  --runs <dir>       override the runs root (default bench/runs)
  --aggregate S      median (default) or min: the statistic the deltas compare
  --tolerance-pct N  token regression tolerance in percent (default 2)
  --fail-on MODE     regression | pass-drop | both (default) | none
  --regression-scope S  task (default) | total | both
  --noise-floor-pct N   pin the A/A noise floor; without a floor every cost
                     direction is withheld (noise-floor-unknown)
  --noise <a> <b>    measure the A/A noise floor from two baseline runs
  --json             print the comparison document as JSON instead of the report
  --out <file>       where the rendered artifact goes (default: the sweep's group
                     folder, named "DSH-OPS Benchmark Report <UTC>.md" — a run with no
                     group folder above it keeps the report in its own directory;
                     "-" is stdout only). With --json the file carries the JSON.
  --help             this text

Exit codes: 0 ok (or a gate that abstained) · 1 a gate failed · 2 usage/input error`

/**
 * The parsed command line.
 * @typedef {object} Options
 * @property {string|null} base - the baseline side spec.
 * @property {string|null} cand - the candidate side spec.
 * @property {string|null} folder - restrict label matching to one group directory.
 * @property {string} runsDir - where run directories live.
 * @property {'median'|'min'} aggregate - the statistic to compare.
 * @property {number} tolerancePct - the regression tolerance.
 * @property {'regression'|'pass-drop'|'both'|'none'} failOn - the gate.
 * @property {'task'|'total'|'both'} regressionScope - what the regression gate judges.
 * @property {number|null} noiseFloorPct - an externally pinned A/A floor.
 * @property {string[]|null} noise - two A/A side specs to measure the floor from.
 * @property {boolean} json - print the comparison document instead of the report.
 * @property {string|null} out - report path, `-` for stdout only, null for the default.
 * @property {boolean} help - whether `--help` was asked for.
 */

/**
 * Parse the command line. A malformed flag throws; `main` turns that into exit 2.
 * @param {string[]} argv - the arguments after the script name.
 * @returns {Options} the options.
 */
export function parseArgs(argv) {
  const positional = []
  const options = {
    base: null,
    cand: null,
    folder: null,
    runsDir: RUNS_DIR,
    aggregate: 'median',
    tolerancePct: 2,
    failOn: 'both',
    regressionScope: 'task',
    noiseFloorPct: null,
    noise: null,
    json: false,
    out: null,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg : arg.slice(0, eq)
      const inline = eq === -1 ? null : arg.slice(eq + 1)
      const take = () => {
        if (inline !== null) return inline
        index += 1
        if (index >= argv.length) throw new Error(`${name} needs a value`)
        return argv[index]
      }
      if (name === '--json') {
        if (inline !== null) throw new Error('--json takes no value; the comparison document goes to stdout and --out names a file')
        options.json = true
      } else if (name === '--aggregate') options.aggregate = take()
      else if (name === '--tolerance-pct') options.tolerancePct = Number(take())
      else if (name === '--fail-on') options.failOn = take()
      else if (name === '--regression-scope') options.regressionScope = take()
      else if (name === '--noise-floor-pct') options.noiseFloorPct = Number(take())
      else if (name === '--noise') {
        const first = take()
        index += 1
        if (index >= argv.length) throw new Error('--noise needs two sides: --noise <base> <cand>')
        options.noise = [first, argv[index]]
      } else if (name === '--out') options.out = take()
      else if (name === '--folder') options.folder = assertFolderName(take(), '--folder')
      else if (name === '--runs') options.runsDir = path.resolve(take())
      else throw new Error(`unknown option "${name}"`)
      continue
    }
    if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown option "${arg}"`)
    positional.push(arg)
  }
  if (!AGGREGATES.includes(options.aggregate)) throw new Error(`--aggregate must be one of ${AGGREGATES.join(', ')}`)
  if (!FAIL_ON.includes(options.failOn)) throw new Error(`--fail-on must be one of ${FAIL_ON.join(', ')}`)
  if (!REGRESSION_SCOPES.includes(options.regressionScope)) throw new Error(`--regression-scope must be one of ${REGRESSION_SCOPES.join(', ')}`)
  if (!Number.isFinite(options.tolerancePct) || options.tolerancePct < 0) throw new Error('--tolerance-pct must be a non-negative number')
  if (options.noiseFloorPct !== null && (!Number.isFinite(options.noiseFloorPct) || options.noiseFloorPct < 0)) {
    throw new Error('--noise-floor-pct must be a non-negative number')
  }
  if (options.help) return options
  if (positional.length !== 2) throw new Error('expected exactly two sides: <base> <cand>')
  options.base = positional[0]
  options.cand = positional[1]
  return options
}

/**
 * A `--folder` name must be one flat, safe directory segment under the runs root.
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

/** Whether a path exists and is a directory. */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Whether a path exists and is a file. */
function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * Read and identify one side's document.
 *
 * Two shapes exist in this repo and both are accepted: the sealed `run.json`
 * (`schemaVersion: 1`, `results` rows) and #183's summary. Anything else is refused
 * loudly rather than silently compared as an empty document.
 * @param {string} file - the document path.
 * @returns {{doc: object, file: string, dir: string, kind: 'run'|'summary'}} the side document.
 */
function readSide(file) {
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: not readable as JSON (${error.message})`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file}: not a JSON object`)
  const sealed = doc.schemaVersion === 1 && Array.isArray(doc.results)
  if (sealed) return { doc, file, dir: path.dirname(file), kind: 'run' }
  if (doc.format === SUMMARY_FORMAT && Array.isArray(doc.results)) return { doc, file, dir: path.dirname(file), kind: 'summary' }
  const saw = typeof doc.format === 'string' ? `format "${doc.format}"` : `schemaVersion ${JSON.stringify(doc.schemaVersion)}`
  throw new Error(`${file}: unrecognised document (want a sealed run.json with schemaVersion 1 or a summary with format "${SUMMARY_FORMAT}", saw ${saw})`)
}

/**
 * Resolve one side of the comparison.
 *
 * Three forms, in the order #183 made convenient: an existing directory (preferring
 * `run.json` over `summary.json`), an existing file, or a label matched against the
 * runs root and one level of group directories (the newest stamp wins — a comparison
 * is about the latest measured state of each side).
 * @param {string} spec - a label, a run directory, or a document path.
 * @param {object} [options] - `{runsDir, folder}`.
 * @returns {{doc: object, file: string, dir: string, kind: 'run'|'summary', spec: string}} the resolved side.
 */
export function resolveSide(spec, options = {}) {
  const runsDir = options.runsDir ?? RUNS_DIR
  const folder = options.folder ?? null
  const direct = path.resolve(spec)
  if (isDirectory(direct)) {
    const file = [SEALED_RUN, LEGACY_SUMMARY]
      .map((name) => path.join(direct, name))
      .find((candidate) => fs.existsSync(candidate))
    if (!file) throw new Error(`${direct}: a directory, but it has no ${SEALED_RUN} and no ${LEGACY_SUMMARY}`)
    return { ...readSide(file), spec }
  }
  if (isFile(direct)) return { ...readSide(direct), spec }
  return { ...readSide(findLabel(spec, runsDir, folder)), spec }
}

/**
 * Find the newest archived run whose directory name is, or ends in, the label.
 * @param {string} spec - the label.
 * @param {string} runsDir - the runs root.
 * @param {string|null} folder - one group directory to search instead of the root
 *   plus one level of groups.
 * @returns {string} the document path.
 */
function findLabel(spec, runsDir, folder) {
  if (!isDirectory(runsDir)) {
    throw new Error(`no runs directory at ${runsDir}; pass a run directory or a ${SEALED_RUN}/${LEGACY_SUMMARY} path instead of the label "${spec}"`)
  }
  let roots
  if (folder !== null) {
    roots = [path.join(runsDir, folder)]
    if (!isDirectory(roots[0])) throw new Error(`no run folder "${folder}" at ${roots[0]}`)
  } else {
    roots = [runsDir]
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(runsDir, entry.name))
    }
  }
  const matches = []
  for (const root of roots) {
    let names
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (name !== spec && !name.endsWith(`-${spec}`)) continue
      const dir = path.join(root, name)
      if (!isDirectory(dir)) continue
      for (const fileName of [SEALED_RUN, LEGACY_SUMMARY]) {
        const candidate = path.join(dir, fileName)
        if (fs.existsSync(candidate)) {
          matches.push({ name, file: candidate })
          break
        }
      }
    }
  }
  if (matches.length === 0) {
    const where = folder === null ? runsDir : path.join(runsDir, folder)
    throw new Error(`"${spec}" is neither a run directory, a ${SEALED_RUN}/${LEGACY_SUMMARY} path, nor a label with an archived run under ${where}`)
  }
  matches.sort((left, right) => (left.name === right.name ? left.file.localeCompare(right.file) : left.name < right.name ? -1 : 1))
  return matches[matches.length - 1].file
}

/** The U+2212 minus sign, so a negative delta reads as a sign rather than a hyphen. */
const MINUS = '\u2212'

/** A thousands-separated integer, `n/a` when it is not a number. */
function number(value) {
  return formatNumber(value)
}

/**
 * A step or tool-call count: an integer, or one decimal when an even repeat count
 * halves the median. Rounding 12.5 → 13 would print "13 → 13 (+4.0%)", a cell that
 * contradicts its own Δ%.
 * @param {number|null} value - the count.
 * @returns {string} the display form.
 */
function count(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return Number.isInteger(value) ? formatNumber(value) : value.toFixed(1)
}

/** A signed integer delta with grouping, for the diagnostic tables. */
function signed(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : rounded < 0 ? MINUS : ''}${Math.abs(rounded).toLocaleString('en-US')}`
}

/**
 * Paint one rendered value: a drop (or no change) is green, a rise is red — the same
 * two colours `panel.html` uses, inline because a markdown file cannot carry a
 * stylesheet. A value with no number behind it is returned unwrapped.
 * @param {string} text - the rendered value.
 * @param {number|null} value - the signed number behind it.
 * @returns {string} the HTML span, or `text`.
 */
function color(text, value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return text
  return `<span style="color:${value > 0 ? RED : GREEN}">${text}</span>`
}

/** A signed percent at the module's reporting precision, painted by its sign. */
function percent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return color(`${value > 0 ? '+' : value < 0 ? MINUS : ''}${Math.abs(value).toFixed(1)}%`, value)
}

/**
 * The per-task paired table: cost, the behaviour behind it (steps, tool calls, tool
 * errors) and the pass migration, all on the row a reviewer reads first.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function taskSection(comparison) {
  const { totals } = comparison
  const useMin = comparison.aggregate === 'min'
  const keys = { steps: useMin ? 'stepsMin' : 'stepsMedian', toolCalls: useMin ? 'toolCallsMin' : 'toolCallsMedian', toolErrors: useMin ? 'toolErrorsMin' : 'toolErrorsMedian', duration: useMin ? 'durationMsMin' : 'durationMsMedian' }
  // The change rides inside the cell it belongs to (`1,050 (+5.0%)`, `4 → 3 (−25%)`):
  // one number per row, with its Δ% in parentheses rather than a column of its own.
  const candCell = (value, pct) => `${number(value)}${Number.isFinite(pct) ? ` (${percent(pct)})` : ''}`
  const deltaCell = (baseValue, candValue, pct) => `${count(baseValue)} → ${count(candValue)}${Number.isFinite(pct) ? ` (${percent(pct)})` : ''}`
  const countCell = (baseValue, candValue) => `${count(baseValue)} → ${count(candValue)}`
  // Time renders like every other metric: same aggregate, same direction colouring.
  const seconds = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '—')
  const timeCell = (baseMs, candMs, pct) => `${seconds(baseMs)} → ${seconds(candMs)}${Number.isFinite(pct) ? ` (${percent(pct)})` : ''}`
  const passCell = (side) => `${side.base.passed}/${side.base.repeats}→${side.cand.passed}/${side.cand.repeats}`
  const lines = [
    '## Per-task pairs',
    '',
    '| task | base | ops (Δ%) | steps: base→ops (Δ%) | tool calls: base→ops (Δ%) | time: base→ops (Δ%) | tool errors | pass |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const task of comparison.tasks) {
    const pair = task.paired
    const name = task.inBase && task.inCand ? task.id : `${task.id}${task.inBase ? '(base only)' : '(ops only)'}`
    lines.push(`| ${name} | ${number(pair.baseValue)} | ${candCell(pair.candValue, pair.pct)} | ${deltaCell(task.base[keys.steps], task.cand[keys.steps], task.delta.stepsPct)} | ${deltaCell(task.base[keys.toolCalls], task.cand[keys.toolCalls], task.delta.toolCallsPct)} | ${timeCell(task.base[keys.duration], task.cand[keys.duration], task.delta.durationPct)} | ${countCell(task.base[keys.toolErrors], task.cand[keys.toolErrors])} | ${passCell(task)} |`)
  }
  lines.push(`| **TOTAL** | ${number(totals.baseGrandTotal)} | ${candCell(totals.candGrandTotal, totals.grandTotalPct)} | ${deltaCell(totals.baseSteps, totals.candSteps, percentChange(totals.baseSteps, totals.candSteps))} | ${deltaCell(totals.baseToolCalls, totals.candToolCalls, percentChange(totals.baseToolCalls, totals.candToolCalls))} | ${timeCell(totals.baseDurationMs, totals.candDurationMs, percentChange(totals.baseDurationMs, totals.candDurationMs))} | ${countCell(totals.baseToolErrors, totals.candToolErrors)} | ${totals.basePasses}/${totals.baseRuns}→${totals.candPasses}/${totals.candRuns} |`)
  return lines
}

/**
 * #183's per-task bucket detail: the three usage buckets behind each task's total.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function bucketSection(comparison) {
  const useMin = comparison.aggregate === 'min'
  const keys = { input: useMin ? 'inputMin' : 'inputMedian', output: useMin ? 'outputMin' : 'outputMedian', cacheRead: useMin ? 'cacheReadMin' : 'cacheReadMedian' }
  const cell = (baseValue, candValue) => `${number(baseValue)} → ${number(candValue)} (${percent(percentChange(baseValue, candValue))})`
  const lines = [
    '## Per-task bucket detail',
    '',
    '| task | input: base→ops (Δ%) | output: base→ops (Δ%) | cache read: base→ops (Δ%) |',
    '| --- | --- | --- | --- |',
  ]
  for (const task of comparison.tasks) {
    lines.push(`| ${task.id} | ${cell(task.base[keys.input], task.cand[keys.input])} | ${cell(task.base[keys.output], task.cand[keys.output])} | ${cell(task.base[keys.cacheRead], task.cand[keys.cacheRead])} |`)
  }
  const buckets = comparison.totals.buckets
  if (buckets.comparable) {
    lines.push(`| **TOTAL** | ${cell(buckets.input.base, buckets.input.cand)} | ${cell(buckets.output.base, buckets.output.cand)} | ${cell(buckets.cacheRead.base, buckets.cacheRead.cand)} |`)
  }
  return lines
}

/**
 * The per-request overhead table: the first request of a run carries no history, so its
 * delta is the fixed cost a tool surface or prompt policy adds, paid on every request.
 * Archives without `metrics.prompt` cannot separate that request, so the section says
 * so instead of inventing numbers.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function overheadSection(comparison) {
  const lines = ['## Per-request overhead (what every request costs before any work)', '']
  const prompted = comparison.tasks.some((task) => Number.isFinite(task.base.firstRequestPromptMedian) || Number.isFinite(task.cand.firstRequestPromptMedian))
  if (!prompted) {
    lines.push('Skipped: neither side recorded `metrics.prompt`, so the first request cannot be separated from the run.')
    return lines
  }
  const firstCell = (task) => {
    const base = task.base.firstRequestPromptMedian
    const cand = task.cand.firstRequestPromptMedian
    if (!Number.isFinite(base) || !Number.isFinite(cand)) return 'n/a'
    return `${number(base)} → ${number(cand)} (${signed(task.delta.firstRequestPromptAbs)}, ${percent(task.delta.firstRequestPromptPct)})`
  }
  lines.push(
    '| task | first request: base→ops |',
    '| --- | --- |',
  )
  for (const task of comparison.tasks) {
    lines.push(`| ${task.id} | ${firstCell(task)} |`)
  }
  return lines
}

/**
 * Tool adoption, per tool and per task: a tool called once and never again is still
 * evidence it was published and reached for. The `base` and `cand` columns keep the
 * sweep-wide sums; each task column splits them by task, so a call can be read against
 * the task whose Δ it explains.
 *
 * Colour follows adoption, not the sign: an `ops_*` tool rising is green (the plugin's
 * tool replaced a built-in), while any other tool rising is red (the candidate kept
 * reaching past the plugin); falling is green for a built-in and red for an `ops_*`
 * tool. Equal counts are not painted.
 *
 * It renders directly under the per-task pair table: that table prices the Δ, this
 * one shows the calls it was spent on, so the reader meets the two together.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function toolSection(comparison) {
  const totals = new Map()
  const perTask = comparison.tasks.map((task) => {
    const counts = new Map()
    for (const side of ['base', 'cand']) {
      for (const [name, value] of Object.entries(task[side].toolCallsByName ?? {})) {
        const entry = totals.get(name) ?? { base: 0, cand: 0 }
        entry[side] += value
        totals.set(name, entry)
        const own = counts.get(name) ?? { base: 0, cand: 0 }
        own[side] += value
        counts.set(name, own)
      }
    }
    return { id: task.id, counts }
  })
  const lines = ['## Tool calls', '']
  if (totals.size === 0) {
    lines.push('Skipped: neither side recorded `toolCallsByName`.')
    return lines
  }
  const own = (name) => name.startsWith('ops')
  const cand = (name, counts) => {
    if (counts.cand === counts.base) return number(counts.cand)
    const good = own(name) ? counts.cand > counts.base : counts.cand < counts.base
    return `<span style="color:${good ? GREEN : RED}">${number(counts.cand)}</span>`
  }
  const cell = (name, counts) => (counts ? `${number(counts.base)} → ${cand(name, counts)}` : '—')
  const rows = [...totals.entries()].sort((left, right) => (Number(own(right[0])) - Number(own(left[0]))) || (right[1].cand - left[1].cand) || left[0].localeCompare(right[0]))
  lines.push(
    `| tool | base | ops | ${comparison.tasks.map((task) => task.id).join(' | ')} |`,
    `| --- | --- | --- | ${comparison.tasks.map(() => '---').join(' | ')} |`,
  )
  for (const [name, counts] of rows) {
    const tasks = perTask.map((task) => cell(name, task.counts.get(name))).join(' | ')
    lines.push(`| ${name} | ${number(counts.base)} | ${cand(name, counts)} | ${tasks} |`)
  }
  return lines
}

/**
 * Render the comparison as the report document — the text `reportFileName` names and
 * `main` writes.
 *
 * Pure: same comparison in, byte-identical text out. No timestamps are written, so the
 * report is reproducible and diffable.
 * @param {object} comparison - the structure from `compareSummaries`.
 * @returns {string} the report text (no trailing newline).
 */
export function renderReport(comparison) {
  const lines = [
    REPORT_TITLE,
    '',
    ...taskSection(comparison),
    '',
    ...toolSection(comparison),
    '',
    ...bucketSection(comparison),
    '',
    ...overheadSection(comparison),
  ]
  return lines.join('\n')
}

/**
 * The write instant in the shape a run directory carries it: `2026-10-20T12-36-38Z`.
 * Colons and dots become dashes so the name is legal on every filesystem, and the
 * seconds are UTC so two comparisons never share a name across time zones.
 * @param {number|Date} [now] - the instant; defaults to the wall clock.
 * @returns {string} the stamp.
 */
export function reportStamp(now = Date.now()) {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z`
}

/**
 * The report's file name: the title's words plus the write instant, so a folder of
 * sweeps reads as reports rather than as `report.md` repeated.
 * @param {number|Date} [now] - the instant; defaults to the wall clock.
 * @returns {string} the file name, `.md` included.
 */
export function reportFileName(now = Date.now()) {
  return `${REPORT_STEM} ${reportStamp(now)}.md`
}

/**
 * The directory the report belongs to: the group folder a sweep shares, not the arm
 * directory that measured half of it. A comparison is about the sweep, so a reviewer
 * opening `bench/runs/full-sweep-4/` should find the report there.
 *
 * Only the shape this harness writes is promoted — a run directory one level below the
 * runs root. A run directly under the root has no group folder to promote to, and
 * anything deeper is some other layout, so both keep the report beside `run.json`.
 * @param {Options} options - the parsed options.
 * @param {{dir: string}} cand - the resolved candidate side.
 * @returns {string} the absolute directory.
 */
function reportDir(options, cand) {
  const runsDir = path.resolve(options.runsDir ?? RUNS_DIR)
  const dir = path.resolve(cand.dir)
  const parent = path.dirname(dir)
  const group = path.relative(runsDir, parent)
  const nested = group !== '' && !group.startsWith('..') && !path.isAbsolute(group) && !/[\\/]/.test(group)
  return nested ? parent : dir
}

/**
 * Where the rendered artifact goes.
 * @param {Options} options - the parsed options.
 * @param {{dir: string}} cand - the resolved candidate side.
 * @param {number} now - the instant the default file name carries.
 * @returns {string|null} the absolute path, or null to write no file.
 */
function reportPath(options, cand, now) {
  if (options.out === '-') return null
  if (options.out !== null) return path.resolve(options.out)
  if (options.json) return null
  return path.join(reportDir(options, cand), reportFileName(now))
}

/**
 * The comparator's main.
 *
 * Everything that decides is in `compare-core.mjs`; this resolves, renders, writes
 * and maps the gate to an exit code. A cost gate that could not run (no noise floor,
 * incomplete usage, no both-passed pair) abstains — it does not fail the run.
 * @param {string[]} argv - the arguments after the script name.
 * @param {{out?: Function, err?: Function, now?: Function}} [io] - output sinks and the
 *   clock the default file name reads; defaults to the console and the wall clock.
 * @returns {Promise<number>} the process exit code.
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  const now = io.now ?? (() => Date.now())
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    err(USAGE)
    err(`compare: ${String(error?.message ?? error)}`)
    return EXIT.usage
  }
  if (options.help) {
    out(USAGE)
    return EXIT.ok
  }

  let base
  let cand
  let noise = null
  try {
    base = resolveSide(options.base, options)
    cand = resolveSide(options.cand, options)
    if (options.noise !== null) {
      noise = { base: resolveSide(options.noise[0], options).doc, cand: resolveSide(options.noise[1], options).doc }
    }
  } catch (error) {
    err(`compare: ${String(error?.message ?? error)}`)
    return EXIT.usage
  }

  const comparison = compareSummaries(base.doc, cand.doc, {
    aggregate: options.aggregate,
    tolerancePct: options.tolerancePct,
    failOn: options.failOn,
    regressionScope: options.regressionScope,
    noiseFloorPct: options.noiseFloorPct ?? undefined,
    noise: noise ?? undefined,
  })
  const payload = options.json
    ? `${JSON.stringify(comparison, null, 2)}\n`
    : `${renderReport(comparison)}\n`
  out(payload)

  const target = reportPath(options, cand, now())
  if (target !== null) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, payload, 'utf8')
    } catch (error) {
      err(`compare: could not write ${target} (${String(error?.message ?? error)})`)
      return EXIT.failure
    }
    err(`compare: wrote ${target}`)
  }

  if (comparison.gate.fail) {
    err(`compare: GATE FAILED (${comparison.gate.failOn}) — ${comparison.gate.reasons.join('; ')}`)
    return EXIT.failure
  }
  if (options.failOn !== 'none') {
    if (!comparison.gate.tokensComparable) err('compare: cost gate did not run (usage incomplete on at least one side); only the pass-drop gate ran.')
    else if (!comparison.gate.costComparable) err(`compare: cost gate did not run (no pair passed on both sides; ${comparison.gate.excludedPairs} pair(s) excluded); only the pass-drop gate ran.`)
    else if (!comparison.noiseFloor.comparable) err('compare: noise floor unknown ⇒ cost direction withheld (noise-floor-unknown); supply one with --noise-floor-pct or --noise.')
  }
  return EXIT.ok
}

// Only when executed, not when the suite imports it.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
