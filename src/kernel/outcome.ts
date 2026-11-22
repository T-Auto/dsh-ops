/** Shared 0.4 result contracts. Existing adapters adopt these in their own migration slices. */
export type EffectState = 'none' | 'applied' | 'partial' | 'unknown'
export type RetryPolicy = 'never' | 'after-input-change' | 'after-state-change' | 'bounded-transient'
export type FailureStatus = 'rejected' | 'conflict' | 'error' | 'unknown'

export interface OpsErrorPayload {
  code: string
  effectState: EffectState
  retry: RetryPolicy
  message: string
  nextAction?: string
}
export interface CoverageMeta {
  scannedFiles: number
  matchedCount: number
  isComplete: boolean
  truncatedBy?: 'scan-budget' | 'output-budget' | 'time-limit' | 'row-limit'
}
export type Outcome<T> =
  | { status: 'completed', data: T, coverage?: CoverageMeta & { isComplete: true } }
  | { status: 'partial', data: T, coverage: CoverageMeta & { isComplete: false }, continuation: string, nextAction?: string }
  | { status: FailureStatus, error: OpsErrorPayload, data?: T }

interface SearchReportBase {
  pageComplete: boolean
  scannedFiles: number
  skippedFiles: number
  skipReasons: Record<string, number>
  matchedObserved: number
  truncatedBy: 'scan-budget' | 'output-budget' | 'time' | 'row-limit' | 'none'
  continuation?: string
}
/** An early-stopped scan may report observed matches, never a claimed full-scan total. */
export type SearchExecutionReport = SearchReportBase & (
  | { scanComplete: true, matchedTotal: number }
  | { scanComplete: false, matchedTotal?: never }
)
export interface StorageReference {
  refId: `ref://${string}/${string}/${string}`
  createdAt: number
  ttlMs: number
  schemaVersion: string
  producerTool: string
  totalItems: number
  totalBytes: number
  preview: string
}
