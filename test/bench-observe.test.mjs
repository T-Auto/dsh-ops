/**
 * The live-narration gate (P5): the observer's wording, its one-shot throttling, its
 * heartbeat / escalating stall warnings, its structured trace rows, and the console
 * code page decoder.
 *
 * Nothing here spawns a child or waits on a wall clock: the clock, the heartbeat
 * scheduler, the log sink and the trace sink are all injected, so every rule the bench
 * console obeys is pinned as a pure function of an event sequence. The event shapes are
 * the ones `run.json` carries (bench/run.schema.json `$defs/result`); a shape this
 * module does not know must still narrate itself rather than vanish.
 *
 * @module dsh-ops/test/bench-observe
 */

import { assert, report, test } from './lib/harness.mjs'
import { createObserver, decodeConsoleBytes, describeEvent, formatClock, OBSERVER_LEVELS, OBSERVER_TRACE_ROLES } from '../bench/lib/observe.mjs'

const LABEL = 'bench-observe'

/**
 * An observer wired to an injected clock, log, trace and heartbeat, so the narration
 * rules can be pinned without a child process or a wall-clock wait.
 * @param {object} [config] - overrides passed to `createObserver`.
 * @returns {{lines: object[], rows: object[], timers: Function[], observer: object, advance: Function, tick: Function, feed: Function, feedRaw: Function, texts: Function, count: Function}} the rig.
 */
function narrate(config = {}) {
  const lines = []
  const rows = []
  const timers = []
  let clock = 1_000
  const observer = createObserver({
    log: (level, text) => lines.push({ level, text }),
    trace: (row) => rows.push(row),
    now: () => clock,
    setTimer: (fn) => {
      timers.push(fn)
      return { unref() {} }
    },
    clearTimer: () => {
      timers.length = 0
    },
    run: { taskId: 'csv-sum', repeatIndex: 0 },
    heartbeatMs: 10_000,
    stallMs: 30_000,
    ...config,
  })
  return {
    lines,
    rows,
    timers,
    observer,
    advance(ms) {
      clock += ms
    },
    tick() {
      for (const fn of [...timers]) fn()
    },
    feed(...objects) {
      for (const object of objects) observer.line(JSON.stringify(object))
    },
    feedRaw(...raw) {
      for (const line of raw) observer.line(line)
    },
    texts: (level) => lines.filter((line) => line.level === level).map((line) => line.text),
    count(matcher) {
      return lines.filter((line) => matcher.test(line.text)).length
    },
  }
}

const SESSION = { type: 'session', sessionId: 'sess-1', cwd: '/w' }
const STEP_WITH_USAGE = (step) => ({ type: 'status', phase: 'step_end', turn: 0, step, usage: { inputTokens: 1500, outputTokens: 260, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 40 } })

// ---------------------------------------------------------------- vocabulary

