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
/** Recent call ids that job records can resolve to a named tool. */
const CALL_NAME_LIMIT = 2_048
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

function replacedSeq(record: CaptureEvent): number | undefined {
  const op = record.surfaceOp
  if (!op || op.startSeq !== op.endSeq || op.startSeq >= record.seq) return undefined
  if (record.sourceEventSeqs !== undefined && !record.sourceEventSeqs.includes(op.startSeq)) return undefined
  return op.startSeq
}

/** Retain details only for results named by a later replacement, even outside the visible views. */
function replacementTargets(records: readonly unknown[]): Set<number> {
  const targets = new Set<number>()
  for (const record of records) {
    if (!object(record) || Array.isArray(record) || record.record !== 'event'
      || record.type !== 'tool/result' || record.surfaceOp === undefined || !foldEvent(record)) continue
    const target = replacedSeq(record)
    if (target !== undefined) targets.add(target)
  }
  return targets
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
  const conversation = new Set<Row>()
  const trace = new Set<Row>()
  const pending = new Map<string, { name: string; startedAt: number }>()
  const callNames = new Map<string, string>()
  const targets = replacementTargets(records)
  const replacedResults = new Map<number, { trace: Row; conversation: Row; name?: string; durationMs?: number; failed: boolean; dropped: number }>()
  let pruneReplacements = 0
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
    if (conversation.size >= CONVERSATION_LIMIT) conversationTruncated = true
    else conversation.add(row)
  }
  const pushTrace = (row: Row) => {
    if (trace.size >= TRACE_LIMIT) traceTruncated = true
    else trace.add(row)
  }
  const preview = (value: unknown) => String(value ?? '').replace(/\s+/gu, ' ').slice(0, PREVIEW_CHARS)
  const dropped = (field: TextField | null | undefined) => field?.truncated === true ? field.droppedChars ?? 0 : 0
  const rememberCall = (callId: string, name: string) => {
    callNames.set(callId, name)
    const oldest = callNames.keys().next()
    if (callNames.size > CALL_NAME_LIMIT && oldest.done !== true) callNames.delete(oldest.value)
  }

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
    const eventDropped = dropped(payload) + dropped(record.reasoning) + dropped(record.arguments)
    droppedChars += eventDropped
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
        if (record.callId !== undefined) {
          pending.set(record.callId, { name, startedAt: time })
          rememberCall(record.callId, name)
        }
        pushTrace(traceRow(record, 'tool_call', 'tool_call', {
          name, callId: record.callId, step: record.step, text: preview(record.arguments?.text),
        }))
        break
      }
      case 'tool/result': {
        const call = record.callId === undefined ? undefined : pending.get(record.callId)
        if (record.callId !== undefined) pending.delete(record.callId)
        const failed = record.isError === true
        const supersedes = replacedSeq(record)
        const original = supersedes === undefined ? undefined : replacedResults.get(supersedes)
        if (original !== undefined && supersedes !== undefined) {
          // Free each view's slot before admitting the replacement at capacity.
          conversation.delete(original.conversation)
          trace.delete(original.trace)
          replacedResults.delete(supersedes)
          pruneReplacements += 1
          if (original.failed) counters.toolErrors -= 1
          droppedChars -= original.dropped
        }
        if (failed) counters.toolErrors += 1
        const name = original?.name ?? call?.name
        const durationMs = original?.durationMs ?? (call === undefined ? undefined : Math.max(0, time - call.startedAt))
        const isReplacement = original !== undefined
        const conversationRow = { ...messageRow(record, 'tool'), isError: failed }
        const row = traceRow(record, 'tool_result', failed ? 'tool_error' : 'tool_result', {
          name, callId: record.callId, isError: failed, errorCode: record.errorCode, step: record.step, durationMs,
          ...(isReplacement ? { supersedes, pruned: true } : {}),
          text: failed ? `${name ?? 'tool'} failed${record.errorCode ? ` (${record.errorCode})` : ''}`
            : preview(payload.text) + (isReplacement ? ` · 已裁剪（替换 #${supersedes}）` : ''),
        })
        pushConversation(conversationRow)
        pushTrace(row)
        if (targets.has(record.seq)) {
          replacedResults.set(record.seq, { trace: row, conversation: conversationRow, name, durationMs, failed, dropped: eventDropped })
        }
        break
      }
      case 'tool/ptc-dispatch-start': case 'tool/ptc-dispatch': {
        const settled = record.type === 'tool/ptc-dispatch', failed = settled && record.isError === true
        if (record.callId !== undefined && record.name !== undefined && record.name !== '(unnamed)') rememberCall(record.callId, record.name)
        pushTrace(traceRow(record, failed ? 'error' : 'tool_result', failed ? 'ptc_dispatch_error' : settled ? 'ptc_dispatch' : 'ptc_dispatch_start', {
          name: record.name, callId: record.callId, rootCallId: record.rootCallId, parentCallId: record.parentCallId,
          isError: failed, errorCode: record.errorCode, arguments: record.arguments?.text, payload: record.payload?.text,
          text: failed ? `${record.name ?? 'tool'} failed${record.errorCode ? ` (${record.errorCode})` : ''}`
            : preview(record.payload?.text ?? record.arguments?.text),
        }))
        break
      }
      case 'job/registered': case 'job/settled': {
        const name = record.callId === undefined ? undefined : callNames.get(record.callId)
        pushTrace(traceRow(record, record.status === 'failed' || record.status === 'killed' ? 'error' : 'milestone',
          record.type === 'job/settled' ? 'job_settled' : 'job_registered', {
            jobId: record.jobId, name: name ?? record.kind, jobKind: record.kind, callId: record.callId, rootCallId: record.rootCallId,
            status: record.status, text: preview(payload.text), payload: payload.text,
          }))
        break
      }
      case 'agent/inbox/spliced':
        pushTrace(traceRow(record, 'milestone', 'inbox_spliced', {
          target: record.target, start: record.start, inserted: record.insertedCount ?? 0, removed: record.removedCount ?? 0,
          text: preview(payload.text), payload: payload.text,
        }))
        break
      case 'todo/write':
        pushTrace(traceRow(record, 'milestone', 'todo_write', { text: preview(payload.text), payload: payload.text }))
        break
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
    conversation: [...conversation],
    trace: [...trace],
    verify: {
      checks: 0, passed: 0, failed: 0,
      degraded: capped || conversationTruncated || traceTruncated || events.malformed > 0,
      notes: [
        ...(pruneReplacements > 0 ? ['宿主裁剪的工具结果显示替换行。事件计数保留原始事件数。'] : []),
        '实时采集没有 verifier:「判卷」标签页只反映采集自身的完整性,不代表任何任务的通过情况。',
        '只有挂载之后产生的事件会被采集;挂载之前的历史与已恢复的会话前缀不回放。',
      ],
    },
    events,
    archive,
    limits: {
      ...(pruneReplacements > 0 ? { pruneReplacements } : {}),
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
