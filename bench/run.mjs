#!/usr/bin/env node
/**
 * The benchmark runner: real tasks, real model, real `dsh`, measured end to end.
 *
 * For every task × repeat it builds a throwaway workspace from a seeded fixture
 * (`lib/fixtures.mjs`), spawns one headless single-shot session in it, archives the
 * raw NDJSON event stream, verifies the result with `lib/verify.mjs`, and folds the
 * whole sweep into `summary.json` + `report.md` under
 * `bench/runs/<folder>/<stamp>-<label>/`. The folder defaults to the local date
 * (`2026-10-16`), and `--folder <name>` picks a reusable group instead, so sweeps
 * never pile up flat in `bench/runs/` — the day's runs are one directory to look at,
 * and a named round (an experiment, a plugin version) stays on its own shelf.
 *
 * Three design points are worth knowing before changing this file:
 *
 * - **It never spawns `dsh` the shim.** On Windows the PATH entry is a bash script
 *   plus `.cmd`/`.ps1` wrappers, and Node cannot spawn those without a shell
 *   (CVE-2024-27980 made `.cmd` throw `EINVAL`); a shell would also re-parse the
 *   task text. So the launcher resolves the package's `lib/bin.js` once and always
 *   runs `spawn(process.execPath, [binJs, ...args])` — no shell, array args, same
 *   code on both platforms (PLAN.md §2.7).
 * - **The LLM routing is an injected overlay, not an edited profile.** The same
 *   `--patch bench/llm.patch.yml` goes into every call on both sides of a
 *   comparison, so "identical provider and model" is a property of how the run was
 *   built rather than a note in a README (§2.7, §10.1).
 * - **Tasks run serially.** Concurrency would make two runs fight over one
 *   self-hosted server's queue and warm cache, and the numbers would stop meaning
 *   anything.
 * - **A run narrates itself while it is in flight.** `lib/observe.mjs` turns the
 *   event stream, the child's stderr and the clock into milestone lines (booted,
 *   first request out, model answered, tool errors, outcome) plus a heartbeat and
 *   stall warnings, so "it printed nothing for ten minutes" is a diagnosis instead
 *   of a guess. Everything also lands in `<run>/runner.log`, which survives the
 *   console being scrolled away or the sweep being interrupted (README §4).
 *
 * No dependencies, and no traffic of its own beyond one optional best-effort TCP
 * connect that asks nothing of the model (see `--probe-endpoint`); nothing is deleted
 * outside the workspaces it created (unless `--keep` asked it not to).
 *
 * @module dsh-ops/bench/run
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { generate } from './lib/fixtures.mjs'
import { verifyWorkspace } from './lib/verify.mjs'
import { createAggregator } from './lib/aggregate.mjs'
import { createObserver, formatClock } from './lib/observe.mjs'
import { describeModulePath, poisonedModulePath } from './lib/env.mjs'
import { loadTasks, selectTasks, TASKS_DIR, DEFAULT_TIMEOUT_MS } from './lib/tasks.mjs'
import { formatNumber, median } from './lib/compare-core.mjs'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(BENCH_DIR, '..')
const RUNS_DIR = path.join(BENCH_DIR, 'runs')
const SHIPPED_PROFILES = ['headless', 'web', 'tui', 'acp', 'sdk', 'sdk-minimal', 'dsh-tui']

/** The documented CLI shape, printed by `--help` and on any argument error. */
const USAGE = `usage: node bench/run.mjs --label <label> --profile <dsh-profile> [options]

  --task <id>          run only this task (repeatable); default: every bench/tasks/*.task.json
  --repeat N           runs per task; default: each task's own "repeat" field, else 3.
                       Passing --repeat explicitly overrides every per-task budget.
  --timeout MS         override each task's timeoutMs
  --dsh <path>         dsh's JS entry (lib/bin.js) or an executable; default: resolved from PATH
  --llm-patch <path>   overlay to inject with --patch (default bench/llm.patch.yml when present)
  --no-llm-patch       do not inject any overlay
  --dsh-home <dir>     isolate DSH_HOME (profiles + sessions) inside the benchmark directory
  --sleep-ms N         fixed pause between repeats (default 0)
  --verbose            live narration: every step, tool call and dsh stderr line, in real time
  --heartbeat-ms N     "still running" line while a run is in flight (default 15000; 0 = off)
  --stall-ms N         escalate once a run has produced nothing for N ms (default 60000)
  --probe-endpoint     reachability-check the overlay's baseURL(s) before spending tokens
  --no-probe-endpoint  skip that check (on by default; TCP connect only, no request is sent)
  --preflight-only     run the environment check and exit: no run directory, no task, no token
  --strict             preflight warnings become errors
  --out <dir>          run directory, named outright (it opts out of grouping);
                       default bench/runs/<YYYY-MM-DD>/<UTC stamp>-<label>
  --folder <name>      group the run under bench/runs/<name>/<UTC stamp>-<label>
                       instead of the default local-date folder; the folder is
                       created on demand and reusable across rounds
                       (one safe directory name; cannot combine with --out)
  --keep               keep each temporary workspace instead of deleting it
  --dry-run            generate fixtures and self-check verify, without spawning dsh
  --list               list the task corpus and exit
  --help               this text

Whatever prints here also goes to <run>/runner.log with timestamps, so an interrupted
sweep leaves its narration behind (README §4). Ctrl-C kills the dsh child and its tree,
stops the sweep, and still writes summary.json + report.md marked "stopped early";
a second Ctrl-C quits immediately.`


/**
 * The parsed command line.
 * @typedef {object} Options
 * @property {string} label - the run label used for naming and by compare.mjs.
 * @property {string} profile - the dsh profile to run.
 * @property {string[]} taskIds - selected task ids (empty = whole corpus).
 * @property {number} repeat - repeats per task (or the default when tasks carry none).
 * @property {boolean} repeatExplicit - whether `--repeat` was passed; an explicit
 *   value overrides every per-task `"repeat"` budget, an absent one defers to it.
 * @property {number|null} timeout - per-task deadline override in ms.
 * @property {string|null} dsh - explicit dsh entry override.
 * @property {string|null} llmPatch - overlay path, or null when injection is off.
 * @property {string|null} dshHome - isolated DSH_HOME.
 * @property {number} sleepMs - pause between repeats.
 * @property {boolean} verbose - narrate every event line, not just the milestones.
 * @property {number} heartbeatMs - period of the in-flight "still running" line; 0 = off.
 * @property {number} stallMs - silence at which the stall warning escalates; 0 = off.
 * @property {boolean} probeEndpoint - reachability-check the overlay's baseURLs in preflight.
 * @property {boolean} preflightOnly - run the environment check and stop: no sweep, no run directory.
 * @property {boolean} strict - escalate preflight warnings to errors.
 * @property {string|null} out - run directory override.
 * @property {string|null} folder - group directory requested with `--folder`, or null
 *   to let the layout default to the day's date folder (see {@link defaultRunFolder}).
 * @property {boolean} keep - keep temporary workspaces.
 * @property {boolean} dryRun - fixture/verify self-check only.
 * @property {boolean} list - print the corpus and exit.
 */

/**
 * A `--folder` name must be one flat, safe directory segment: groups live directly
 * under bench/runs/ and are reused across rounds, so no separators, no traversal,
 * no drive letters.
 * @param {string} name - the requested folder name.
 * @param {string} flag - the flag it came from, for the error text.
 * @returns {string} the validated name.
 */
export function assertFolderName(name, flag) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[\\/]/.test(name) || name.includes(':')) {
    throw new Error(`${flag} must be one safe directory name (no path separators, no "." or ".."), got "${name}"`)
  }
  return name
}

/**
 * Parse the command line into {@link Options}.
 * @param {string[]} argv - the arguments after the script name.
 * @returns {Options} the options.
 */