await test('every event shape narrates itself, and a missing usage is never laundered', () => {
  assert.match(describeEvent(SESSION).text, /session sess-1/)
  const answered = describeEvent(STEP_WITH_USAGE(3))
  assert.equal(answered.kind, 'step_end')
  assert.match(answered.text, /step 3: model answered/)
  assert.match(answered.text, /in 1,500 \/ out 260 \/ cacheRead 0/)
  assert.match(answered.text, /reasoning 40/)
  const bare = describeEvent({ type: 'status', phase: 'step_end', turn: 0, step: 4 })
  assert.equal(bare.kind, 'step_end_no_usage')
  assert.match(bare.text, /NO usage/)
  assert.match(bare.text, /token totals will be n\/a/)
  assert.ok(!/in 0 \/ out 0/.test(bare.text), 'an absent usage object must not be described as zero tokens')
  // A usage object that IS present is narrated as reported, even when individual
  // buckets are absent; bucket-level completeness is the aggregator's decision
  // (it drives `usageReported`), not the narrator's.
  const partial = describeEvent({ type: 'status', phase: 'step_end', turn: 0, step: 5, usage: { inputTokens: 7 } })
  assert.equal(partial.kind, 'step_end')
  assert.match(partial.text, /in 7 \/ out 0/)
  assert.match(describeEvent({ type: 'status', phase: 'step_start', turn: 0, step: 0 }).text, /request sent to the model/)
  assert.match(describeEvent({ type: 'status', phase: 'turn_start', turn: 0 }).text, /turn 0 started/)
  assert.equal(describeEvent({ type: 'status', phase: 'turn_end', turn: 0, reason: { kind: 'error' } }).kind, 'turn_end_failed')
  assert.equal(describeEvent({ type: 'status', phase: 'turn_end', turn: 0, reason: { kind: 'completed' } }).kind, 'turn_end')
  assert.equal(describeEvent({ type: 'status', phase: 'something_new', turn: 0 }).kind, 'status_something_new')
  assert.equal(describeEvent({ type: 'tool_result', callId: 'c', status: 'error', result: 'boom' }).kind, 'tool_result_error')
  assert.equal(describeEvent({ type: 'tool_result', callId: 'c', status: 'ok', result: 'fine' }).kind, 'tool_result')
  assert.match(describeEvent({ type: 'error', message: 'workspace preparation failed' }).text, /dsh reported an error: workspace preparation failed/)
  assert.match(describeEvent({ type: 'tool_call', tool: 'ops_bash', input: { command: 'ls -1' } }).text, /tool ops_bash ← \{"command":"ls -1"\}/)
  assert.match(describeEvent({ type: 'thinking', text: 'x'.repeat(5) }).text, /reasoning \+5 chars/)
  assert.match(describeEvent({ type: 'text', text: 'x'.repeat(5) }).text, /assistant text \+5 chars/)
  assert.match(describeEvent({ type: 'final', text: 'ok' }).text, /final answer received \(2 bytes\)/)
  // The unknown shape is named, not swallowed, and a line that is not an event at
  // all is declined rather than invented.
  assert.equal(describeEvent({ type: 'brand_new', x: 1 }).kind, 'brand_new')
  assert.match(describeEvent({ type: 'brand_new', x: 1 }).text, /event type=brand_new/)
  assert.equal(describeEvent(null), null)
  assert.equal(describeEvent({ noType: 1 }), null)
  assert.equal(describeEvent('not an object'), null)
  assert.equal(OBSERVER_LEVELS.join(','), 'info,detail,warn')
  assert.ok(OBSERVER_TRACE_ROLES.includes('milestone') && OBSERVER_TRACE_ROLES.includes('stall'))
})

// ---------------------------------------------------------------- throttling

await test('the observer answers the four questions once, then keeps the chatter short', () => {
  const run = narrate()
  run.observer.started({ command: 'node', args: ['bin.js', '--profile', 'bench-ops', '--json', 'do it'], pid: 4242, timeoutMs: 900_000, cwd: '/w', eventsFile: 'results/csv-sum-r0.events.ndjson' })
  run.feed(SESSION)
  run.advance(1000)
  run.feed({ type: 'status', phase: 'step_start', turn: 0, step: 0 })
  run.advance(1000)
  run.feed(STEP_WITH_USAGE(0))
  run.advance(1000)
  run.feed(STEP_WITH_USAGE(1))
  run.observer.finished({ exitCode: 0 })
  const info = run.texts('info')
  assert.ok(info.some((text) => /startup OK/.test(text)), 'boot must be reported')
  assert.equal(run.count(/startup OK/), 1, 'boot is announced once per run')
  assert.equal(run.count(/model connection OK/), 1, 'a healthy later step does not re-announce the connection')
  assert.equal(run.count(/request sent to the model/), 1, 'the first request is the milestone; the rest are detail')
  assert.ok(run.lines.some((line) => line.level === 'detail' && /step 1: model answered/.test(line.text)), 'later steps are still there, as chatter')
  assert.ok(info.some((text) => /pid=4242/.test(text)), 'the pid is printed while the child is alive')
  assert.ok(info.some((text) => /timeout=900s/.test(text)), 'the deadline is printed before it is paid')
  assert.ok(info.some((text) => /exited 0 after 0m03s/.test(text)), 'the outcome names the elapsed time')
  assert.ok(run.lines.some((line) => /\[csv-sum r0\]/.test(line.text)), 'every line carries which run it is')
})

