/** One-shot worker transport. Only trusted bridge code supplies envelope metadata and budgets. */
import { randomUUID } from 'node:crypto'

export const WORKER_TIMEOUT_MS = 30000
export const WORKER_OUTPUT_BYTES = 128 * 1024

export interface WorkerStorage {
  root: string
  authorityId: string
  allowedTools: string[]
  windowsWriteSid?: string
}
export function workerEnvelope(component: 'file' | 'ptc', request: Record<string, unknown>, timeoutMs: number | null = WORKER_TIMEOUT_MS, storage?: WorkerStorage) {
  timeoutMs ??= WORKER_TIMEOUT_MS
  const timeout = Math.max(1, Math.trunc(timeoutMs))
  if (!['file', 'ptc'].includes(component) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeout > 2147483647) {
    throw new TypeError('Invalid internal worker component or timeout')
  }
  return { version: 1, requestId: randomUUID(), component,
    budget: { timeoutMs: Math.min(timeout, WORKER_TIMEOUT_MS), maxBytes: WORKER_OUTPUT_BYTES }, request, ...(storage ? { storage } : {}) }
}