export function parseArgs(argv) {
  const options = {
    label: null, profile: null, taskIds: [], repeat: 3, repeatExplicit: false, timeout: null, dsh: null,
    llmPatch: null, llmPatchExplicit: false, dshHome: null, sleepMs: 0, strict: false,
    out: null, folder: null, keep: false, dryRun: false, list: false, help: false,
    verbose: false, heartbeatMs: 15000, stallMs: 60000, probeEndpoint: true, preflightOnly: false,
  }
  const flagsWithValues = { '--label': 'label', '--profile': 'profile', '--task': 'taskIds', '--repeat': 'repeat', '--timeout': 'timeout', '--dsh': 'dsh', '--llm-patch': 'llmPatch', '--dsh-home': 'dshHome', '--sleep-ms': 'sleepMs', '--out': 'out', '--folder': 'folder', '--heartbeat-ms': 'heartbeatMs', '--stall-ms': 'stallMs' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`)
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? null : arg.slice(eq + 1)
    if (name === '--no-llm-patch') {
      options.llmPatchExplicit = true
      options.llmPatch = null
      continue
    }
    if (name === '--probe-endpoint' || name === '--no-probe-endpoint') {
      options.probeEndpoint = name === '--probe-endpoint'
      continue
    }
    if (['--strict', '--keep', '--dry-run', '--list', '--help', '--verbose', '--preflight-only'].includes(name)) {
      options[{ '--strict': 'strict', '--keep': 'keep', '--dry-run': 'dryRun', '--list': 'list', '--help': 'help', '--verbose': 'verbose', '--preflight-only': 'preflightOnly' }[name]] = true
      continue
    }
    const target = flagsWithValues[name]
    if (!target) throw new Error(`unknown option "${name}"`)
    const value = inline ?? argv[++i]
    if (value === undefined) throw new Error(`${name} needs a value`)
    if (target === 'taskIds') options.taskIds.push(value)
    else if (['repeat', 'timeout', 'sleepMs', 'heartbeatMs', 'stallMs'].includes(target)) {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} needs a non-negative integer, got "${value}"`)
      if (target === 'repeat' && parsed < 1) throw new Error('--repeat must be at least 1')
      options[target] = parsed
      if (target === 'repeat') options.repeatExplicit = true
    } else options[target] = value
  }
  if (options.folder !== null) {
    // One flat, reusable group directory under bench/runs/ — never a path of its own.
    assertFolderName(options.folder, '--folder')
    if (options.out) throw new Error('--folder groups the default bench/runs/ layout; with --out you already name the directory — drop one of them')
  }
  if (options.help || options.list) return options
  if (options.preflightOnly) {
    // A check needs a profile to check, not a label to archive under: it produces no
    // run directory, so it must not be asked to name one.
    if (!options.profile) throw new Error('--profile is required')
    return options
  }
  if (!options.label) throw new Error('--label is required')
  if (!options.profile) throw new Error('--profile is required')
  if (SHIPPED_PROFILES.includes(options.profile) && !options.dryRun) {
    throw new Error(`--profile "${options.profile}" is a shipped template name, not a bench profile; create one with "dsh <name> --from-default-profile headless" (PLAN §2.3)`)
  }
  return { ...options, llmPatchExplicit: Boolean(options.llmPatch || options.llmPatchExplicit) }
}

/**
 * Everything the runner learns while locating the dsh launcher.
 * @typedef {object} DshEntry
 * @property {string} file - the resolved `lib/bin.js` (or an executable).
 * @property {'js'|'exe'} kind - how to spawn it.
 * @property {string|null} version - the reported dsh version.
 * @property {string[]} notes - how it was found, for the audit trail.
 */

/**
 * Find the dsh launcher to spawn.
 *
 * `--dsh` wins when given. Otherwise the PATH shim is read and its
 * `node_modules/@deepseek-ai/dsh/lib/bin.js` target is extracted; the documented
 * npm global locations are the fallbacks (PLAN §5.1).
 * @param {string|null} explicit - the `--dsh` value.
 * @returns {DshEntry} the entry.
 */
