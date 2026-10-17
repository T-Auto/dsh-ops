/**
 * The driver for **one** measured row: a single task × repeat. It builds a throwaway
 * workspace from the task's seeded fixture, spawns exactly one headless single-shot
 * `dsh` in it, archives the event stream and stderr **while the run is in flight**,
 * narrates the stream into milestones and a trace, and verifies the workspace.
 * Scheduling (AB/BA interleaving), sealing into `run.json` and progress orchestration
 * belong to the caller — nothing here knows how many rows a sweep has.
 *
 * Disciplines copied deliberately, not re-invented: a fresh seeded workspace per repeat
 * (`mkdtemp` under an injectable root, removed after the verifier read it); `spawnPlan`
 * plus `spawn(process.execPath, [binJs, ...])` and never a `.cmd`/`.bat`/`.ps1` shim;
 * append-only NDJSON for events and stderr plus a separate trace NDJSON; and numbers
 * that never launder a failure (`timedOut`/`exit: null` on a timeout, the real exit
 * code otherwise, `usageReported` all-or-nothing).
 *
 * @module dsh-ops/bench/run/session
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn as spawnChild, spawnSync } from 'node:child_process'

import { generate } from '../lib/fixtures/index.mjs'
import { verifyWorkspace } from '../lib/verify.mjs'
import { createObserver } from '../lib/observe.mjs'
import { spawnPlan } from '../lib/env.mjs'
import { DEFAULT_TIMEOUT_MS } from '../lib/tasks.mjs'

/** The five token buckets `run.schema.json $defs/usage` requires, in its order. */
const USAGE_BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']

/** Cap on the stdout-close barrier; it matters only for a spawn that left a stream open. */
const DEFAULT_STREAM_FLUSH_GRACE_MS = 1_000

/** Cap on waiting for `close` after a spawn error with no pid (Node may never emit one). */
const DEFAULT_SPAWN_ERROR_GRACE_MS = 1_000

/** How long a killed tree is given to flush what it already wrote (as in the original). */
const KILL_DRAIN_MS = 250

/** Cap on waiting for `close` after the deadline killed a tree that swallowed the signal. */
const DEFAULT_KILL_GRACE_MS = 5_000

/** The file layout of one row, so the scheduler can hash or list the same paths. */
const FILE_SUFFIXES = {
  events: '.events.ndjson',
  stderr: '.stderr.log',
  trace: '.trace.ndjson',
  metrics: '.metrics.json',
}

/** An all-zero usage block; every bucket in the schema is always present. */
function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

/**
 * The archive paths of one row: `<task>-r<n><suffix>` under `<outDir>/results/` — the
 * layout `run.schema.json`'s `events.layout` ("ndjson-per-run") describes.
 * @param {string} outDir - the run directory. @param {string} taskId - the task id.
 * @param {number} repeatIndex - 1-based repeat number.
 * @returns {{resultsDir: string, events: string, stderr: string, trace: string, metrics: string}} absolute paths.
 */
export function sessionPaths(outDir, taskId, repeatIndex) {
  const base = path.join(outDir, 'results')
  const segment = archiveSegment(taskId, repeatIndex)
  return {
    resultsDir: base,
    events: path.join(base, `${segment}${FILE_SUFFIXES.events}`),
    stderr: path.join(base, `${segment}${FILE_SUFFIXES.stderr}`),
    trace: path.join(base, `${segment}${FILE_SUFFIXES.trace}`),
    metrics: path.join(base, `${segment}${FILE_SUFFIXES.metrics}`),
  }
}

/**
 * The `<task>-r<n>` stem every archive file of a row shares; a task id with a path
 * separator is refused so the run directory's listing stays a manifest.
 * @param {string} taskId - the task id. @param {number} repeatIndex - 1-based repeat number.
 * @returns {string} the stem.
 */
