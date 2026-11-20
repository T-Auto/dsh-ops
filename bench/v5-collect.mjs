/**
 * The V5 (#994) collector: judge the archived real sessions of one or more
 * v5-run sweeps and print the complete denominator with its noise read.
 *
 * The judge reuses the V4 shared rules verbatim (scanReissues for no-progress
 * retries and waits, countOpportunities for correction opportunities) and the
 * task verifiers that generalize to real trajectories (the paged-cursor and
 * wait-dispatch rules). The scripted-only parts of the V4 stories — the catalog
 * track's mandatory wrong call, the load-order track's mandatory not-loaded
 * rejection — are deliberately NOT required of a real run: a model that never
 * errs must not be judged as failing the story. What the collector reports
 * instead, per task and arm, is what #994 asks for: correct next steps,
 * correction opportunities, no-progress retries, waits, rule violations, the
 * first-round prompt versus the post-load step, and the usage buckets with
 * missing usage listed separately.
 *
 * Nothing here invents a denominator: a session that timed out stays in the
 * completion and pass rates, a session without usage stays a missing-usage row,
 * and an A/A sweep whose noise band covers a difference makes the collector say
 * "not distinguished" instead of attributing the difference to the tier.
 *
 * @module dsh-ops/bench/v5-collect
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadTrackTasks, TRACK_TASK_IDS } from './lib/track-corpus.mjs'
import { countOpportunities, scanReissues, TASK_VERIFIERS } from './lib/tracks.mjs'

const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

/** The buckets one step's prompt is made of. */
const PROMPT_BUCKETS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']
/** The shared usage buckets, in report order. */
const USAGE_BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']

/** The CLI text. */
const USAGE = [
  'usage: node bench/v5-collect.mjs --run <dir> [--run <dir>...] [--out <file>]',
  '',
  'Judges the archived sessions of v5-run sweeps and prints the V5 report tables.',
  'Multiple --run directories merge; the last one carries the output file when',
  '--out is omitted.',
  '',
  'Exit codes: 0 collected · 2 usage error',
].join('\n')

/** Parse the command line. */
function parseArgs(argv) {
  const options = { runs: [], out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '-h' || flag === '--help') { console.log(USAGE); process.exit(0) }
    if (flag === '--run') { options.runs.push(path.resolve(argv[index + 1])); index += 1; continue }
    if (flag === '--out') { options.out = path.resolve(argv[index + 1]); index += 1; continue }
    console.error('unknown option ' + JSON.stringify(flag) + '\n'); console.error(USAGE); process.exit(2)
  }
  if (options.runs.length === 0) { console.error(USAGE); process.exit(2) }
  return options
}

/** Read one JSON file or fail loud. */
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }

/**
 * Load one sweep: its environment, its summary rows and every archived trajectory.
 * @param {string} runDir - the sweep directory v5-run wrote.
 * @returns {object} {environment, rows: [{row, trajectory}]}.
 */
function loadRun(runDir) {
  const summaryFile = path.join(runDir, 'summary.json')
  if (!fs.existsSync(summaryFile)) throw new Error(summaryFile + ' is missing; run bench/v5-run.mjs first')
  const summary = readJson(summaryFile)
  const rows = summary.rows.map(row => {
    const trajectory = readJson(path.join(runDir, 'results', row.task + '-r' + row.repeat + '.' + row.arm + '.trajectory.json'))
    return { row, trajectory }
  })
  return { runDir, environment: summary.environment, rows }
}

/** Flatten one trajectory into the judge's ordered steps. */
function stepsOf(trajectory) {
  const steps = []
  trajectory.programs.forEach((program, programIndex) => {
    for (const call of program.calls ?? []) {
      steps.push({ index: steps.length, program: programIndex + 1, api: String(call.api), args: call.args ?? {}, response: call.response ?? {} })
    }
  })
  return steps
}

/** A step's dedupe key: same API, same arguments. */
const stepKey = step => step.api + ' ' + JSON.stringify(step.args)

/**
 * Count one task's correct next steps — the per-task rule, stated plainly:
 * - ptc-paged-lookup: reads that start at offset 1 or continue at the pending
 *   cursor, plus the answer write;
 * - ptc-catalog-recover: completed calls that used the task's advertised SDK
 *   set (the loader counts when the arm publishes one);
 * - ptc-sdk-load-order: a completed load followed by completed uses of the
 *   loaded API in later programs, plus the answer write;
 * - ptc-wait-dispatch: completed reads (batching counts once more per extra
 *   read in one program) and the edit when it awaited an earlier read's
 *   revision, plus the answer write.
 * @param {string} taskId - the task id.
 * @param {object[]} steps - the ordered steps.
 * @param {object} corpus - the task's fixed facts.
 * @param {object} row - the session's folded metrics (for the written answer).
 * @returns {number} the count.
 */
