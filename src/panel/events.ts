/** Pure projection from host events into bounded capture records. */
import { object, field, finite } from './types.js'
import { PANEL_DEFAULTS } from './config.js'
import type { Row, PanelConfig, Usage, UsageBucket, CaptureEvent, CoreBucket } from './types.js'
/** The four core usage buckets in `bench/run.schema.json` order, and the optional ones. */
const USAGE_BUCKETS: readonly CoreBucket[] = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
const OPTIONAL_BUCKETS: readonly UsageBucket[] = Object.freeze(['reasoningTokens', 'totalTokens'])

/** Clamp one text field, naming what was dropped so a reader can tell truncation apart. */
function clamp(value: unknown, limit: number) {
  const full = typeof value === 'string' ? value : ''
  if (full.length <= limit) return { text: full, chars: full.length, truncated: false, droppedChars: 0 }
  return { text: full.slice(0, limit), chars: full.length, truncated: true, droppedChars: full.length - limit }
}

/** Non-negative safe integer, or undefined. */
const integer = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined)
/** Non-empty string, or undefined. */
const string = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

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
        ...base, callId: string(data.callId), name: string(data.name) ?? '(unnamed)', step: integer(data.step),
        arguments: clamp(typeof data.arguments === 'string' ? data.arguments : '', config.textLimit),
      }
    case 'tool/result':
      return {
        ...base, callId: string(field(field(data.message, 'source'), 'callId')) ?? string(field(data.message, 'toolCallId')),
        isError: field(data.message, 'isError') === true, errorCode: string(field(data.error, 'code')), step: integer(data.step),
        payload: clamp(joined(data.message, 'text'), config.textLimit),
      }
    case 'turn/start': case 'turn/end': case 'step/start': case 'step/end':
      return {
        ...base, turn: integer(data.turn), step: integer(data.step),
        reason: string(field(data.reason, 'kind')) ?? string(field(data.reason, 'message')),
      }
    default:
      return base
  }
}
