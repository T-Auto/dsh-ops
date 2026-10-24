/**
 * Schedule one A/B sweep: AB/BA-interleaved pairs, one session at a time, and the
 * A/A noise floor (issue #205 §三①).
 *
 * #183 measured one arm per process: every baseline run first, then every candidate
 * run. On a shared machine the two halves then see different conditions — server
 * warm-up, prompt-cache state, thermal drift, a background build — and that
 * difference lands in the token delta as if the plugin had caused it. The fix is not
 * statistics, it is ordering: for each `(task, repeat)` the two arms run back to
 * back, and which arm goes first flips with the parity of the repeat — odd repeats
 * base→cand, even repeats cand→base — so a monotone drift cancels instead of piling
 * onto one side. {@link armOrder} is the whole of that rule.
 *
 * The runs are strictly serial on purpose: two `dsh` children at once would contend
 * for the model server's queue and each other's prompt cache, and a pairing is only
 * meaningful when both halves see the same machine.
 *
 * A/A mode (`aa: true`) runs the baseline twice and pairs the two baseline sides with
 * `compare-core`'s {@link noiseFloor}, so a later comparison can ask "is this delta
 * bigger than what the harness does while standing still?" instead of reading noise as
 * a result.
 *
 * Sealing is deliberately NOT here: `bench/run/seal.mjs` (P8a) owns the run.json
 * contract, so the caller injects `options.seal` and this module only calls it with the
 * complete sweep context. Nothing here imports that file, and nothing here renders a
 * verdict of its own: the summaries go to `compare-core`, which owns the pass-drop
 * gate, the paired cost statistics and the noise floor.
 *
 * @module dsh-ops/bench/run/schedule
 */

import fs from 'node:fs'
import path from 'node:path'
import { createObserver } from '../lib/observe.mjs'
import { pairMetrics } from '../lib/aggregate.mjs'
import { compareSummaries, noiseFloor } from '../lib/compare-core.mjs'
import { runSession } from './session.mjs'

/** The summary tag `bench/compare.mjs` (P11b) accepts as one side of a comparison. */
export const SUMMARY_FORMAT = 'dsh-ops-bench-summary-v1'
/** The sweep document tag this module returns; the seal step turns it into run.json. */
export const SWEEP_FORMAT = 'dsh-ops-bench-sweep-v1'
/** Repeats per task when neither `--repeat` nor the task's own `repeat` field says. */
export const DEFAULT_REPEAT = 1
/** The two sides an arm may play. `--aa` uses `base` twice, with distinct labels. */
export const SIDES = ['base', 'cand']

/**
 * The arms in the order one pair runs them: odd repeats `base → cand`, even repeats
 * `cand → base`. This is the first-principles fix of #205 §三①, in one function, so a
 * test can pin the flip without a model or a clock.
 * @param {number} repeatIndex - the 1-based repeat number of the pair.
 * @param {object[]} arms - the arms of the sweep, in their nominal (`base`, `cand`) order.
 * @returns {object[]} the same arms, possibly reversed.
 */
export function armOrder(repeatIndex, arms) {
  if (!Number.isInteger(repeatIndex) || repeatIndex < 1) {
    throw new TypeError(`armOrder: repeatIndex must be a positive integer (got ${String(repeatIndex)})`)
  }
  const list = [...arms]
  return repeatIndex % 2 === 1 ? list : list.reverse()
}

/**
 * The effective repeat budget per task: an explicit `--repeat` rules over the whole
 * sweep, otherwise the task's own `repeat` field wins over the default. Tiering this
 * way lets cheap tasks earn their samples without taxing the expensive ones.
 * @param {object[]} tasks - the selected tasks.
 * @param {{repeat?: number, repeatExplicit?: boolean}} [options] - the parsed budget.
 * @returns {Record<string, number>} the budget keyed by task id.
 */
