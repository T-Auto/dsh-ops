/**
 * Live narration of one in-flight benchmark run (bench/README §4), plus the
 * structured trace the panel's "轨迹" tab reads back.
 *
 * Before this module existed the runner printed exactly one line per run, and only
 * once the run was over. On a machine where the model server is unreachable — or
 * where the candidate profile stalls in workspace preparation — an empty console for
 * fifteen minutes is indistinguishable from a healthy but slow run, so the honest
 * answer to "did it start? did it connect? is it stuck?" was "wait and find out".
 *
 * The observer answers that while the child is alive: it turns the NDJSON event
 * stream, the child's stderr and the wall clock into timestamped lines. It owns no
 * I/O, no `fs` and no timers of its own — the caller injects the log sink, the trace
 * sink, the clock and the heartbeat — which is what keeps every rule below testable
 * with a fake clock and an array.
 *
 * Two rules shape the wording:
 *
 * - **Milestones print always, chatter prints under `--verbose`.** Boot, the first
 *   request, the first model answer, missing usage, tool errors, `error` events, the
 *   turn outcome and the run outcome always print; every other step/tool/text line
 *   only when asked for. A quiet run stays legible, and a quiet run is exactly the
 *   case that used to read as a hang.
 * - **Silence gets a voice.** A heartbeat carrying the counters collected so far, plus
 *   an escalating stall warning, because "nothing printed" is the failure mode this
 *   module exists to expose.
 *
 * A third concern is the panel (issue #205 §四): every narrated line is ALSO appended
 * to an ordered trace (`observer.trace()`), each row carrying `at`/`offsetMs`, a
 * `role` for the timeline lane and the `kind` of the thing that happened. The trace is
 * a faithful copy of what was said — one row per line, nothing dropped for being
 * unfamiliar — so a panel can draw the timeline without re-parsing the event archive,
 * and a reader can still get at the raw NDJSON. The sink is injectable for the same
 * reason the log is: the runner can append rows to NDJSON while the sweep is alive.
 *
 * @module dsh-ops/bench/observe
 */

import { formatNumber } from './compare-core.mjs'

/** How many `tool_result` errors to name before the rest are only counted. */
const TOOL_ERROR_REPORTS = 5
/** How many stderr lines to echo under `--verbose` before the rest are only counted. */
const STDERR_REPORTS = 40
/** How many recent stderr lines the post-mortem can quote. */
const STDERR_TAIL = 3
/** Silence multiples at which the stall warning escalates (1×, 2×, 4×, 8× `stallMs`). */
const STALL_STEPS = [1, 2, 4, 8]

/** The levels a log sink can be handed; `warn` is the stderr level, the rest stdout. */
export const OBSERVER_LEVELS = ['info', 'detail', 'warn']

/**
 * The lanes a panel draws the trace in. `milestone` is the set of facts a reader
 * asked about (boot, first request, first answer), `raw` is the per-event line that
 * says "event #N of kind K" (the panel usually folds these into the lanes around
 * them), and `stall` is the only lane that means something is wrong.
 */
export const OBSERVER_TRACE_ROLES = ['boot', 'milestone', 'event', 'raw', 'tool', 'stderr', 'heartbeat', 'stall', 'outcome', 'note']

/** Legacy code pages worth trying when a child writes its diagnostics in the local OEM page. */
const FALLBACK_ENCODINGS = ['gbk', 'cp932', 'cp949', 'big5', 'windows-1252']

/**
 * Decode one line of a child's stderr, whatever code page it was written in.
 *
 * Windows PowerShell writes its errors in the console's OEM code page — cp936 on a zh-CN
 * machine — while every consumer here assumes UTF-8. The result is the worst possible
 * diagnostic: the one line that names the failure arrives as `??ģ??????`. UTF-8 is
 * always tried first and kept when it survives intact; only a decode that produces
 * replacement characters falls through to the legacy pages (an unknown label is ignored
 * by `TextDecoder` and yields UTF-8 again, so a machine without the legacy codecs simply
 * keeps the original text instead of crashing on it).
 * @param {Buffer|string} bytes - the raw line.
 * @returns {{text: string, encoding: string|null}} the decoded text and the page used.
 */