export function resolveDshEntry(explicit = null) {
  const notes = []
  if (explicit) {
    const file = path.resolve(explicit)
    if (!fs.existsSync(file)) throw new Error(`--dsh points at a path that does not exist: ${file}`)
    const kind = /\.(js|mjs|cjs)$/i.test(file) ? 'js' : 'exe'
    notes.push(`explicit --dsh (${kind})`)
    return { file, kind, version: null, notes }
  }

  const candidates = []
  if (process.platform === 'win32') {
    const shim = findOnPath('dsh.cmd') ?? findOnPath('dsh')
    if (shim) {
      notes.push(`PATH shim ${shim}`)
      const fromShim = binFromShim(shim)
      if (fromShim) candidates.push(fromShim)
    }
    const appData = process.env.APPDATA
    if (appData) candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  } else {
    const shim = findOnPath('dsh')
    if (shim) {
      notes.push(`PATH entry ${shim}`)
      try {
        const real = fs.realpathSync(shim)
        if (/\.js$/i.test(real)) candidates.push(real)
        else {
          const fromShim = binFromShim(real)
          if (fromShim) candidates.push(fromShim)
        }
      } catch {}
    }
  }
  const npmRoot = runCapture('npm', ['root', '-g'])
  if (npmRoot?.status === 0) {
    const root = npmRoot.stdout.trim()
    if (root) {
      notes.push(`npm root -g ${root}`)
      candidates.push(path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    }
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return { file: candidate, kind: 'js', version: null, notes }
  }
  throw new Error(
    'could not find the dsh launcher. Install it globally ("npm i -g @deepseek-ai/dsh") or pass '
    + `--dsh <path>/lib/bin.js. Looked via: ${notes.length ? notes.join('; ') : 'nothing (no dsh on PATH, no npm root -g)'}`,
  )
}

/**
 * Extract the package's JS entry from an npm shim (`.cmd`, shell script, or symlink target).
 * @param {string} shimFile - the shim path.
 * @returns {string|null} the bin.js path when it can be located.
 */
function binFromShim(shimFile) {
  if (!fs.existsSync(shimFile)) return null
  let text = ''
  try {
    text = fs.readFileSync(shimFile, 'utf8')
  } catch {
    return null
  }
  // npm's Windows shims reference "%dp0%\node_modules\@deepseek-ai\dsh\lib\bin.js";
  // the POSIX shell shim references "$basedir/node_modules/.../bin.js".
  const match = text.match(/(?:%dp0%|\$basedir|"?\{?\$?DIR\}?)[/\\]?(node_modules[/\\]@deepseek-ai[/\\]dsh[/\\].*?\.js)/i)
    ?? text.match(/(node_modules[/\\]@deepseek-ai[/\\]dsh[/\\].*?\.js)/i)
  if (!match) return null
  const relative = match[1].replace(/"/g, '')
  const fromShim = path.resolve(path.dirname(shimFile), relative)
  if (fs.existsSync(fromShim)) return fromShim
  const tail = relative.split(/[/\\]/).pop()
  const guess = path.resolve(path.dirname(shimFile), '..')
  const fallback = path.join(guess, '@deepseek-ai', 'dsh', 'lib', tail ?? 'bin.js')
  return fs.existsSync(fallback) ? fallback : null
}

/**
 * Run a command and capture its output, never throwing on a missing binary.
 * @param {string} command - the executable.
 * @param {string[]} args - the argument array.
 * @returns {{status: number|null, stdout: string, stderr: string, errorCode: string|null}|null} the outcome, or null when it could not start.
 */
function runCapture(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', errorCode: result.error?.code ?? null }
  } catch {
    return null
  }
}

/**
 * Find an executable on PATH without spawning anything.
 *
 * A PATH scan is the right tool here: `where.exe` and `which` both have to be
 * spawned with captured output, and a confined parent (an agent session inside a
 * sandbox) cannot always open those pipes — the launcher would then look missing
 * when it is on the very next directory.
 * @param {string} name - the file name to look for, without PATHEXT expansion.
 * @returns {string|null} the first match.
 */
function findOnPath(name) {
  const directories = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`)
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
      } catch {}
    }
  }
  return null
}

/**
 * Can this process spawn a child and read its stdout? The whole harness depends
 * on it (`dsh --json` is measured through a pipe), and a sandboxed parent says no.
 * @returns {string|null} the reason it does not work, or null when it does.
 */
export function pipedSpawnBlocker() {
  const probe = runCapture(process.execPath, ['--version'])
  if (probe && probe.status === 0) return null
  return probe?.errorCode ?? 'unknown spawn failure'
}

/**
 * Ask the launcher for its version, best effort.
 * @param {DshEntry} entry - the resolved entry.
 * @returns {string|null} the version string.
 */
function probeDshVersion(entry) {
  const args = entry.kind === 'js' ? [entry.file, '--version'] : ['--version']
  const command = entry.kind === 'js' ? process.execPath : entry.file
  const result = runCapture(command, args)
  const text = `${result?.stdout ?? ''}${result?.stderr ?? ''}`
  const match = text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
  return match ? match[0] : null
}

/**
 * The home directory dsh will use for this run.
 * @param {Options} options - the parsed options.
 * @returns {string} the absolute home.
 */
function dshHomeFor(options) {
  if (options.dshHome) return path.resolve(options.dshHome)
  return path.resolve(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
}

/**
 * The environment a spawned dsh inherits.
 * @param {Options} options - the parsed options.
 * @returns {Record<string, string|undefined>} the environment.
 */
function childEnv(options) {
  const env = { ...process.env }
  if (options.dshHome) env.DSH_HOME = path.resolve(options.dshHome)
  return env
}

/**
 * A log sink that writes narration to the console and, once attached, to a file.
 *
 * The two halves differ on purpose: `detail` lines print on the console only under
 * `--verbose`, but always reach `runner.log`, because a run the human is *watching*
 * should stay readable while the run they are *investigating afterwards* should be
 * complete. The runner always has one, so nothing downstream has to care whether
 * narration was asked for at all.
 * @param {{verbose?: boolean}} [config] - the console policy.
 * @returns {{info: Function, detail: Function, warn: Function, attach: Function, close: Function, file: () => string|null}} the sink.
 */
export function createLogger(config = {}) {
  const { verbose = false } = config
  // Lines produced before the run directory exists — all of preflight — are
  // buffered and flushed into the file when it does, because a run directory whose
  // log starts at "task 1" is exactly the artifact that is missing when preflight is
  // what went wrong.
  const buffer = []
  let stream = null
  let file = null
  const emit = (level, text) => {
    const at = new Date()
    const clock = at.toTimeString().slice(0, 8)
    if (level === 'warn') console.error(`[${clock}] *** ${text}`)
    else if (level !== 'detail' || verbose) console.log(`[${clock}] ${text}`)
    const record = { at: at.toISOString(), level, text }
    if (stream) stream.write(`${record.at} ${level.toUpperCase().padEnd(6)} ${text}\n`)
    else buffer.push(record)
  }
  return {
    info: (text) => emit('info', text),
    detail: (text) => emit('detail', text),
    warn: (text) => emit('warn', text),
    /**
     * Start writing the log inside a run directory, flushing what came before it.
     * @param {string} dir - the run root.
     * @returns {string} the log file path.
     */
    attach: (dir) => {
      file = path.join(dir, 'runner.log')
      stream = fs.createWriteStream(file)
      for (const record of buffer) stream.write(`${record.at} ${record.level.toUpperCase().padEnd(6)} ${record.text}\n`)
      buffer.length = 0
      return file
    },
    /**
     * Flush and close the file, when one was ever attached.
     * @returns {Promise<void>} resolves when the log is on disk.
     */
    close: () => (stream ? endStream(stream) : Promise.resolve()),
    file: () => file,
  }
}

/**
 * Every `baseURL` the composed tree (or the overlay) names, de-duplicated.
 * @param {string} text - YAML-ish text to scan.
 * @returns {string[]} the endpoint URLs.
 */
export function extractEndpoints(text) {
  const urls = [...String(text ?? '').matchAll(/^\s*baseURL:\s*["']?([^"'\s,]+)["']?\s*$/gim)].map((match) => match[1])
  return [...new Set(urls)]
}

/**
 * Ask whether an endpoint's port will accept a connection at all — a TCP connect
 * and nothing more.
 *
 * This is the one piece of traffic the runner originates, and it is deliberately
 * dumb: it sends no bytes and authenticates with nothing, so it cannot spend a token
 * or change server state. It exists because "the sweep printed nothing for ten
 * minutes" is far more likely to mean `ECONNREFUSED`/black-holed TCP than a slow
 * model, and a three-second connect answers that before the corpus does.
 * @param {string[]} urls - the endpoints to probe.
 * @param {{timeoutMs?: number}} [config] - per-probe deadline.
 * @returns {Promise<Array<{url: string, host: string|null, port: number|null, ok: boolean, ms: number, note: string}>>} one result per URL.
 */
export async function probeEndpoints(urls, { timeoutMs = 3000 } = {}) {
  const results = []
  for (const url of urls) {
    const target = parseTcpTarget(url)
    if (!target) {
      results.push({ url, host: null, port: null, ok: false, ms: 0, note: 'not a http(s)/tcp URL — nothing to probe' })
      continue
    }
    const started = Date.now()
    results.push({ url, host: target.host, port: target.port, ...(await connectOnce(target, timeoutMs)), ms: Date.now() - started })
  }
  return results
}

/**
 * Split a URL into the host and port a connect needs.
 * @param {string} url - the endpoint.
 * @returns {{host: string, port: number, secure: boolean}|null} the target, or null when it is not TCP.
 */
function parseTcpTarget(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const secure = parsed.protocol === 'https:'
    const host = parsed.hostname
    if (!host) return null
    const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80
    return { host, port, secure }
  } catch {
    return null
  }
}

/**
 * One connect attempt, resolved either way. Never throws, never sends a request.
 * @param {{host: string, port: number}} target - the endpoint.
 * @param {number} timeoutMs - the deadline.
 * @returns {Promise<{ok: boolean, note: string}>} the outcome.
 */
function connectOnce(target, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host: target.host, port: target.port })
    const finish = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ ok: true, note: 'port accepted the connection' }))
    socket.once('timeout', () => finish({ ok: false, note: `no answer within ${timeoutMs} ms (filtered or the host is not there)` }))
    socket.once('error', (error) => finish({ ok: false, note: `${error.code ?? 'error'}: ${error.message}` }))
  })
}

/**
 * What preflight learned about the machine, the profile, and the overlay.
 * @typedef {object} Preflight
 * @property {DshEntry} entry - the dsh launcher.
 * @property {string|null} llmPatch - the overlay actually injected.
 * @property {string} dump - the archived `--dump-config` text, with dsh's stderr when it said anything.
 * @property {{provider: string|null, model: string|null, bestEffort: boolean}} model - the best-effort model identity.
 * @property {string[]} warnings - things a human should read before trusting the run.
 * @property {string} home - the DSH_HOME in play.
 * @property {Array<{url: string, ok: boolean, note: string}>} endpoints - the reachability probe results, empty when it was skipped.
 */

/**
 * Check the machine before burning a model's tokens.
 * @param {Options} options - the parsed options.
 * @param {{info: Function, detail: Function, warn: Function}} [log] - the narration sink; preflight is where a run that "hangs" usually already hung.
 * @returns {Promise<Preflight>} the preflight result.
 * @throws {Error} when a hard prerequisite is missing, or a warning is fatal under --strict.
 */
export async function preflight(options, log = createLogger()) {
  const warnings = []
  log.info('preflight: checking the machine before any tokens are spent …')
  // Everything downstream reads a child's stdout through a pipe. Saying so here,
  // before any work is thrown away, is the difference between a clear diagnosis
  // and a sweep that appears to hang.
  const blocked = pipedSpawnBlocker()
  if (blocked) {
    throw new Error(`preflight: this process cannot spawn a child with captured stdout (${blocked}). Run bench/run.mjs from a normal terminal, not from inside a confined agent session.`)
  }
  log.info('preflight: this process can spawn a child and read its stdout')
  const entry = resolveDshEntry(options.dsh)
  log.info(`preflight: dsh launcher ${entry.file} (${entry.kind}) — ${entry.notes.join('; ') || 'explicit --dsh'}`)
  entry.version = probeDshVersion(entry)
  if (!entry.version) warnings.push('could not read "dsh --version" output; the run archive will record the entry path only')
  else log.info(`preflight: "dsh --version" answered ${entry.version}`)

  const home = dshHomeFor(options)
  const profileDir = path.join(home, 'profiles', options.profile)
  log.info(`preflight: DSH_HOME ${home}${options.dshHome ? ' (isolated)' : ''}; profile dir ${profileDir}`)
  if (!fs.existsSync(profileDir)) {
    if (SHIPPED_PROFILES.includes(options.profile)) {
      warnings.push(`profile "${options.profile}" is a shipped template, not a dedicated bench profile`)
    } else {
      // §2.3: this step only initializes the profile (no boot, no task) and is NOT
      // idempotent — re-running it on an existing profile throws — so the runner
      // never creates profiles itself; it prints the one-time command instead.
      throw new Error(
        `profile "${options.profile}" does not exist under ${path.join(home, 'profiles')}. Create it once with: `
        + `node ${entry.file} ${options.profile} --from-default-profile headless --dump-config`,
      )
    }
  } else {
    log.info(`preflight: profile "${options.profile}" exists`)
    const pluginDir = path.join(profileDir, 'node_modules', 'dsh-ops')
    let installed = null
    try {
      installed = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')).version ?? null
    } catch {}
    log.info(`preflight: candidate plugin ${installed ? `dsh-ops@${installed} is installed in this profile` : 'dsh-ops is NOT installed in this profile'}`)
  }

  // §2.5/§2.7: an isolated home is the only way to be sure nobody's global routing
  // or plugins leaked into the stock baseline.
  const homePatch = path.join(home, 'cordis.patch.yml')
  if (fs.existsSync(homePatch) && fs.readFileSync(homePatch, 'utf8').trim() !== '') {
    warnings.push(`${homePatch} exists and is not empty: it composes into EVERY profile ahead of the profile layer, so bench-base may not be stock (PLAN §2.7). Use --dsh-home to isolate.`)
  }
  const pnpm = findOnPath('pnpm')
  if (!pnpm) warnings.push('pnpm is not available on PATH; "dsh plugin ... add" would fail with exit 127 (PLAN §2.3)')
  else log.info(`preflight: pnpm found at ${pnpm}`)
  // README §1: this pollution used to make the CANDIDATE side die inside workspace
  // preparation while looking exactly like a hang, and it arrives through the terminal
  // that started the runner. The plugin now sanitizes its own preparation child, so what
  // is left to report is the measurement condition (and an older installed plugin), and
  // it is worth naming before the sweep, not after.
  const poison = poisonedModulePath(process.env.PSModulePath)
  log.info(`preflight: PSModulePath search order — ${describeModulePath(process.env.PSModulePath, poison)}`)
  if (poison) {
    warnings.push(`PSModulePath puts the PowerShell Core root ${poison} ahead of Windows PowerShell's own module root (README §1). This checkout's plugin strips that shadow for its own preparation child, so the candidate side should keep working — but a candidate profile holding an older dsh-ops (--reinstall to update it) fails every pwsh/bash/run_code call before the model's command runs, and this machine is still not the documented clean-cmd environment. Start the sweep from cmd.exe (or Windows PowerShell 5.1) if the numbers are meant to describe one.`)
    log.warn(`preflight: PowerShell Core module root ${poison} precedes the in-box 5.1 root — the preparation child is sanitized either way, but a clean cmd.exe is the documented condition (README §1)`)
  }

  const llmPatch = resolveOverlay(options)
  let dump = null
  let model = { provider: null, model: null, bestEffort: true }
  const endpoints = []
  if (llmPatch) {
    const overlayText = fs.readFileSync(llmPatch, 'utf8')
    log.info(`preflight: overlay ${llmPatch} (${overlayText.split(/\r?\n/).length} line(s)) — placeholders checked, then rendered through dsh`)
    assertNoPlaceholders(overlayText, llmPatch)
    dump = captureDumpConfig(entry, options, llmPatch, log)
    model = extractModel(dump.text) ?? modelFromOverlay(overlayText) ?? model
    log.info(`preflight: routing resolved to provider "${model.provider ?? '?'}" / model "${model.model ?? '?'}" (best effort from the composed tree)`)
    checkPatchesApplied(dump, llmPatch, warnings, log)
    checkCredentials(overlayText, home, warnings, log)
    for (const url of extractEndpoints(overlayText)) {
      if (!options.probeEndpoint) {
        log.info(`preflight: endpoint ${url} — probe skipped (--no-probe-endpoint)`)
        continue
      }
      const [probe] = await probeEndpoints([url])
      endpoints.push({ url, ...probe })
      if (probe.ok) log.info(`preflight: endpoint ${url} is reachable (${probe.host}:${probe.port} accepted a TCP connect in ${probe.ms} ms) — no request was sent, so this proves reachability, not auth`)
      else {
        log.warn(`preflight: endpoint ${url} is NOT reachable (${probe.host}:${probe.port} — ${probe.note})`)
        warnings.push(`endpoint ${url} is not reachable: ${probe.note}. A sweep against it will sit at "request sent to the model" until the timeout, then report usage n/a (README §2).`)
      }
    }
  } else {
    log.warn('preflight: no LLM overlay injected — whatever routing the profile itself carries is what runs')
    warnings.push('no LLM overlay injected: the profile must already route to a model, and token totals depend on the server reporting usage (PLAN §2.6)')
    dump = captureDumpConfig(entry, options, null, log)
    model = extractModel(dump.text) ?? model
    if (options.probeEndpoint) {
      for (const url of extractEndpoints(dump.text)) {
        const [probe] = await probeEndpoints([url])
        endpoints.push({ url, ...probe })
        if (probe.ok) log.info(`preflight: endpoint ${url} is reachable (${probe.host}:${probe.port} in ${probe.ms} ms)`)
        else log.warn(`preflight: endpoint ${url} is NOT reachable (${probe.host}:${probe.port} — ${probe.note})`)
      }
    }
  }

  if (options.strict && warnings.length > 0) {
    throw new Error(`--strict: ${warnings.length} preflight warning(s):\n  - ${warnings.join('\n  - ')}`)
  }
  log.info(`preflight done: ${warnings.length} warning(s)`)
  return { entry, llmPatch, dump: renderDumpConfig(dump), model, warnings, home, endpoints }
}

/**
 * The archive of the composed config tree: the rendered tree, plus dsh's own
 * diagnostics when it printed any — a silently skipped patch shows up only there.
 * @param {{text: string, stderr: string}} dump - the captured `--dump-config` outcome.
 * @returns {string} the text to archive.
 */
function renderDumpConfig(dump) {
  const stderr = (dump.stderr ?? '').trim()
  if (stderr === '') return dump.text
  return `${dump.text}${dump.text.endsWith('\n') ? '' : '\n'}\n--- dsh diagnostics (stderr) ---\n${stderr}\n`
}

/**
 * Which overlay file, if any, gets injected.
 * @param {Options} options - the parsed options.
 * @returns {string|null} the absolute overlay path, or null for none.
 */
function resolveOverlay(options) {
  if (options.llmPatchExplicit && options.llmPatch === null) return null
  const candidate = options.llmPatch ? path.resolve(options.llmPatch) : path.join(BENCH_DIR, 'llm.patch.yml')
  if (options.llmPatch && !fs.existsSync(candidate)) throw new Error(`--llm-patch points at a path that does not exist: ${candidate}`)
  return fs.existsSync(candidate) ? candidate : null
}

/**
 * The non-comment lines still carrying the template's `<...>` placeholders — that is how a
 * "baseline" quietly becomes a run that fails on every task. Shared with `bench/setup.mjs`
 * so its seeding step and this preflight agree on what "unfilled" means.
 * @param {string} text - the overlay YAML.
 * @returns {string[]} the offending lines, trimmed, in file order.
 */
export function placeholderLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .filter((line) => /<[^>\n]*>/.test(line))
    .map((line) => line.trim())
}

/**
 * Refuse to run against the template's placeholders.
 * @param {string} text - the overlay YAML.
 * @param {string} file - where it came from.
 * @returns {void}
 */
function assertNoPlaceholders(text, file) {
  const offenders = placeholderLines(text)
  if (offenders.length > 0) {
    throw new Error(`${file} still contains placeholders: ${offenders.join(' | ')}. Fill in the server and model (bench/setup.mjs seeds the file from the example when it is missing; PLAN §8).`)
  }
}

/**
 * Ask dsh to render the composed config tree, with the overlay layer applied.
 * @param {DshEntry} entry - the launcher.
 * @param {Options} options - the parsed options.
 * @param {string|null} llmPatch - the overlay to inject.
 * @param {{info: Function, detail: Function, warn: Function}} [log] - the narration sink.
 * @returns {{text: string, stderr: string, status: number}} the rendered tree, its diagnostics and the exit status.
 */
function captureDumpConfig(entry, options, llmPatch, log = createLogger()) {
  // The launcher's own options come first, the overlay next, the mode last (§2.7).
  const args = entry.kind === 'js' ? [entry.file] : []
  args.push('--profile', options.profile)
  if (llmPatch) args.push('--patch', llmPatch)
  args.push('--dump-config')
  const command = entry.kind === 'js' ? process.execPath : entry.file
  log.info(`preflight: spawning the config render (no model, no tokens): ${describeCall(command, args)}`)
  const started = Date.now()
  const result = runCapture(command, args)
  log.info(`preflight: --dump-config returned in ${formatClock(Date.now() - started)} (exit=${result?.status ?? 'spawn failed'}, ${formatNumber(result?.stdout?.length ?? 0)} bytes of tree, ${formatNumber(result?.stderr?.length ?? 0)} bytes of diagnostics)`)
  if (!result) throw new Error(`could not spawn the dsh launcher at ${entry.file}`)
  if ((result.stderr ?? '').trim() !== '') log.info(`preflight: dsh diagnostics: ${result.stderr.trim().split(/\r?\n/).slice(0, 3).join(' ⏐ ')}`)
  if (result.status !== 0) {
    throw new Error(`preflight: "dsh --profile ${options.profile} --dump-config" exited ${result.status}\n${(result.stderr || result.stdout).trim().slice(0, 2000)}`)
  }
  // A patch whose id is unknown to the tree is a *diagnostic*, not part of the
  // rendered tree, so the skip notice can land on either stream.
  return { text: result.stdout, stderr: result.stderr, status: result.status }
}

/**
 * Render a spawn line for the log, with absurdly long arguments clipped.
 * @param {string} command - the executable.
 * @param {string[]} args - its argv.
 * @returns {string} one readable line.
 */
function describeCall(command, args) {
  return [command, ...args].map((part) => (String(part).length > 120 ? `${String(part).slice(0, 117)}…` : String(part))).join(' ')
}

/**
 * Confirm the two patches really landed in the composed tree (§2.7: a patch whose
 * id is unknown to the tree is warned about and skipped, silently).
 * @param {{text: string, stderr: string}} dump - the rendered tree and its diagnostics.
 * @param {string} llmPatch - the overlay path, for the message.
 * @param {string[]} warnings - the preflight warning sink.
 * @param {{info: Function, detail: Function, warn: Function}} [log] - the narration sink.
 * @returns {void}
 */
function checkPatchesApplied(dump, llmPatch, warnings, log = createLogger()) {
  const text = `${dump.text ?? ''}\n${dump.stderr ?? ''}`
  const skipped = [...text.matchAll(/^.*(warn|skipped|not found|unknown id).*$/gim)].map((match) => match[0].trim())
  const relevant = skipped.filter((line) => /llm-pi-ai|agent-default-model/i.test(line))
  if (relevant.length > 0) {
    throw new Error(`preflight: ${path.basename(llmPatch)} was not applied to the composed tree:\n  - ${relevant.join('\n  - ')}`)
  }
  for (const id of ['llm-pi-ai', 'agent-default-model']) {
    if ((dump.text ?? '').includes(id)) log.info(`preflight: patch id "${id}" is present in the composed tree — the overlay landed`)
    else warnings.push(`--dump-config output does not mention "${id}"; cannot prove the overlay landed (checked ${path.basename(llmPatch)})`)
  }
}

/**
 * Pull `provider`/`model` out of the rendered tree, best effort.
 * @param {string} text - the dump-config output.
 * @returns {{provider: string|null, model: string|null, bestEffort: boolean}|null} the identity.
 */
export function extractModel(text) {
  if (!text) return null
  const section = text.match(/agent-default-model[\s\S]{0,400}?\bprovider:\s*"?([^"\n]+?)"?\s*\n[\s\S]{0,200}?\bmodel:\s*"?([^"\n]+?)"?\s*(?:\n|$)/i)
  if (section) return { provider: section[1].trim(), model: section[2].trim(), bestEffort: true }
  const provider = text.match(/^\s*provider:\s*"?([^"\n]+?)"?\s*$/im)
  const model = text.match(/^\s*model:\s*"?([^"\n]+?)"?\s*$/im)
  if (!provider && !model) return null
  return { provider: provider?.[1]?.trim() ?? null, model: model?.[1]?.trim() ?? null, bestEffort: true }
}

