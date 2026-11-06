/** Persisted capture boundaries. JSON remains unknown until the fields used by the fold are checked. */
import type fsp from 'node:fs/promises'
export type Row = Record<string, unknown>
export interface PanelConfig { readonly capture: boolean; readonly textLimit: number; readonly maxSessionBytes: number }
export interface PanelPaths { dir: string; data: string; wal: string; html: string; sessionId: string }
export interface TextField { text?: string | null; chars?: number | null; truncated?: unknown; droppedChars?: number | null }
export type CoreBucket = 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
export type UsageBucket = CoreBucket | 'reasoningTokens' | 'totalTokens'
export type Usage = Partial<Record<UsageBucket, number>>
export interface CaptureEvent {
  seq: number; time: number; type: string; role?: string; source?: unknown; turn?: unknown; step?: unknown
  callId?: string; name?: string; reason?: string; errorCode?: string; interrupted?: unknown; isError?: unknown
  payload?: TextField | null; reasoning?: TextField | null; arguments?: TextField | null
  toolCalls?: unknown[]; usage?: Usage | null; usageReported?: unknown; usageBuckets?: string[]
  jobId?: string; status?: string; kind?: string; target?: string; insertedCount?: number; removedCount?: number
}
export interface ArchiveMember { path: string; bytes: number; sha256: string; role: string }
export interface EventFile { path: string; events: number; sha256: string }
export interface FoldedEvents {
  layout: 'merged'; merged: boolean; mergedAt?: string; records: number; malformed: number
  types: Record<string, number>; files: EventFile[]
}
export interface SessionState {
  sessionId: string; paths: PanelPaths; size: number; droppedEvents: number; capped: boolean; closed: boolean
  pendingBytes: number; queueCapped: boolean; openFailed: boolean
  header?: Row; chain: Promise<void>
}
export interface PanelMeta { pluginVersion?: unknown; platform?: unknown; node?: unknown; argv?: unknown }
export interface FoldContext { config?: PanelConfig; meta?: PanelMeta; droppedEvents?: number; malformed?: number }
export type PanelIO = Pick<typeof fsp, 'readFile' | 'mkdir' | 'appendFile' | 'writeFile' | 'rename' | 'stat' | 'rm'>
export interface CollectorOptions {
  config?: PanelConfig; io?: PanelIO; env?: NodeJS.ProcessEnv; now?: () => number
  report?: (message: string, level: string) => void; meta?: PanelMeta
}
export const object = (value: unknown): value is Row => value !== null && typeof value === 'object'
export const field = (value: unknown, key: string): unknown => object(value) ? value[key] : undefined
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'
function textField(value: unknown): value is TextField | null | undefined {
  if (value == null) return true
  if (!object(value) || Array.isArray(value)) return false
  return (value.text == null || typeof value.text === 'string')
    && (value.chars == null || finite(value.chars)) && (value.droppedChars == null || finite(value.droppedChars))
}
/** Invalid persisted fields are counted as malformed; never coerce them into text or token totals. */
export function foldEvent(value: Row): value is Row & CaptureEvent {
  if (typeof value.type !== 'string' || !value.type || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0
    || !finite(value.time) || value.time < 0 || value.time > 8_640_000_000_000_000) return false
  if (!['role', 'callId', 'name', 'reason', 'errorCode', 'jobId', 'status', 'kind', 'target'].every(key => optionalString(value[key]))) return false
  if (![value.payload, value.reasoning, value.arguments].every(textField)) return false
  if (value.toolCalls !== undefined && !Array.isArray(value.toolCalls)) return false
  if (!['insertedCount', 'removedCount'].every(key => value[key] === undefined
    || (Number.isSafeInteger(value[key]) && (value[key] as number) >= 0))) return false
  if (value.usageBuckets !== undefined && (!Array.isArray(value.usageBuckets) || !value.usageBuckets.every(item => typeof item === 'string'))) return false
  if (value.usage != null) {
    if (!object(value.usage) || Array.isArray(value.usage)) return false
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) {
      if (value.usage[key] !== undefined && !finite(value.usage[key])) return false
    }
  }
  return true
}
export const missingFile = (error: unknown): boolean => field(error, 'code') === 'ENOENT'