await test('missing usage, tool errors and stderr each report themselves once and then count', () => {
  const run = narrate()
  run.feed(STEP_WITH_USAGE(0))
  run.feed({ type: 'status', phase: 'step_end', turn: 0, step: 1 })
  run.feed({ type: 'status', phase: 'step_end', turn: 0, step: 2 })
  assert.equal(run.lines.filter((line) => line.level === 'warn' && /NO usage/.test(line.text)).length, 1, 'the first lost usage is the warning')
  assert.equal(run.count(/NO usage/), 2, 'the later ones are still narration, just not shouting')
  const counters = run.observer.snapshot()
  assert.equal(counters.stepsWithUsage, 1, 'a step without usage is never counted as a usage-bearing step')
  assert.equal(counters.steps, 3)
  assert.notEqual(counters.stepsWithUsage, counters.steps, 'so run.json must record usageReported=false for this row')
  assert.equal(run.count(/model answered/), 1, 'and no line claims a token figure for the step that reported none')
  for (let i = 0; i < 8; i += 1) run.feed({ type: 'tool_result', callId: `c${i}`, status: 'error', result: 'denied' })
  assert.equal(run.count(/tool result error/), 5, 'tool errors are named up to the cap')
  assert.equal(run.observer.snapshot().toolErrors, 8, 'and counted past it')
  assert.equal(run.count(/counted but not printed/), 1)

  const quiet = narrate()
  quiet.observer.stderr('stub: workspace preparation failed\nsecond line\n')
  assert.equal(quiet.count(/dsh is writing to stderr/), 1, 'the first stderr line is a milestone')
  assert.ok(!quiet.lines.some((line) => line.level === 'detail' && /second line/.test(line.text)), 'stderr lines are echoed only under --verbose')
  quiet.observer.stderr('split ')
  quiet.observer.stderr('across chunks\n')
  assert.equal(quiet.observer.snapshot().stderrLines, 3, 'a chunk boundary must not lose or double-count a line')

  const loud = narrate({ verbose: true })
  loud.observer.stderr('a\nb\n')
  assert.ok(loud.lines.some((line) => line.level === 'detail' && /stderr \| b/.test(line.text)), 'verbose echoes stderr as it arrives')
})

await test('an event the narrator cannot name is still narrated and still counted', () => {
  const run = narrate()
  run.feed({ type: 'brand_new', x: 1 })
  run.feed({ type: 'brand_new', x: 2 })
  assert.equal(run.count(/event type=brand_new/), 2, 'an unknown shape is named every time, never silently dropped')
  assert.equal(run.observer.snapshot().lastKind, 'brand_new')
  // A JSON line that carries no event type has nothing to narrate, but it must not
  // look like a lost line either: it is still counted as an event.
  run.feedRaw('{"noType":1}', 'null')
  assert.equal(run.observer.snapshot().events, 4, 'every non-blank line is counted, narrated or not')
  assert.equal(run.count(/noType/), 0, 'a line with no type is not invented into an event')
  run.feedRaw('   ')
  assert.equal(run.observer.snapshot().events, 4, 'a blank line is not an event at all')
})

// ---------------------------------------------------------------- silence

await test('a silent run speaks for itself: heartbeat, then escalating stall warnings', () => {
  const run = narrate({ heartbeatMs: 10_000, stallMs: 30_000 })
  run.observer.started({ pid: 7, eventsFile: 'results/x.events.ndjson', timeoutMs: 60_000 })
  run.advance(5_000)
  run.tick()
  assert.equal(run.count(/still running/), 0, 'a run that just printed does not also get a heartbeat')
  run.advance(6_000)
  run.tick()
  assert.equal(run.count(/still running/), 1, 'a silent run says it is alive')
  assert.match(run.texts('info').find((text) => /still running/.test(text)), /0 event\(s\), steps=0/)
  run.advance(20_000)
  run.tick()
  assert.equal(run.count(/NO OUTPUT FOR/), 1, 'the stall warning arrives once at 1x')
  run.advance(30_000)
  run.tick()
  assert.equal(run.count(/NO OUTPUT FOR/), 2, 'it escalates at 2x')
  assert.match(run.texts('warn').at(-1), /results\/x\.events\.ndjson/, 'and names the archive to watch')
  for (let i = 0; i < 20; i += 1) {
    run.advance(1_000_000)
    run.tick()
  }
  assert.equal(run.count(/NO OUTPUT FOR/), 4, 'escalation stops at the last step instead of shouting forever')
  // The heartbeat and the stall warning are their own lanes, each carrying the
  // counters collected so far so the panel can draw them without replaying events.
  const stalls = run.rows.filter((row) => row.role === 'stall')
  assert.equal(stalls.length, 4)
  for (const row of stalls) assert.deepEqual(row.counters, { events: 0, steps: 0, stepsWithUsage: 0, toolCalls: 0, toolErrors: 0 })
  assert.ok(run.rows.some((row) => row.role === 'heartbeat' && row.kind === 'heartbeat'))
})

