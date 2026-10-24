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
 * (P11a), and sealing is opt-in: `--seal` writes the schema-validated `run.json` through
 * `bench/run/seal.mjs` (P8a), while every sweep keeps each arm's `results/` and
 * `summary.json` either way. A finished sweep also renders the markdown report from its
 * own verdict (`compare.mjs`'s `renderReport`) into the group folder — `--no-report`
 * skips it, and an interrupted sweep writes none, because a partial run is not a
 * comparison. An injected `io.seal` supplies the document an embedder
 * wants; the CLI spawns this entry as a child and cannot inject one, so the flag has to
 * select the real seal rather than a missing slice.
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

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { EXIT, UsageError, planAb } from './cli.mjs'
import { LLM_OVERLAY, REPO_ROOT, resolveDshEntry, spawnPlan } from './lib/env.mjs'
import { TASKS_DIR, loadTasks, selectTasks } from './lib/tasks.mjs'
import { RUNS_DIR } from './lib/next-folder.mjs'
import { DEFAULT_REPEAT, armOrder, createInterrupt, planPairs, planSessions, repeatsById, runSweep } from './run/schedule.mjs'
import { sealRun } from './run/seal.mjs'
import { renderReport, reportFileName } from './compare.mjs'

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
    '  --folder <name>      group directory under bench/runs (default: the next free benchmark-YYYY-MM-DD-NN)',
    '  --out <dir>          the sweep directory outright; not with --folder',
    '  --sleep-ms N         fixed pause between pairs (default 0)',
    '  --heartbeat-ms N     per-session "still running" line (default 15000; 0 = off)',
    '  --stall-ms N         per-session silence that escalates a warning (default 60000)',
    '  --timeout MS         override each task\'s timeoutMs',
    '  --dsh <path>         dsh\'s JS entry (lib/bin.js); default: resolved from PATH',
    '  --llm-patch <path>   the overlay every dsh call is given with --patch',
    '                       (default: bench/llm.patch.yml, the file `setup` creates)',
    '  --no-llm-patch       run on the profiles\' own routes instead of the overlay;',
    '                       the two sides then share no route and the sweep says so',
    '  --model <id>         model id recorded for the run',
    '  --keep               keep each temporary workspace',
    '  --verbose            narrate every event line',
    '  --show               print the pair-by-pair plan and exit without running',
    '  --seal               also seal the sweep into the schema-validated run.json (default:',
    '                       every arm keeps results/ and summary.json, nothing else)',
    '  --no-seal            explicit off; this is already the default, kept for old command lines',
    '  --no-report          skip the markdown report a finished sweep writes into the group',
    '                       folder (default: written; an interrupted sweep never writes one)',
    '  -h, --help           this text',
    '',
    'Exit codes: 0 ok · 1 a failed sweep · 2 usage error',
    'A finished sweep writes each arm\'s results/ and summary.json, the group folder\'s',
    '"DSH-OPS Benchmark Report <UTC>.md", and --seal adds the schema-validated run.json',
    'on top. `bench report` re-renders that report from the archives at any later time.',
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
    seal: false,
    noReport: false,
    noLlmPatch: false,
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
    else if (flag === '--seal') options.seal = true
    else if (flag === '--no-seal') options.seal = false
    else if (flag === '--no-report') options.noReport = true
    else if (flag === '--no-llm-patch') options.noLlmPatch = true
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

/**
 * Which LLM overlay this sweep hands to every dsh call.
 *
 * The overlay is the one file naming the bench server, the model and the environment
 * variable holding the key, and `setup` is what creates it. A sweep that quietly ran
 * without it would exercise the profiles' own routes instead — identical on both sides,
 * so the report could not show the difference and the run would still look complete. The
 * default is therefore the overlay, `--no-llm-patch` is how an operator says the profiles'
 * own routes are what they mean, and anything else is refused before a token is spent.
 * @param {{llmPatch: string|null, noLlmPatch: boolean}} options - the parsed flags.
 * @param {{overlay?: string, exists?: (file: string) => boolean}} [context] - the default
 *   overlay and the existence probe; injectable so a suite never reads the real file.
 * @returns {{path: string|null, implicit: boolean}} the overlay to inject — null when the
 *   sweep runs without one — and whether it came from the default rather than the flags.
 * @throws {UsageError} when the two flags contradict, when a named overlay is missing, or
 *   when there is no overlay to default to and `--no-llm-patch` did not say that is fine.
 */
export function resolveLlmPatch(options, context = {}) {
  const overlay = context.overlay ?? LLM_OVERLAY
  const exists = context.exists ?? ((file) => fs.existsSync(file))
  if (options.llmPatch !== null && options.noLlmPatch) {
    throw new UsageError('--llm-patch names the overlay to inject and --no-llm-patch removes it; pass one of them')
  }
  if (options.llmPatch !== null) {
    if (!exists(options.llmPatch)) throw new UsageError(`--llm-patch names a file that does not exist: ${options.llmPatch}`)
    return { path: options.llmPatch, implicit: false }
  }
  if (options.noLlmPatch) return { path: null, implicit: false }
  if (!exists(overlay)) {
    throw new UsageError(`there is no ${overlay}, so both arms would run on their profiles' own routes — run "node bench/cli.mjs setup" to create it, or pass --no-llm-patch to run that way on purpose`)
  }
  return { path: overlay, implicit: true }
}

/**
 * The default profile fingerprint probe: the composed configuration `dsh` reports for one
 * profile. `setup` reads the same tree back to prove a pin really landed, so hashing it
 * records what each arm ran rather than what its file was called.
 * @param {{file: string, kind: 'js'|'exe'}} entry - the resolved dsh launcher.
 * @param {string} profile - the profile name to dump.
 * @param {{run?: Function, cwd?: string, env?: Record<string, string|undefined>}} [context] - injectable probe, directory and environment.
 * @returns {string} the command's stdout and stderr.
 * @throws {Error} when it cannot start or exits nonzero: an arm with no fingerprint is not evidence.
 */
export function dumpProfileConfig(entry, profile, context = {}) {
  const plan = spawnPlan(entry, ['--profile', profile, '--dump-config'])
  const result = (context.run ?? spawnSync)(plan.command, plan.args, {
    cwd: context.cwd ?? REPO_ROOT,
    env: context.env ?? process.env,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error(`could not run "dsh --profile ${profile} --dump-config": ${String(result.error.message ?? result.error)}`)
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
    throw new Error(`"dsh --profile ${profile} --dump-config" exited ${String(result.status)}${detail === '' ? '' : `: ${detail}`}`)
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

/**
 * Fingerprint both arms: the SHA-256 of each profile's dumped configuration, which
 * `bench/run.schema.json` records in `arms[]` and `sealRun` requires before it will seal.
 * @param {{side: string, profile: string}[]} arms - the two arms of the sweep.
 * @param {{entry?: object, dump?: (entry: object, profile: string, context: object) => string, env?: object}} [context] - the launcher and the injectable probe.
 * @returns {Record<string, string>} the hex digest of each side's composed configuration.
 * @throws {Error} when a dump prints nothing, naming the arm that has no fingerprint.
 */
export function profileFingerprints(arms, context = {}) {
  const dump = context.dump ?? dumpProfileConfig
  const hashes = {}
  for (const arm of arms) {
    const text = dump(context.entry, arm.profile, context)
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error(`"dsh --profile ${arm.profile} --dump-config" printed nothing, so the ${arm.side} arm has no profile fingerprint`)
    }
    hashes[arm.side] = createHash('sha256').update(text).digest('hex')
  }
  return hashes
}

/**
 * The default seal: adapt the sweep's seal context to {@link sealRun}.
 *
 * The callback is handed the two arm directories as a `{base, cand}` map, while `sealRun`
 * folds a list of sweep directories into one document and places `run.json` in their
 * common parent (the group folder). Handing the map straight to `sealRun` fails on
 * `dirs.map` — which no injected double could catch, because a double never inspects it.
 * @param {{dirs: {base: string, cand: string}|string[], arms: object, meta?: object}} context - the seal context.
 * @param {(options: object) => object} [seal] - the sealer, injectable so a suite can read what it is handed.
 * @returns {object} the seal receipt.
 */
export function sealSweep(context, seal = sealRun) {
  const dirs = Array.isArray(context.dirs) ? context.dirs : [context.dirs.base, context.dirs.cand]
  return seal({ ...context, dirs })
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
  out(`[ab] sealed  : ${result.sealed?.path ?? (result.sealError ? `FAILED (${result.sealError})` : 'no — not requested (--seal writes run.json)')}`)
}

/**
 * The sweep's own report: the verdict it just computed, rendered through
 * `compare.mjs`'s `renderReport` and written beside the arm directories — the group
 * folder, or the `--out` sweep directory a custom one named. This is the `bench report`
 * artifact produced without a second command; `bench report` still re-renders it later
 * from the same summaries.
 *
 * An interrupted sweep writes none: the comparison of a partial run is not evidence, and
 * a report-shaped file that looks complete while the sweep says PARTIAL would lie to a
 * reviewer who opens it without the console.
 * @param {object} result - the sweep result (`compare`, `arms`, `dirs`, `summaryFiles`,
 *   `interrupted` as `runSweep` returned them).
 * @param {{now?: Function, writeFile?: Function, mkdir?: Function}} [context] - the clock
 *   the file name stamps and injectable sinks; defaults to the wall clock and `fs`.
 * @returns {{target: string|null, skipped: string|null}} where the report landed, or why
 *   it was skipped (`target: null`).
 * @throws {Error} when rendering or writing fails — `main` reports that without turning
 *   it into a sweep failure.
 */
export function sweepReport(result, context = {}) {
  if (result.compare === null) return { target: null, skipped: 'no comparison ran' }
  if (result.interrupted) return { target: null, skipped: 'a partial sweep is not a comparison' }
  const now = context.now ?? Date.now
  const write = context.writeFile ?? fs.writeFileSync
  const mkdir = context.mkdir ?? fs.mkdirSync
  const target = path.join(path.dirname(result.dirs.base), reportFileName(now()))
  mkdir(path.dirname(target), { recursive: true })
  write(target, `${renderReport(result.compare)}\n`, 'utf8')
  return { target, skipped: null }
}

/**
 * Run the sweep. Every dependency is injectable through `io` so a test never spawns,
 * never reads `~/.dsh` and never touches a model: `io.seal`, `io.runSession`,
 * `io.sweep`, `io.observe`, `io.resolveEntry`, `io.now`, `io.sleep`, `io.kill`,
 * `io.tasksDir`, `io.runsDir`, `io.env`, `io.interrupt`, `io.profileHashes`,
 * `io.dumpProfileConfig`.
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
  // Resolved before any spawn: a contradictory or absent overlay is a condition under which
  // the sweep would measure something other than what the operator asked for.
  let patch
  try {
    patch = resolveLlmPatch(options, { overlay: io.llmOverlay, exists: io.overlayExists })
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    // A contradictory or absent *named* overlay is a usage error whatever else is asked for;
    // only a missing default is something `--show` may still print a plan around, because
    // that plan is exactly how an operator sees that `setup` has not run yet.
    const operatorNamed = options.llmPatch !== null || options.noLlmPatch
    if (operatorNamed || options.show !== true) {
      err(`bench ab: ${error.message}`)
      err(abUsage())
      return EXIT.usage
    }
    patch = { path: null, implicit: false, refused: error.message }
  }
  // Sealing is opt-in: a sweep always writes each arm's `results/` and `summary.json`, and
  // `--seal` adds the schema-validated `run.json` on top. The CLI spawns this entry as a
  // child and cannot inject a callback, so "sealed" means the flag plus either the injected
  // `io.seal` (an embedder's own document) or the real seal in `bench/run/seal.mjs` (P8a).
  const seal = options.seal !== true ? undefined : (typeof io.seal === 'function' ? io.seal : sealSweep)

  let tasks
  try {
    tasks = selectTasks(loadTasks(io.tasksDir ?? TASKS_DIR), options.tasks)
  } catch (error) {
    err(`bench ab: ${error.message}`)
    return EXIT.usage
  }
  const repeats = repeatsById(tasks, { repeat: options.repeat, repeatExplicit: options.repeatExplicit })
  const arms = buildArms(options)
  const { sweepDir, dirs } = prepareDirs(options, arms, io)
  const pairs = planPairs({ tasks, repeats })
  const sessions = planSessions({ tasks, repeats, arms })

  out(`[ab] base    : ${arms[0].label} (profile ${arms[0].profile})`)
  out(`[ab] cand    : ${arms[1].label} (profile ${arms[1].profile})${options.aa ? '  [A/A: the baseline run twice]' : ''}`)
  out(`[ab] patch   : ${patch.path ?? 'none (--no-llm-patch) — the two sides share no route'}`)
  out(`[ab] pairs   : ${pairs.length} pair(s) = ${sessions.length} session(s), serial, AB/BA-interleaved${options.repeatExplicit ? ` (--repeat ${options.repeat})` : ' (per-task repeat budgets)'}`)
  if (options.out === null) out(`[ab] group   : bench/runs/${options.folder}${options.allocated ? ' [auto]' : ''}`)
  out(`[ab] out     : ${sweepDir}`)
  for (const arm of arms) out(`[ab]           ${arm.side.padEnd(4)} → ${dirs[arm.side]}`)
  if (options.show) {
    for (const [index, pair] of pairs.entries()) {
      out(`[ab] ${String(index + 1).padStart(3)}/${pairs.length} ${pair.task.id} r${pair.repeatIndex}: ${armOrder(pair.repeatIndex, arms).map((arm) => arm.label).join(' → ')}`)
    }
    if (patch.refused !== undefined) err(`[ab] patch   : ${patch.refused} — this plan cannot run as it stands`)
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

  // Before any session: an arm whose composed configuration cannot be read has no
  // fingerprint, and a sweep that cannot be sealed is not evidence. Refusing here costs
  // nothing; refusing after the sweep would have spent the tokens first.
  let hashes = io.profileHashes ?? null
  if (hashes === null && seal !== undefined) {
    try {
      hashes = profileFingerprints(arms, { entry, dump: io.dumpProfileConfig, env: io.env })
    } catch (error) {
      err(`bench ab: ${String(error?.message ?? error)}`)
      err('nothing was spawned and no token was spent; run "node bench/cli.mjs setup" if the profiles are not prepared yet, or pass --no-seal to sweep without sealing.')
      return EXIT.failure
    }
  }
  for (const arm of arms) arm.profileHash = hashes?.[arm.side] ?? null
  if (seal !== undefined) {
    out(`[ab] profile : ${arms.map((arm) => `${arm.profile} ${arm.profileHash === null ? 'n/a' : arm.profileHash.slice(0, 12)}`).join('  ')}`)
  }

  const interrupt = io.interrupt ?? createInterrupt()
  const uninstall = (io.installSignals ?? true) === false ? () => { } : installSignals(interrupt, err, io)
  const log = (level, line) => (level === 'warn' ? err : out)(line)
  // The recorded command line names the overlay when the operator did not: a summary that
  // cannot say which route ran is not evidence of anything.
  const recordedArgv = patch.implicit ? ['bench/run.mjs', ...argv, '--llm-patch', patch.path] : ['bench/run.mjs', ...argv]
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
      llmPatch: patch.path,
      timeoutMs: options.timeoutMs,
      model: options.model,
      argv: recordedArgv,
    }, {
      seal,
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
  let report = { target: null, skipped: '--no-report' }
  if (options.noReport !== true) {
    try {
      report = sweepReport(result, { now: io.now, writeFile: io.writeFile, mkdir: io.mkdir })
    } catch (error) {
      // The verdict is already computed and the summaries already written; a report that
      // could not land is a loud note, not a failed sweep.
      err(`[ab] report  : FAILED — ${String(error?.message ?? error)}`)
      report = { target: null, skipped: null }
    }
  }
  if (report.skipped !== null) out(`[ab] report  : not written (${report.skipped})`)
  else if (report.target !== null) out(`[ab] report  : ${report.target}`)
  return exitFor(result)
}

// Only when executed, not when imported by the CLI or the suite.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
