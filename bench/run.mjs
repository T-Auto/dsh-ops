#!/usr/bin/env node
/**
 * The `ab` subcommand: run BOTH arms of one A/B sweep, AB/BA-interleaved, and seal it.
 *
 * This is the entry point the CLI (P1) declared and the Lead wires in P12. It owns
 * exactly three things: parsing the documented flags, turning them into a corpus +
 * repeat budget + two run directories, and calling {@link runSweep} in
 * `bench/run/schedule.mjs`. It does not spawn a child, does not aggregate and does not
 * judge: scheduling is `run/schedule.mjs`, one session is `run/session.mjs` (P7),
 * aggregation is `lib/aggregate.mjs` (P6), the verdict is `lib/compare-core.mjs`
 * (P11a), and sealing is the **injected** `io.seal` callback — `bench/run/seal.mjs`
 * (P8a) is not imported here, deliberately, so this slice lands while P8a is still in
 * flight; the wiring supplies it.
 *
 * Why one process for both arms: the pre-#205 shape spawned one runner per arm, so
 * every baseline run happened before every candidate run and the machine's drift
 * became a fake token delta. `runSweep` interleaves the arms per `(task, repeat)`
 * instead, which only a single process can order.
 *
 * It also refuses `--label`/`--profile`: those named one arm of a per-process run, and
 * accepting them again would quietly restore the un-interleaved shape this slice
 * exists to remove. `--base`/`--cand` name the two arms of the sweep instead.
 *
 * @module dsh-ops/bench/run
 */

import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { EXIT, UsageError, planAb } from './cli.mjs'
import { REPO_ROOT, resolveDshEntry } from './lib/env.mjs'
import { TASKS_DIR, loadTasks, selectTasks } from './lib/tasks.mjs'
import { RUNS_DIR } from './lib/next-folder.mjs'
import { DEFAULT_REPEAT, armOrder, createInterrupt, planPairs, planSessions, repeatsById, runSweep } from './run/schedule.mjs'

/** The runner-only flags that take a value; `--task`/`--repeat`/`--folder`/`--base`/`--cand` are parsed by the CLI. */
const VALUE_FLAGS = ['--sleep-ms', '--out', '--heartbeat-ms', '--stall-ms', '--timeout', '--dsh', '--llm-patch', '--model']
/** The integer-valued flags, by option name. */
const INTEGER_FLAGS = { '--sleep-ms': 'sleepMs', '--heartbeat-ms': 'heartbeatMs', '--stall-ms': 'stallMs', '--timeout': 'timeoutMs' }
/** The string-valued flags, by option name. */
const STRING_FLAGS = { '--out': 'out', '--dsh': 'dsh', '--llm-patch': 'llmPatch', '--model': 'model' }
/** The heartbeat/stall defaults (P5's): a line every 15 s, a stall warning after 60 s of silence. */
const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_STALL_MS = 60_000

/** The `ab` help: this runner's flags. */
export function abUsage() {
  return [
    'usage: node bench/run.mjs [--base <label>] [--cand <label>] [options]',
    '',
    'Runs both arms of one A/B sweep, AB/BA-interleaved: odd repeats base→cand, even',
    'repeats cand→base, one session at a time, then hands the sweep to the seal step.',
    '',
    '  --task <id>          run only this task (repeatable); default: every bench/tasks/*.task.json',
    '  --repeat N           repeats per task; overrides each task\'s own repeat budget',
    '  --base <label>       baseline arm label, also its profile name (default bench-base)',
    '  --cand <label>       candidate arm label, also its profile name (default bench-ops)',
    '  --aa                 A/A mode: run the baseline twice and measure the noise floor; --cand is ignored',
    '  --folder <name>      group directory under bench/runs (default: the next benchmark-test-NN)',
    '  --out <dir>          the sweep directory outright; not with --folder',
    '  --sleep-ms N         fixed pause between pairs (default 0)',
    '  --heartbeat-ms N     per-session "still running" line (default 15000; 0 = off)',
    '  --stall-ms N         per-session silence that escalates a warning (default 60000)',
    '  --timeout MS         override each task\'s timeoutMs',
    '  --dsh <path>         dsh\'s JS entry (lib/bin.js); default: resolved from PATH',
    '  --llm-patch <path>   overlay the session injects with --patch',
    '  --model <id>         model id recorded for the run',
    '  --keep               keep each temporary workspace',
    '  --verbose            narrate every event line',
    '  --show               print the pair-by-pair plan and exit without running',
    '  --no-seal            run without the injected seal callback (no run.json; said out loud)',
    '  -h, --help           this text',
    '',
    'Exit codes: 0 ok · 1 a failed sweep · 2 usage error · 3 sealing is not wired yet',
    '(the caller injects P8a\'s sealRun as `io.seal`; without it, and without --no-seal,',
    'nothing is spawned so no token is spent on an unsealable sweep).',
  ].join('\n')
}