await test('the outcome line tells the truth about a run that never started', () => {
  const run = narrate()
  run.observer.started({ pid: 9, timeoutMs: 60_000, eventsFile: 'results/x.events.ndjson' })
  run.observer.stderr('DSH workspace preparation failed (not a user permission denial)\n')
  run.observer.finished({ timedOut: true, timeoutMs: 60_000 })
  assert.equal(run.count(/TIMEOUT after 60s/), 1)
  assert.ok(run.lines.some((line) => line.level === 'warn' && /not one event/.test(line.text)), 'zero events is a startup problem, and must be said as one')
  assert.ok(run.lines.some((line) => /stderr tail: DSH workspace preparation failed/.test(line.text)), 'the post-mortem quotes the last stderr lines')
  assert.equal(run.timers.length, 0, 'finished() must cancel the heartbeat, or the runner outlives its own report')
  assert.ok(run.rows.some((row) => row.role === 'outcome' && row.kind === 'timeout'))
  assert.ok(run.rows.some((row) => row.role === 'outcome' && row.kind === 'no_events'))

  const exit = narrate()
  exit.feed(SESSION)
  exit.observer.finished({ exitCode: 1 })
  assert.ok(exit.lines.some((line) => line.level === 'warn' && /dsh exited 1/.test(line.text)), 'a non-zero exit is not a pass')

  const stopped = narrate()
  stopped.feed(SESSION)
  stopped.observer.finished({ exitCode: null, interrupted: true })
  assert.ok(stopped.lines.some((line) => line.level === 'warn' && /interrupted by the operator/.test(line.text)), 'Ctrl-C is recorded as a stop, not as a finished run')

  const dead = narrate()
  dead.observer.finished({ exitCode: null, spawnError: 'ENOENT: no such file' })
  assert.ok(dead.lines.some((line) => line.level === 'warn' && /could not be spawned: ENOENT/.test(line.text)), 'a spawn failure names the cause, not an exit code')

  const junk = narrate()
  junk.feedRaw('not json at all')
  assert.equal(junk.count(/not JSON/), 1, 'a malformed line is narrated, not swallowed')
  assert.equal(junk.observer.snapshot().events, 1, 'and it still counts as an event that arrived')
  assert.ok(junk.rows.some((row) => row.kind === 'malformed'))
  assert.match(formatClock(65_000), /^1m05s$/)
  assert.equal(formatClock(0), '0m00s')
})

// ---------------------------------------------------------------- trace

await test('every narrated line becomes exactly one trace row, in order, ready for run.json', () => {
  const run = narrate()
  run.observer.started({ command: 'node', args: ['bin.js'], pid: 11, timeoutMs: 60_000, cwd: '/w', eventsFile: 'results/r.events.ndjson' })
  run.feed(SESSION)
  run.feed({ type: 'status', phase: 'step_start', turn: 0, step: 0 })
  run.feed(STEP_WITH_USAGE(0))
  run.feed(STEP_WITH_USAGE(1))
  run.feed({ type: 'tool_call', tool: 'ops_read', input: { path: 'a.csv' } })
  run.feed({ type: 'tool_result', callId: 'c1', status: 'ok', result: 'done' })
  run.feed({ type: 'text', text: 'working' })
  run.feed({ type: 'status', phase: 'turn_end', turn: 0, reason: { kind: 'completed' } })
  run.feed({ type: 'final', text: 'ok' })
  run.observer.finished({ exitCode: 0 })

  // The sink and the accessor are the same run: a runner that appends NDJSON while
  // the sweep is alive and a panel that reads the sealed document see one sequence.
  assert.deepEqual(run.observer.trace(), run.rows)
  assert.equal(run.rows.length, run.lines.length, 'one row per narrated line, nothing dropped')
  run.rows.forEach((row, index) => {
    assert.equal(row.seq, index + 1, 'seq is dense and 1-based')
    assert.equal(row.text, run.lines[index].text, 'the row quotes the exact console line')
    assert.ok(OBSERVER_LEVELS.includes(row.level), `${row.level} is not an observer level`)
    assert.ok(OBSERVER_TRACE_ROLES.includes(row.role), `${row.role} is not a trace lane`)
    assert.equal(typeof row.kind, 'string')
    assert.match(row.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'at is ISO 8601 UTC')
    assert.ok(Number.isInteger(row.offsetMs) && row.offsetMs >= 0)
  })
  for (let i = 1; i < run.rows.length; i += 1) assert.ok(run.rows[i].offsetMs >= run.rows[i - 1].offsetMs, 'the timeline never runs backwards')

  const roles = new Set(run.rows.map((row) => row.role))
  for (const expected of ['boot', 'milestone', 'raw', 'tool', 'event', 'outcome']) assert.ok(roles.has(expected), `the ${expected} lane must appear`)

  // Throttling is visible in the trace, not hidden by it: the first answer is a
  // milestone, the second step of the same kind is an ordinary event. The `raw` lane
  // (the per-line "event #N kind" note) carries the same `kind`, so it is excluded
  // here — it is the panel's fold-away lane, not a second milestone.
  const answered = run.rows.filter((row) => row.kind === 'step_end' && row.role !== 'raw')
  assert.deepEqual(answered.map((row) => row.role), ['milestone', 'event'])

  const live = run.observer.snapshot()
  assert.equal(live.traceRows, run.rows.length)
  const expectedMilestones = run.rows.filter((row) => row.role === 'boot' || row.role === 'milestone' || row.role === 'stall')
  assert.deepEqual(live.milestones, expectedMilestones.map((row) => ({ seq: row.seq, at: row.at, offsetMs: row.offsetMs, kind: row.kind, text: row.text })))
  assert.ok(live.milestones.length > 0 && live.milestones.length < run.rows.length, 'the milestone list is the quoted subset, not the whole timeline')

  // The document is JSON and only JSON: a row that cannot survive a round trip
  // cannot live in run.json (hard boundary 1).
  assert.deepEqual(JSON.parse(JSON.stringify(run.observer.trace())), run.rows)
})