export function repeatsById(tasks, { repeat = DEFAULT_REPEAT, repeatExplicit = false } = {}) {
  const budgets = {}
  for (const task of tasks ?? []) {
    const own = Number.isInteger(task?.repeat) && task.repeat > 0 ? task.repeat : repeat
    budgets[task.id] = repeatExplicit ? repeat : own
  }
  return budgets
}

/**
 * Every `(task, repeat)` the sweep measures, in run order: task by task, repeats
 * within a task ascending. A pair is the unit the interleaving and the pairing share.
 * @param {{tasks?: object[], repeats?: Record<string, number>}} [spec] - the corpus and its budget.
 * @returns {{task: object, repeatIndex: number}[]} the pairs.
 */
export function planPairs({ tasks = [], repeats = {} } = {}) {
  const pairs = []
  for (const task of tasks) {
    const count = repeats[task.id] ?? task.repeat ?? DEFAULT_REPEAT
    for (let repeatIndex = 1; repeatIndex <= count; repeatIndex += 1) pairs.push({ task, repeatIndex })
  }
  return pairs
}

/**
 * The flat session plan, in execution order — what `--show` prints and what makes the
 * interleaving auditable before a single token is spent.
 * @param {{tasks?: object[], repeats?: Record<string, number>, arms: object[]}} spec - corpus, budget and arms.
 * @returns {{taskId: string, repeatIndex: number, side: string, label: string}[]} the sessions.
 */
export function planSessions({ tasks = [], repeats = {}, arms }) {
  const plan = []
  for (const pair of planPairs({ tasks, repeats })) {
    for (const arm of armOrder(pair.repeatIndex, arms)) {
      plan.push({ taskId: pair.task.id, repeatIndex: pair.repeatIndex, side: arm.side, label: arm.label })
    }
  }
  return plan
}

/**
 * The Ctrl-C state one sweep shares with every session it runs. The session attaches
 * its live child here; the caller's signal handler flips `stopped` and kills it.
 * @returns {{stopped: boolean, child: object|null, pid: number|null}} the state.
 */
export function createInterrupt() {
  return { stopped: false, child: null, pid: null }
}

/** Validate and default the arms: one or two, each with a side, a label and a profile. */
function normalizeArms(arms) {
  if (!Array.isArray(arms) || arms.length < 1 || arms.length > 2) {
    throw new TypeError('runSweep: spec.arms must be one or two {side, label, profile} arms')
  }
  return arms.map((arm, index) => {
    const side = arm?.side ?? SIDES[index]
    if (!SIDES.includes(side)) throw new TypeError(`runSweep: spec.arms[${index}].side must be "base" or "cand"`)
    const label = arm?.label
    const profile = arm?.profile ?? label
    if (typeof label !== 'string' || label === '') throw new TypeError(`runSweep: spec.arms[${index}].label is required`)
    if (typeof profile !== 'string' || profile === '') throw new TypeError(`runSweep: spec.arms[${index}].profile is required`)
    return { ...arm, side, label, profile }
  })
}

/**
 * A row for a session that never produced one — a throw out of the runner, or a
 * runner that returned nothing. It is a failed row, never a pass, so a broken row
 * cannot erase a sweep *or* quietly count as a success.
 * @param {object} arm - the arm that was running.
 * @param {object} pair - the task and repeat.
 * @param {unknown} error - what went wrong.
 * @param {() => number} clock - the injectable clock.
 * @param {object} spec - the sweep spec, for the timeout the row claims.
 * @returns {object} the row.
 */
function failedRow(arm, pair, error, clock, spec) {
  const message = String(error?.message ?? error)
  return {
    taskId: pair.task.id,
    repeatIndex: pair.repeatIndex,
    arm: arm.label,
    profile: arm.profile,
    startedAt: new Date(clock()).toISOString(),
    durationMs: 0,
    exit: null,
    timedOut: false,
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    usage: null,
    usageReported: false,
    toolCallsByName: {},
    turnEndReason: null,
    interrupted: false,
    spawnError: null,
    runnerError: message,
    timeoutMs: spec.timeoutMs ?? pair.task.timeoutMs ?? null,
    verify: [{ type: 'runner', target: null, pass: false, detail: message.slice(0, 200) }],
    verifyPassed: false,
    verifyError: message,
    eventsFile: null,
    stderrFile: null,
    traceFile: null,
    traceRows: 0,
    workspace: null,
    archiveErrors: [message],
  }
}