/** Apply one runner-only flag with a value to the parsed options. */
function applyRunFlag(options, flag, value) {
  if (Object.hasOwn(INTEGER_FLAGS, flag)) {
    const number = Number(value)
    if (!Number.isInteger(number) || number < 0) throw new UsageError(`${flag} needs a non-negative integer, got ${value}`)
    options[INTEGER_FLAGS[flag]] = number
    return
  }
  options[STRING_FLAGS[flag]] = value
}

/**
 * Parse the `ab` command line: the CLI-documented flags through `planAb` (so the
 * validation of `--base`/`--cand`/`--repeat`/`--folder` stays single-sourced), then the
 * runner-only flags out of its `extra` list. An unknown flag is a usage error, never a
 * silent drop.
 * @param {string[]} argv - the arguments after the command name.
 * @param {{runsDir?: string, repoRoot?: string}} [context] - where the group is allocated.
 * @returns {object} the parsed plan plus the runner options.
 */
export function parseRunArgs(argv, context = {}) {
  const plan = planAb(argv, { runsDir: context.runsDir ?? RUNS_DIR, repoRoot: context.repoRoot ?? REPO_ROOT })
  const options = {
    ...plan,
    aa: false,
    verbose: false,
    keep: false,
    noSeal: false,
    sleepMs: 0,
    out: null,
    heartbeatMs: null,
    stallMs: null,
    timeoutMs: null,
    dsh: null,
    llmPatch: null,
    model: null,
  }
  for (let index = 0; index < plan.extra.length; index += 1) {
    const flag = plan.extra[index]
    if (flag === '--aa') options.aa = true
    else if (flag === '--verbose' || flag === '-v') options.verbose = true
    else if (flag === '--keep') options.keep = true
    else if (flag === '--no-seal') options.noSeal = true
    else if (flag === '--label' || flag === '--profile') {
      throw new UsageError(`${flag} named one arm of a per-process run; \`ab\` runs both arms itself — use --base/--cand`)
    } else if (VALUE_FLAGS.includes(flag)) {
      const value = plan.extra[index + 1]
      if (value === undefined || value === '') throw new UsageError(`this flag needs a value: ${flag}`)
      applyRunFlag(options, flag, value)
      index += 1
    } else if (flag.startsWith('-')) {
      throw new UsageError(`unknown option for ab: ${flag}`)
    } else {
      throw new UsageError(`unexpected argument: ${flag}`)
    }
  }
  if (options.out !== null && plan.allocated === false) {
    throw new UsageError('--out names the sweep directory outright; drop --folder (it would group a directory you already named)')
  }
  options.repeatExplicit = plan.repeat !== null
  options.repeat = plan.repeat === null ? DEFAULT_REPEAT : Number(plan.repeat)
  return options
}

/** The two arms of the sweep: `--aa` runs the baseline twice, under a second label. */
export function buildArms(options) {
  return [
    { side: 'base', label: options.base, profile: options.base },
    options.aa
      ? { side: 'cand', label: `${options.base}-aa`, profile: options.base }
      : { side: 'cand', label: options.cand, profile: options.cand },
  ]
}

/** The `<UTC stamp>-<label>` run directories, one per arm, under the sweep's group. */
export function prepareDirs(options, arms, context = {}) {
  const runsDir = context.runsDir ?? RUNS_DIR
  const clock = context.now ?? Date.now
  const stamp = `${new Date(clock()).toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z`
  const sweepDir = options.out === null ? path.join(runsDir, options.folder) : path.resolve(options.out)
  const dirs = {}
  for (const arm of arms) dirs[arm.side] = path.join(sweepDir, `${stamp}-${arm.label}`)
  return { sweepDir, stamp, dirs }
}