// ---------------------------------------------------------------- code page

await test('a stderr written in the local code page arrives readable, not as mojibake', () => {
  // The real zh-CN shape of the failure: Windows PowerShell writes its diagnostics in
  // cp936, every consumer here assumes UTF-8, and the one line that names the cause used
  // to arrive as `??ģ??????`.
  const gbk = Buffer.from([0xce, 0xde, 0xb7, 0xa8, 0xbc, 0xd3, 0xd4, 0xd8, 0xc4, 0xa3, 0xbf, 0xe9, 0x20, ...Buffer.from('Microsoft.PowerShell.Security', 'utf8')])
  const decoded = decodeConsoleBytes(gbk)
  assert.equal(decoded.encoding, 'gbk', 'the local page is identified')
  assert.equal(decoded.text, `无法加载模块 Microsoft.PowerShell.Security`, 'and the line is readable')
  assert.equal(decodeConsoleBytes(Buffer.from('plain ascii', 'utf8')).encoding, null, 'UTF-8 is never second-guessed')
  assert.equal(decodeConsoleBytes(Buffer.from('中文也是 UTF-8', 'utf8')).encoding, null)
  assert.equal(decodeConsoleBytes('already a string').text, 'already a string')
  // The chain ends at a total single-byte page, so a diagnostic line is never thrown
  // away for being unreadable; a runtime WITHOUT those legacy codecs keeps the UTF-8
  // reading, replacement characters and all, and names no page (the last-resort branch).
  assert.equal(decodeConsoleBytes(Buffer.from([0x81, 0x40, 0x81])).encoding, 'windows-1252')

  const run = narrate()
  run.observer.stderr(gbk.subarray(0, 9))
  run.observer.stderr(gbk.subarray(9))
  run.observer.stderr(Buffer.from('\n'))
  assert.equal(run.observer.snapshot().stderrLines, 1, 'a chunk boundary inside a multibyte character must not invent a line')
  assert.ok(run.lines.some((line) => /无法加载模块/.test(line.text)), 'the narrated line is readable')
  assert.ok(run.lines.some((line) => /local code page gbk/.test(line.text)), 'and it says which page it came from')
  assert.ok(run.rows.some((row) => row.kind === 'stderr_encoding'), 'the decoding is a trace row of its own')

  // The unrecoverable case: the bytes are already gone upstream, so the observer says
  // so once instead of forwarding the garble as a diagnosis.
  const mangled = narrate()
  mangled.feed({ type: 'tool_result', callId: 'c', status: 'error', result: '\uFFFD\uFFFDģ\uFFFD\uFFFD Microsoft.PowerShell.Security' })
  assert.equal(mangled.count(/not valid UTF-8/), 1, 'mojibake that is already unrecoverable is explained once, not silently forwarded')
  assert.equal(mangled.count(/unrecoverable here/), 1, 'and it says the garbled part cannot be recovered here')
  assert.ok(mangled.rows.some((row) => row.kind === 'mojibake'))
  mangled.feed({ type: 'tool_result', callId: 'd', status: 'error', result: '\uFFFD again' })
  assert.equal(mangled.count(/not valid UTF-8/), 1, 'the explanation is a milestone, not a per-line alarm')
})

report(LABEL)
