/** The PTC projection preserves canonical facts and never replays an operation. */
import { errorPolicy } from '../../kernel/errors.js'
import type { CoverageMeta, EffectState, Outcome } from '../../kernel/outcome.js'
import { continuationFor } from './continuation.js'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type CanonicalData = { [key: string]: JsonValue }
export function record(value: unknown): CanonicalData | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as CanonicalData : undefined
}
export const count = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
const effects = new Set<EffectState>(['none', 'applied', 'partial', 'unknown'])
function effect(value: CanonicalData, fallback: EffectState): EffectState {
  return typeof value.effectState === 'string' && effects.has(value.effectState as EffectState)
    ? value.effectState as EffectState : fallback
}
function failure(data: CanonicalData | undefined, code: string, message: string, state: EffectState, nextAction?: string): Outcome<CanonicalData> {
  const policy = errorPolicy(code, state)
  return { status: policy.status, error: { code, message, effectState: state, retry: policy.retry,
    ...(nextAction ? { nextAction } : {}) }, ...(data ? { data } : {}) }
}
function coverage(data: CanonicalData, complete: boolean): CoverageMeta {
  const cause = data.truncatedBy === 'time' ? 'time-limit' : data.truncatedBy
  const truncatedBy = cause === 'scan-budget' || cause === 'output-budget' || cause === 'time-limit' || cause === 'row-limit'
    ? cause : data.truncated === true ? 'output-budget' : undefined
  return { scannedFiles: count(data.scannedFiles), matchedCount: count(data.matchedObserved ?? data.matched ?? data.done),
    isComplete: complete, ...(truncatedBy ? { truncatedBy } : {}) }
}
/** Incomplete observations without a safe cursor are errors with retained data, never fabricated pages. */
export function toOutcome(tool: string, args: unknown, value: unknown): Outcome<CanonicalData> {
  const data = record(value)
  if (!data) return failure(undefined, 'RESULT_UNKNOWN', 'The worker did not return a canonical object.', 'unknown')
  const error = record(data.error)
  if (error) return failure(data, typeof error.code === 'string' ? error.code : 'RESULT_UNKNOWN',
    typeof error.message === 'string' ? error.message : 'The operation did not return a settled receipt.', effect(error, 'unknown'),
    typeof error.nextAction === 'string' ? error.nextAction : undefined)
  const action = record(args)?.action
  if (tool === 'result' && action === 'release' && data.status === 'released' && typeof data.id === 'string') {
    return { status: 'completed', data }
  }
  if (tool === 'result' && action === 'put' && data.status === undefined && typeof data.id === 'string'
    && typeof data.contentHash === 'string' && Number.isSafeInteger(data.total) && Number(data.total) >= 0) {
    return { status: 'completed', data }
  }
  if (data.status !== undefined && !['completed', 'planned', 'partial', 'partial_completion', 'unknown', 'rejected', 'conflict', 'error'].includes(String(data.status))) {
    return failure(data, 'RESULT_UNKNOWN', 'The worker returned an unrecognized execution status.', 'unknown')
  }
  if (data.status === undefined && !(tool === 'stat' && typeof data.exists === 'boolean')
    && !(typeof data.complete === 'boolean' && Array.isArray(data.items))) {
    return failure(data, 'RESULT_UNKNOWN', 'The worker omitted its execution receipt.', 'unknown')
  }
  const next = typeof data.nextAction === 'string' ? data.nextAction : undefined
  if (data.status === 'unknown' || count(data.unknown) > 0) {
    return failure(data, 'RESULT_UNKNOWN', 'Some effects are unknown; inspect retained observations before any recovery.', 'unknown', next)
  }
  if (data.status === 'rejected' || data.status === 'conflict' || data.status === 'error') {
    return failure(data, 'RESULT_UNKNOWN', 'A failed receipt omitted its structured error.', 'unknown', next)
  }
  // Batch summaries intentionally omit audit rows. Successful planning/execution is still complete.
  if (tool === 'batch') {
    if (data.status === 'completed' || data.status === 'planned') return { status: 'completed', data }
    return failure(data, 'RESULT_PARTIAL', 'The batch contains failed or unsettled operations; inspect detailsRef.',
      count(data.done) > 0 ? 'partial' : 'none', next)
  }
  // Stored rows are not echoed by put/release; their own successful operation is complete.
  if (tool === 'result' && record(args)?.action !== 'page' && data.status === 'completed') return { status: 'completed', data }
  if (count(data.failed) > 0) return failure(data, 'RESULT_PARTIAL', 'Some items failed; inspect each retained receipt.',
    effect(data, count(data.changed) > 0 ? 'partial' : 'none'), next)
  const incomplete = data.complete === false || data.truncated === true || data.scanComplete === false
    || data.pageComplete === false || data.status === 'partial' || data.status === 'partial_completion'
  if (incomplete) {
    const continuation = continuationFor(tool, args, data)
    if (continuation) return { status: 'partial', data, coverage: { ...coverage(data, false), isComplete: false }, continuation }
    return failure(data, 'RESULT_PARTIAL', 'Observation is incomplete and has no safe continuation; refine the request.',
      effect(data, count(data.changed) > 0 ? 'applied' : 'none'), next)
  }
  return { status: 'completed', data, ...(typeof data.scanComplete === 'boolean'
    ? { coverage: { ...coverage(data, true), isComplete: true as const } } : {}) }
}