function archiveSegment(taskId, repeatIndex) {
  if (typeof taskId !== 'string' || taskId.trim() === '') throw new TypeError('runSession: task.id must be a non-empty string')
  if (taskId === '.' || taskId === '..' || taskId.includes('/') || taskId.includes('\\')) {
    // A task id is a slug in every task file; one with a separator would write outside
    // results/ and the run directory's archive listing would no longer be a manifest.
    throw new Error(`runSession: task.id must not contain a path separator: ${JSON.stringify(taskId)}`)
  }
  if (!Number.isInteger(repeatIndex) || repeatIndex < 1) {
    throw new TypeError(`runSession: repeatIndex must be a positive integer (got ${String(repeatIndex)})`)
  }
  return `${taskId}-r${repeatIndex}`
}

/**
 * Refuse a launcher entry that cannot be spawned without a shell: a `.cmd`/`.bat`/`.ps1`
 * npm shim either throws (`EINVAL`, CVE-2024-27980) or needs `shell: true`, which
 * re-parses the prompt.
 * @param {{file: string, kind: 'js'|'exe'}} entry - the resolved launcher.
 * @returns {{file: string, kind: 'js'|'exe'}} the same entry, for chaining.
 */
export function assertSpawnableEntry(entry) {
  if (!entry || typeof entry.file !== 'string' || entry.file === '') {
    throw new TypeError('runSession: options.entry.file must be the resolved dsh launcher path')
  }
  if (entry.kind !== 'js' && entry.kind !== 'exe') {
    throw new TypeError(`runSession: options.entry.kind must be "js" or "exe" (got ${JSON.stringify(entry.kind)})`)
  }
  if (entry.kind === 'exe' && /\.(cmd|bat|ps1)$/i.test(entry.file)) {
    throw new Error(
      `runSession: refusing to spawn the shell shim ${entry.file} — the bench only spawns node with the package's lib/bin.js `
      + '(resolve it with lib/env.mjs resolveDshEntry); spawning a shim needs a shell, which re-parses the prompt and throws EINVAL on Windows',
    )
  }
  return entry
}

/**
 * Map the verifier's verdict onto `run.schema.json $defs/check`: `{passed, path}` there,
 * `{pass, target}` here, with `detail` untouched. Renaming once, here, keeps the row
 * directly liftable into `results[].verify`.
 * @param {{checks?: object[], passed?: boolean}|null|undefined} outcome - the verifier's verdict.
 * @returns {{type: string, target: string|null, pass: boolean, detail: string}[]} schema-shaped checks.
 */
export function toVerifyChecks(outcome) {
  return (outcome?.checks ?? []).map((check) => ({
    type: typeof check?.type === 'string' ? check.type : 'unknown',
    target: typeof check?.path === 'string' ? check.path : null,
    pass: check?.passed === true,
    detail: typeof check?.detail === 'string' ? check.detail : '',
  }))
}

/**
 * A streaming fold of the event stream into the schema's `metrics` fields, deliberately
 * narrow: steps, tool calls, the five usage buckets, the all-or-nothing `usageReported`
 * and the last turn's end reason. Prompt-shape analysis belongs to the aggregate slice;
 * this keeps its invariant — one step without usage makes the totals a lower bound.
 * @returns {{push(line: string): void, finish(): object}} the fold.
 */
function createFold() {
  const state = {
    steps: 0,
    stepsWithUsage: 0,
    toolCalls: 0,
    toolCallsByName: Object.create(null),
    usage: emptyUsage(),
    turnEndReason: null,
  }
  return {
    push(line) {
      let event
      try {
        event = JSON.parse(String(line ?? ''))
      } catch {
        // Malformed lines are still archived verbatim; they just carry no numbers.
        return
      }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') return
      if (event.type === 'status') {
        if (event.phase === 'step_end') {
          state.steps += 1
          if (addUsage(state, event.usage)) state.stepsWithUsage += 1
          return
        }
        if (event.phase === 'turn_end') {
          const kind = event.reason?.kind
          if (typeof kind === 'string' && kind !== '') state.turnEndReason = kind
        }
        return
      }
      if (event.type === 'tool_call') {
        state.toolCalls += 1
        const name = typeof event.tool === 'string' && event.tool !== '' ? event.tool : '<unknown>'
        state.toolCallsByName[name] = (state.toolCallsByName[name] ?? 0) + 1
      }
    },
    finish() {
      return {
        steps: state.steps,
        stepsWithUsage: state.stepsWithUsage,
        toolCalls: state.toolCalls,
        toolCallsByName: { ...state.toolCallsByName },
        usage: { ...state.usage },
        usageReported: state.steps > 0 && state.stepsWithUsage === state.steps,
        turnEndReason: state.turnEndReason,
      }
    },
  }
}

