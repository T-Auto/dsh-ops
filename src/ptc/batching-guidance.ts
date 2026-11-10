/**
 * Repeated-write detection and the model-facing batch-call guidance it loads.
 *
 * The guidance text lives in an editable Markdown file (prompts/batching-guidance.md)
 * so wording changes never require a code change. The module imports no host
 * values, so a unit test can drive it with plain objects and a fake agent. The
 * caller owns delivery.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent } from '../adapter/dsh/types.js'

/** Identity of the guidance in the host message source. */
export const BATCHING_GUIDANCE_ID = 'batching-guidance'
/** Revision of the guidance text; bump it when the wording or the file format changes. */
export const BATCHING_GUIDANCE_REVISION = '3'

/** The shipped guidance file, resolved from this module's own location (src or lib). */
const DEFAULT_GUIDANCE_FILE = new URL('../../prompts/batching-guidance.md', import.meta.url)

/** Loaded text by absolute location; a failed load caches '' instead of retrying. */
const loaded = new Map<string, string>()
let warned = false

/** Report an unreadable guidance file once, never once per agent or call. */
function warnUnavailable(location: string, error: unknown): void {
  if (warned) return
  warned = true
  console.warn('dsh-ops: batching guidance is unavailable at ' + location + '; guidance is skipped. ' + String(error))
}

/**
 * Load the batch-call guidance from an editable Markdown file.
 * The file is read once per location and cached; an unreadable or empty file
 * yields '' so delivery is skipped instead of failing a tool result.
 * @param filePath - optional override location (absolute path or file URL).
 * @returns the trimmed guidance text, or '' when it cannot be read.
 */
export function loadBatchingGuidance(filePath?: string | URL): string {
  let location: string
  try {
    location = path.resolve(filePath instanceof URL ? fileURLToPath(filePath)
      : filePath ?? fileURLToPath(DEFAULT_GUIDANCE_FILE))
  } catch (error) {
    warnUnavailable(String(filePath), error)
    return ''
  }
  const cached = loaded.get(location)
  if (cached !== undefined) return cached
  try {
    const text = readFileSync(location, 'utf8').trim()
    loaded.set(location, text)
    return text
  } catch (error) {
    loaded.set(location, '')
    warnUnavailable(location, error)
    return ''
  }
}

// ---- program shape: what one run_code program says about its step ----

/** A program shorter than this is treated as single-step unless it is structured. */
export const THIN_CODE_CHARS = 800

/** The directive every program opens with: its declared operation list. */
export const PLAN_DIRECTIVE = '// plan:'

/**
 * Only the first physical line may carry the plan comment.
 *
 * The rule is what makes the declaration binding: a comment parked further down
 * is written after the step was already decided, so it cannot constrain the step.
 */