/**
 * The same identity, read straight out of the overlay when the dump is unhelpful.
 * @param {string} text - the overlay YAML.
 * @returns {{provider: string|null, model: string|null, bestEffort: boolean}|null} the identity.
 */
function modelFromOverlay(text) {
  const provider = text.match(/^\s*provider:\s*"?([^"\n]+?)"?\s*$/im)?.[1]?.trim()
  const model = text.match(/^\s*model:\s*"?([^"\n]+?)"?\s*$/im)?.[1]?.trim()
  if (!provider || !model) return null
  return { provider, model, bestEffort: true }
}

/**
 * Check that the credentials the overlay names actually exist, without printing them.
 * @param {string} overlayText - the overlay YAML.
 * @param {string} home - the DSH_HOME in play.
 * @param {string[]} warnings - the preflight warning sink.
 * @param {{info: Function, detail: Function, warn: Function}} [log] - the narration sink.
 * @returns {void}
 */
function checkCredentials(overlayText, home, warnings, log = createLogger()) {
  const names = [...overlayText.matchAll(/^\s*apiKeyEnv:\s*(\S+)\s*$/gmi)].map((match) => match[1])
  if (names.length === 0) return
  const credentialsFile = path.join(home, '.credentials.yaml')
  const credentials = fs.existsSync(credentialsFile) ? fs.readFileSync(credentialsFile, 'utf8') : ''
  for (const name of new Set(names)) {
    const inEnv = typeof process.env[name] === 'string' && process.env[name] !== ''
    const inFile = credentials.split(/\r?\n/).some((line) => line.trim().startsWith(`${name}:`) && line.split(':').slice(1).join(':').trim() !== '')
    if (inEnv || inFile) log.info(`preflight: credential "${name}" resolves from ${inEnv ? `the environment (${process.env[name].length} chars, never printed)` : `${credentialsFile}`} — the server still has to accept it`)
    if (!inEnv && !inFile) {
      // `apiKeyEnv` is a credential *reference*: dsh resolves the name from the
      // credentials store first, then from the launch environment. There is no
      // literal-key field on this profile, so a key written in its place can never
      // resolve — say so, and name the references that already exist locally.
      const looksLikeAKey = /^(sk-|key-|pat-|ghp_|xox)/i.test(name) || name.length > 24
      const available = [...new Set([...credentials.matchAll(/^\s{1,}([A-Z][A-Z0-9_]{2,}):\s*\S/gm)].map((match) => match[1]))]
      throw new Error(
        `preflight: the overlay names credential "${name}" but neither the environment nor ${credentialsFile} provides it (PLAN §5.1). `
        + (looksLikeAKey
          ? 'Note that "apiKeyEnv" must be an environment variable NAME (e.g. BENCH_SERVER_API_KEY), not the key itself: name the variable here and set its value outside any repo file. '
          : '')
        + `Pick one: (a) "setx ${name} ..." and then open a NEW terminal (setx does not reach the one you are typing in), `
        + `(b) set it for this session only - PowerShell: $env:${name}="...", POSIX: export ${name}=... - `
        + (available.length > 0
          ? `or (c) point "apiKeyEnv" at a reference ${credentialsFile} already has: ${available.slice(0, 6).join(', ')}.`
          : `or (c) store ${name} through the dsh credentials service (the Models page writes it).`),
      )
    }
    if (!inEnv && inFile && process.platform !== 'win32') {
      const mode = fs.statSync(credentialsFile).mode & 0o777
      if (mode !== 0o600) warnings.push(`${credentialsFile} is mode ${mode.toString(8)}; dsh requires 600 on POSIX`)
    }
  }
}