/**
 * Add one step's usage. Only finite numbers are summed; `usageReported` depends on the
 * presence of a usage object, not on which buckets it carried.
 * @param {object} state - the fold's state. @param {unknown} usage - the event's usage.
 * @returns {boolean} true when the event carried a usage object.
 */
function addUsage(state, usage) {
  if (!usage || typeof usage !== 'object') return false
  for (const bucket of USAGE_BUCKETS) {
    const value = usage[bucket]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    state.usage[bucket] += Math.max(0, Math.round(value))
  }
  return true
}

/**
 * Run one task × repeat: fixture → one headless session → archive → verdict.
 *
 * The returned document is the row slice the scheduler folds into `results[]`: the
 * `$defs/metrics` fields at the top level, `verify` as the schema-shaped check array,
 * and the archive pointers (`eventsFile`, `stderrFile`, `traceFile`, `traceRows`) that
 * the seal step turns into `events.files` and `archive[]`. It **returns** a row even
 * when the runner itself failed (a fixture that cannot be generated, a verifier that
 * throws): the failure is carried in `runnerError`, so one broken row cannot erase a
 * sweep, and `verifyPassed` stays false.
 *
 * Required: `outDir` (archives land in `<outDir>/results/`), `entry`, `profile`.
 * Optional: `llmPatch`, `workspaceRoot` (default `os.tmpdir()`), `timeoutMs` (default
 * `task.timeoutMs`, then 15 min), `keep`, `env`, `verbose`, `heartbeatMs`, `stallMs`,
 * `model`. Injectable for tests: `spawn`, `kill`, `log`, `now`, `interrupt`,
 * `streamFlushGraceMs`, `spawnErrorGraceMs`, `killGraceMs`.
 *
 * @param {{task: object, repeatIndex: number, arm?: string|null}} spec - the row identity.
 * @param {object} options - the wiring described above.
 * @returns {Promise<object>} the row document (also written to `<task>-r<n>.metrics.json`).
 */