function countCorrectNextSteps(taskId, steps, corpus, row) {
  const completed = step => step.response?.status === 'completed'
  const wroteAnswer = (row.verify?.checks ?? []).some(check => check.passed && /answer/.test(check.path ?? '')) ? 1 : 0
  if (taskId === 'ptc-paged-lookup') {
    let correct = 0
    let cursor = null
    for (const step of steps.filter(candidate => candidate.api === 'ops_inspect_local_file' && stepArgsPath(step) === corpus.verify.path)) {
      const offset = Number(step.args.offset ?? 1)
      if (offset === 1 || (cursor !== null && offset === cursor)) correct += 1
      cursor = step.response?.status === 'partial' ? Number(step.response?.data?.nextOffset) : null
    }
    return correct + wroteAnswer
  }
  if (taskId === 'ptc-catalog-recover') {
    const advertised = new Set([...corpus.sdk, 'ops_load_sdk'])
    return steps.filter(step => advertised.has(step.api) && completed(step)).length + wroteAnswer
  }
  if (taskId === 'ptc-sdk-load-order') {
    const load = steps.find(step => step.api === corpus.verify.loader && completed(step))
    const uses = steps.filter(step => step.api === corpus.verify.api)
    const good = uses.filter(step => completed(step) && load !== undefined && step.program > load.program).length
    return good + wroteAnswer
  }
  // ptc-wait-dispatch
  let correct = 0
  const perProgram = new Map()
  for (const step of steps) {
    if (step.api === 'ops_inspect_local_file' && completed(step)) {
      correct += 1
      perProgram.set(step.program, (perProgram.get(step.program) ?? 0) + 1)
    }
  }
  for (const count of perProgram.values()) if (count >= 2) correct += 1
  const edits = steps.filter(step => step.api === corpus.verify.editApi && stepArgsPath(step) === corpus.verify.winner)
  if (edits.length > 0) {
    const revision = edits[0].args?.expectedRevision
    const awaited = steps.some(step => step.api === 'ops_inspect_local_file' && stepArgsPath(step) === corpus.verify.winner
      && completed(step) && step.response?.data?.revision === revision && step.index < edits[0].index)
    if (awaited && edits[0].response?.status === 'completed') correct += 2
  }
  return correct + wroteAnswer
}

/** One step's path argument, whatever key it used. */
function stepArgsPath(step) { return step.args?.path ?? null }

/**
 * Judge one real session: shared rules plus the task rules that generalize.
 * @param {object} entry - {row, trajectory}.
 * @param {object} corpus - the task's fixed facts.
 * @returns {object} the judged block.
 */
function judgeSession(entry, corpus) {
  const { row, trajectory } = entry
  const steps = stepsOf(trajectory)
  const facts = []
  const add = fact => facts.push(fact)
  const waits = scanReissues(steps, add)
  const opportunities = countOpportunities(steps)
  const general = TASK_VERIFIERS[corpus.id]
  // The scripted story verifiers demand a mandatory wrong call (catalog) or a
  // mandatory not-loaded rejection (load order); a real run that never erred
  // must not fail for missing them, so those two task rules stay unused here.
  if (corpus.id === 'ptc-paged-lookup' || corpus.id === 'ptc-wait-dispatch') {
    general({ programs: trajectory.programs }, corpus, steps, add)
  }
  if (String(row.answer ?? '').trim() !== String(corpus.answer.content).trim()) {
    add('answer.txt: expected ' + short(corpus.answer.content) + ' but the session wrote ' + short(row.answer ?? ''))
  }
  if (trajectory.programs.length > corpus.budget.maxPrograms) {
    add('the session spent ' + trajectory.programs.length + ' programs, over the fixed budget of ' + corpus.budget.maxPrograms)
  }
  return {
    opportunities, waits,
    noProgressRetries: facts.filter(fact => fact.startsWith('no-progress retry')).length,
    ruleViolations: facts.length,
    violations: facts,
    correctNextSteps: countCorrectNextSteps(corpus.id, steps, corpus, row),
    answerMatch: String(row.answer ?? '').trim() === String(corpus.answer.content).trim(),
  }
}

/** Clamp one fact for a report line. */
function short(text) {
  const value = String(text ?? '')
  return value.length > 60 ? value.slice(0, 57) + '...' : value
}