export function decodeConsoleBytes(bytes) {
  if (typeof bytes === 'string') return { text: bytes, encoding: null }
  const lossy = tryDecode(bytes, 'utf-8', false) ?? String(bytes)
  if (!lossy.includes('\uFFFD')) return { text: lossy, encoding: null }
  for (const encoding of FALLBACK_ENCODINGS) {
    const decoded = tryDecode(bytes, encoding, false)
    if (decoded !== null && !decoded.includes('\uFFFD')) return { text: decoded, encoding }
  }
  // Nothing decoded cleanly: keep the UTF-8 reading, replacement characters and all, so
  // the line still says something rather than throwing away the diagnostic.
  return { text: lossy, encoding: null }
}

/** Decode with `encoding`, or null when the runtime does not know it. */
function tryDecode(bytes, encoding, fatal) {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Render one parsed NDJSON event as a short human line (PLAN §2.2 vocabulary).
 *
 * Pure on purpose: a test can pin the wording of every event shape without a child
 * process, a clock or a stream. An event type this module does not know is NOT
 * swallowed: it narrates itself by name, so a future dsh that adds a telemetry event
 * shows up in the console and in the trace instead of looking like a lost line.
 * @param {object|null} event - the parsed event.
 * @returns {{kind: string, text: string}|null} the narration, or null for nothing worth saying.
 */
export function describeEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null
  switch (event.type) {
    case 'session':
      return { kind: 'session', text: `dsh booted — session ${text(event.sessionId)} in ${text(event.cwd)}` }
    case 'status': {
      const step = text(event.step)
      if (event.phase === 'turn_start') return { kind: 'turn_start', text: `turn ${text(event.turn)} started` }
      if (event.phase === 'step_start') return { kind: 'step_start', text: `step ${step}: request sent to the model …` }
      if (event.phase === 'step_end') {
        const usage = event.usage
        if (!usage || typeof usage !== 'object') {
          return { kind: 'step_end_no_usage', text: `step ${step} finished with NO usage — token totals will be n/a (the server must report usage: PLAN §2.6)` }
        }
        const buckets = [
          `in ${count(usage.inputTokens)}`,
          `out ${count(usage.outputTokens)}`,
          `cacheRead ${count(usage.cacheReadTokens)}`,
          `cacheWrite ${count(usage.cacheWriteTokens)}`,
        ]
        if (isNumeric(usage.totalTokens)) buckets.push(`total ${count(usage.totalTokens)}`)
        if (isNumeric(usage.reasoningTokens)) buckets.push(`reasoning ${count(usage.reasoningTokens)}`)
        return { kind: 'step_end', text: `step ${step}: model answered — ${buckets.join(' / ')}` }
      }
      if (event.phase === 'turn_end') {
        const kind = text(event.reason?.kind)
        const detail = text(event.reason?.message)
        return {
          kind: kind === 'completed' ? 'turn_end' : 'turn_end_failed',
          text: `turn ${text(event.turn)} ended: reason=${kind}${detail !== '?' ? ` — ${clip(detail)}` : ''}`,
        }
      }
      return { kind: `status_${text(event.phase)}`, text: `status: ${text(event.phase)}` }
    }
    case 'tool_call':
      return { kind: 'tool_call', text: `tool ${text(event.tool)} ← ${clip(payload(event.input))}` }
    case 'tool_result': {
      const status = text(event.status)
      const body = clip(payload(event.result))
      return { kind: status === 'error' ? 'tool_result_error' : 'tool_result', text: `tool result ${status}${body !== '?' ? `: ${body}` : ''}` }
    }
    case 'text':
      return { kind: 'text', text: `assistant text +${count(charLength(event.text))} chars${event.truncated === true ? ' (line truncated)' : ''}` }
    case 'thinking':
      return { kind: 'thinking', text: `reasoning +${count(charLength(event.text))} chars${event.truncated === true ? ' (line truncated)' : ''}` }
    case 'final':
      return { kind: 'final', text: `final answer received (${count(byteLength(event.text))} bytes)` }
    case 'error':
      return { kind: 'error', text: `dsh reported an error: ${clip(payload(event.message ?? event))}` }
    default:
      return { kind: text(event.type), text: `event type=${text(event.type)}${event.truncated === true ? ' (line truncated)' : ''}` }
  }
}

