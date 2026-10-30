/** Pure append-log recovery, document folding and bounded serialization. */
import { object, finite, foldEvent } from './types.js'
import { PANEL_FORMAT, PANEL_DEFAULTS } from './config.js'
import type { Row, TextField, CoreBucket, UsageBucket, CaptureEvent, ArchiveMember, FoldedEvents, FoldContext } from './types.js'
const string = (value: unknown) => typeof value === 'string' && value !== '' ? value : undefined
const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
// View guards: a pathological session must not turn the trace into the document.
const TRACE_LIMIT = 20_000
const CONVERSATION_LIMIT = 20_000
/** Distinct tool names the histogram keeps before folding the rest into `(other)`. */
const TOOL_NAME_LIMIT = 64
/** Characters of a tool name line kept in a trace preview. */
const PREVIEW_CHARS = 120
/** The four core usage buckets in `bench/run.schema.json` order, and the optional ones. */
const USAGE_BUCKETS: readonly CoreBucket[] = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
const OPTIONAL_BUCKETS: readonly UsageBucket[] = Object.freeze(['reasoningTokens', 'totalTokens'])

/**
 * Read one NDJSON append log, counting lines that are not objects instead of
 * failing the whole fold on one bad byte sequence.
 * @param {string} text - the file contents.
 * @returns {{records: object[], malformed: number}} the parsed records.
 */
export function parseAppendLog(text: string): { records: Row[]; malformed: number } {
  const records: Row[] = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (object(parsed) && !Array.isArray(parsed)) records.push(parsed)
      else malformed += 1
    } catch { malformed += 1 }
  }
  return { records, malformed }
}

/** A fresh four-bucket usage total. */
const emptyUsage = (): Record<CoreBucket, number> & { grandTotal: number; reasoningTokens?: number } => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, grandTotal: 0 })
/** One conversation row: the fields every captured message shares. */
function messageRow(record: CaptureEvent, role: string) {
  const payload = record.payload ?? {}
  return {
    seq: record.seq, time: record.time, at: new Date(record.time).toISOString(), role,
    turn: record.turn, step: record.step, callId: record.callId,
    text: payload.text ?? '', chars: payload.chars ?? 0,
    truncated: payload.truncated === true, droppedChars: payload.droppedChars ?? 0,
  }
}

/** One trace row, in the lane vocabulary the panel draws. */
function traceRow(record: CaptureEvent, lane: string, kind: string, extra: Row = {}) {
  return { seq: record.seq, time: record.time, at: new Date(record.time).toISOString(), lane, kind, ...extra }
}

/**
 * Fold one session's records into the document `panel.html` reads.
 * @param {object[]} records - parsed append-log records, in order.
 * @param {{config?: object, meta?: object, droppedEvents?: number, malformed?: number}} [context] - fold inputs.
 * @returns {object} the panel document.
 */
