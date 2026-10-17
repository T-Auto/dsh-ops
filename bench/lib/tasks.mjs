/**
 * Task corpus loading and structure validation (PLAN.md §4.1).
 *
 * The corpus is the experiment, so its shape is checked before anything is
 * measured: a task that silently loses its `verify` list would score zero tokens
 * and zero failures and look like a win. Failures here are loud and say which file
 * and which field, because these JSON files are edited by hand.
 *
 * One constraint is inherited from dsh's headless launcher rather than invented
 * here: the task text is passed as a **single argv element that must not begin
 * with `-`**, because commander would parse it as an option (§2.1). Every prompt in
 * the corpus is English and machine-verifiable, and the prompt is the only thing
 * the model sees — the expected values stay on the harness side.
 *
 * @module dsh-ops/bench/tasks
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GENERATORS } from './fixtures.mjs'
import { CHECK_TYPES } from './verify.mjs'

/** The directory holding `*.task.json`, resolved from this module. */
export const TASKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tasks')

/** The default per-task deadline when a task does not set one. */
export const DEFAULT_TIMEOUT_MS = 900000

/** Fields every task file must carry. */
const REQUIRED_TEXT_FIELDS = ['id', 'title', 'prompt']

/** Which parameter each check type needs besides its expected value. */
const CHECK_LOCATION_FIELDS = {
  fileExists: 'path',
  fileMissing: 'path',
  fileEquals: 'path',
  fileContains: 'path',
  fileLines: 'path',
  countFiles: 'dir',
  contentHashes: 'dir',
  command: 'command',
}

/**
 * Load and validate every task in a directory, sorted by file name.
 * @param {string} [dir] - the corpus directory.
 * @returns {object[]} the validated tasks.
 */
export function loadTasks(dir = TASKS_DIR) {
  if (!fs.existsSync(dir)) throw new Error(`task directory not found: ${dir}`)
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.task.json')).sort()
  if (names.length === 0) throw new Error(`no *.task.json files in ${dir}`)
  return names.map((name) => validateTask(readTask(path.join(dir, name)), name))
}

/**
 * Read and parse one task file.
 * @param {string} file - the task JSON path.
 * @returns {object} the parsed task.
 */
export function readTask(file) {
  const text = fs.readFileSync(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${path.basename(file)}: not valid JSON (${error.message})`)
  }
}

/**
 * Validate one task and return it with defaults applied.
 * @param {object} task - the parsed task.
 * @param {string} [origin] - where it came from, for the error message.
 * @returns {object} the task with `timeoutMs` defaulted.
 */
export function validateTask(task, origin = 'task') {
  const fail = (message) => {
    throw new Error(`${origin}: ${message}`)
  }
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('task must be a JSON object')

  for (const field of REQUIRED_TEXT_FIELDS) {
    if (typeof task[field] !== 'string' || task[field].trim() === '') fail(`"${field}" must be a non-empty string`)
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(task.id)) fail(`"${task.id}" is not a slug-able id`)
  // The headless launcher parses a leading "-" as an option, not as the task (§2.1).
  if (task.prompt.startsWith('-')) fail('prompt must not start with "-" (the headless launcher would read it as an option)')
  if (task.prompt.startsWith(' ')) fail('prompt must not start with whitespace')
  if (task.prompt.includes('\0')) fail('prompt must not contain NUL')

  const fixture = task.fixture
  if (!fixture || typeof fixture !== 'object') fail('"fixture" must be an object')
  if (typeof fixture.generator !== 'string' || !Object.hasOwn(GENERATORS, fixture.generator)) {
    fail(`unknown fixture generator "${fixture.generator}" (known: ${Object.keys(GENERATORS).sort().join(', ')})`)
  }
  if (fixture.params !== undefined && (typeof fixture.params !== 'object' || fixture.params === null || Array.isArray(fixture.params))) {
    fail('"fixture.params" must be an object')
  }

  if (!Array.isArray(task.verify) || task.verify.length === 0) fail('"verify" must be a non-empty array')
  task.verify.forEach((check, index) => validateCheck(check, index, fail))

  const timeout = task.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeout) || timeout <= 0) fail(`"timeoutMs" must be a positive integer, got ${task.timeoutMs}`)
  // A task may carry its own repeat budget (tiered sweeps: cheap tasks sampled more
  // often than expensive ones). The runner's explicit `--repeat N` still overrides it.
  if (task.repeat !== undefined && (!Number.isInteger(task.repeat) || task.repeat <= 0)) {
    fail(`"repeat" must be a positive integer, got ${task.repeat}`)
  }

  return { ...task, timeoutMs: timeout }
}

/**
 * Validate one verify check descriptor.
 * @param {object} check - the descriptor.
 * @param {number} index - its position, for the message.
 * @param {(message: string) => void} fail - the reporting callback.
 * @returns {void}
 */
function validateCheck(check, index, fail) {
  if (!check || typeof check !== 'object') fail(`verify[${index}] must be an object`)
  if (!CHECK_TYPES.includes(check.type)) fail(`verify[${index}] has unknown check type "${check.type}" (known: ${CHECK_TYPES.join(', ')})`)
  const locationField = CHECK_LOCATION_FIELDS[check.type]
  if (locationField && (typeof check[locationField] !== 'string' || check[locationField] === '')) {
    fail(`verify[${index}] of type "${check.type}" needs a non-empty "${locationField}"`)
  }
  const expectations = ['expect', 'text', 'lines', 'count'].filter((key) => check[key] !== undefined)
  const needsValue = check.type !== 'fileExists' && check.type !== 'fileMissing' && check.type !== 'command'
  if (needsValue && expectations.length === 0) {
    fail(`verify[${index}] of type "${check.type}" needs one of "expect"/"text"/"lines"/"count"`)
  }
  if (expectations.length > 1) fail(`verify[${index}] sets more than one expectation: ${expectations.join(', ')}`)
  if (check.expect !== undefined && typeof check.expect !== 'string') fail(`verify[${index}] "expect" must name a fixture export key (a string)`)
  if (check.type === 'fileLines' && check.lines !== undefined && !Array.isArray(check.lines)) fail('verify fileLines "lines" must be an array')
  if (check.type === 'command' && check.args !== undefined && !Array.isArray(check.args)) fail('verify command "args" must be an array')
  if (check.type === 'command' && check.exitCode !== undefined && !Number.isInteger(check.exitCode)) fail('verify command "exitCode" must be an integer')
  // `invariant: true` marks a guard that must already hold before the task runs
  // (an anti-tamper check on a fixture file). `--dry-run` expects those to pass and
  // everything else to fail — see run.mjs.
  if (check.invariant !== undefined && typeof check.invariant !== 'boolean') fail(`verify[${index}] "invariant" must be a boolean`)
}

/**
 * Select tasks by id, preserving corpus order, and reject unknown ids.
 * @param {object[]} tasks - the loaded corpus.
 * @param {string[]} ids - the requested ids, empty for all of them.
 * @returns {object[]} the selection.
 */
export function selectTasks(tasks, ids = []) {
  if (!ids || ids.length === 0) return tasks
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new Error(`unknown task id(s): ${missing.join(', ')} (known: ${tasks.map((task) => task.id).join(', ')})`)
  }
  return ids.map((id) => byId.get(id))
}
