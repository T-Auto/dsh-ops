/** Pure projection from host events into bounded capture records. */
import { object, field, finite } from './types.js'
import { PANEL_DEFAULTS } from './config.js'
import type { Row, PanelConfig, Usage, UsageBucket, CaptureEvent, CoreBucket, SurfaceOp } from './types.js'
/** The four core usage buckets in `bench/run.schema.json` order, and the optional ones. */
const USAGE_BUCKETS: readonly CoreBucket[] = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
const OPTIONAL_BUCKETS: readonly UsageBucket[] = Object.freeze(['reasoningTokens', 'totalTokens'])

/** Clamp one text field, naming what was dropped so a reader can tell truncation apart. */
function clamp(value: unknown, limit: number) {
  const full = typeof value === 'string' ? value : ''
  if (full.length <= limit) return { text: full, chars: full.length, truncated: false, droppedChars: 0 }
  return { text: full.slice(0, limit), chars: full.length, truncated: true, droppedChars: full.length - limit }
}

/**
 * Text a durable event value carries. The host writes PTC `arguments` as detached JSON
 * values rather than strings, so serialise them once here: strings stay verbatim, other
 * JSON values become their JSON text, and nothing is ever rendered as `[object Object]`.
 */
function argumentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : ''
  } catch { return '' }
}

/** Non-negative safe integer, or undefined. */
const integer = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined)
/** Non-empty string, or undefined. */
const string = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

/**
 * The host's surface replacement, kept only when it supersedes exactly one earlier
 * event: the panel needs it to stop drawing the superseded row twice.
 */
function replacement(event: unknown): { surfaceOp: SurfaceOp; sourceEventSeqs: number[] } | undefined {
  const op = field(event, 'surfaceOp')
  if (!object(op) || string(op.op) !== 'replace') return undefined
  const startSeq = integer(op.startSeq)
  const endSeq = integer(op.endSeq)
  if (startSeq === undefined || endSeq === undefined) return undefined
  const seqs = field(event, 'sourceEventSeqs')
  return {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: Array.isArray(seqs) ? seqs.filter((seq): seq is number => integer(seq) !== undefined) : [],
  }
}

/** Message content blocks of one type, in order; anything unrecognised is skipped. */
function blocks(message: unknown, type: string): Row[] {
  const content = field(message, 'content')
  if (!Array.isArray(content)) return []
  return content.filter((block: unknown): block is Row => object(block) && block.type === type)
}

/** Concatenate the text of one content-block type, and name the tool calls, in order. */
function joined(message: unknown, type: string): string {
  return blocks(message, type).filter((block) => typeof block.text === 'string').map((block) => block.text).join('\n')
}
function toolNames(message: unknown): string[] {
  return blocks(message, 'tool-call').flatMap(block => typeof block.name === 'string' ? [block.name] : [])
}
/** Text a content value carries: a plain string, or the text blocks of a block array. */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const text: string[] = []
  for (const block of value) {
    if (field(block, 'type') !== 'text') continue
    const part = field(block, 'text')
    if (typeof part === 'string') text.push(part)
  }
  return text.join('\n')
}

/** Project one usage report onto the core buckets plus the optional ones actually sent. */
function projectUsage(usage: unknown) {
  if (!object(usage)) return { reported: false, usage: {}, buckets: [] }
  const projected: Usage = {}
  const buckets: UsageBucket[] = []
  for (const key of [...USAGE_BUCKETS, ...OPTIONAL_BUCKETS]) {
    const value = usage[key]
    if (finite(value) && value >= 0) { projected[key] = Math.round(value); buckets.push(key) }
  }
  return { reported: USAGE_BUCKETS.every((key) => key in projected), usage: projected, buckets }
}

/**
 * Project one session event onto the bounded append-log record. An event this
 * module does not recognise is still recorded by type, so a newer harness shows
 * up in the document instead of vanishing.
 * @returns {object|undefined} the projected record, or undefined when it is unusable.
 */
