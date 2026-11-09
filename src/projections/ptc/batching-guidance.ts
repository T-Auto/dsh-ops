/**
 * Static step-shape analysis and the batching playbook for PTC `run_code`.
 *
 * The analysis is model-free and disk-free, in the same spirit as the compaction
 * planner: literal rules over the program text decide whether one step did one
 * thing, and whether the step did the things it said it would.
 *
 * The playbook is a teacher trajectory, not an exhortation. A one-line "batch
 * your calls" changes nothing; complete programs the model can copy change the
 * shape of the step. Delegation already proves the model can plan: a subagent
 * cannot be dispatched before its task is worked out, so a fan-out arrives
 * complete. The plan line applies that constraint to every program, and the
 * analysis compares the declared count with the executed one.
 */

/** A program shorter than this is single-step even when it looks structured. */
export const THIN_CODE_CHARS = 800

/** The directive every program is asked to open with: its declared operation list. */
export const PLAN_DIRECTIVE = '// plan:'

const PLAN_LINE = /^\s*\/\/\s*plan\s*:\s*(.*)$/imu
const PLAN_ENTRY_SEPARATOR = /\s*;\s*/u
const BATCHED = /Promise\.all|Promise\.allSettled|\.map\s*\(|for\s*\(|while\s*\(|forEach\s*\(|\[\s*\.\.\./u
const BRANCHING = /\bif\s*\(|\btry\s*\{|\bswitch\s*\(|\?\s*[^:]{1,80}:/u
const BYPASS = /node:fs|node:child_process|\bfs\.|require\(\s*['"](?:node:)?(?:fs|child_process)/u
const SHELL_TOOL = /^(?:pwsh|bash|shell|ops_bash|pwsh_persistent|bash_persistent)$/u
const SHELL_FILE_WORK = /Get-ChildItem|Get-Content|Select-String|Test-Path|(?:^|[\s;&|])(?:ls|dir|cat|type|grep|rg|find|head|tail|wc|sed|awk|cp|mv|rm|mkdir)\s/iu
const WAITING = /\bwait\s*:\s*true|job_output\s*\(/u
const DISPATCH = /\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*\(/gu

/** Features observable in the program text alone. */
export interface ProgramShape {
  readonly dispatches: number
  /** Operations the plan line declares; 0 when there is no plan line. */
  readonly declared: number
  readonly planned: boolean
  readonly batched: boolean
  readonly branching: boolean
  readonly waiting: boolean
  readonly bypass: boolean
  readonly chars: number
}

/**
 * Read the operations a program declared it would perform.
 * @param code - the `run_code` program text.
 * @returns the declared entries, empty when the program has no plan line.
 */
export function parsePlan(code: unknown): string[] {
  if (typeof code !== 'string' || code.length === 0) return []
  const match = PLAN_LINE.exec(code)
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
    return { dispatches: 0, declared: 0, planned: false, batched: false, branching: false, waiting: false, bypass: false, chars: 0 }
  }
  const sites = [...code.matchAll(DISPATCH)]
  const plan = parsePlan(code)
  const shellForFiles = sites.some(m => SHELL_TOOL.test(m[1] ?? m[2] ?? '') && SHELL_FILE_WORK.test(code))
  return {
    dispatches: sites.length,
    declared: plan.length,
    planned: plan.length > 0,
    batched: BATCHED.test(code),
    branching: BRANCHING.test(code),
    waiting: WAITING.test(code),
    bypass: BYPASS.test(code) || shellForFiles,
    chars: code.length,
  }
}

/** Why one step is or is not a wasted round-trip. */
export type ProgramVerdict = 'batched' | 'waiting' | 'bypass' | 'shortfall' | 'single'

/**
 * Name the reason one step keeps the playbook on screen.
 * `shortfall` needs the model to have committed to something: a program that
 * declared several operations and issued fewer contradicts itself.
 * @param shape - the parsed shape of the program.
 * @returns the verdict; `batched` and `waiting` mean no reminder is due.
 */
export function verdictOf(shape: ProgramShape): ProgramVerdict {
  if (shape.waiting) return 'waiting'
  if (shape.bypass) return 'bypass'
  if (shape.declared > shape.dispatches) return 'shortfall'
  if (shape.batched || shape.branching) return 'batched'
  if (shape.dispatches === 0) return shape.chars < 200 ? 'single' : 'batched'
  if (shape.dispatches === 1) return 'single'
  return shape.dispatches <= 2 && shape.chars < THIN_CODE_CHARS ? 'single' : 'batched'
}

/**
 * Whether one step looks like "do a single thing, then look again".
 * @param code - the `run_code` program text.
 * @returns true when the step has no batching shape and no branching.
 */
export function isSingleStepProgram(code: unknown): boolean {
  const verdict = verdictOf(analyzeProgram(code))
  return verdict !== 'batched' && verdict !== 'waiting'
}

// ---- playbook: procedure plus complete, runnable trajectories ----

/** Text rendered while the turn is flagged. */
export const BATCHING_GUIDANCE = [
  'Batching playbook - plan the step, then spend one round-trip on all of it.',
  '',
  'One run_code call is one round-trip. Fetching one fact, thinking, then fetching',
  'the next costs the same budget as fetching six facts and deciding once. The',
  'difference is not length: it is whether every operation was decided before the',
  'first one ran.',
  '',
  'You already satisfy this where it is unavoidable: you cannot dispatch a subagent',
  'without first working out that subagent task, so a fan-out arrives complete.',
  'Give every program the same constraint by writing its plan first.',
  '',
  'Step 0 - the plan line. The first line of every program is:',
  '',
  '  // plan: <operation>; <operation>; <operation>',
  '',
  'One entry per tool call, in the order you intend to run them. Prose is fine.',
  'The point is that the line cannot be written without deciding the whole step.',
  '',
  'Step 1 - split by dependency. Independent operations go in the same program',
  'under Promise.all; an operation that needs a value you do not have yet is a',
  'later program.',
  '',
  'Step 2 - reconcile. Fewer operations ran than the plan listed means the plan',
  'was wrong or the step was wasted; decide which before the next step. A',
  'one-entry plan is legitimate only when that result decides what comes next.',
  '',
  'Step 3 - load before you call. Not every tools.ops_* name exists in the',
  'program you are writing: the SDK directory at the end of this prompt lists what',
  'is callable now and what has to be loaded first. tools.ops_load_sdk({ tools:',
  '["read_files", "glob"] }) makes those names callable on the NEXT step, never in',
  'the program that loads them. So the load shares a program with resident work',
  'that is already possible, and the step is not wasted:',
  '',
  '  // plan: load read_files/glob/stat; count files with the shell meanwhile',
  '  const [load, count] = await Promise.all([',
  '    tools.ops_load_sdk({ tools: ["read_files", "glob", "stat"] }),',
  '    tools.ops_bash({ description: "Count files", command: "find . -type f | wc -l" }),',
  '  ])',
  '  return { loaded: load.data?.tools, count: count.stdout.text.trim() }',
  '',
  'Calling an unloaded name throws "tools.ops_read_files is not a function". That',
  'is not a reason to fall back to the shell: it is one step spent loading.',
  'Loaded names stay callable for the rest of the session, so pay it once, early.',
  '',  'Trajectory 1 - reconnaissance: independent probes in one program.',
  '```ts',
  '// plan: depth<=2 tree; manifest head; src file list',
  'const [tree, manifest, src] = await Promise.all([',
  '  tools.ops_bash({ description: "List depth<=2 dirs", command: "pwd; find . -maxdepth 2 -type d | head -40" }),',
  '  tools.ops_read_files({ files: [{ path: "package.json", limit: 30 }] }),',
  '  tools.ops_glob({ pattern: ["src/**/*.ts"], outputMode: "paths", limit: 40 }),',
  '])',
  'return {',
  '  tree: tree.stdout.text.slice(0, 1200),',
  '  manifestLines: manifest.data?.items?.[0]?.lineCount,',
  '  srcFiles: src.data?.items?.length ?? 0,',
  '}',
  '```',
  'Three probes, one round-trip. Read the three result shapes carefully: a shell',
  'call answers in stdout.text, a file read in data.items[0].items, a glob in',
  'data.items[].path. Mixing them up is the most common copy error.',
  'If ops_read_files or ops_glob is not callable yet, the load belongs in the',
  'previous program (Step 3); this trajectory is the step that follows it.',
  '',
  'Trajectory 2 - search, then read the hits: one dependency, then a fan-out.',
  '```ts',
  '// plan: grep candidates; read the first five; keep per-file failures',
  'const hits = await tools.ops_grep({ pattern: "TODO|FIXME", path: "src", glob: ["**/*.ts"], outputMode: "files_with_matches", limit: 50 })',
  'const files = (hits.data?.items ?? []).map(i => i.path).slice(0, 5)',
  'const reads = await Promise.all(files.map(async path => {',
  '  try {',
  '    const r = await tools.ops_read_files({ files: [{ path, limit: 20 }] })',
  '    return { path, ok: true, lines: r.data?.items?.[0]?.lineCount }',
  '  } catch (e) { return { path, ok: false, reason: e.message } }',
  '}))',
  'return reads',
  '```',
  'The search is the dependency, so it is awaited first. The five reads are not,',
  'so they fan out - inside the same program, not across five steps.',
  '',
  'Trajectory 3 - a verified edit: revision first, patch second, receipt third.',
  '```ts',
  '// plan: read the revision; read surrounding context; patch against the revision',
  'const [stat, head] = await Promise.all([',
  '  tools.ops_stat({ path: "src/index.ts" }),',
  '  tools.ops_inspect_local_file({ path: "src/index.ts", offset: 1, limit: 20 }),',
  '])',
  'const edit = await tools.ops_edit_file({',
  '  path: "src/index.ts",',
  '  expectedRevision: stat.data.revision,',
  '  edits: [{ oldText: "export const VERSION = 1", newText: "export const VERSION = 2" }],',
  '})',
  'return { context: head.data?.items?.length, changed: edit.data?.changed, revision: edit.data?.revision }',
  '```',
  'The revision and the context are independent, so they share one program. The',
  'write needs the revision, so it is a second await in the same program - not a',
  'second step.',
  '',
  'Trajectory 4 - paging: a loop is still one program.',
  '```ts',
  '// plan: read every page until the file reports complete',
  'const rows = []',
  'let offset = 1',
  'for (let page = 0; page < 40; page++) {',
  '  const r = await tools.ops_read_files({ files: [{ path: "events.jsonl", offset, limit: 200 }] })',
  '  const file = r.data?.items?.[0]',
  '  rows.push(...(file?.items ?? []))',
  '  const next = file?.nextOffset ?? 0',
  '  if (file?.complete || !next || next <= offset) break',
  '  offset = next',
  '}',
  'return { lines: rows.length }',
  '```',
  'Advance by nextOffset, never by page count, and stop on complete. A loop of',
  'dispatches is batched work, not repeated single steps.',
  '',
  'Anti-pattern, and its rewrite:',
  '',
  '  // plan: count files                      <- one entry, one dispatch, one trip',
  '  const n = await tools.ops_bash({ description: "Count files", command: "find . -type f | wc -l" })',
  '  return n.stdout.text',
  '  // ... then a second program for total bytes, a third for the newest files',
  '',
  '  // plan: file count; total bytes; newest ten files   <- same work, one program',
  '  const [count, bytes, newest] = await Promise.all([',
  '    tools.ops_bash({ description: "Count files", command: "find . -type f | wc -l" }),',
  '    tools.ops_bash({ description: "Sum bytes", command: "du -sb . | cut -f1" }),',
  '    tools.ops_bash({ description: "Newest ten files", command: "find . -type f -printf \'%T@ %p\\n\' | sort -rn | head -10" }),',
  '  ])',
  '',
  'Rules that still hold:',
  '1. Every tool is called inside the program: await tools.name(args).',
  '2. Independent calls go through Promise.all; a dependent call is awaited first.',
  '   One program issues at most 128 dispatches. A larger fan-out is split into',
  '   batches of 128 and chained with await; the ceiling is per program, not per',
  '   turn, so the next batch continues in the following program.',
  '3. One failing item is wrapped in try/catch so the rest still report.',
  '4. Return only the fields the next step needs; the payload stays here.',
  '5. Writes are explicitly awaited in order, even when submitted together.',
  '6. OPS first. File, search, read and edit work uses its tools.ops_* API; the',
  '   shell starts processes and reads environment facts, never a shortcut around',
  '   a tool that exists. node:fs and node:child_process bypass path policy, the',
  '   sandbox and the audit trail - they are not workarounds.',
  '7. An unloaded name is loaded, not replaced. Load it in the previous program',
  '   and keep working with the resident tools meanwhile; reaching for the shell',
  '   because a name threw "is not a function" is the shortcut rule 6 forbids.',
  '',
  'Common mistakes:',
  '| mistake | correct shape |',
  '|---|---|',
  '| dependent value inside Promise.all | await it first, then fan out |',
  '| more than 128 dispatches in one program | slice(0, 128) before mapping; batch the rest |',
  '| returning the whole payload | return the fields the next step needs |',
  '| one failure aborting the batch | try/catch per item, keep e.message |',
  '| shell standing in for a file tool | call the ops_* API |',
  '| ops_read_files before it is loaded | ops_load_sdk in the previous program |',
].join('\n')

// ---- tracker ----

/** What one finished program said and did, kept for the next assembly. */
export interface ProgramObservation {
  readonly verdict: ProgramVerdict
  readonly declared: number
  readonly dispatches: number
}

/** Per-agent latch: one decision per turn, so the cached prefix never rewrites mid-turn. */
export interface BatchingTracker {
  observe(key: object, code: unknown): boolean
  active(key: object): boolean
  primed(key: object): boolean
  notice(key: object): string
  reopen(key: object): void
  forget(key: object): void
}

/**
 * Create the per-agent flag used by the PTC guidance renderer.
 * @returns a tracker that keeps one flag per agent.
 */
export function createBatchingTracker(): BatchingTracker {
  const flagged = new WeakMap<object, boolean>()
  const observed = new WeakMap<object, ProgramObservation>()
  const turns = new WeakMap<object, number>()
  return {
    observe(key, code) {
      const shape = analyzeProgram(code)
      const verdict = verdictOf(shape)
      if (verdict === 'batched' || verdict === 'waiting') return false
      const was = flagged.get(key) ?? false
      // The notice is frozen on the step that raises the flag. Recomputing it from the newest
      // observation rewrote the system prompt on every step, which invalidated the provider
      // prompt cache for the rest of the turn; one revision per turn is the documented budget.
      if (!was) observed.set(key, { verdict, declared: shape.declared, dispatches: shape.dispatches })
      flagged.set(key, true)
      return !was
    },
    active(key) { return flagged.get(key) ?? false },
    // Asked after turn/start, so turn one already counts as one. The first program decides the
    // shape of every later step; from turn two the playbook appears only after a wasted step.
    primed(key) { return (turns.get(key) ?? 0) <= 1 },
    notice(key) {
      const seen = observed.get(key)
      if (seen === undefined) return ''
      if (seen.verdict === 'shortfall') return 'Your last program declared ' + seen.declared + ' operation(s) and issued ' + seen.dispatches + '. Reconcile the two before planning the next step.'
      if (seen.verdict === 'single') return 'Your last program issued ' + seen.dispatches + ' dispatch(es) and declared ' + seen.declared + '. If the next operations do not depend on its result, put them in one plan.'
      // The notice has to name the replacement, not just the offence: the old text told the
      // model nothing it could act on, and the flag is frozen for the rest of the turn.
      if (seen.verdict === 'bypass') return 'Your last program did file work through the shell or node:*, which bypasses path policy and the audit trail. List with ops_glob, search with ops_grep, read with ops_read_files; load them first with tools.ops_load_sdk if they are not callable yet.'
      return ''
    },
    reopen(key) {
      flagged.set(key, false)
      // Dropping the frozen notice is what lets the next turn start clean; keeping it would
      // re-render the previous turn's contradiction before the new turn has taken a step.
      observed.delete(key)
      turns.set(key, (turns.get(key) ?? 0) + 1)
    },
    forget(key) { flagged.delete(key); observed.delete(key); turns.delete(key) },
  }
}