export async function runSession(spec, options = {}) {
  const task = spec?.task
  if (!task || typeof task !== 'object') throw new TypeError('runSession: spec.task must be a task object')
  const repeatIndex = spec?.repeatIndex
  const segment = archiveSegment(task.id, repeatIndex)
  if (typeof task.prompt !== 'string' || task.prompt.trim() === '') throw new Error(`${segment}: task.prompt must be a non-empty string`)
  if (!task.fixture || typeof task.fixture.generator !== 'string' || task.fixture.generator === '') {
    throw new Error(`${segment}: task.fixture.generator must name a fixture generator`)
  }
  if (typeof options.outDir !== 'string' || options.outDir === '') throw new TypeError(`${segment}: options.outDir is required`)
  if (typeof options.profile !== 'string' || options.profile === '') throw new TypeError(`${segment}: options.profile is required`)
  const entry = assertSpawnableEntry(options.entry)
  const outDir = path.resolve(options.outDir)
  const paths = sessionPaths(outDir, task.id, repeatIndex)
  fs.mkdirSync(paths.resultsDir, { recursive: true })

  const clock = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? task.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError(`${segment}: timeoutMs must be a positive number`)

  const arm = spec.arm ?? null
  const facts = {
    taskId: task.id,
    repeatIndex,
    arm,
    profile: options.profile,
    startedAt: new Date(clock()).toISOString(),
    durationMs: 0,
    exit: null,
    timedOut: false,
    interrupted: false,
    spawnError: null,
    timeoutMs,
    workspace: null,
  }
  const streamErrors = []
  const writers = []
  const log = typeof options.log === 'function' ? options.log : () => {}
  const workspaceRoot = path.resolve(options.workspaceRoot ?? os.tmpdir())

  /** One append-only writer, its asynchronous failures collected, never an unhandled `'error'`. */
  const appendStream = (file) => {
    const stream = fs.createWriteStream(file, { flags: 'a' })
    stream.on('error', (error) => streamErrors.push(`${path.basename(file)}: ${String(error?.code ?? error?.message ?? error)}`))
    writers.push(stream)
    return stream
  }
  /** Write without letting a late write after `end` (a killed tree flushing) throw. */
  const write = (stream, chunk) => {
    if (stream.writableEnded || stream.destroyed) {
      streamErrors.push(`write after end (${String(chunk).slice(0, 40)})`)
      return
    }
    try {
      stream.write(chunk)
    } catch (error) {
      streamErrors.push(String(error?.code ?? error?.message ?? error))
    }
  }

  try {
    return await drive()
  } catch (error) {
    // Close what was opened, put the workspace back, record the failure as a row with
    // nulls (never as a pass), and return it so the sweep continues.
    await Promise.all(writers.map((stream) => endStream(stream)))
    if (facts.workspace !== null && options.keep !== true && isInside(workspaceRoot, facts.workspace)) {
      removeTree(facts.workspace)
    }
    const message = String(error?.message ?? error)
    log('warn', `${segment}: runner error: ${message}`)
    const document = {
      startedAt: facts.startedAt,
      durationMs: facts.durationMs,
      exit: facts.exit,
      timedOut: facts.timedOut,
      steps: 0,
      toolCalls: 0,
      usage: emptyUsage(),
      usageReported: false,
      toolCallsByName: {},
      turnEndReason: null,
      taskId: facts.taskId,
      repeatIndex,
      arm,
      profile: facts.profile,
      interrupted: facts.interrupted,
      spawnError: facts.spawnError,
      runnerError: message,
      timeoutMs,
      verify: [{ type: 'runner', target: null, pass: false, detail: message.slice(0, 200) }],
      verifyPassed: false,
      verifyError: message,
      eventsFile: relativeTo(outDir, paths.events),
      stderrFile: relativeTo(outDir, paths.stderr),
      traceFile: relativeTo(outDir, paths.trace),
      traceRows: countLines(paths.trace),
      workspace: facts.workspace,
      archiveErrors: [...streamErrors],
    }
    writeJson(paths.metrics, document)
    return document
  }

  /** The normal path: everything below is one row, start to finish. */
  async function drive() {
    const started = clock()
    const traceWriter = appendStream(paths.trace)
    const eventsWriter = appendStream(paths.events)
    const stderrWriter = appendStream(paths.stderr)
    const observer = createObserver({
      log: (level, text) => log(level, text),
      // Appended as it happens, like the event stream: a crash keeps the timeline so far.
      trace: (row) => write(traceWriter, `${JSON.stringify(row)}\n`),
      run: { taskId: task.id, repeatIndex },
      verbose: options.verbose === true,
      heartbeatMs: options.heartbeatMs,
      stallMs: options.stallMs,
      now: clock,
    })
    const workspace = fs.mkdtempSync(path.join(workspaceRoot, `dsh-ops-bench-${task.id}-r${repeatIndex}-`))
    facts.workspace = workspace

    observer.note('info', `[r${repeatIndex}] building the ${task.fixture.generator} fixture (${task.title ?? task.id})`)
    const fixture = generate(task.fixture.generator, task.fixture.params ?? {})
    for (const file of fixture.files) writeFixtureFile(workspace, file)
    observer.note('detail', `workspace ${workspace} — ${fixture.files.length} fixture file(s) written`)

    const args = ['--profile', options.profile]
    if (options.llmPatch) args.push('--patch', options.llmPatch)
    args.push('--json', task.prompt)
    const plan = spawnPlan(entry, args)
    const fold = createFold()

    const spawnFn = options.spawn ?? spawnChild
    const killer = options.kill ?? killTree
    const processes = spawnFn(plan.command, plan.args, {
      cwd: workspace,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      // `shell` is deliberately absent: a shell would re-quote the prompt (PLAN §2.7).
    })

    // Ctrl-C lands on the runner: hand the child over so the scheduler can kill its tree.
    const interrupt = options.interrupt ?? { stopped: false, child: null, pid: null }
    interrupt.child = processes
    interrupt.pid = processes.pid ?? null

    observer.started({
      command: plan.command,
      args: plan.args,
      cwd: workspace,
      pid: processes.pid ?? null,
      timeoutMs,
      prompt: task.prompt,
      model: options.model ?? null,
      eventsFile: relativeTo(outDir, paths.events),
      stderrFile: relativeTo(outDir, paths.stderr),
    })

    let spawnGrace = null
    let killGrace = null
    let settleExit
    const exitSettled = new Promise((resolve) => {
      settleExit = resolve
    })
    processes.once('error', (error) => {
      facts.spawnError = String(error?.message ?? error)
      write(stderrWriter, `\nspawn failed: ${String(error?.stack ?? error)}\n`)
      observer.note('warn', `the child could not start: ${String(error?.code ?? '')} ${String(error?.message ?? error)}`.trim())
      // No pid means no `close` is guaranteed; cap the wait instead of hanging the sweep.
      if (!processes.pid) spawnGrace = setTimeout(() => settleExit(null), options.spawnErrorGraceMs ?? DEFAULT_SPAWN_ERROR_GRACE_MS)
    })
    processes.once('close', (code) => {
      if (spawnGrace !== null) clearTimeout(spawnGrace)
      settleExit(typeof code === 'number' ? code : null)
    })

    const lines = readline.createInterface({ input: processes.stdout })
    lines.on('line', (line) => {
      fold.push(line)
      write(eventsWriter, `${line}\n`)
      observer.line(line)
    })
    processes.stderr.on('data', (chunk) => {
      write(stderrWriter, chunk)
      observer.stderr(chunk)
    })
    // The readline `close` is the barrier: the last buffered events arrive after exit.
    const streamClosed = new Promise((resolve) => lines.once('close', resolve))

    const deadline = setTimeout(() => {
      facts.timedOut = true
      observer.note('warn', `deadline of ${Math.round(timeoutMs / 1000)}s reached — killing the child and its tree (pid ${processes.pid ?? '?'})`)
      killer(processes)
      write(stderrWriter, `\nrunner: killed after ${timeoutMs} ms timeout\n`)
      // A kill that never closes must not hang the sweep: fall back to the archives.
      killGrace = setTimeout(() => {
        observer.note('warn', `the child did not report close after the kill — recording the row from the archives anyway (pid ${processes.pid ?? '?'})`)
        settleExit(null)
      }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
    }, timeoutMs)

    const exit = await exitSettled
    clearTimeout(deadline)
    if (killGrace !== null) clearTimeout(killGrace)
    const interrupted = Boolean(interrupt.stopped)
    interrupt.child = null
    await withDeadline(streamClosed, options.streamFlushGraceMs ?? DEFAULT_STREAM_FLUSH_GRACE_MS)
    // A killed tree's last stderr writes can land just after `close`; drain briefly.
    if (facts.timedOut || interrupted) await delay(KILL_DRAIN_MS)

    facts.exit = facts.timedOut ? null : exit
    facts.interrupted = interrupted
    facts.durationMs = clock() - started
    write(stderrWriter, `\nrunner: exit=${facts.timedOut ? 'timeout' : interrupted ? 'interrupted' : exit} duration=${facts.durationMs}ms\n`)
    await Promise.all([endStream(eventsWriter), endStream(stderrWriter)])

    observer.finished({
      exitCode: exit,
      timedOut: facts.timedOut,
      interrupted,
      spawnError: facts.spawnError,
      timeoutMs,
    })
    observer.note('info', `verifying the workspace against ${(task.verify ?? []).length} check(s) …`)

    let verify = []
    let verifyPassed = false
    let verifyError = null
    try {
      const outcome = await verifyWorkspace(workspace, task.verify ?? [], fixture.exports, { execPath: process.execPath })
      verify = toVerifyChecks(outcome)
      verifyPassed = outcome?.passed === true
    } catch (error) {
      verifyError = String(error?.message ?? error)
      verify = [{ type: 'runner', target: null, pass: false, detail: verifyError.slice(0, 200) }]
      observer.note('warn', `the verifier threw: ${verifyError}`)
    }
    await endStream(traceWriter)
    const live = observer.snapshot()
    const counted = fold.finish()

    const document = {
      // `run.schema.json $defs/metrics`, in the schema's order.
      startedAt: facts.startedAt,
      durationMs: facts.durationMs,
      exit: facts.exit,
      timedOut: facts.timedOut,
      steps: counted.steps,
      toolCalls: counted.toolCalls,
      usage: counted.usage,
      usageReported: counted.usageReported,
      toolCallsByName: counted.toolCallsByName,
      turnEndReason: counted.turnEndReason,
      // Identity and archive pointers the seal step lifts into `results[]` / `archive[]`.
      taskId: task.id,
      repeatIndex,
      arm,
      profile: options.profile,
      interrupted: facts.interrupted,
      spawnError: facts.spawnError,
      timeoutMs,
      verify,
      verifyPassed,
      verifyError,
      eventsFile: relativeTo(outDir, paths.events),
      stderrFile: relativeTo(outDir, paths.stderr),
      traceFile: relativeTo(outDir, paths.trace),
      traceRows: live.traceRows,
      milestones: live.milestones.length,
      workspace,
      archiveErrors: [...streamErrors],
    }
    writeJson(paths.metrics, document)

    if (options.keep === true) {
      log('info', `kept workspace: ${workspace}`)
    } else if (!isInside(workspaceRoot, workspace)) {
      log('warn', `refusing to delete ${workspace}: not inside ${workspaceRoot}`)
    } else if (!removeTree(workspace)) {
      log('warn', `could not delete the workspace: ${workspace}`)
    }
    log('info', progressLine(task, repeatIndex, document))
    return document
  }
}

/** Write one fixture file, refusing a path that would escape the workspace. */
function writeFixtureFile(workspace, file) {
  const parts = String(file.path).split('/')
  if (path.isAbsolute(file.path) || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`fixture file path must stay inside the workspace: ${JSON.stringify(file.path)}`)
  }
  const target = path.join(workspace, ...parts)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, file.content, 'utf8')
}

