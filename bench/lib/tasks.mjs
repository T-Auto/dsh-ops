/**
 * Task corpus loading and structure validation.
 *
 * The corpus is the experiment, so its shape is checked before anything is measured:
 * a task that silently loses its `verify` list would score zero tokens and zero
 * failures and look like a win. Failures name the file and the field, because these
 * JSON files are edited by hand. Two constraints come from dsh's headless launcher:
 * the task text is one argv element that must not begin with `-`, and the prompt is
 * the only thing the model sees. Fixture generator and check-type names belong to
 * later slices and arrive as `registries`; left out, any non-empty slug is accepted.
 *
 * @module dsh-ops/bench/tasks
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The directory holding `*.task.json`. */
export const TASKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tasks')
/** The per-task deadline when a task does not set one: 15 min, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 900_000
/** The floor a `timeoutMs` may take (1000 ms): below it a task measures the killer, not the model. */
export const MIN_TIMEOUT_MS = 1_000
/** The ceiling a `timeoutMs` may take (86_400_000 ms = 24 h): above it a stuck sweep outlives its runner. */
export const MAX_TIMEOUT_MS = 86_400_000
/** The ceiling a `repeat` may take: a budget, so the evidence stays bounded and comparable. */
export const MAX_REPEAT = 100
/** Every field a task file may carry; anything else is a typo, not an extension. */
export const TASK_FIELDS = ['id', 'title', 'prompt', 'fixture', 'verify', 'repeat', 'timeoutMs']
/** Every field a `fixture` block may carry. */
export const FIXTURE_FIELDS = ['generator', 'params']
/** Every field a `verify` check may carry; which are required depends on `type`. */
export const CHECK_FIELDS = ['type', 'invariant', 'path', 'dir', 'command', 'args', 'exitCode', 'expect', 'text', 'lines', 'count']
/** The check types this repository ships (`bench/lib/verify.mjs` is the authority). */
export const KNOWN_CHECK_TYPES = ['fileExists', 'fileMissing', 'fileEquals', 'fileContains', 'fileLines', 'countFiles', 'contentHashes', 'command']

/** Which parameter each check type needs besides its expected value. */
const CHECK_LOCATION_FIELDS = {
  fileExists: 'path', fileMissing: 'path', fileEquals: 'path', fileContains: 'path', fileLines: 'path',
  countFiles: 'dir', contentHashes: 'dir', command: 'command',
}
/** The expectation keys a check may set, at most one of them. */
const CHECK_EXPECTATION_FIELDS = ['expect', 'text', 'lines', 'count']
/**
 * A registry argument as a Set: an array of names, a Set, or a `fixtures`-style name -> builder map.
 * @param {string[]|Set<string>|Record<string, unknown>} registry - the registry to read.
 * @returns {Set<string>} the known names.
 */
const asSet = (registry) => (registry instanceof Set ? registry : new Set(Array.isArray(registry) ? registry : Object.keys(registry)))

/**
 * Read and parse one task file, naming it when it cannot be read or parsed.
 * @param {string} file - the `*.task.json` path.
 * @returns {object} the parsed task (not yet validated).
 * @throws {Error} when the file cannot be read or is not valid JSON, naming the file.
 */
