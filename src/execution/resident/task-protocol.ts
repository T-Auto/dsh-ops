/** Internal fresh-task wire. Publication remains on the existing executor until parity is proven. */
import type { ShellFailure, ShellLaunch, ShellStream } from './shell-protocol.js'
export type TaskFailure = ShellFailure
export type TaskStream = ShellStream
export interface TaskOutput {
  type: 'task.output'; requestId: string; stream: TaskStream
  /** Requested cursor, actual returned-byte start, and total observed bytes respectively. */
  offset: number; retainedOffset: number; nextOffset: number
  bytesBase64: string; lossy: boolean; eof: boolean; error?: TaskFailure
  spillPath?: string; spillOrigin?: 'ops-native-v1'; spillPid?: number; spillSealed?: boolean; spillError?: string
}
export interface TaskCompleted {
  type: 'task.completed'; requestId: string
  status: 'completed' | 'failed' | 'cancelled' | 'rejected'
  exitCode: number | null; signal?: string | null; effectState: 'none' | 'unknown'
  cleanupConfirmed: boolean; stdoutTotal: number; stderrTotal: number; error?: TaskFailure
}
export type TaskHostMessage =
  | { type: 'task.execute'; requestId: string; ownerKey: string; lifetime: 'foreground' | 'job'; graceMs: number
      output: { memoryBytes: number; spillBytes: number }
      /** Independent hard execution cap; promotion does not disarm it. Jobs producers omit it. */
      timeoutMs?: number }
  | ({ type: 'task.admission'; requestId: string } & (
      { decision: 'launch'; launch: ShellLaunch } | { decision: 'reject'; error: TaskFailure }))
  | { type: 'task.promote' | 'cancel' | 'task.release'; requestId: string }
  | { type: 'task.read'; requestId: string; stream: TaskStream; offset: number; maxBytes: number }
  | { type: 'task.closeOwner'; requestId: string; ownerKey: string; reason: string }
export type TaskKernelMessage = TaskCompleted | TaskOutput
  | { type: 'task.admit' | 'task.started'; requestId: string }
  | { type: 'task.promoted'; requestId: string; accepted: boolean }
  | { type: 'task.ownerClosed'; requestId: string; cleanupConfirmed: boolean; error?: TaskFailure }
  | { type: 'task.unavailable'; cleanupConfirmed: boolean; error: TaskFailure }
export interface TaskTransport {
  readonly available: boolean
  readonly capabilities: readonly string[]
  /** Bounded enqueue; throwing proves this frame was not accepted. */
  send(message: TaskHostMessage): void
  read(requestId: string, stream: TaskStream, offset: number, maxBytes: number): Promise<TaskOutput>
  abort(error: Error): void
  subscribe(listener: (message: TaskKernelMessage) => void): () => void
}