/** The options one session runs with; `options.sessionOptions` overrides at the end. */
function sessionOptions(arm, pair, spec, options, ctx) {
  return {
    outDir: ctx.dirs[arm.side],
    entry: spec.entry,
    profile: arm.profile,
    llmPatch: spec.llmPatch ?? null,
    conditionPatch: spec.conditionPatch ?? null,
    workspaceRoot: spec.workspaceRoot,
    timeoutMs: spec.timeoutMs ?? null,
    keep: options.keep === true,
    env: spec.env,
    verbose: options.verbose === true,
    heartbeatMs: options.heartbeatMs,
    stallMs: options.stallMs,
    model: spec.model ?? null,
    log: ctx.log,
    now: ctx.clock,
    interrupt: ctx.interrupt,
    ...(options.sessionOptions ?? {}),
  }
}

/** One arm's summary: the shape `bench/compare.mjs` reads as a side. */
function buildSummary(arm, rows, ctx) {
  return {
    meta: { platform: ctx.spec.meta?.platform ?? `${process.platform}-${process.arch}` },
    profileHash: arm.profileHash ?? null,
    components: arm.components ?? null,
    format: SUMMARY_FORMAT,
    label: arm.label,
    profile: arm.profile,
    aa: ctx.spec.aa === true,
    model: ctx.spec.model ?? null,
    condition: ctx.spec.condition ?? null,
    argv: ctx.spec.argv ?? [],
    dir: ctx.dirs[arm.side],
    startedAt: ctx.startedAt,
    endedAt: ctx.endedAt,
    pairs: ctx.pairs,
    plannedSessions: ctx.plannedSessions,
    completedSessions: rows.length,
    interrupted: ctx.interrupted,
    failures: ctx.failures.filter((failure) => failure.arm === arm.label),
    noise: null,
    results: rows,
  }
}

/** The noise floor of a sweep: measured from an A/A pair, or handed in. */
function noiseFor(spec, summaries, arms) {
  const aggregate = spec.aggregate
  if (spec.aa === true && arms.length === 2) return noiseFloor(summaries.base, summaries.cand, { aggregate })
  const named = spec.noise
  if (named && typeof named === 'object' && Array.isArray(named.base?.results) && Array.isArray(named.cand?.results)) {
    return noiseFloor(named.base, named.cand, { aggregate })
  }
  return null
}

/** The arm descriptor the seal step (P8a) lifts into `run.json`'s `arms`. */
function descriptor(arm) {
  return {
    components: arm.components ?? null,
    label: arm.label,
    profile: arm.profile,
    profileHash: arm.profileHash ?? null,
    dshPath: arm.dshPath ?? null,
    dshVersion: arm.dshVersion ?? null,
    env: arm.env ?? {},
  }
}

/** What the seal callback is handed: everything it needs, computed here and nowhere else. */
function sealContext(result, spec, summaryFile) {
  const [first, second] = result.arms
  return {
    format: result.format,
    dirs: result.dirs,
    summaryFile,
    folder: spec.folder ?? null,
    arms: { base: descriptor(first), cand: descriptor(second ?? first) },
    meta: {
      ...(spec.meta ?? {}),
      mode: 'ab',
      model: spec.model ?? null,
      condition: spec.condition ?? null,
      argv: spec.argv ?? [],
      startedAt: result.startedAt,
      endedAt: result.endedAt,
    },
    aa: result.aa,
    summaries: result.summaries,
    noise: result.noise,
    compare: result.compare,
    pairing: result.pairing,
    pairs: result.pairs,
    plannedSessions: result.plannedSessions,
    completedSessions: result.completedSessions,
    interrupted: result.interrupted,
    failures: result.failures,
  }
}