/**
 * A per-run live narrator and trace recorder.
 *
 * @param {object} [config] - the wiring.
 * @param {(level: string, text: string) => void} [config.log] - where lines go; defaults to nowhere.
 * @param {(row: object) => void} [config.trace] - where trace rows go as they happen; defaults to nowhere.
 * @param {{taskId?: string, repeatIndex?: number, position?: number, total?: number}} [config.run] - identity for the line prefix.
 * @param {boolean} [config.verbose] - print chatter, not just milestones.
 * @param {number} [config.heartbeatMs] - period of the "still running" line; 0 disables it.
 * @param {number} [config.stallMs] - silence at which the stall warning escalates; 0 disables it.
 * @param {() => number} [config.now] - the clock, injectable for tests.
 * @param {(fn: () => void, ms: number) => unknown} [config.setTimer] - the heartbeat scheduler.
 * @param {(handle: unknown) => void} [config.clearTimer] - its cancel counterpart.
 * @param {number} [config.maxMessageChars] - how long a quoted payload may get.
 * @returns {{started: Function, line: Function, stderr: Function, note: Function, finished: Function, dispose: Function, snapshot: Function, trace: Function}} the observer.
 */
export function createObserver(config = {}) {
  const {
    log = () => {},
    trace = () => {},
    run = {},
    verbose = false,
    heartbeatMs = 15_000,
    stallMs = 60_000,
    now = () => Date.now(),
    setTimer = (fn, ms) => setInterval(fn, ms),
    clearTimer = (handle) => clearInterval(handle),
    maxMessageChars = 200,
  } = config
  const tag = [run.taskId ?? 'run', run.repeatIndex === undefined || run.repeatIndex === null ? null : `r${run.repeatIndex}`]
    .filter(Boolean)
    .join(' ')
  const state = {
    startedAt: now(),
    lastEventAt: null,
    lastLogAt: null,
    lastKind: 'nothing yet',
    events: 0,
    steps: 0,
    stepsWithUsage: 0,
    toolCalls: 0,
    toolErrors: 0,
    stderrBytes: 0,
    stderrLines: 0,
    stderrTail: [],
    stderrCarry: Buffer.alloc(0),
    stallStep: 0,
    toolErrorReports: 0,
    milestones: new Set(),
    milestoneRows: [],
    timeline: [],
  }
  let heartbeat = null

  /** The counters a heartbeat, a stall warning and the outcome all quote. */
  const counted = () => ({
    events: state.events,
    steps: state.steps,
    stepsWithUsage: state.stepsWithUsage,
    toolCalls: state.toolCalls,
    toolErrors: state.toolErrors,
  })
  /** The same counters on one line, for the human reading the console. */
  const counterText = () => {
    const { events, steps, stepsWithUsage, toolCalls, toolErrors } = counted()
    return `${events} event(s), steps=${steps} (usage on ${stepsWithUsage}), tool calls=${toolCalls}${toolErrors ? `, tool errors=${toolErrors}` : ''}`
  }
  /**
   * Append one row to the trace. Every narrated line becomes exactly one row — the
   * trace is a copy of the narration, not a filtered highlight reel — so a reader can
   * always answer "what was said, when" from the same document the numbers came from.
   */
  const record = (level, line, shape) => {
    const row = {
      seq: state.timeline.length + 1,
      at: new Date(now()).toISOString(),
      offsetMs: Math.max(0, now() - state.startedAt),
      role: shape?.role ?? 'note',
      kind: shape?.kind ?? 'note',
      level,
      text: line,
      event: shape?.event ?? null,
      counters: shape?.counters ?? null,
    }
    state.timeline.push(row)
    // The milestone list is the subset a summary quotes, in the order it happened.
    if (row.role === 'boot' || row.role === 'milestone' || row.role === 'stall') state.milestoneRows.push(row)
    trace(row)
  }
  const emit = (level, message, shape = null) => {
    state.lastLogAt = now()
    const line = tag === '' ? message : `[${tag}] ${message}`
    log(level, line)
    record(level, line, shape)
    // The unrecoverable case: text that arrived already mangled (dsh decoded a PowerShell
    // diagnostic written in the local code page before it reached the JSON stream). The
    // bytes are gone by the time we see them, so say what happened instead of letting
    // `??ģ??????` stand as the diagnosis — README §1 names the cause and the cure.
    if (level !== 'detail' && line.includes('\uFFFD') && !state.milestones.has('mojibake')) {
      state.milestones.add('mojibake')
      const prefix = tag === '' ? '' : `[${tag}] `
      const warning = `${prefix}the text above is not valid UTF-8: a child wrote it in the local console code page and something decoded it as UTF-8 upstream. The garbled part is unrecoverable here — read the raw bytes in the archive with that code page. On a zh-CN Windows this is almost always the Microsoft.PowerShell.Security import failure of bench/README.md §1 (PSModulePath pollution): start the sweep from cmd.exe.`
      log('warn', warning)
      record('warn', warning, { role: 'milestone', kind: 'mojibake' })
    }
  }
  /** Print at most once per run — what separates a one-shot notice from a repeat. */
  const say = (level, message, onceKey, shape = null) => {
    if (state.milestones.has(onceKey)) return
    state.milestones.add(onceKey)
    emit(level, message, shape)
  }
  /**
   * Print a milestone the first time it happens, then demote every later occurrence of
   * the same fact to chatter.
   *
   * The distinction matters: "the model answered" is worth an unconditional line
   * exactly once, but the second, third and fortieth step of the same run are still
   * evidence that the run is moving, and dropping them silently would make a long run
   * look frozen again — the thing this module exists to prevent. `repeatMessage` lets
   * the demoted line drop the milestone framing instead of shouting it a second time.
   * The trace follows the same rule: the first occurrence lands in the `milestone`
   * lane, the repeats land in `event`, so a panel does not draw the same fact forty
   * times as forty milestones.
   */
  const once = (level, message, onceKey, repeatMessage = null, shape = null) => {
    if (state.milestones.has(onceKey)) {
      emit('detail', repeatMessage ?? message, shape === null ? null : { ...shape, role: 'event' })
      return
    }
    state.milestones.add(onceKey)
    emit(level, message, shape === null ? null : { ...shape, role: 'milestone' })
  }
  const since = (anchor) => formatClock(now() - anchor)
  const ago = (anchor) => `${Math.max(0, Math.round((now() - anchor) / 1000))}s`

  const observer = {
    /**
     * Announce the child that was just spawned, and start the heartbeat.
     * @param {{command?: string, args?: string[], cwd?: string, pid?: number|null, timeoutMs?: number, eventsFile?: string, stderrFile?: string, prompt?: string, model?: object}} spec - the spawn facts.
     * @returns {void}
     */
    started(spec = {}) {
      const head = [spec.command, ...(spec.args ?? [])].filter(Boolean).map((part) => clipArg(String(part))).join(' ')
      const model = spec.model && (spec.model.model || spec.model.provider)
        ? ` provider ${spec.model.provider ?? '?'}/model ${spec.model.model ?? '?'}`
        : ''
      emit('info', `spawn${model}: ${clip(head, 400)}`, { role: 'boot', kind: 'spawn' })
      emit('info', `pid=${spec.pid ?? 'n/a'} timeout=${Math.round((spec.timeoutMs ?? 0) / 1000)}s workspace=${spec.cwd ?? '?'} — waiting for dsh to boot (task text: ${clip(spec.prompt ?? '', 80)})`, { role: 'boot', kind: 'spawn_facts' })
      if (verbose) {
        emit('detail', `events archive → ${spec.eventsFile ?? '?'}`, { role: 'note', kind: 'archive' })
        emit('detail', `stderr archive → ${spec.stderrFile ?? '?'}`, { role: 'note', kind: 'archive' })
      }
      if (heartbeatMs <= 0) return
      heartbeat = setTimer(() => {
        const anchor = state.lastEventAt ?? state.startedAt
        const quiet = now() - anchor
        if (stallMs > 0) {
          const due = STALL_STEPS.find((multiple) => quiet >= multiple * stallMs && state.stallStep < multiple)
          if (due !== undefined) {
            state.stallStep = due
            emit('warn', `NO OUTPUT FOR ${ago(anchor)} (last event: ${state.lastKind}). The child is still alive (pid=${spec.pid ?? '?'}): either the model call is hanging, the server is unreachable, or one step is genuinely long. The archives say which: ${spec.eventsFile ?? 'results/'}`, { role: 'stall', kind: 'stall', counters: counted() })
            return
          }
        }
        if (now() - (state.lastLogAt ?? state.startedAt) < heartbeatMs) return
        emit('info', `still running ${since(state.startedAt)} — ${counterText()}, last=${state.lastKind} ${ago(anchor)} ago`, { role: 'heartbeat', kind: 'heartbeat', counters: counted() })
      }, heartbeatMs)
      // Never hold the process open on a timer alone: if the run throws past the
      // heartbeat, an owning timer turns a reported error into a real hang.
      if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref()
    },

    /**
     * Narrate one raw NDJSON line from the child's stdout.
     * @param {string} line - the raw line.
     * @returns {void}
     */
    line(line) {
      const raw = String(line ?? '')
      if (raw.trim() === '') return
      state.events += 1
      state.lastEventAt = now()
      let event = null
      try {
        event = JSON.parse(raw)
      } catch {
        state.lastKind = 'malformed line'
        say('warn', `the event stream produced a line that is not JSON: ${clip(raw, 160)}`, 'malformed', { role: 'event', kind: 'malformed' })
        return
      }
      const described = describeEvent(event)
      if (!described) return
      const kind = described.kind
      state.lastKind = kind
      observer.note('detail', `event #${state.events} ${kind}`, { role: 'raw', kind, event: text(event.type) })

      if (kind === 'tool_call') {
        state.toolCalls += 1
        emit('detail', `tool call #${state.toolCalls}: ${described.text.replace(/^tool /, '')}`, { role: 'tool', kind: 'tool_call', event: text(event.type) })
        return
      }
      if (kind === 'tool_result') {
        emit('detail', described.text, { role: 'tool', kind: 'tool_result', event: text(event.type) })
        return
      }
      if (kind === 'tool_result_error') {
        state.toolErrors += 1
        if (state.toolErrorReports < TOOL_ERROR_REPORTS) {
          state.toolErrorReports += 1
          emit('warn', `tool result error #${state.toolErrors} — ${described.text.replace(/^tool result error: ?/, '')}`, { role: 'tool', kind: 'tool_error', event: text(event.type) })
        } else {
          say('warn', 'later tool errors are counted but not printed (the archive keeps all of them)', 'tool-error-cap', { role: 'tool', kind: 'tool_error_cap' })
        }
        return
      }
      if (kind === 'text' || kind === 'thinking') {
        emit('detail', described.text, { role: 'event', kind, event: text(event.type) })
        return
      }
      if (kind === 'error') {
        emit('warn', described.text, { role: 'event', kind: 'error', event: text(event.type) })
        return
      }
      if (kind === 'turn_end_failed') {
        emit('warn', `${described.text} — headless exits non-zero on anything but "completed" (PLAN §2.2)`, { role: 'event', kind: 'turn_end_failed', event: text(event.type) })
        return
      }
      if (kind === 'step_end' || kind === 'step_end_no_usage') {
        state.steps += 1
        if (kind === 'step_end') {
          state.stepsWithUsage += 1
          // The four questions a stalled run needs answered, in the order they can be
          // answered. Each prints once at its milestone level; every later occurrence of
          // the same kind is the same fact about a different step, so it drops to
          // chatter — a long run keeps saying "still moving", a quiet one says it four
          // times instead of forty.
          once('info', `model connection OK — ${described.text}`, 'first-response', described.text, { role: 'milestone', kind: 'step_end', event: text(event.type) })
          return
        }
        once('warn', described.text, 'no-usage', null, { role: 'milestone', kind: 'step_no_usage', event: text(event.type) })
        return
      }
      if (kind === 'session') {
        once('info', `${described.text} — startup OK`, 'boot', null, { role: 'boot', kind: 'session', event: text(event.type) })
        return
      }
      if (kind === 'step_start') {
        once('info', `${described.text} — the first request is out; if this is the last line you see, the model call is the suspect`, 'first-request', described.text, { role: 'milestone', kind: 'step_start', event: text(event.type) })
        return
      }
      if (kind === 'turn_end') {
        once('info', described.text, `turn_end_${text(event.turn)}`, null, { role: 'milestone', kind: 'turn_end', event: text(event.type) })
        return
      }
      if (kind === 'final') {
        once('info', described.text, 'final', null, { role: 'milestone', kind: 'final', event: text(event.type) })
        return
      }
      emit('detail', described.text, { role: 'event', kind, event: text(event.type) })
    },

    /**
     * Narrate a chunk of the child's stderr as it arrives.
     *
     * Buffered by *byte*, not by character: a diagnostic written in the local OEM code
     * page arrives exactly as PowerShell wrote it, and a character-wise decode of a chunk
     * boundary would corrupt the very line that explains the failure.
     * @param {string|Buffer} chunk - the raw bytes.
     * @returns {void}
     */
    stderr(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
      if (bytes.length === 0) return
      state.stderrBytes += bytes.length
      let buffer = Buffer.concat([state.stderrCarry, bytes])
      let cut = buffer.indexOf(0x0a)
      while (cut !== -1) {
        const raw = buffer.subarray(0, cut)
        buffer = buffer.subarray(cut + 1)
        const decoded = decodeConsoleBytes(raw)
        const line = decoded.text.trim()
        if (line !== '') {
          state.stderrLines += 1
          state.stderrTail.push(line)
          if (state.stderrTail.length > STDERR_TAIL) state.stderrTail.shift()
          if (decoded.encoding) {
            say('warn', `stderr was written in the local code page ${decoded.encoding}, not UTF-8 — decoded it for you; the bytes are unchanged in the archive`, 'stderr-encoding', { role: 'stderr', kind: 'stderr_encoding' })
          }
          say('warn', `dsh is writing to stderr — first line: "${clip(line, maxMessageChars)}" (the archive keeps all of them)`, 'first-stderr', { role: 'stderr', kind: 'stderr' })
          if (verbose && state.stderrLines <= STDERR_REPORTS) emit('detail', `stderr | ${clip(line, maxMessageChars)}`, { role: 'stderr', kind: 'stderr_line' })
          else if (verbose) say('detail', 'later stderr lines go to the archive only', 'stderr-cap', { role: 'stderr', kind: 'stderr_cap' })
        }
        cut = buffer.indexOf(0x0a)
      }
      state.stderrCarry = buffer
    },

    /**
     * Say something outside the stream (fixture building, verification, killing).
     * @param {string} level - one of OBSERVER_LEVELS.
     * @param {string} message - the text.
     * @param {{role?: string, kind?: string, event?: string|null}} [shape] - the trace lane this line belongs to.
     * @returns {void}
     */
    note(level, message, shape = null) {
      emit(level, message, shape)
    },

    /**
     * The current counters, recorded into the metrics document.
     * @returns {object} a snapshot.
     */
    snapshot() {
      return {
        events: state.events,
        steps: state.steps,
        stepsWithUsage: state.stepsWithUsage,
        toolCalls: state.toolCalls,
        toolErrors: state.toolErrors,
        stderrBytes: state.stderrBytes,
        stderrLines: state.stderrLines,
        lastKind: state.lastKind,
        silentMs: state.lastEventAt === null ? null : now() - state.lastEventAt,
        elapsedMs: now() - state.startedAt,
        // Additive for the panel: the milestones worth quoting, and how many trace rows
        // the full timeline holds. `observer.trace()` returns the rows themselves.
        traceRows: state.timeline.length,
        milestones: state.milestoneRows.map((row) => ({ seq: row.seq, at: row.at, offsetMs: row.offsetMs, kind: row.kind, text: row.text })),
      }
    },

    /**
     * Every trace row so far, in order. The live array, not a copy: a caller that
     * writes rows out as they arrive (the crash-safe NDJSON path) can rely on the sink
     * and this accessor agreeing, and no consumer needs two copies of the same run.
     * @returns {object[]} the rows.
     */
    trace() {
      return state.timeline
    },

    /**
     * Narrate the outcome and stop the heartbeat.
     * @param {{exitCode?: number|null, timedOut?: boolean, interrupted?: boolean, spawnError?: string|null, timeoutMs?: number}} outcome - what happened.
     * @returns {void}
     */
    finished(outcome = {}) {
      observer.dispose()
      const counters = counterText()
      const failed = outcome.timedOut || outcome.interrupted || Boolean(outcome.spawnError) || (outcome.exitCode !== null && outcome.exitCode !== undefined && outcome.exitCode !== 0)
      if (outcome.interrupted) {
        emit('warn', `interrupted by the operator after ${since(state.startedAt)} — the child and its tree were killed. ${counters}; last event ${state.lastKind}${state.lastEventAt === null ? ' (none reached the stream)' : `, ${ago(state.lastEventAt)} ago`}`, { role: 'outcome', kind: 'interrupted', counters: counted() })
      } else if (outcome.timedOut) {
        emit('warn', `TIMEOUT after ${Math.round((outcome.timeoutMs ?? 0) / 1000)}s — the child was killed. ${counters}; it never got past "${state.lastKind}"${state.lastEventAt === null ? ' (it produced no event at all)' : `, last event ${ago(state.lastEventAt)} ago`}`, { role: 'outcome', kind: 'timeout', counters: counted() })
      } else if (outcome.spawnError) {
        emit('warn', `the child could not be spawned: ${clip(String(outcome.spawnError), maxMessageChars)}`, { role: 'outcome', kind: 'spawn_error', counters: counted() })
      } else if (failed) {
        emit('warn', `dsh exited ${outcome.exitCode} after ${since(state.startedAt)} — ${counters}, last event=${state.lastKind}`, { role: 'outcome', kind: 'exit_nonzero', counters: counted() })
      } else {
        emit('info', `dsh exited 0 after ${since(state.startedAt)} — ${counters}`, { role: 'outcome', kind: 'exit_zero', counters: counted() })
      }
      if (failed && state.stderrTail.length > 0) {
        emit('warn', `stderr tail: ${state.stderrTail.map((line) => clip(line, maxMessageChars)).join(' ⏐ ')}`, { role: 'outcome', kind: 'stderr_tail', counters: counted() })
      }
      if (failed && state.events === 0) {
        emit('warn', 'not one event reached the stream: dsh never started printing --json output, so this is a startup problem (profile, plugin, sandbox, terminal), not a model answer', { role: 'outcome', kind: 'no_events', counters: counted() })
      }
    },

    /**
     * Cancel the heartbeat. Idempotent.
     * @returns {void}
     */
    dispose() {
      if (heartbeat === null) return
      clearTimer(heartbeat)
      heartbeat = null
    },
  }
  return observer
}

/**
 * Render milliseconds as `1m07s`.
 * @param {number} ms - the duration.
 * @returns {string} the clock form.
 */
export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

/** A scalar field rendered for humans, with '?' for anything absent. */
function text(value) {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number') return String(value)
  return '?'
}

/** Whether a usage field is a usable, non-zero number. */
function isNumeric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0
}

/** A count rendered for humans. */
function count(value) {
  return isNumeric(value) ? formatNumber(value) : '0'
}

/** Character length of a payload. */
function charLength(value) {
  return typeof value === 'string' ? value.length : 0
}

/** UTF-8 byte length of a payload. */
function byteLength(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0
}

/** Render a tool payload (parsed object or raw string) for one line. */
function payload(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Clamp a string to a single line of at most `max` characters, marking the cut. */
function clip(value, max = 200) {
  const line = String(value ?? '').replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max)}…`
}

/** Clip one argument of a rendered command line, keeping short paths whole. */
function clipArg(part) {
  return part.length > 120 ? `${part.slice(0, 117)}…` : part
}
