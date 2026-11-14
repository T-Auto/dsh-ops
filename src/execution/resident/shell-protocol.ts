/** Internal shell wire contract. No tool is published until the native driver supports it. */
import { record } from '../boundary.js'
export interface ShellBootstrap {
  commandPipe: string; receiptPipe: string
  /** Fixed stdout/stderr/receipt pools select the three-record command envelope. */
  outputPipes?: [string, string, string]
}
export function validShellBootstrap(value: unknown): value is ShellBootstrap {
  const endpoint = (item: unknown): boolean => typeof item === 'string' && item.length > 0 && item.length <= 512 && !item.includes('\0')
  return record(value) && [value.commandPipe, value.receiptPipe].every(endpoint)
    && Object.entries(value).every(([key, item]) => key === 'outputPipes' || endpoint(item))
    && (value.outputPipes === undefined || (Array.isArray(value.outputPipes) && value.outputPipes.length === 3
      && value.outputPipes.every(endpoint) && new Set([value.commandPipe, value.receiptPipe, ...value.outputPipes]).size === 5))
}
export interface ShellLaunch { argv: string[]; cwd: string; env: Record<string, string> }
export interface ShellFailure { code: string; message: string }
export type ShellStream = 'stdout' | 'stderr'
export interface ShellOutput {
  type: 'shell.output'; requestId: string; stream: ShellStream
  offset: number; nextOffset: number; bytesBase64: string; lossy: boolean; eof: boolean
  error?: ShellFailure
  spillPath?: string; spillOrigin?: 'ops-native-v1'; spillPid?: number; spillSealed?: boolean; spillError?: string
}
export type ShellAdmission = { type: 'shell.admission'; requestId: string } & (
  | { decision: 'launch'; launch: ShellLaunch; closeAfter: boolean; commandCwd?: string }
  | { decision: 'reuse'; commandCwd?: string }
  | { decision: 'retire' }
  | { decision: 'reject'; error: ShellFailure })
export interface ShellCompleted {
  type: 'shell.completed'; requestId: string
  status: 'completed' | 'failed' | 'cancelled' | 'rejected'
  exitCode: number | null; effectState: 'none' | 'unknown'
  shellState: 'preserved' | 'reset'; cleanupConfirmed: boolean
  stdoutTotal: number; stderrTotal: number; error?: ShellFailure
}
export type ShellHostMessage = ShellAdmission
  | { type: 'shell.execute'; requestId: string; sessionKey: string; command: string; timeoutMs: number; stdoutBytes: number; stderrBytes: number }
  | { type: 'shell.retire' | 'shell.close'; requestId: string; sessionKey: string; reason: string }
  | { type: 'cancel'; requestId: string }
  | { type: 'shell.read'; requestId: string; stream: ShellStream; offset: number; maxBytes: number }
  | { type: 'shell.release'; requestId: string }
export type ShellKernelMessage = ShellCompleted | ShellOutput
  | { type: 'shell.admit'; requestId: string; hasShell: boolean; bootstrap?: ShellBootstrap }
  | { type: 'shell.started'; requestId: string }
  | { type: 'shell.closed'; requestId: string; cleanupConfirmed: boolean; error?: ShellFailure }
  // Transport emits this only after its owned kernel range has settled (or cleanup failed).
  | { type: 'shell.unavailable'; cleanupConfirmed: boolean; error: ShellFailure }
export interface ShellTransport {
  readonly available: boolean
  readonly capabilities: readonly string[]
  /** Synchronous bounded enqueue; a throw proves the frame was not accepted. */
  send(message: ShellHostMessage): void
  read(requestId: string, stream: ShellStream, offset: number, maxBytes: number): Promise<ShellOutput>
  /** Fail the shared connection; unavailable is delivered only after its owned range is joined. */
  abort(error: Error): void
  subscribe(listener: (message: ShellKernelMessage) => void): () => void
}