export function projectEvent(event: unknown, config: PanelConfig = PANEL_DEFAULTS): CaptureEvent | undefined {
  if (!object(event)) return undefined
  const type = string(event.type)
  const seq = integer(event.seq)
  if (type === undefined || seq === undefined) return undefined
  const time = finite(event.time) && event.time >= 0 ? event.time : 0
  const base = { seq, time, type }
  const data = event.data
  if (!object(data)) return base
  switch (type) {
    case 'user/message':
      return { ...base, role: 'user', source: string(field(data.source, 'kind')), payload: clamp(joined(data, 'text'), config.textLimit) }
    case 'assistant/message': {
      const usage = projectUsage(data.usage)
      return { ...base, role: 'assistant', turn: integer(data.turn), step: integer(data.step),
        interrupted: data.interrupted === true, toolCalls: toolNames(data.message),
        payload: clamp(joined(data.message, 'text'), config.textLimit),
        reasoning: clamp(joined(data.message, 'reasoning'), config.textLimit),
        usage: usage.usage, usageReported: usage.reported, usageBuckets: usage.buckets }
    }
    case 'tool/call':
      return {
        ...base, callId: string(data.callId), name: string(data.name) ?? '(unnamed)', turn: integer(data.turn), step: integer(data.step),
        arguments: clamp(typeof data.arguments === 'string' ? data.arguments : '', config.textLimit),
      }
    case 'tool/result': {
      const surface = replacement(event)
      return {
        ...base, callId: string(field(field(data.message, 'source'), 'callId')) ?? string(field(data.message, 'toolCallId')),
        isError: field(data.message, 'isError') === true, errorCode: string(field(data.error, 'code')), turn: integer(data.turn), step: integer(data.step),
        payload: clamp(joined(data.message, 'text'), config.textLimit),
        ...(surface === undefined ? {} : surface),
      }
    }
    case 'turn/start': case 'turn/end': case 'step/start': case 'step/end':
      return {
        ...base, turn: integer(data.turn), step: integer(data.step),
        reason: string(field(data.reason, 'kind')) ?? string(field(data.reason, 'message')),
      }
    // A `run_code` program reaches every tool through PTC, so these two events are the
    // only record of which inner tool ran, what it was given, and what it answered.
    case 'tool/ptc-dispatch-start':
      return {
        ...base, callId: string(data.subCallId), name: string(data.name) ?? '(unnamed)',
        arguments: clamp(argumentText(data.arguments), config.textLimit),
      }
    case 'tool/ptc-dispatch':
      return {
        ...base, callId: string(data.subCallId), name: string(data.name) ?? '(unnamed)', isError: data.isError === true,
        errorCode: string(field(data.error, 'code')),
        arguments: clamp(argumentText(data.arguments), config.textLimit),
        payload: clamp(contentText(data.content), config.textLimit),
      }
    // Job lifecycle: without the id, a registration that never settles cannot be attributed.
    // The host names no tool here: `toolCall` carries only `callId`, so the reader joins
    // that id against the `tool/call` record instead of inventing a name from `kind`.
    case 'job/registered': case 'job/settled':
      return {
        ...base, jobId: string(data.jobId), callId: string(field(data.toolCall, 'callId')),
        kind: string(data.kind), status: string(data.status),
        payload: clamp([string(data.label), string(data.detail)].filter(Boolean).join(' — '), config.textLimit),
      }
    // An inbox splice can merge away a pending turn; keep what it merged and how much.
    case 'agent/inbox/spliced': {
      const inserted = Array.isArray(data.inserted) ? data.inserted : []
      return {
        ...base, target: string(data.target), insertedCount: inserted.length,
        removedCount: integer(data.removedCount) ?? 0,
        payload: clamp(inserted.map((message: unknown) => joined(message, 'text')).filter(text => text !== '').join('\n'), config.textLimit),
      }
    }
    case 'todo/write': {
      const todos = Array.isArray(data.todos) ? data.todos : []
      const lines = todos.map((todo: unknown) => `${string(field(todo, 'status')) ?? 'unknown'}: ${string(field(todo, 'content')) ?? ''}`)
      return { ...base, payload: clamp(lines.join('\n'), config.textLimit) }
    }
    default:
      return base
  }
}