/** A path as the archive documents it: relative to the run directory, forward slashes. */
function relativeTo(outDir, file) {
  return path.relative(outDir, file).split(path.sep).join('/')
}

/** The line count of an archive file, or 0 when it is absent (runner-error path only). */
function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (text === '') return 0
    const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
    return trimmed === '' ? 0 : trimmed.split('\n').length
  } catch {
    return 0
  }
}

/** Write the row document; a write failure throws, because the row is the evidence. */
function writeJson(file, document) {
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

/** Flush and close a write stream; idempotent, so both the normal and error paths call it. */
function endStream(stream) {
  return new Promise((resolve) => {
    if (stream.writableEnded || stream.destroyed) {
      resolve()
      return
    }
    stream.end(() => resolve())
  })
}

/** Resolve `promise` or after `ms`, whichever comes first, clearing the timer. */
function withDeadline(promise, ms) {
  let timer
  // Deliberately not unref'd: the runner must still be alive to write the row when
  // this cap is the only thing left, which is exactly the case it exists for.
  const cap = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer))
}

/** A promise that resolves after `ms`. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Is `target` strictly inside `root`? Checked before a delete, so a wrong root can only refuse. */
function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Kill a child and everything it spawned. */
function killTree(child) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000 })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    // The child may already be gone; the close handler archives whatever happened.
  }
}

/** Delete a tree, retrying the momentary locks Windows leaves behind. */
function removeTree(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    } catch (error) {
      if (error?.code !== 'EBUSY' && error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') return false
      // Synchronous backoff: this runs on the row's own path, and a sleeping child
      // process just to wait is more machinery than a locked directory needs.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (attempt + 1))
    }
  }
  return false
}

/** The one progress line the scheduler may print for a row. */
function progressLine(task, repeatIndex, row) {
  const tokens = row.usageReported
    ? `${row.usage.inputTokens.toLocaleString('en-US')} in/${row.usage.outputTokens.toLocaleString('en-US')} out`
    : 'usage n/a'
  const exit = row.timedOut ? 'TIMEOUT' : row.interrupted ? 'STOPPED' : row.exit ?? 'n/a'
  return `${task.id} r${repeatIndex}: exit=${exit} steps=${row.steps} tokens=${tokens} verify=${row.verifyPassed ? 'PASS' : 'FAIL'} ${Math.round(row.durationMs / 1000)}s`
}