/** Kill a child and everything it spawned; the interrupt path, as P7's timeout path does. */
export function killTree(child) {
  if (!child?.pid) return false
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000 })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
    return true
  } catch {
    return false
  }
}

/**
 * Ctrl-C is a thing a human does to a benchmark that appears to hang, so it gets the
 * same treatment as a deadline: the dsh tree is killed instead of orphaned, the sweep
 * stops, and the summaries are still written from the runs that finished. A second
 * signal quits immediately.
 */
function installSignals(interrupt, err, io) {
  const kill = io.kill ?? killTree
  const handler = (signal) => {
    if (interrupt.stopped) {
      err(`bench ab: ${signal} again — quitting now; whatever reached the disk stays there.`)
      process.exit(1)
    }
    interrupt.stopped = true
    const killed = kill(interrupt.child)
    err(`bench ab: ${signal}: stopping after the current run${killed ? ` (killed pid ${interrupt.pid ?? '?'} and its tree)` : ''} and writing the summaries from the runs that finished. Send ${signal} again to quit immediately.`)
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  return () => {
    process.off('SIGINT', handler)
    process.off('SIGTERM', handler)
  }
}

/** The process exit code: the runner's own failures and the pass-drop gate, never a token direction without a noise floor. */
export function exitFor(result) {
  if (result.interrupted) return EXIT.failure
  if (result.failures.length > 0) return EXIT.failure
  if (result.compare?.gate?.fail === true) return EXIT.failure
  return EXIT.ok
}

/** Print the sweep's outcome, honestly: what ran, what failed, what the seal wrote. */
function printResult(out, err, result, options) {
  const totals = result.compare?.totals
  const noise = result.noise
  out(`[ab] ran     : ${result.completedSessions}/${result.plannedSessions} session(s), ${result.pairs} pair(s)`)
  if (result.interrupted) err(`[ab] interrupted: the sweep is PARTIAL (${result.completedSessions}/${result.plannedSessions}); it is not a comparison`)
  for (const failure of result.failures) {
    err(`[ab] failure : ${failure.arm ?? '-'} ${failure.taskId ?? '-'} r${failure.repeatIndex ?? '-'} ${failure.kind}: ${failure.error}`)
  }
  if (totals) {
    out(`[ab] verify  : base ${totals.basePasses}/${totals.baseRuns}, cand ${totals.candPasses}/${totals.candRuns}${totals.candPasses < totals.basePasses ? '  ⚠ pass-drop' : ''}`)
    out(`[ab] tokens  : base ${totals.baseGrandTotal ?? 'n/a'} → cand ${totals.candGrandTotal ?? 'n/a'} (${totals.grandTotalPct === null ? 'n/a' : `${totals.grandTotalPct}%`}), pairs usable ${result.compare.pairing.usablePairs}`)
  }
  out(options.aa
    ? `[ab] noise   : A/A ±${noise?.pct ?? 'n/a'}% (${noise?.method ?? 'none'}, ${noise?.pairs ?? 0} pair(s)) — measured here, so a later comparison can use it`
    : `[ab] noise   : ${noise === null ? 'not measured (no --aa); cost direction withheld' : `±${noise.pct}% (${noise.method})`}`)
  if (result.compare?.gate?.fail === true) err(`[ab] verdict : FAIL — ${result.compare.gate.reasons.join('; ')}`)
  else out('[ab] verdict : pass (pass-rate gate)')
  out(`[ab] sealed  : ${result.sealed?.path ?? (result.sealError ? `FAILED (${result.sealError})` : 'no — run.json was not written')}`)
}

/**
 * Run the sweep. Every dependency is injectable through `io` so a test never spawns,
 * never reads `~/.dsh` and never touches a model: `io.seal`, `io.runSession`,
 * `io.sweep`, `io.observe`, `io.resolveEntry`, `io.now`, `io.sleep`, `io.kill`,
 * `io.tasksDir`, `io.runsDir`, `io.env`, `io.interrupt`, `io.profileHashes`.
 * @param {string[]} argv - the arguments after `ab`.
 * @param {object} [io] - the wiring and the sinks (`out`, `err`).
 * @returns {Promise<number>} the exit code.
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  let options
  try {
    options = parseRunArgs(argv, io)
  } catch (error) {
    if (error instanceof UsageError) {
      err(`bench ab: ${error.message}`)
      err(abUsage())
      return EXIT.usage
    }
    err(`bench ab: ${String(error?.stack ?? error)}`)
    return EXIT.failure
  }
  if (options.help) {
    out(abUsage())
    return EXIT.ok
  }
  if (!options.show && options.noSeal !== true && typeof io.seal !== 'function') {
    err('bench ab: sealing is not wired in this slice yet — P8a\'s bench/run/seal.mjs must be injected as io.seal.')
    err('Nothing was spawned and no token was spent. Pass --no-seal to run an unsealed sweep (no run.json), or --show to just print the plan.')
    return EXIT.pending
  }

  let tasks
  try {
    tasks = selectTasks(loadTasks(io.tasksDir ?? TASKS_DIR), options.tasks)
  } catch (error) {
    err(`bench ab: ${error.message}`)
    return EXIT.usage
  }
  const repeats = repeatsById(tasks, { repeat: options.repeat, repeatExplicit: options.repeatExplicit })
  const hashes = io.profileHashes ?? {}
  const arms = buildArms(options).map((arm) => ({ ...arm, profileHash: hashes[arm.side] ?? null }))
  const { sweepDir, dirs } = prepareDirs(options, arms, io)
  const pairs = planPairs({ tasks, repeats })
  const sessions = planSessions({ tasks, repeats, arms })

  out(`[ab] base    : ${arms[0].label} (profile ${arms[0].profile})`)
  out(`[ab] cand    : ${arms[1].label} (profile ${arms[1].profile})${options.aa ? '  [A/A: the baseline run twice]' : ''}`)
  out(`[ab] pairs   : ${pairs.length} pair(s) = ${sessions.length} session(s), serial, AB/BA-interleaved${options.repeatExplicit ? ` (--repeat ${options.repeat})` : ' (per-task repeat budgets)'}`)
  if (options.out === null) out(`[ab] group   : bench/runs/${options.folder}${options.allocated ? ' [auto]' : ''}`)
  out(`[ab] out     : ${sweepDir}`)
  for (const arm of arms) out(`[ab]           ${arm.side.padEnd(4)} → ${dirs[arm.side]}`)
  if (options.show) {
    for (const [index, pair] of pairs.entries()) {
      out(`[ab] ${String(index + 1).padStart(3)}/${pairs.length} ${pair.task.id} r${pair.repeatIndex}: ${armOrder(pair.repeatIndex, arms).map((arm) => arm.label).join(' → ')}`)
    }
    out(`[ab] show only: nothing was spawned.`)
    return EXIT.ok
  }

  let entry
  try {
    entry = (io.resolveEntry ?? resolveDshEntry)(options.dsh, { env: io.env ?? process.env })
  } catch (error) {
    err(`bench ab: ${error.message}`)
    return EXIT.failure
  }

  const interrupt = io.interrupt ?? createInterrupt()
  const uninstall = (io.installSignals ?? true) === false ? () => {} : installSignals(interrupt, err, io)
  const log = (level, line) => (level === 'warn' ? err : out)(line)
  let result
  try {
    result = await (io.sweep ?? runSweep)({
      arms,
      tasks,
      repeats,
      aa: options.aa,
      dirs,
      folder: options.out === null ? options.folder : null,
      entry,
      llmPatch: options.llmPatch,
      timeoutMs: options.timeoutMs,
      model: options.model,
      argv: ['bench/run.mjs', ...argv],
    }, {
      seal: options.noSeal === true ? undefined : io.seal,
      runSession: io.runSession,
      observe: io.observe,
      now: io.now,
      sleep: io.sleep,
      writeFile: io.writeFile,
      mkdir: io.mkdir,
      log,
      verbose: options.verbose,
      keep: options.keep,
      sleepMs: options.sleepMs,
      heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      stallMs: options.stallMs ?? DEFAULT_STALL_MS,
      interrupt,
    })
  } catch (error) {
    err(`bench ab: the sweep failed: ${String(error?.message ?? error)}`)
    return EXIT.failure
  } finally {
    uninstall()
  }
  printResult(out, err, result, options)
  return exitFor(result)
}

// Only when executed, not when imported by the CLI or the suite.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