const PLAN_LINE = /^[\t ]*\/\/\s*plan\s*:\s*(.*)$/u
/** Entries inside one plan line; the full-width semicolon separates them too. */
const PLAN_ENTRY_SEPARATOR = /[;；]/u
/** One dispatch site: dot access or bracket access on `tools`. */
const DISPATCH = /\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*\(/gu
const BATCHED = /Promise\.all|Promise\.allSettled|\.map\s*\(|for\s*\(|while\s*\(|forEach\s*\(|\[\s*\.\.\./u
const BRANCHING = /\bif\s*\(|\btry\s*\{|\bswitch\s*\(|\?\s*[^:]{1,80}:/u
const WAITING = /\bwait\s*:\s*true|job_output\s*\(/u
const BYPASS = /node:fs|node:child_process|\bfs\./u
const SHELL_TOOL = /^(?:pwsh|bash|shell|ops_bash|pwsh_persistent|bash_persistent)$/u
const SHELL_FILE_WORK = /Get-ChildItem|Get-Content|Select-String|Test-Path|(?:^|[\s;&|"'`])(?:ls|dir|cat|type|grep|rg|find|head|tail|wc|sed|awk|cp|mv|rm|mkdir)\s/iu

/** Program text with comments and string bodies separated from executable tokens. */
interface ReadableProgram {
  /** Comments blanked; string bodies intact, so dispatch names and shell commands stay visible. */
  readonly code: string
  /** Comments blanked as well, with string bodies blanked except module specifiers and template expressions. */
  readonly bare: string
}

/**
 * Whether one string literal opens in a module-specifier position.
 *
 * A real import of `node:fs` must stay visible to the bypass rule, while the same
 * text inside a message or a comment must not.
 * @param code - the program text.
 * @param open - index of the opening quote.
 * @returns whether the quote follows `from`, `import`, `require(` or `import(`.
 */
function isModuleSpecifier(code: string, open: number): boolean {
  let index = open - 1
  while (index >= 0 && /\s/u.test(code[index]!)) index -= 1
  if (index < 0) return false
  if (code[index] === '(') {
    index -= 1
    while (index >= 0 && /\s/u.test(code[index]!)) index -= 1
    const end = index
    while (index >= 0 && /[\w$]/u.test(code[index]!)) index -= 1
    const callee = code.slice(index + 1, end + 1)
    return callee === 'require' || callee === 'import'
  }
  if (!/[\w$]/u.test(code[index]!)) return false
  const end = index
  while (index >= 0 && /[\w$]/u.test(code[index]!)) index -= 1
  const keyword = code.slice(index + 1, end + 1)
  return keyword === 'from' || keyword === 'import'
}

/**
 * Separate executable program text from comments and string bodies.
 *
 * A false bypass is worse than a missed one: a program that only mentions
 * `node:fs` in a comment or a message must not be accused of raw file IO. Module
 * specifiers and template expressions stay readable, so real imports and real
 * `fs.readFileSync(...)` calls still count.
 * @param code - the program text.
 * @returns the comment-free view and the comment-and-string-free view.
 */
function readProgram(code: string): ReadableProgram {
  const comments = [...code]
  const bare = [...code]
  const blank = (target: string[], from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      const char = target[index]
      if (char !== '\n' && char !== '\r') target[index] = ' '
    }
  }
  const stringEnd = (open: number, quote: string): number => {
    let index = open + 1
    while (index < code.length) {
      const char = code[index]
      if (char === '\\') { index += 2; continue }
      if (char === quote) return index + 1
      if (char === '\n') return index
      index += 1
    }
    return code.length
  }
  const commentEnd = (open: number, block: boolean): number => {
    let end: number
    if (block) {
      const close = code.indexOf('*/', open + 2)
      end = close === -1 ? code.length : close + 2
    } else {
      end = code.indexOf('\n', open)
      if (end === -1) end = code.length
    }
    blank(comments, open, end)
    blank(bare, open, end)
    return end
  }
  const quotedEnd = (open: number, quote: string): number => {
    const end = stringEnd(open, quote)
    if (!isModuleSpecifier(code, open)) {
      const close = end > open && code[end - 1] === quote ? end - 1 : end
      blank(bare, open + 1, close)
    }
    return end
  }
  const templateEnd = (open: number): number => {
    let index = open + 1
    let literal = index
    while (index < code.length) {
      const char = code[index]
      if (char === '\\') { index += 2; continue }
      if (char === '\x60') { blank(bare, literal, index); return index + 1 }
      if (char === '$' && code[index + 1] === '{') {
        blank(bare, literal, index)
        index = expressionEnd(index + 2)
        literal = index
        continue
      }
      index += 1
    }
    blank(bare, literal, code.length)
    return code.length
  }
  const expressionEnd = (open: number): number => {
    let depth = 1
    let index = open
    while (index < code.length) {
      const char = code[index]
      if (char === '/' && code[index + 1] === '/') { index = commentEnd(index, false); continue }
      if (char === '/' && code[index + 1] === '*') { index = commentEnd(index, true); continue }
      if (char === "'" || char === '"') { index = quotedEnd(index, char); continue }
      if (char === '\x60') { index = templateEnd(index); continue }
      if (char === '{') depth += 1
      else if (char === '}' && --depth === 0) return index + 1
      index += 1
    }
    return code.length
  }
  let index = 0
  while (index < code.length) {
    const char = code[index]
    if (char === '/' && code[index + 1] === '/') { index = commentEnd(index, false); continue }
    if (char === '/' && code[index + 1] === '*') { index = commentEnd(index, true); continue }
    if (char === "'" || char === '"') { index = quotedEnd(index, char); continue }
    if (char === '\x60') { index = templateEnd(index); continue }
    index += 1
  }
  return { code: comments.join(''), bare: bare.join('') }
}

/** Features observable in the program text alone. */
export interface ProgramShape {
  /** Whether the first physical line carries a nonempty plan comment. */
  readonly hasFirstLinePlan: boolean
  /** Operations the plan line declares; 0 when there is no plan line. */
  readonly declaredOperations: number
  /** Static dispatch sites; a loop or map counts one, not its runtime fan-out. */
  readonly dispatchSites: number
  readonly hasBatchingStructure: boolean
  readonly hasBranching: boolean
  readonly isWaiting: boolean
  /** File work routed through the shell or raw Node IO instead of the OPS APIs. */
  readonly bypassesFileTools: boolean
  readonly chars: number
}

/**
 * Read the operations a program declared on its first line.
 * @param code - the `run_code` program text.
 * @returns the declared entries; empty when the first line carries no plan comment.
 */
export function parsePlan(code: unknown): string[] {
  if (typeof code !== 'string' || code.length === 0) return []
  // A leading BOM must not hide the first line from the anchor.
  const body = code.charCodeAt(0) === 0xfeff ? code.slice(1) : code
  const newline = body.search(/\r?\n/u)
  const firstLine = newline === -1 ? body : body.slice(0, newline)
  const match = PLAN_LINE.exec(firstLine)
  if (match === null) return []
  return match[1].split(PLAN_ENTRY_SEPARATOR).map(entry => entry.trim()).filter(entry => entry.length > 0)
}

/**
 * Read the static shape of one program.
 * @param code - the `run_code` program text, or anything that is not a string.
 * @returns the observable features; an absent program has zero of each.
 */
export function analyzeProgram(code: unknown): ProgramShape {
  if (typeof code !== 'string' || code.length === 0) {
    return { hasFirstLinePlan: false, declaredOperations: 0, dispatchSites: 0, hasBatchingStructure: false,
      hasBranching: false, isWaiting: false, bypassesFileTools: false, chars: 0 }
  }
  const readable = readProgram(code)
  // A commented-out call is not a call: dispatch sites are read from comment-free
  // text, which is also what lets a truly dispatch-free program earn no notice.
  const sites = [...readable.code.matchAll(DISPATCH)]
  const plan = parsePlan(code)
  const shellForFiles = sites.some(match => SHELL_TOOL.test(match[1] ?? match[2] ?? '')) && SHELL_FILE_WORK.test(readable.code)
  return {
    hasFirstLinePlan: plan.length > 0,
    declaredOperations: plan.length,
    dispatchSites: sites.length,
    hasBatchingStructure: BATCHED.test(code),
    hasBranching: BRANCHING.test(code),
    isWaiting: WAITING.test(code),
    // Comments and message text are not file work; module specifiers stay readable
    // so a real import of node:fs still bypasses.
    bypassesFileTools: BYPASS.test(readable.bare) || shellForFiles,
    chars: code.length,
  }
}

/** Which of the three tracked categories one program breaks. */
export interface ProgramViolations {
  /** The first line declares no operations. */
  readonly plan: boolean
  /** File work bypassed the OPS APIs. */
  readonly bypass: boolean
  /** The program spent a round trip on one operation it could have batched. */
  readonly shape: boolean
}

/**
 * Classify one program into the three independently latched categories.
 *
 * They are kept separate on purpose: a write window or a single verdict would let
 * one category mask another, and the notice for each one names a different fix.
 * @param shape - the parsed shape of the program.
 * @returns whether each category was violated.
 */
export function violationsOf(shape: ProgramShape): ProgramViolations {
  // No dispatch site means there is no call shape to correct: a value program or a
  // comment-only program must never earn a plan, bypass or shape notice.
  if (shape.dispatchSites === 0) return { plan: false, bypass: false, shape: false }
  return {
    plan: !shape.hasFirstLinePlan,
    bypass: shape.bypassesFileTools,
    // Waiting on a job and branching are legitimate non-batched shapes, and a long
    // program is not judged from its text alone.
    shape: !shape.hasBatchingStructure && !shape.hasBranching && !shape.isWaiting && shape.chars < THIN_CODE_CHARS,
  }
}

// ---- per-turn latch: one notice per category, re-armed by compliance ----

/** The three independently latched categories. */
export type BatchingCategory = 'plan' | 'bypass' | 'shape'

/** Delivery priority when one program breaks several categories at once. */
export const CATEGORY_PRIORITY: readonly BatchingCategory[] = Object.freeze(['bypass', 'plan', 'shape'])

/** One notice to deliver, attributed to the category that earned it. */
export interface ProgramNotice {
  readonly category: BatchingCategory
  /** Host turn the notice belongs to; 0 until the host reported one. */
  readonly turn: number
  readonly text: string
}

/** Per-agent latch over the three categories. */
export interface ProgramLatch {
  /** Start a host turn: every category re-arms. Repeating the same turn is a no-op. */
  noteTurn(agent: Agent, turn: number): void
  /** Record one program and return the notice it earns, if any. */
  observe(agent: Agent, code: unknown): ProgramNotice | undefined
  /** Whether a category may still deliver in this turn. */
  isArmed(agent: Agent, category: BatchingCategory): boolean
  /** Deliveries so far this turn, for the optional telemetry line. */
  stats(agent: Agent): { turn: number; plan: number; bypass: number; shape: number; total: number }
  /** Drop all state for one agent. */
  forget(agent: Agent): void
}

/**
 * The text one category delivers.
 *
 * Each notice names one fix, because the teacher trajectory already carries the full
 * procedure: repeating it here would spend the same words on every turn. The plan
 * notice says only that the comment is missing, which is all that category asks for.
 * @param category - the category that earned the notice.
 * @param shape - the program shape the notice describes.
 * @returns the model-facing text, without the plugin-context envelope.
 */
export function noticeText(category: BatchingCategory, shape: ProgramShape): string {
  if (category === 'plan') {
    return [
      'Your last program did not open with a plan line.',
      'Start the next program on its first line with `// plan: <operation>; <operation>`, one entry per tool call.',
      'A plan comment further down does not count.',
    ].join('\n')
  }
  if (category === 'bypass') {
    return [
      'Your last program did file work through the shell or Node IO, which bypasses path policy and the audit trail.',
      'List with `ops_glob`, search with `ops_grep`, read with `ops_read_files` or `ops_inspect_local_file`, edit with `ops_edit_file`.',
      'Only `ops_inspect_local_file` is resident: load the others with `tools.ops_load_sdk` in the previous program, then call them here.',
    ].join('\n')
  }
  return [
    'Your last program spent a round trip on a single operation.',
    'Put independent operations in one program under `Promise.all`; keep a dependent call as a second `await` in the same program.',
    'This is read from the program text alone: a loop or map counts as one dispatch site, so state the intended shape in the plan line.',
  ].join('\n')
}

/**
 * Create the per-agent latch used by the root `run_code` trigger.
 *
 * Compliance re-arms its own category, so a model that fixes a category and then
 * regresses earns a fresh notice instead of staying silent for the rest of the turn.
 * There is deliberately no per-turn cap: the cost of an extra short notice is bounded
 * by the notice text, while a missed correction lasts the rest of the turn.
 * @returns the latch; state is keyed by agent identity and never serialized.
 */
export function createProgramLatch(): ProgramLatch {
  const states = new WeakMap<Agent, { turn: number; armed: Record<BatchingCategory, boolean>; sent: Record<BatchingCategory, number> }>()
  const fresh = (turn: number) => ({ turn, armed: { plan: true, bypass: true, shape: true }, sent: { plan: 0, bypass: 0, shape: 0 } })
  const stateFor = (agent: Agent) => {
    let state = states.get(agent)
    if (state === undefined) { state = fresh(0); states.set(agent, state) }
    return state
  }
  return {
    noteTurn(agent, turn) {
      const normalised = Number.isSafeInteger(turn) ? turn : 0
      const state = states.get(agent)
      // The host may announce one turn more than once; only a change starts a new turn.
      if (state !== undefined && state.turn === normalised) return
      states.set(agent, fresh(normalised))
    },
    observe(agent, code) {
      const state = stateFor(agent)
      const shape = analyzeProgram(code)
      const violations = violationsOf(shape)
      // A compliant program in a category restores that category's right to speak.
      for (const entry of CATEGORY_PRIORITY) if (!violations[entry]) state.armed[entry] = true
      const category = CATEGORY_PRIORITY.find(entry => violations[entry] && state.armed[entry])
      if (category === undefined) return undefined
      state.armed[category] = false
      state.sent[category] += 1
      return { category, turn: state.turn, text: noticeText(category, shape) }
    },
    isArmed(agent, category) { return stateFor(agent).armed[category] },
    stats(agent) {
      const state = stateFor(agent)
      const { plan, bypass, shape } = state.sent
      return { turn: state.turn, plan, bypass, shape, total: plan + bypass + shape }
    },
    forget(agent) { states.delete(agent) },
  }
}