export function readTask(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`${path.basename(file)}: cannot be read (${error.message})`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${path.basename(file)}: not valid JSON (${error.message})`)
  }
}

/**
 * Load and validate every `*.task.json` in a directory, sorted by file name.
 * @param {string} [dir] - the corpus directory (default {@link TASKS_DIR}).
 * @param {{generators?: string[]|Set<string>|Record<string, unknown>, checkTypes?: string[]|Set<string>|Record<string, unknown>}} [registries] -
 *   the later slices' known generator and check-type names; left out, any non-empty slug passes.
 * @returns {object[]} the validated tasks, `timeoutMs` defaulted.
 * @throws {Error} when the directory is missing, holds no task file, or any file is invalid.
 */
export function loadTasks(dir = TASKS_DIR, registries = {}) {
  if (!fs.existsSync(dir)) throw new Error(`task directory not found: ${dir}`)
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.task.json')).sort()
  if (names.length === 0) throw new Error(`no *.task.json files in ${dir}`)
  return names.map((name) => validateTask(readTask(path.join(dir, name)), name, registries))
}

/**
 * Validate one task and return it with `timeoutMs` defaulted.
 * @param {object} task - the parsed task document.
 * @param {string} [origin] - the file name every failure message is prefixed with.
 * @param {{generators?: string[]|Set<string>|Record<string, unknown>, checkTypes?: string[]|Set<string>|Record<string, unknown>}} [registries] -
 *   the known generator and check-type names, when the later slices have landed.
 * @returns {object} a shallow copy of the task with `timeoutMs` resolved.
 * @throws {Error} on the first structural problem, naming the file and the field.
 */
export function validateTask(task, origin = 'task', registries = {}) {
  const fail = (message) => {
    throw new Error(`${origin}: ${message}`)
  }
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('task must be a JSON object')
  rejectUnknown(task, TASK_FIELDS, '', fail)
  for (const field of ['id', 'title', 'prompt']) {
    if (typeof task[field] !== 'string' || task[field].trim() === '') fail(`"${field}" must be a non-empty string`)
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(task.id)) fail(`"${task.id}" is not a slug-able id`)
  // The headless launcher parses a leading "-" as an option, not as the task.
  if (task.prompt.startsWith('-')) fail('prompt must not start with "-" (the headless launcher would read it as an option)')
  if (task.prompt.startsWith(' ')) fail('prompt must not start with whitespace')
  if (task.prompt.includes('\0')) fail('prompt must not contain NUL')

  const fixture = task.fixture
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) fail('"fixture" must be an object')
  rejectUnknown(fixture, FIXTURE_FIELDS, 'fixture ', fail)
  if (typeof fixture.generator !== 'string' || fixture.generator.trim() === '') fail('"fixture.generator" must be a non-empty string')
  if (registries.generators && !asSet(registries.generators).has(fixture.generator)) {
    fail(`unknown fixture generator "${fixture.generator}" (known: ${[...asSet(registries.generators)].sort().join(', ')})`)
  }
  if (fixture.params !== undefined && (!fixture.params || typeof fixture.params !== 'object' || Array.isArray(fixture.params))) {
    fail('"fixture.params" must be an object')
  }
  if (!Array.isArray(task.verify) || task.verify.length === 0) fail('"verify" must be a non-empty array')
  task.verify.forEach((check, index) => validateCheck(check, index, fail, registries))

  const timeout = task.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    fail(`"timeoutMs" must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms, got ${String(task.timeoutMs)}`)
  }
  // A task may carry its own repeat budget (tiered sweeps: cheap tasks sampled more
  // often than expensive ones). The runner's explicit `--repeat N` still overrides it.
  if (task.repeat !== undefined && (!Number.isInteger(task.repeat) || task.repeat <= 0 || task.repeat > MAX_REPEAT)) {
    fail(`"repeat" must be an integer between 1 and ${MAX_REPEAT}, got ${String(task.repeat)}`)
  }
  return { ...task, timeoutMs: timeout }
}

/**
 * Reject any field the allowlist does not know.
 * @param {object} value - the object to check.
 * @param {string[]} allowed - the fields it may carry.
 * @param {string} where - the message prefix naming the block (`''` or `fixture `).
 * @param {(message: string) => never} fail - the caller's raiser, so the file name is added once.
 * @returns {void}
 */
function rejectUnknown(value, allowed, where, fail) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    fail(`unknown ${where}field(s) ${unknown.map((key) => `"${key}"`).join(', ')} (known: ${allowed.join(', ')})`)
  }
}

/**
 * Validate one verify check descriptor.
 * @param {object} check - the check to validate.
 * @param {number} index - its position in `verify[]`, used in every message.
 * @param {(message: string) => never} fail - the caller's raiser, already prefixed with the file name.
 * @param {{generators?: string[]|Set<string>|Record<string, unknown>, checkTypes?: string[]|Set<string>|Record<string, unknown>}} registries - the registries `validateTask` received.
 * @returns {void}
 */
function validateCheck(check, index, fail, registries) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) fail(`verify[${index}] must be an object`)
  rejectUnknown(check, CHECK_FIELDS, '', (message) => fail(`verify[${index}] has ${message}`))
  const types = asSet(registries.checkTypes ?? KNOWN_CHECK_TYPES)
  if (!types.has(check.type)) fail(`verify[${index}] has unknown check type "${String(check.type)}" (known: ${[...types].sort().join(', ')})`)
  const locationField = CHECK_LOCATION_FIELDS[check.type]
  if (locationField && (typeof check[locationField] !== 'string' || check[locationField] === '')) {
    fail(`verify[${index}] of type "${check.type}" needs a non-empty "${locationField}"`)
  }
  const expectations = CHECK_EXPECTATION_FIELDS.filter((key) => check[key] !== undefined)
  const needsValue = check.type !== 'fileExists' && check.type !== 'fileMissing' && check.type !== 'command'
  if (needsValue && expectations.length === 0) {
    fail(`verify[${index}] of type "${check.type}" needs one of ${CHECK_EXPECTATION_FIELDS.map((key) => `"${key}"`).join('/')}`)
  }
  if (expectations.length > 1) fail(`verify[${index}] sets more than one expectation: ${expectations.join(', ')}`)
  if (check.text !== undefined && typeof check.text !== 'string') fail(`verify[${index}] "text" must be a string`)
  if (check.count !== undefined && !Number.isInteger(check.count)) fail(`verify[${index}] "count" must be an integer`)
  if (check.lines !== undefined && !Array.isArray(check.lines)) fail(`verify[${index}] "lines" must be an array`)
  if (check.args !== undefined && !Array.isArray(check.args)) fail(`verify[${index}] "args" must be an array`)
  if (check.exitCode !== undefined && !Number.isInteger(check.exitCode)) fail(`verify[${index}] "exitCode" must be an integer`)
  // `invariant: true` marks a guard that must hold before the task runs (an anti-tamper
  // check on a fixture file): `--dry-run` expects those to pass and everything else to fail.
  if (check.invariant !== undefined && typeof check.invariant !== 'boolean') fail(`verify[${index}] "invariant" must be a boolean`)
}

/**
 * Select tasks by id, preserving corpus order, and reject unknown ids.
 * @param {object[]} tasks - the loaded corpus.
 * @param {string[]} [ids] - the ids to keep; empty means the whole corpus.
 * @returns {object[]} the selected tasks, in corpus order.
 * @throws {Error} when an id is not in the corpus, naming every unknown one.
 */
export function selectTasks(tasks, ids = []) {
  if (!ids || ids.length === 0) return tasks
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) throw new Error(`unknown task id(s): ${missing.join(', ')} (known: ${tasks.map((task) => task.id).join(', ')})`)
  return ids.map((id) => byId.get(id))
}