/**
 * One task × one repeat, from fixture to metrics document.
 * @param {object} task - the validated task.
 * @param {number} repeatIndex - the repeat number.
 * @param {Options} options - the parsed options.
 * @param {Preflight} setup - the preflight result.
 * @param {object} out - the run directory layout.
 * @param {number} position - the 1-based position for the progress line.
 * @param {number} total - the number of runs in the sweep.
 * @param {{info: Function, detail: Function, warn: Function}} [log] - the narration sink.
 * @returns {Promise<object>} the metrics document.
 */
async function runOnce(task, repeatIndex, options, setup, out, position, total, log = createLogger(), interrupt = { stopped: false, child: null }) {
  const observer = createObserver({
    // The observer speaks in levels; the runner's sink is an object of methods.
    log: (level, text) => (typeof log === 'function' ? log(level, text) : (log[level] ?? log.info)(text)),
    run: { taskId: task.id, repeatIndex, position, total },
    verbose: options.verbose,
    heartbeatMs: options.heartbeatMs,
    stallMs: options.stallMs,
  })
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ops-bench-${task.id}-r${repeatIndex}-`))
  observer.note('info', `[${position}/${total}] building the ${task.fixture.generator} fixture (${task.title})`)
  const fixture = generate(task.fixture.generator, task.fixture.params ?? {})
  for (const file of fixture.files) {
    const target = path.join(workspace, ...file.path.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content, 'utf8')
  }
  observer.note('detail', `workspace ${workspace} — ${fixture.files.length} fixture file(s) written`)

  const timeoutMs = options.timeout ?? task.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const args = setup.entry.kind === 'js' ? [setup.entry.file] : []
  args.push('--profile', options.profile)
  if (setup.llmPatch) args.push('--patch', setup.llmPatch)
  args.push('--json', task.prompt)
  const command = setup.entry.kind === 'js' ? process.execPath : setup.entry.file

  const eventsFile = path.join(out.results, `${task.id}-r${repeatIndex}.events.ndjson`)
  const stderrFile = path.join(out.results, `${task.id}-r${repeatIndex}.stderr.log`)
  const eventsWriter = fs.createWriteStream(eventsFile)
  const stderrWriter = fs.createWriteStream(stderrFile)
  const aggregator = createAggregator({ label: options.label, profile: options.profile, taskId: task.id, repeatIndex })

  const startedAt = new Date().toISOString()
  const started = Date.now()
  let timedOut = false
  let spawnError = null
  const child = spawn(command, args, {
    cwd: workspace,
    env: childEnv(options),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  // The operator's Ctrl-C lands on the runner, not on the child: without handing the
  // child over, dsh would keep talking to the model behind a dead console. main() kills
  // the tree, this run ends, and the archive is still written from what completed.
  interrupt.child = child
  interrupt.pid = child.pid ?? null
  observer.started({
    command,
    args,
    cwd: workspace,
    pid: child.pid ?? null,
    timeoutMs,
    prompt: task.prompt,
    model: setup.model,
    eventsFile: path.relative(out.dir, eventsFile).replace(/\\/g, '/'),
    stderrFile: path.relative(out.dir, stderrFile).replace(/\\/g, '/'),
  })
  child.once('error', (error) => {
    spawnError = error
    stderrWriter.write(`\nspawn failed: ${String(error?.stack ?? error)}\n`)
    observer.note('warn', `the child could not start: ${String(error?.code ?? '')} ${String(error?.message ?? error)}`)
  })
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    aggregator.push(line)
    eventsWriter.write(`${line}\n`)
    observer.line(line)
  })
  child.stderr.on('data', (chunk) => {
    stderrWriter.write(chunk)
    observer.stderr(chunk)
  })
  // The interface's own "close" is the barrier: the last buffered events must be
  // folded into the metrics before we measure them, and they arrive after the
  // child has already exited.
  const streamClosed = new Promise((resolve) => lines.once('close', resolve))

  const killer = setTimeout(() => {
    timedOut = true
    observer.note('warn', `deadline of ${Math.round(timeoutMs / 1000)}s reached — killing the child and its tree (pid ${child.pid ?? '?'})`)
    killTree(child)
    stderrWriter.write(`\nrunner: killed after ${timeoutMs} ms timeout\n`)
  }, timeoutMs)

  const exitCode = await new Promise((resolve) => {
    child.once('close', (code) => resolve(code))
  })
  clearTimeout(killer)
  const interrupted = Boolean(interrupt.stopped)
  interrupt.child = null
  await streamClosed
  if (timedOut || interrupted) await new Promise((resolve) => setTimeout(resolve, 250))
  stderrWriter.write(`\nrunner: exit=${timedOut ? 'timeout' : interrupted ? 'interrupted' : exitCode} duration=${Date.now() - started}ms\n`)
  await Promise.all([endStream(eventsWriter), endStream(stderrWriter)])

  observer.finished({
    exitCode,
    timedOut,
    interrupted,
    spawnError: spawnError ? String(spawnError.message ?? spawnError) : null,
    timeoutMs,
  })
  observer.note('info', `verifying the workspace against ${task.verify.length} check(s) …`)

  const verify = await verifyWorkspace(workspace, task.verify, fixture.exports, { execPath: process.execPath })
  const live = observer.snapshot()
  const metrics = {
    ...aggregator.finish(),
    startedAt,
    durationMs: Date.now() - started,
    exitCode: timedOut ? null : exitCode,
    timedOut,
    interrupted,
    spawnError: spawnError ? String(spawnError.message ?? spawnError) : null,
    timeoutMs,
    workspace,
    verify,
    liveNarration: live,
    eventsFile: path.relative(out.dir, eventsFile).replace(/\\/g, '/'),
    stderrFile: path.relative(out.dir, stderrFile).replace(/\\/g, '/'),
  }
  fs.writeFileSync(path.join(out.results, `${task.id}-r${repeatIndex}.metrics.json`), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8')

  if (options.keep) {
    log.info(`  kept workspace: ${workspace}`)
  } else {
    removeTree(workspace)
  }
  console.log(`[${position}/${total}] ${formatProgress(task, repeatIndex, metrics)}`)
  return metrics
}

/**
 * The metrics document for a run the **runner** could not complete — a fixture that
 * could not be written, a verifier that threw. It is recorded as a failed run rather
 * than aborting the sweep, because a sweep is a measurement of the whole corpus and
 * one broken row must not erase the fifteen good ones.
 * @param {unknown} error - what the runner threw.
 * @param {object} task - the task.
 * @param {number} repeatIndex - the repeat number.
 * @param {number} position - the 1-based position in the sweep.
 * @param {number} total - the number of runs in the sweep.
 * @param {Options} options - the parsed options.
 * @param {{info: Function, detail: Function, warn: Function}} log - the narration sink.
 * @returns {object} a metrics document in the §4.4 shape.
 */
function runnerErrorMetrics(error, task, repeatIndex, position, total, options, log) {
  log.warn(`[${position}/${total}] ${task.id} r${repeatIndex}: runner error: ${String(error?.stack ?? error)}`)
  return {
    format: 'dsh-ops-bench-metrics-v1',
    label: options.label,
    profile: options.profile,
    taskId: task.id,
    repeatIndex,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    exitCode: null,
    timedOut: false,
    runnerError: String(error?.message ?? error),
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, grandTotal: 0 },
    usageReported: false,
    prompt: { reported: false, firstStep: null, median: null, max: null, total: null, perTurn: [] },
    steps: 0,
    stepsWithUsage: 0,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolCallsByName: {},
    textChars: 0,
    thinkingChars: 0,
    finalTextBytes: 0,
    eventCount: 0,
    malformedLines: 0,
    errorEvents: [],
    verify: { passed: false, checks: [{ type: 'runner', passed: false, detail: String(error?.message ?? error).slice(0, 200) }] },
  }
}

/**
 * Flush and close a write stream.
 * @param {import('node:fs').WriteStream} stream - the stream.
 * @returns {Promise<void>} resolves once the data is on disk.
 */
function endStream(stream) {
  return new Promise((resolve) => {
    if (stream.writableEnded || stream.destroyed) {
      resolve()
      return
    }
    stream.end(() => resolve())
  })
}

/**
 * Kill a child and everything it spawned.
 * @param {import('node:child_process').ChildProcess} child - the process.
 * @returns {void}
 */
function killTree(child) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {}
}

/**
 * Delete a tree, retrying the momentary locks Windows leaves behind.
 * @param {string} dir - the directory.
 * @returns {void}
 */
function removeTree(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'EBUSY' && error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') return
      const until = Date.now() + 200 * (attempt + 1)
      while (Date.now() < until) {
        try {
          spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], { stdio: 'ignore', timeout: 5000 })
        } catch {}
      }
    }
  }
}

/**
 * The single progress line per run.
 * @param {object} task - the task.
 * @param {number} repeatIndex - the repeat number.
 * @param {object} metrics - the finished metrics.
 * @returns {string} the line.
 */
function formatProgress(task, repeatIndex, metrics) {
  const tokens = metrics.usageReported ? `${formatNumber(metrics.usage.inputTokens)} in/${formatNumber(metrics.usage.outputTokens)} out` : 'usage n/a'
  const exit = metrics.timedOut ? 'TIMEOUT' : metrics.interrupted ? 'STOPPED' : metrics.exitCode ?? 'n/a'
  return `${task.id} r${repeatIndex}: exit=${exit} steps=${metrics.steps} tokens=${tokens} verify=${metrics.verify.passed ? 'PASS' : 'FAIL'} ${Math.round(metrics.durationMs / 1000)}s`
}

/**
 * The output layout of one run directory.
 * @typedef {object} OutDirs
 * @property {string} dir - the run root.
 * @property {string} results - where per-run artifacts go.
 * @property {string|null} folder - the group directory it was filed under, or null
 *   when `--out` named the directory outright.
 */

/**
 * The group directory a run lands in when nobody names one: **today's date**, as
 * `YYYY-MM-DD` in the machine's local time. The stamp inside the run directory stays
 * UTC — this is the shelf a human browses, and "the 16th's runs" is what the person
 * typing the command means, not what `toISOString()` means at 00:30.
 * @param {Date} [at] - the moment to name.
 * @returns {string} the folder name, always a safe single directory segment.
 */
export function defaultRunFolder(at = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * Create the run directory: `bench/runs/<folder>/<stamp>-<label>`.
 *
 * The folder is the group the run is filed under — an explicit `--folder`, or the
 * day's date when none was asked for. Both are created on demand and reused by every
 * later round, so a day's work sits in one directory instead of piling up flat in
 * `bench/runs/`. `--out` names the directory outright and opts out of grouping.
 * @param {Options} options - the parsed options.
 * @param {string} [runsDir] - the runs root override (defaults to bench/runs).
 * @param {Date} [at] - the moment of the run (the stamp and the default folder).
 * @returns {OutDirs} the layout.
 */
export function prepareOut(options, runsDir = RUNS_DIR, at = new Date()) {
  const stamp = `${at.toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z`
  const folder = options.out ? null : options.folder ?? defaultRunFolder(at)
  const defaultDir = folder
    ? path.join(runsDir, folder, `${stamp}-${options.label}`)
    : path.join(runsDir, `${stamp}-${options.label}`)
  const dir = path.resolve(options.out ?? defaultDir)
  const results = path.join(dir, 'results')
  fs.mkdirSync(results, { recursive: true })
  return { dir, results, folder }
}

/**
 * The recorded node identities: the runner's own node and the node on PATH.
 *
 * The PATH node matters because that is the one the model reaches when a task tells
 * it to run `node test.js`, while verify runs on the runner's own executable (§10.6).
 * When both resolve to the same file the version is known without spawning.
 * @returns {{node: string, pathNode: string|null, pathNodeFile: string|null}} both versions.
 */
function nodeVersions() {
  const pathNodeFile = findOnPath('node')
  if (!pathNodeFile) return { node: process.version, pathNode: null, pathNodeFile: null }
  if (sameFile(pathNodeFile, process.execPath)) return { node: process.version, pathNode: process.version, pathNodeFile }
  const probe = runCapture(pathNodeFile, ['--version'])
  return { node: process.version, pathNode: probe?.status === 0 ? probe.stdout.trim() : null, pathNodeFile }
}

/**
 * Do two paths name the same file?
 * @param {string} left - a path.
 * @param {string} right - another path.
 * @returns {boolean} true when both resolve to one file.
 */
function sameFile(left, right) {
  const real = (file) => {
    try {
      return fs.realpathSync(file)
    } catch {
      return path.resolve(file)
    }
  }
  const a = real(left)
  const b = real(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Write the human-facing one-run report.
 * @param {object} summary - the summary document.
 * @param {string} file - where to write it.
 * @returns {void}
 */
function writeReport(summary, file) {
  const rows = summary.taskIds.map((id) => {
    const runs = summary.results.filter((metrics) => metrics.taskId === id)
    const totals = runs.map((metrics) => metrics.usage?.grandTotal ?? 0)
    const steps = runs.map((metrics) => metrics.steps)
    const tools = runs.map((metrics) => metrics.toolCalls)
    const errors = runs.map((metrics) => metrics.toolErrors)
    const passed = runs.filter((metrics) => metrics.verify?.passed).length
    const usageOk = runs.length > 0 && runs.every((metrics) => metrics.usageReported)
    return `| ${id} | ${usageOk ? formatNumber(median(totals)) : 'n/a'} | ${formatNumber(median(steps))} | ${formatNumber(median(tools))} | ${formatNumber(median(errors))} | ${passed}/${runs.length} |`
  })
  // The per-tool breakdown is a count question, not a median one: a tool called
  // once in one repeat is adoption evidence, and a median over the repeats would
  // round it away. Sum every archived run and sort by volume so the tools a sweep
  // actually leans on come first (the shape the test03 retro reads).
  const toolTotals = new Map()
  for (const metrics of summary.results) {
    for (const [name, count] of Object.entries(metrics.toolCallsByName ?? {})) {
      if (typeof count !== 'number' || !Number.isFinite(count)) continue
      toolTotals.set(name, (toolTotals.get(name) ?? 0) + count)
    }
  }
  const toolTable = toolTotals.size > 0
    ? [
      '| tool | calls |',
      '|------|-------|',
      ...[...toolTotals.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([name, count]) => `| ${name} | ${formatNumber(count)} |`),
    ].join('\n')
    : 'Skipped: the archived runs recorded no `toolCallsByName` breakdown.'
  const incomplete = summary.results.filter((metrics) => !metrics.usageReported).map((metrics) => `${metrics.taskId} r${metrics.repeatIndex}`)
  const header = incomplete.length > 0
    ? `> **usage incomplete**: ${incomplete.length} of ${summary.results.length} run(s) lost a \`step_end.usage\`, so token totals here are lower bounds and \`compare.mjs\` will refuse a token verdict. Check that the server reports usage with \`stream_options.include_usage\` (PLAN §2.6).\n\n`
    : ''
  const spawnFailures = summary.results.filter((metrics) => metrics.timedOut || metrics.interrupted || metrics.spawnError || metrics.runnerError)
  const stoppedNote = summary.stoppedEarly
    ? `> **stopped early**: the operator interrupted this sweep after ${summary.completedRuns ?? summary.results.length} of ${summary.plannedRuns ?? '?'} planned run(s). The medians below are over a smaller sample than the plan asked for.\n\n`
    : ''
  const text = `# bench run ${summary.label} (${summary.profile})

${stoppedNote}${header}\`\`\`
label        ${summary.label}
profile      ${summary.profile}
dsh entry    ${summary.dshEntry}${summary.dshVersion ? ` (v${summary.dshVersion})` : ''}
overlay      ${summary.llmPatch ?? '(none injected)'}
model        ${summary.model.provider ?? '?'} / ${summary.model.model ?? '?'} (best effort)
platform     ${summary.platform.os}/${summary.platform.arch}
node         ${summary.platform.node} (runner) / ${summary.platform.pathNode ?? '?'} (PATH)
repeat       ${summary.repeat}${summary.taskRepeats ? ` (per task: ${Object.entries(summary.taskRepeats).map(([id, n]) => `${id}:${n}`).join(' ')})` : ''}
window       ${summary.startedAt} -> ${summary.finishedAt}
usage        ${summary.totals.usageComplete ? 'complete' : 'INCOMPLETE'}
grand total  ${summary.totals.usageComplete ? formatNumber(summary.totals.grandTotal) : 'n/a'} tokens
steps        ${summary.totals.steps}   tool calls ${summary.totals.toolCalls}   tool errors ${summary.totals.toolErrors}
verify       ${summary.totals.passed} passed / ${summary.totals.failed} failed
\`\`\`

| task | tokens (median) | steps | tool calls | tool errors | pass |
|------|-----------------|-------|------------|-------------|------|
${rows.join('\n')}

## Tool calls (summed over every run)

${toolTable}

${spawnFailures.length > 0 ? `## Runs that did not finish cleanly\n\n${spawnFailures.map((metrics) => `- \`${metrics.taskId} r${metrics.repeatIndex}\`: ${metrics.timedOut ? `timeout after ${metrics.timeoutMs} ms` : metrics.interrupted ? 'stopped by the operator (Ctrl-C); the child and its tree were killed' : metrics.runnerError ? `runner error: ${metrics.runnerError}` : `spawn error: ${metrics.spawnError}`}`).join('\n')}\n\n` : ''}`
  fs.writeFileSync(file, text, 'utf8')
}

/**
 * Assemble the summary document from the metrics list.
 * @param {Options} options - the parsed options.
 * @param {Preflight} setup - the preflight result.
 * @param {object[]} results - the metrics documents.
 * @param {{startedAt: string, finishedAt: string, taskIds: string[]}} window - the sweep window.
 * @returns {object} the summary.
 */
export function buildSummary(options, setup, results, window) {
  const platform = { os: process.platform, arch: process.arch }
  const nodes = nodeVersions()
  const totals = results.reduce((acc, metrics) => {
    acc.grandTotal += metrics.usage?.grandTotal ?? 0
    acc.steps += metrics.steps
    acc.toolCalls += metrics.toolCalls
    acc.toolErrors += metrics.toolErrors
    if (metrics.verify?.passed) acc.passed += 1
    else acc.failed += 1
    return acc
  }, { grandTotal: 0, steps: 0, toolCalls: 0, toolErrors: 0, passed: 0, failed: 0 })
  return {
    format: 'dsh-ops-bench-summary-v1',
    label: options.label,
    folder: options.folder ?? null,
    profile: options.profile,
    dshEntry: setup.entry.file,
    dshVersion: setup.entry.version,
    llmPatch: setup.llmPatch ? path.relative(REPO_ROOT, setup.llmPatch).replace(/\\/g, '/') : null,
    model: setup.model,
    platform: { ...platform, node: `v${nodes.node.replace(/^v/, '')}`, pathNode: nodes.pathNode },
    startedAt: window.startedAt,
    finishedAt: window.finishedAt,
    repeat: options.repeat,
    // The per-task budgets the sweep actually used (tiered sampling), when they exist.
    taskRepeats: window.taskRepeats ?? null,
    taskIds: window.taskIds,
    // A sweep the operator stopped is a partial measurement, and `compare.mjs` reads
    // medians: say so in the document instead of letting four runs impersonate twelve.
    plannedRuns: window.plannedRuns ?? results.length,
    completedRuns: results.length,
    stoppedEarly: Boolean(window.stoppedEarly),
    results,
    totals: { ...totals, usageComplete: results.length > 0 && results.every((metrics) => metrics.usageReported) },
  }
}

/**
 * The `--dry-run` self-check: build each fixture, run its checks against a workspace
 * nothing has touched yet, and insist that every check behaves the way its kind
 * demands (PLAN §5.1). It catches the corpus mistakes that would otherwise waste a
 * whole sweep: a check that passes on an empty workspace verifies nothing, and a
 * guard that fails there can never pass later.
 *
 * Two kinds are expected to pass untouched: `fileMissing` (there is nothing there to
 * be absent) and any check marked `invariant: true`, which is an anti-tamper guard on
 * a fixture file — `gate-repair-loop`'s "check.js was not edited" guard is exactly
 * that, and it is the reason the corpus needs this distinction rather than a blanket
 * rule.
 * @param {object[]} tasks - the selected tasks.
 * @param {Options} options - the parsed options.
 * @returns {Promise<boolean>} true when every task self-checked.
 */
export async function dryRun(tasks, options) {
  let ok = true
  for (const task of tasks) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ops-bench-dry-${task.id}-`))
    try {
      const fixture = generate(task.fixture.generator, task.fixture.params ?? {})
      for (const file of fixture.files) {
        const target = path.join(workspace, ...file.path.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, file.content, 'utf8')
      }
      const verdict = await verifyWorkspace(workspace, task.verify, fixture.exports, { execPath: process.execPath })
      verdict.checks.forEach((result, index) => {
        const descriptor = task.verify[index] ?? {}
        const expectPass = result.type === 'fileMissing' || descriptor.invariant === true
        const label = expectPass ? 'guard' : 'answer'
        if (result.passed === expectPass) return
        ok = false
        console.error(`dry-run FAIL ${task.id}: ${label} check "${result.type}" ${result.passed ? 'passed' : 'failed'} on an untouched workspace (${result.detail})`)
      })
      const fixtureBytes = fixture.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0)
      console.log(`dry-run ${task.id}: ${fixture.files.length} file(s), ${formatNumber(fixtureBytes)} bytes, exports [${Object.keys(fixture.exports).sort().join(', ')}], ${verdict.checks.length} check(s) behaved as expected`)
    } finally {
      if (options.keep) console.log(`  kept workspace: ${workspace}`)
      else removeTree(workspace)
    }
  }
  console.log(ok ? 'dry-run: corpus self-check OK' : 'dry-run: corpus self-check FAILED')
  return ok
}

/**
 * The effective repeat budget per task: an explicit `--repeat` rules over the whole
 * sweep (that is what a smoke run and a CI gate expect), otherwise each task's own
 * `"repeat"` field wins over the global default. Tiering this way lets the cheap
 * tasks earn their samples without taxing the expensive ones.
 * @param {object[]} tasks - the selected tasks.
 * @param {Options} options - the parsed options.
 * @returns {Record<string, number>} the budget keyed by task id.
 */
export function repeatsById(tasks, options) {
  const map = {}
  for (const task of tasks) {
    map[task.id] = options.repeatExplicit ? options.repeat : (task.repeat ?? options.repeat)
  }
  return map
}

/**
 * The runner's main.
 * @param {string[]} argv - the arguments after the script name.
 * @returns {Promise<number>} the process exit code.
 */
export async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`${USAGE}\n\nrun: ${String(error?.message ?? error)}`)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  let tasks
  try {
    tasks = selectTasks(loadTasks(TASKS_DIR), options.taskIds)
  } catch (error) {
    console.error(`run: ${String(error?.message ?? error)}`)
    return 2
  }

  if (options.list) {
    const budgets = repeatsById(tasks, options)
    for (const task of tasks) {
      console.log(`${task.id}\t${task.fixture.generator}\t${task.verify.length} check(s)\t${task.timeoutMs} ms\trepeat ${budgets[task.id]}${task.repeat !== undefined && !options.repeatExplicit ? ' (task)' : ''}\t${task.title}`)
    }
    console.log(`\n${tasks.length} task(s) from ${TASKS_DIR}`)
    return 0
  }
  if (options.dryRun) return (await dryRun(tasks, options)) ? 0 : 1

  let setup
  const log = createLogger({ verbose: options.verbose })
  try {
    setup = await preflight(options, log)
  } catch (error) {
    console.error(`preflight failed: ${String(error?.message ?? error)}`)
    return 1
  }
  // Buffered until the run directory exists, so the warnings also land in runner.log.
  for (const warning of setup.warnings) log.warn(`preflight warning: ${warning}`)
  if (options.preflightOnly) {
    // The cheapest honest answer to "will this machine and this profile work at all":
    // everything preflight knows, with no task spawned, no run directory and no token.
    log.info(`preflight-only: no task was spawned and no token was spent. profile "${options.profile}" → provider ${setup.model.provider ?? '?'} / model ${setup.model.model ?? '?'}, overlay ${setup.llmPatch ?? '(none)'}, home ${setup.home}`)
    log.info('preflight-only: to smoke one real task anyway, use the bench:baseline --task example in bench/README.md §2')
    return 0
  }
  // The run directory is created only once the machine is known to be able to do
  // the run: a failed preflight should not litter bench/runs with empty archives.
  // It is filed under a group directory — the `--folder` the operator asked for, or
  // the day's date when nobody did; `--out` is the escape hatch that names
  // a directory outright and steps out of the layout, and then there is no group.
  const requestedFolder = options.folder
  const out = prepareOut(options)
  // From here the archive records the group the run *actually* landed in, so that
  // summary.json and the "compare it with" line agree with the path on disk.
  options.folder = out.folder
  const runnerLog = log.attach(out.dir)
  log.info(`narration also goes to ${runnerLog} — it survives scrolling away, and Ctrl-C`)
  if (setup.dump) fs.writeFileSync(path.join(out.dir, 'dump-config.txt'), setup.dump, 'utf8')

  const nodes = nodeVersions()
  const budgets = repeatsById(tasks, options)
  const plannedRuns = tasks.reduce((sum, task) => sum + budgets[task.id], 0)
  fs.writeFileSync(path.join(out.dir, 'meta.json'), `${JSON.stringify({
    label: options.label,
    folder: options.folder ?? null,
    profile: options.profile,
    dshEntry: setup.entry.file,
    dshEntryKind: setup.entry.kind,
    dshVersion: setup.entry.version,
    dshEntryNotes: setup.entry.notes,
    dshHome: setup.home,
    isolatedHome: Boolean(options.dshHome),
    llmPatch: setup.llmPatch,
    model: setup.model,
    argv,
    platform: { os: process.platform, arch: process.arch, node: nodes.node, pathNode: nodes.pathNode },
    repeat: options.repeat,
    repeatExplicit: options.repeatExplicit,
    taskRepeats: budgets,
    plannedRuns,
    taskIds: tasks.map((task) => task.id),
    preflightWarnings: setup.warnings,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    narration: {
      verbose: options.verbose,
      heartbeatMs: options.heartbeatMs,
      stallMs: options.stallMs,
      endpointProbe: options.probeEndpoint ? 'on' : 'off',
      endpoints: setup.endpoints ?? [],
      runnerLog: path.relative(out.dir, runnerLog).replace(/\\/g, '/'),
    },
  }, null, 2)}\n`, 'utf8')

  log.info(`bench run "${options.label}" on profile "${options.profile}" via ${setup.entry.file}${setup.entry.version ? ` v${setup.entry.version}` : ''}`)
  log.info(`overlay ${setup.llmPatch ?? '(none)'}`)
  log.info(`out     ${out.dir}`)
  if (out.folder) log.info(`group   bench/runs/${out.folder} — ${requestedFolder ? 'the --folder asked for' : "today's date, since no --folder was given (pass one to name the round)"}`)
  const budgetText = tasks.map((task) => `${task.id}:${budgets[task.id]}`).join(' ')
  log.info(`${tasks.length} task(s) = ${plannedRuns} run(s), serially. ${options.repeatExplicit ? `Explicit --repeat ${options.repeat} overrode every per-task budget.` : `Per-task repeat budgets (corpus tiers): ${budgetText}. Add --repeat to force one number for all.`} ${options.verbose ? '--verbose: every event line.' : `Milestones only — add --verbose for every step, tool call and stderr line. Heartbeat ${options.heartbeatMs > 0 ? `every ${Math.round(options.heartbeatMs / 1000)}s` : 'off'}, stall warning after ${Math.round(options.stallMs / 1000)}s of silence.`}`)

  const startedAt = new Date().toISOString()
  const results = []
  const plan = []
  const maxRepeat = Math.max(...tasks.map((task) => budgets[task.id]))
  for (let repeat = 0; repeat < maxRepeat; repeat += 1) {
    for (const task of tasks) if (repeat < budgets[task.id]) plan.push({ task, repeat })
  }
  const total = plan.length
  let position = 0
  // Ctrl-C is a thing a human does to a benchmark that appears to hang, so it gets the
  // same treatment as a timeout: the dsh tree is killed instead of being orphaned, the
  // sweep stops, and the archive is still written from the runs that did finish. A
  // second SIGINT quits immediately, with whatever had already reached the disk.
  const interrupt = { stopped: false, child: null, pid: null }
  const onSignal = (signal) => {
    if (interrupt.stopped) {
      log.warn(`${signal} again — quitting without the summary. ${out.dir} keeps the narration and the archives written so far.`)
      process.exit(1)
    }
    interrupt.stopped = true
    if (interrupt.child) {
      log.warn(`${signal}: killing the dsh child (pid ${interrupt.pid ?? '?'}) and its tree, then writing the archive from the ${results.length}/${total} run(s) that finished. Send ${signal} once more to quit immediately.`)
      killTree(interrupt.child)
    } else {
      log.warn(`${signal}: stopping after the current run and writing the archive from the ${results.length}/${total} run(s) done so far.`)
    }
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  for (const entry of plan) {
    if (interrupt.stopped) break
    const { task, repeat } = entry
    position += 1
    try {
      results.push(await runOnce(task, repeat, options, setup, out, position, total, log, interrupt))
    } catch (error) {
      results.push(runnerErrorMetrics(error, task, repeat, position, total, options, log))
    }
    if (options.sleepMs > 0 && position < total) {
      log.detail(`sleeping ${formatClock(options.sleepMs)} before the next run …`)
      await new Promise((resolve) => setTimeout(resolve, options.sleepMs))
    }
  }
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)

  const summary = buildSummary(options, setup, results, {
    startedAt,
    finishedAt: new Date().toISOString(),
    taskIds: tasks.map((task) => task.id),
    taskRepeats: budgets,
    plannedRuns: total,
    stoppedEarly: interrupt.stopped,
  })
  fs.writeFileSync(path.join(out.dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeReport(summary, path.join(out.dir, 'report.md'))

  if (!summary.totals.usageComplete) {
    log.warn('usage was NOT reported for every step: token totals here are lower bounds, and compare.mjs refuses a token verdict until the server reports usage (PLAN §2.6).')
  }
  const crashed = results.filter((metrics) => metrics.timedOut || metrics.interrupted || metrics.spawnError || metrics.runnerError)
  const timeouts = results.filter((metrics) => metrics.timedOut).length
  const neverBooted = crashed.filter((metrics) => metrics.eventCount === 0).length
  log.info(`verdict ${options.label}: ${summary.totals.passed}/${results.length} verify passes, ${formatNumber(summary.totals.grandTotal)} tokens, usage ${summary.totals.usageComplete ? 'complete' : 'INCOMPLETE'}, ${timeouts} timeout(s), ${crashed.length - timeouts} runner/spawn failure(s)`)
  if (summary.stoppedEarly) {
    log.warn(`STOPPED by the operator after ${results.length}/${summary.plannedRuns} run(s). The archive above is written and readable, but it is a partial sweep: compare.mjs would be comparing medians over fewer runs than the plan asked for.`)
  }
  if (neverBooted > 0) {
    log.warn(`${neverBooted} run(s) produced not one event: dsh never started printing them. Look at startup, not at the model — profile, plugin install, PSModulePath (README §1), or the launcher path in meta.json.`)
  }
  if (crashed.length > 0) log.warn(`${crashed.length} run(s) did not finish cleanly (see report.md and the per-run .stderr.log)`)
  log.info(`artifacts: ${out.dir} (report.md, summary.json, meta.json, results/, runner.log)`)
  log.info(`compare it with: node bench/compare.mjs <base-label> ${options.label}${options.folder ? ` --folder ${options.folder}` : ''}`)
  console.log(`\nwrote ${out.dir}: ${summary.totals.passed}/${results.length} verify passes, ${formatNumber(summary.totals.grandTotal)} tokens`)
  await log.close()
  return 0
}

/**
 * Let other modules import this file without running it; only direct execution starts a sweep.
 * @returns {void}
 */
async function run() {
  process.exitCode = await main(process.argv.slice(2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) await run()
