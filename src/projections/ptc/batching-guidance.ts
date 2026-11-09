/**
 * Static step-shape analysis and the batching playbook for PTC `run_code`.
 *
 * The analysis is deliberately model-free and disk-free, in the same spirit as
 * the compaction planner: a handful of literal rules over the program text
 * decide whether one step did one thing. Length alone was the previous proxy
 * and it was wrong in both directions - a long program can still fetch a single
 * file, and a short one can batch ten reads behind `Promise.all`.
 *
 * Cost model: the playbook is rendered only while a turn is flagged, so an
 * agent that already batches pays nothing for it.
 */

/** A program shorter than this is single-step even when it looks structured. */
export const THIN_CODE_CHARS = 800

/** Rule: any of these means the program schedules more than one operation. */
const BATCHED = /Promise\.all|Promise\.allSettled|\.map\s*\(|for\s*\(|while\s*\(|forEach\s*\(|\[\s*\.\.\./u

/** Rule: control flow means the program decides something instead of just fetching. */
const BRANCHING = /\bif\s*\(|\btry\s*\{|\bswitch\s*\(|\?\s*[^:]{1,80}:/u

/** Rule: a program that reaches for the host modules bypasses the tool surface entirely. */
const BYPASS = /node:fs|node:child_process|fs\.|require\(\s*['"](?:node:)?(?:fs|child_process)/u

/**
 * Rule: OPS owns file and search work, so a shell call that lists, reads, greps or
 * writes files is off-surface even when the shell form is shorter to write.
 */
const SHELL_TOOL = /^(?:pwsh|bash|shell|ops_bash|pwsh_persistent|bash_persistent)$/u

const SHELL_FILE_WORK = /Get-ChildItem|Get-Content|Select-String|Test-Path|(?:^|[\\s;&|])(?:ls|dir|cat|type|grep|rg|find|head|tail|wc|sed|awk|cp|mv|rm|mkdir)\\s/iu

/** Rule: one dispatch that is only holding a wait is a real step, not a wasted one. */
const WAITING = /\bwait\s*:\s*true|job_output\s*\(/u

/** One `tools.name(` or `tools["name"](` dispatch site. */
const DISPATCH = /\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*\(/gu

/** Features observable in the program text alone. */
export interface ProgramShape {
  /** Number of `tools.*(` dispatch sites, an upper bound on inner calls. */
  readonly dispatches: number
  /** The program schedules work through a loop or `Promise.all`. */
  readonly batched: boolean
  /** The program branches, so it is doing more than a single fetch. */
  readonly branching: boolean
  /** The only work is holding a wait for an existing job. */
  readonly waiting: boolean
  /** The program reaches for host modules instead of the tool surface. */
  readonly bypass: boolean
  /** Characters of program text, kept for the short-program rule. */
  readonly chars: number
}

/**
 * Read the static shape of one program.
 * @param code - the `run_code` program text, or anything that is not a string.
 * @returns the observable features; an absent program has zero of each.
 */
export function analyzeProgram(code: unknown): ProgramShape {
  if (typeof code !== 'string' || code.length === 0) {
    return { dispatches: 0, batched: false, branching: false, waiting: false, bypass: false, chars: 0 }
  }
  const sites = [...code.matchAll(DISPATCH)]
  const dispatches = sites.length
  // A shell dispatch that lists, reads, greps or writes files is doing OPS work
  // through the wrong surface, whatever else the program does.
  const shellForFiles = sites.some(match => SHELL_TOOL.test(match[1] ?? match[2] ?? '') && SHELL_FILE_WORK.test(code))
  return {
    dispatches,
    batched: BATCHED.test(code),
    branching: BRANCHING.test(code),
    waiting: WAITING.test(code),
    bypass: BYPASS.test(code) || shellForFiles,
    chars: code.length,
  }
}

/**
 * Whether one step looks like "do a single thing, then look again".
 *
 * Conservative by design: a program that loops, branches or holds a wait is
 * never flagged, so the reminder cannot fire on legitimate single-purpose work.
 * @param code - the `run_code` program text.
 * @returns true when the step has no batching shape and no branching.
 */
export function isSingleStepProgram(code: unknown): boolean {
  const shape = analyzeProgram(code)
  if (shape.waiting) return false
  // An off-surface step is wrong on its own: it must be reminded even when the
  // program is long or structured.
  if (shape.bypass) return true
  if (shape.batched || shape.branching) return false
  // A program that dispatched nothing is either a pure computation or a step that
  // reached around the tool surface. The second one is exactly the wasted step
  // this playbook is about, whatever its length.
  if (shape.dispatches === 0) return shape.bypass || shape.chars < 200
  if (shape.dispatches === 1) return true
  // Several dispatches written out one by one are still one-operation-per-line.
  return shape.dispatches <= 2 && shape.chars < THIN_CODE_CHARS
}

/** Text rendered while the turn is flagged, condensed from the batching playbook. */
export const BATCHING_GUIDANCE = [
  'Batching playbook - one step is one round-trip, so spend it on several operations.',
  '',
  'Rules:',
  '1. Every tool is called inside the program: `await tools.name(args)`.',
  '2. Independent calls go through `Promise.all` - read-only calls may overlap.',
  '3. Dependent calls are separate `await` steps; never guess an unknown value.',
  '4. One failing item is wrapped in `try/catch` so the rest still report.',
  '5. Return or print only the summary you need; intermediate results stay here.',
  '6. Writes are explicitly awaited in order, even when submitted together.',
  '7. OPS first. Every file, search, read, write and edit operation goes through its',
  '   `tools.ops_*` API. The host shell is only for work OPS has no API for (starting',
  '   a process, running a test, reading an environment fact) - never as a shortcut',
  '   around a tool that exists. Reaching for `node:fs` or `node:child_process` is',
  '   not a workaround: it skips path policy, the sandbox and the audit trail.',
  '',
  'Shape to copy - gather, then decide, then report:',
  '',
  '```ts',
  'const g = await tools.ops_grep({ pattern: "TODO", path: "src", include: "*.ts" })',
  'const files = [...new Set(g.matches.map(m => m.path))].slice(0, 5)',
  'const reads = await Promise.all(files.map(async f => {',
  '  try { return { f, ok: true, lines: (await tools.ops_read_files({ path: f, limit: 20 })).status } }',
  '  catch (e) { return { f, ok: false, reason: e.message } }   // e.message, not e.toolName',
  '}))',
  'return reads',
  '```',
  '',
  'Never:',
  '- a program whose only work is one file, one image, or one job poll;',
  '- dependent calls inside `Promise.all` (they race on an unknown value);',
  '- unbounded fan-out (slice first), or returning a whole payload;',
  '- any call that bypasses the tool surface (`node:fs`, `child_process`, `pwsh`/bash',
  '  standing in for an ops tool); a workaround is not a result.',
].join('\n')

/** Per-agent latch: one decision per turn, so the cached prefix never rewrites mid-turn. */
export interface BatchingTracker {
  /**
   * Record one finished `run_code` call.
   * @param key - the agent the call belongs to.
   * @param code - the program text of that call.
   * @returns whether this call flagged the current turn.
   */
  observe(key: object, code: unknown): boolean
  /**
   * Whether the playbook should render right now.
   * @param key - the agent to ask about.
   * @returns true while the latched decision is to render.
   */
  active(key: object): boolean
  /**
   * Whether this agent is still on its first turn, which carries the playbook
   * unconditionally: the first program decides the shape of every later step, so
   * waiting for a wasted step to correct it means the first step is already wasted.
   * @param key - the agent to ask about.
   * @returns true while the agent has had at most one turn.
   */
  primed(key: object): boolean
  /**
   * Close a turn: clear the flag so the next turn starts unreminded, and count
   * the turn so priming ends after the first one.
   * @param key - the agent whose turn started.
   */
  reopen(key: object): void
  /**
   * Drop an agent's state.
   * @param key - the agent to forget.
   */
  forget(key: object): void
}

/**
 * Create the per-agent flag used by the PTC guidance renderer.
 *
 * The flag takes effect at the next assembly instead of waiting for the next
 * turn. Waiting was wrong in practice: a real task runs the whole job inside one
 * turn, so a turn-boundary latch never fired at all. One wasted step now costs
 * one system-prompt revision, and the flag stays set until the turn ends, so the
 * cost is at most one revision per turn.
 * @returns a tracker that keeps one flag per agent.
 */
export function createBatchingTracker(): BatchingTracker {
  const flagged = new WeakMap<object, boolean>()
  // Turns observed per agent; priming lasts through the first one only.
  const turns = new WeakMap<object, number>()
  return {
    observe(key, code) {
      if (!isSingleStepProgram(code)) return false
      const was = flagged.get(key) ?? false
      flagged.set(key, true)
      return !was
    },
    active(key) {
      return flagged.get(key) ?? false
    },
    primed(key) {
      return (turns.get(key) ?? 0) <= 1
    },
    reopen(key) {
      flagged.set(key, false)
      turns.set(key, (turns.get(key) ?? 0) + 1)
    },
    forget(key) {
      flagged.delete(key)
      turns.delete(key)
    },
  }
}