export function foldRecords(records: readonly unknown[], context: FoldContext = {}) {
  const config = context.config ?? PANEL_DEFAULTS
  const supplied = { ...(context.meta ?? {}) }
  const conversation: Row[] = []
  const trace: Row[] = []
  const pending = new Map<string, { name: string; startedAt: number }>()
  const usage = emptyUsage()
  const bucketNames = new Set<string>()
  const eventTypes: Record<string, number> = {}
  const toolCallsByName: Record<string, number> = {}
  const counters = {
    turns: 0, steps: 0, stepsWithUsage: 0, toolCalls: 0, toolErrors: 0,
    textChars: 0, thinkingChars: 0, eventCount: 0, usageReported: (context.malformed ?? 0) === 0,
  }
  let sessionId: string | undefined
  let cwd: string | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  let turnEndReason: string | undefined
  let capped = false
  let conversationTruncated = false
  let traceTruncated = false
  let droppedChars = 0
  let malformedRecords = 0

  const mark = (ms: number) => {
    if (!Number.isFinite(ms) || ms <= 0) return
    if (startedAt === undefined || ms < startedAt) startedAt = ms
    if (endedAt === undefined || ms > endedAt) endedAt = ms
  }
  const pushConversation = (row: Row) => {
    if (conversation.length >= CONVERSATION_LIMIT) conversationTruncated = true
    else conversation.push(row)
  }
  const pushTrace = (row: Row) => {
    if (trace.length >= TRACE_LIMIT) traceTruncated = true
    else trace.push(row)
  }
  const preview = (value: unknown) => String(value ?? '').replace(/\s+/gu, ' ').slice(0, PREVIEW_CHARS)
  const dropped = (field: TextField | null | undefined) => { if (field?.truncated === true) droppedChars += field.droppedChars ?? 0 }

  for (const record of records) {
    if (!object(record) || Array.isArray(record)) continue
    if (record.record === 'open') {
      sessionId = string(record.sessionId) ?? sessionId
      cwd = string(record.cwd) ?? cwd
      continue
    }
    if (record.record === 'capped') { capped = true; continue }
    if (record.record !== 'event') continue
    if (!foldEvent(record)) { malformedRecords += 1; counters.usageReported = false; continue }
    const time = Number.isFinite(record.time) && record.time >= 0 ? record.time : 0
    counters.eventCount += 1
    eventTypes[record.type] = (eventTypes[record.type] ?? 0) + 1
    mark(time)
    const payload = record.payload ?? {}
    dropped(payload)
    dropped(record.reasoning)
    dropped(record.arguments)
    switch (record.type) {
      case 'user/message':
        pushConversation({ ...messageRow(record, 'user'), source: record.source })
        pushTrace(traceRow(record, 'milestone', 'user_message', { text: preview(payload.text) }))
        break
      case 'assistant/message': {
        const calls = Array.isArray(record.toolCalls) ? record.toolCalls.filter((name) => typeof name === 'string') : []
        counters.textChars += payload.chars ?? 0
        counters.thinkingChars += record.reasoning?.chars ?? 0
        if (record.usageReported === true) {
          counters.stepsWithUsage += 1
          for (const bucket of Array.isArray(record.usageBuckets) ? record.usageBuckets : []) bucketNames.add(bucket)
          for (const key of USAGE_BUCKETS) usage[key] += record.usage?.[key] ?? 0
          if (finite(record.usage?.reasoningTokens)) usage.reasoningTokens = (usage.reasoningTokens ?? 0) + record.usage.reasoningTokens
        } else counters.usageReported = false
        pushConversation({ ...messageRow(record, 'assistant'), reasoning: record.reasoning?.text ?? '', toolCalls: calls, interrupted: record.interrupted === true })
        pushTrace(traceRow(record, 'milestone', record.interrupted === true ? 'assistant_interrupted' : 'assistant_message', {
          text: calls.length > 0 ? `assistant → ${calls.join(', ')}` : preview(payload.text),
        }))
        break
      }
      case 'tool/call': {
        counters.toolCalls += 1
        const name = record.name ?? '(unnamed)'
        const key = Object.hasOwn(toolCallsByName, name) || Object.keys(toolCallsByName).length < TOOL_NAME_LIMIT ? name : '(other)'
        toolCallsByName[key] = (toolCallsByName[key] ?? 0) + 1
        if (record.callId !== undefined) pending.set(record.callId, { name, startedAt: time })
        pushTrace(traceRow(record, 'tool_call', 'tool_call', {
          name, callId: record.callId, step: record.step, text: preview(record.arguments?.text),
        }))
        break
      }
      case 'tool/result': {
        const call = record.callId === undefined ? undefined : pending.get(record.callId)
        if (record.callId !== undefined) pending.delete(record.callId)
        const failed = record.isError === true
        if (failed) counters.toolErrors += 1
        pushConversation({ ...messageRow(record, 'tool'), isError: failed })
        pushTrace(traceRow(record, 'tool_result', failed ? 'tool_error' : 'tool_result', {
          name: call?.name, callId: record.callId, isError: failed, errorCode: record.errorCode, step: record.step,
          durationMs: call === undefined ? undefined : Math.max(0, time - call.startedAt),
          text: failed ? `${call?.name ?? 'tool'} failed${record.errorCode ? ` (${record.errorCode})` : ''}` : preview(payload.text),
        }))
        break
      }
      case 'step/start': case 'step/end':
        if (record.type === 'step/start') counters.steps += 1
        pushTrace(traceRow(record, 'milestone', record.type === 'step/start' ? 'step_start' : 'step_end', {
          step: record.step, text: record.type === 'step/start' ? 'request sent' : 'step finished',
        }))
        break
      case 'turn/start':
        counters.turns += 1
        pushTrace(traceRow(record, 'milestone', 'turn_start', { text: 'turn started' }))
        break
      case 'turn/end':
        turnEndReason = record.reason ?? turnEndReason
        pushTrace(traceRow(record, 'milestone', 'turn_end', {
          reason: record.reason, text: `turn ended${record.reason ? ` (${record.reason})` : ''}`,
        }))
        break
      case 'assistant/attempt':
        pushTrace(traceRow(record, 'error', 'assistant_attempt', { text: 'model attempt committed no message' }))
        break
      default:
        break
    }
  }
  usage.grandTotal = USAGE_BUCKETS.reduce((total, key) => total + usage[key], 0)
  const at = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())
  const events: FoldedEvents = { layout: 'merged', merged: true, mergedAt: undefined,
    records: counters.eventCount, malformed: (context.malformed ?? 0) + malformedRecords, types: eventTypes, files: [] }
  const archive: ArchiveMember[] = []
  return {
    schemaVersion: 1,
    format: PANEL_FORMAT,
    meta: {
      pluginVersion: string(supplied.pluginVersion), platform: string(supplied.platform) ?? process.platform,
      node: string(supplied.node) ?? process.version,
      argv: Array.isArray(supplied.argv) ? supplied.argv.map((value) => String(value)) : [],
      sessionId, cwd, startedAt: at(startedAt), endedAt: at(endedAt),
    },
    metrics: {
      format: PANEL_FORMAT, sessionId, startedAt: at(startedAt), endedAt: at(endedAt),
      durationMs: startedAt === undefined || endedAt === undefined ? 0 : Math.max(0, endedAt - startedAt),
      ...counters, toolCallsByName, usage, usageBucketsSeen: [...bucketNames].sort(),
      turnEndReason, malformed: (context.malformed ?? 0) + malformedRecords,
    },
    conversation,
    trace,
    verify: {
      checks: 0, passed: 0, failed: 0,
      degraded: capped || conversationTruncated || traceTruncated || events.malformed > 0,
      notes: [
        '实时采集没有 verifier:「判卷」标签页只反映采集自身的完整性,不代表任何任务的通过情况。',
        '只有挂载之后产生的事件会被采集;挂载之前的历史与已恢复的会话前缀不回放。',
      ],
    },
    events,
    archive,
    limits: {
      textLimit: config.textLimit ?? PANEL_DEFAULTS.textLimit, maxSessionBytes: config.maxSessionBytes ?? PANEL_DEFAULTS.maxSessionBytes,
      truncated: capped, droppedEvents: context.droppedEvents ?? 0, droppedChars,
      traceTruncated, conversationTruncated, trimmed: false, trimmedRows: 0,
    },
  }
}

/**
 * Shrink a document until it fits `cap`, dropping the oldest view rows first.
 * Metrics and usage totals are never dropped: they stay the complete accounting.
 * @returns {{text: string, bytes: number, trimmedRows: number}} the fitted text.
 */
export function fitDocument(document: ReturnType<typeof foldRecords>, cap: number) {
  let text = JSON.stringify(document)
  let size = bytes(text)
  let trimmedRows = 0
  while (size > cap && (document.conversation.length > 0 || document.trace.length > 0)) {
    const batch = Math.max(1, Math.ceil((size - cap) / 256))
    if (document.trace.length >= document.conversation.length) trimmedRows += document.trace.splice(0, batch).length
    else trimmedRows += document.conversation.splice(0, batch).length
    text = JSON.stringify(document)
    size = bytes(text)
  }
  document.limits.trimmed = trimmedRows > 0
  document.limits.trimmedRows = trimmedRows
  if (trimmedRows > 0) { text = JSON.stringify(document); size = bytes(text) }
  return { text, bytes: size, trimmedRows }
}