/** A promise that resolves after `ms`. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run one sweep: every pair, both arms, AB/BA-interleaved, strictly serially.
 *
 * Required in `spec`: `arms`, `tasks`, `repeats`, `dirs` (one run directory per side)
 * and `entry` (the resolved dsh launcher P7 spawns). Optional: `aa`, `noise`,
 * `noiseFloorPct`, `aggregate`, `tolerancePct`, `failOn`, `regressionScope`,
 * `llmPatch`, `workspaceRoot`, `timeoutMs`, `model`, `argv`, `meta`, `folder`.
 *
 * Injectable in `options`: `runSession` (P7), `observe` (P5), `seal` (P8a), `now`,
 * `sleep`, `writeFile`, `mkdir`, `log`, `interrupt`, `verbose`, `keep`, `sleepMs`,
 * `heartbeatMs`, `stallMs`, `setTimer`/`clearTimer`, and `sessionOptions` as a last
 * override for the per-session block.
 *
 * @param {object} spec - the sweep.
 * @param {object} [options] - the wiring.
 * @returns {Promise<object>} the sweep result, including both summaries, the noise
 *   floor, the comparison, the pairing tally and the seal receipt.
 */
export async function runSweep(spec = {}, options = {}) {
  const arms = normalizeArms(spec.arms)
  const pairs = planPairs({ tasks: spec.tasks ?? [], repeats: spec.repeats ?? {} })
  if (pairs.length === 0) throw new Error('runSweep: nothing to run — pass at least one task with a positive repeat budget')
  if (spec.entry === undefined || spec.entry === null) throw new TypeError('runSweep: spec.entry (the resolved dsh launcher) is required')
  const dirs = spec.dirs ?? {}
  const clock = options.now ?? Date.now
  const sleep = options.sleep ?? delay
  const mkdir = options.mkdir ?? ((dir) => fs.mkdirSync(dir, { recursive: true }))
  const writeFile = options.writeFile ?? fs.writeFileSync
  const log = typeof options.log === 'function' ? options.log : () => {}
  const session = options.runSession ?? runSession
  const interrupt = options.interrupt ?? createInterrupt()
  const observer = (options.observe ?? createObserver)({
    log,
    run: { taskId: 'ab' },
    verbose: options.verbose === true,
    heartbeatMs: options.heartbeatMs,
    stallMs: options.stallMs,
    now: clock,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
  })

  for (const arm of arms) {
    const dir = dirs[arm.side]
    if (typeof dir !== 'string' || dir === '') throw new TypeError(`runSweep: spec.dirs.${arm.side} must be that arm's run directory`)
    mkdir(dir)
  }

  const startedAt = new Date(clock()).toISOString()
  const rowsBySide = new Map(arms.map((arm) => [arm.side, []]))
  const failures = []
  const plannedSessions = pairs.length * arms.length
  const sleepMs = options.sleepMs ?? 0
  let position = 0
  let stopped = false

  for (const pair of pairs) {
    if (interrupt.stopped) {
      stopped = true
      break
    }
    position += 1
    const order = armOrder(pair.repeatIndex, arms)
    observer.note('info', `pair ${position}/${pairs.length} ${pair.task.id} r${pair.repeatIndex}: ${order.map((arm) => arm.label).join(' → ')}`)
    for (const arm of order) {
      if (interrupt.stopped) {
        stopped = true
        break
      }
      let row
      // A row this module synthesized already carries its own failure entry; only a
      // row P7 *returned* with runnerError/spawnError needs one added below.
      let synthesized = false
      try {
        row = await session({ task: pair.task, repeatIndex: pair.repeatIndex, arm: arm.label }, sessionOptions(arm, pair, spec, options, { dirs, clock, log, interrupt }))
      } catch (error) {
        row = failedRow(arm, pair, error, clock, spec)
        synthesized = true
        failures.push({ taskId: pair.task.id, repeatIndex: pair.repeatIndex, arm: arm.label, kind: 'threw', error: String(error?.message ?? error) })
        observer.note('warn', `${pair.task.id} r${pair.repeatIndex} ${arm.label}: the runner threw (${String(error?.message ?? error)}) — recorded as a failed row, never as a pass`)
      }
      if (row === null || typeof row !== 'object') {
        const error = new Error('runSession returned no row')
        row = failedRow(arm, pair, error, clock, spec)
        synthesized = true
        failures.push({ taskId: pair.task.id, repeatIndex: pair.repeatIndex, arm: arm.label, kind: 'no-row', error: error.message })
      }
      if (typeof row.arm !== 'string' || row.arm === '') row.arm = arm.label
      if (typeof row.profile !== 'string' || row.profile === '') row.profile = arm.profile
      rowsBySide.get(arm.side).push(row)
      // A row P7 returned with a runner/spawn error is archived honestly *and* named
      // here: the sweep's exit code must not read 0 because the harness itself broke.
      if (!synthesized && (row.runnerError || row.spawnError)) {
        failures.push({
          taskId: pair.task.id,
          repeatIndex: pair.repeatIndex,
          arm: arm.label,
          kind: row.runnerError ? 'runner-error' : 'spawn-error',
          error: String(row.runnerError ?? row.spawnError),
        })
      }
      if (interrupt.stopped) {
        stopped = true
        break
      }
    }
    if (sleepMs > 0 && position < pairs.length && !interrupt.stopped) await sleep(sleepMs)
  }

  const endedAt = new Date(clock()).toISOString()
  const summaries = {}
  const summaryFiles = {}
  for (const arm of arms) {
    summaries[arm.side] = buildSummary(arm, rowsBySide.get(arm.side), {
      spec, dirs, startedAt, endedAt, pairs: pairs.length, plannedSessions, interrupted: stopped, failures,
    })
    summaryFiles[arm.side] = path.join(dirs[arm.side], 'summary.json')
  }
  const noise = noiseFor(spec, summaries, arms)
  if (noise !== null) for (const summary of Object.values(summaries)) summary.noise = noise
  const paired = arms.length === 2
  const compare = paired
    ? compareSummaries(summaries.base, summaries.cand, {
      aggregate: spec.aggregate,
      tolerancePct: spec.tolerancePct,
      failOn: spec.failOn,
      regressionScope: spec.regressionScope,
      noiseFloorPct: spec.noiseFloorPct,
      noise: spec.noise ?? (spec.aa === true ? { base: summaries.base, cand: summaries.cand } : undefined),
    })
    : null
  const pairing = paired ? pairMetrics(summaries.base.results, summaries.cand.results) : null

  const result = {
    format: SWEEP_FORMAT,
    aa: spec.aa === true,
    arms,
    dirs,
    summaryFiles,
    folder: spec.folder ?? null,
    startedAt,
    endedAt,
    pairs: pairs.length,
    plannedSessions,
    completedSessions: [...rowsBySide.values()].reduce((sum, rows) => sum + rows.length, 0),
    interrupted: stopped,
    failures,
    summaries,
    noise,
    compare,
    pairing,
    sealed: null,
    sealError: null,
  }
  // The summaries land before sealing: they are the crash-safe record of a sweep that
  // was interrupted, and `bench/compare.mjs` can already read them as one side each.
  for (const arm of arms) {
    writeFile(summaryFiles[arm.side], `${JSON.stringify(summaries[arm.side], null, 2)}\n`)
  }

  if (typeof options.seal === 'function') {
    try {
      result.sealed = await options.seal(sealContext(result, spec, summaryFiles))
    } catch (error) {
      result.sealError = String(error?.message ?? error)
      result.failures.push({ taskId: null, repeatIndex: null, arm: null, kind: 'seal', error: result.sealError })
      observer.note('warn', `sealing failed: ${result.sealError} — the per-row archives and summary.json are on disk, but run.json was not written`)
    }
  } else {
    observer.note('info', 'sealing was not requested: this sweep has results/ and summary.json, and no run.json')
  }
  observer.dispose?.()
  return result
}