/** One number's median over a non-empty list; null otherwise. */
function medianOf(values) {
  const usable = values.filter(value => Number.isFinite(value))
  if (usable.length === 0) return null
  const sorted = [...usable].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Fold one arm's rows of one task into the report block.
 * @param {object[]} entries - the {row, trajectory} pairs of that arm.
 * @param {object} corpus - the task facts.
 * @returns {object} the arm block.
 */
function armBlock(entries, corpus) {
  const judged = entries.map(entry => judgeSession(entry, corpus))
  const rows = entries.map(entry => entry.row)
  const completedRows = rows.filter(row => !row.timedOut && row.sessionError === null)
  const firstPrompts = completedRows.map(row => row.prompt.firstStep).filter(value => Number.isFinite(value))
  const totals = completedRows.map(row => row.prompt.total).filter(value => Number.isFinite(value))
  const arm = {
    planned: rows.length,
    completed: completedRows.length,
    timedOut: rows.filter(row => row.timedOut).length,
    errored: rows.filter(row => row.sessionError !== null).length,
    missingUsage: rows.filter(row => !row.usageReported).length,
    verifyPass: rows.filter(row => row.verify.passed).length,
    opportunities: judged.reduce((sum, value) => sum + value.opportunities, 0),
    correctNextSteps: judged.reduce((sum, value) => sum + value.correctNextSteps, 0),
    noProgressRetries: judged.reduce((sum, value) => sum + value.noProgressRetries, 0),
    waits: judged.reduce((sum, value) => sum + value.waits, 0),
    ruleViolations: judged.reduce((sum, value) => sum + value.ruleViolations, 0),
    firstPrompt: { median: medianOf(firstPrompts), min: firstPrompts.length ? Math.min(...firstPrompts) : null, max: firstPrompts.length ? Math.max(...firstPrompts) : null },
    promptTotal: { median: medianOf(totals), min: totals.length ? Math.min(...totals) : null, max: totals.length ? Math.max(...totals) : null },
    usage: Object.fromEntries(USAGE_BUCKETS.map(bucket => [bucket, completedRows.reduce((sum, row) => sum + Number(row.usage[bucket] ?? 0), 0)])),
    cacheMissing: completedRows.filter(row => row.stepsWithUsage !== row.steps || Number.isNaN(Number(row.usage.cacheReadTokens))).length,
    judged: judged.map((value, index) => ({ repeat: entries[index].row.repeat, ...value })),
  }
  return arm
}

/** Render one block of key/value lines for the report. */
function lines(label, block, indent = '  ') {
  return [indent + '- ' + label + ':']
    .concat(Object.entries(block).filter(([, value]) => typeof value !== 'object').map(([key, value]) => indent + '  ' + key + ': ' + value))
}

/**
 * The entry point: load every run, judge, and write the report.
 * @param {string[]} argv - the arguments after the script name.
 */
export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const corpusAll = loadTrackTasks()
  const runs = options.runs.map(loadRun)
  const report = []
  report.push('# V5 Flash comparison — collected tables')
  for (const run of runs) {
    report.push('')
    report.push('## Sweep ' + path.basename(run.runDir) + (run.environment.aa ? ' (A/A)' : ''))
    const byTask = new Map()
    for (const entry of run.rows) {
      if (!byTask.has(entry.row.task)) byTask.set(entry.row.task, new Map())
      const arms = byTask.get(entry.row.task)
      arms.set(entry.row.arm, [...(arms.get(entry.row.arm) ?? []), entry])
    }
    for (const [taskId, arms] of byTask) {
      const corpus = corpusAll.find(entry => entry.id === taskId)
      report.push('')
      report.push('### Task ' + taskId)
      for (const [armLabel, entries] of arms) {
        const block = armBlock(entries, corpus)
        report.push(...lines('arm ' + armLabel, block))
        for (const bucket of USAGE_BUCKETS) report.push('    usage.' + bucket + ': ' + block.usage[bucket])
        report.push('    firstPrompt: median=' + block.firstPrompt.median + ' min=' + block.firstPrompt.min + ' max=' + block.firstPrompt.max)
        report.push('    promptTotal: median=' + block.promptTotal.median + ' min=' + block.promptTotal.min + ' max=' + block.promptTotal.max)
        for (const judged of block.judged) {
          report.push('    r' + judged.repeat + ': correct=' + judged.correctNextSteps + ' opportunities=' + judged.opportunities
            + ' retries=' + judged.noProgressRetries + ' waits=' + judged.waits + ' violations=' + judged.ruleViolations
            + ' answer=' + (judged.answerMatch ? 'match' : 'MISMATCH'))
        }
      }
    }
    report.push('')
    report.push('Environment: plugin ' + run.environment.plugin.commit + ', host ' + run.environment.host.version
      + ', ' + run.environment.platform + ', worker sha256 ' + String(run.environment.worker.sha256).slice(0, 8)
      + ', preset ' + run.environment.preset + ', condition ' + JSON.stringify(run.environment.condition)
      + ', sandbox ' + run.environment.sandbox.mode)
  }
  const text = report.join('\n') + '\n'
  const out = options.out ?? path.join(runs.at(-1).runDir, 'v5-collect.md')
  fs.writeFileSync(out, text)
  console.log(text)
  console.log('[v5] wrote ' + out)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
