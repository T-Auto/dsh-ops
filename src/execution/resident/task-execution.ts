/** One native task as the existing ShellExecution contract, without a second execution queue. */
import type { ShellExecution, ShellExecutionSpec, ShellResult } from '../../shells/types.js'
import { settledStream } from '../../shells/execution.js'
import type { ShellLaunch } from './shell-protocol.js'
import type { TaskCompleted, TaskFailure, TaskKernelMessage, TaskTransport } from './task-protocol.js'
import { TaskOutputView } from './task-output.js'

export interface TaskExecution extends ShellExecution {
  readonly effectState: 'none' | 'unknown'
  readonly cleanupConfirmed: boolean
  /** Native arbitrates against root exit; false never creates a replacement process. */
  promote(): Promise<boolean>
}
export interface TaskExecutionOptions {
  requestId: string; ownerKey: string; lifetime: 'foreground' | 'job'; source: string
  spec: ShellExecutionSpec; signal?: AbortSignal
  /** Current public authority/confine at the native head, rechecked after every await. */
  admit(signal: AbortSignal): Promise<ShellLaunch>
}
const failure = (error: unknown): TaskFailure => {
  const message = String(error instanceof Error ? error.message : error).slice(0, 2000)
  return { code: /^([A-Z][A-Z_]+):/.exec(message)?.[1] ?? 'EXECUTOR_UNAVAILABLE', message }
}

export class NativeTaskExecution implements TaskExecution {
  status: ShellExecution['status'] = 'running'
  started = false
  effectState: 'none' | 'unknown' = 'none'
  cleanupConfirmed = false
  readonly observed = { stdout: new TaskOutputView(), stderr: new TaskOutputView() }
  readonly done: Promise<void>
  exitCode?: number | null
  signal?: string | null
  private readonly controller = new AbortController()
  private readonly startedAt = performance.now()
  private value!: Promise<ShellResult>
  private resolve!: (value: ShellResult) => void
  private terminal?: TaskCompleted
  private promotion?: { promise: Promise<boolean>; resolve(value: boolean): void }
  private polling?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private stopped?: string
  private unavailable?: TaskFailure
  private disconnectCleanup?: boolean
  private readonly disconnected: Promise<void>
  private disconnect!: () => void
  constructor(private readonly transport: TaskTransport, private readonly options: TaskExecutionOptions) {
    this.value = new Promise(resolve => { this.resolve = resolve })
    this.done = this.value.then(() => undefined)
    this.disconnected = new Promise(resolve => { this.disconnect = resolve })
  }
  /** The owner registers correlation before enqueue, including synchronous local cancellation. */
  start(): void {
    const { requestId, ownerKey, lifetime, spec, signal } = this.options
    if (signal?.aborted) { this.refuse('CANCELLED', 'Task cancelled before enqueue.'); return }
    try {
      this.transport.send({ type: 'task.execute', requestId, ownerKey, lifetime, graceMs: spec.graceMs,
        output: { memoryBytes: 64000, spillBytes: 67108864 }, ...(spec.onExpiry === 'none' ? {} : { timeoutMs: spec.timeoutMs }) })
      // A physically started receipt may be delayed or lost after accepted traffic.
      this.effectState = 'unknown'
      signal?.addEventListener('abort', this.callerAbort, { once: true })
      if (signal?.aborted) this.callerAbort()
    } catch (error) { this.refuse('EXECUTOR_UNAVAILABLE', failure(error).message) }
  }
  private refuse(code: string, message: string): void {
    this.terminal = { type: 'task.completed', requestId: this.options.requestId, status: code === 'CANCELLED' ? 'cancelled' : 'rejected',
      exitCode: null, effectState: 'none', cleanupConfirmed: true, stdoutTotal: 0, stderrTotal: 0, error: { code, message } }
    this.settle(this.terminal)
  }
  private readonly callerAbort = () => this.kill('tool call aborted')
  kill(reason = 'task cancelled'): void {
    if (this.terminal || this.controller.signal.aborted) return
    this.stopped = reason
    this.controller.abort(new Error(reason))
    try { this.transport.send({ type: 'cancel', requestId: this.options.requestId }) }
    catch (error) { this.transport.abort(new Error(failure(error).message)) }
  }
  promote(): Promise<boolean> {
    if (this.promotion) return this.promotion.promise
    if (!this.started || this.terminal || this.controller.signal.aborted) return Promise.resolve(false)
    let resolve!: (value: boolean) => void
    const promise = new Promise<boolean>(done => { resolve = done })
    this.promotion = { promise, resolve }
    try { this.transport.send({ type: 'task.promote', requestId: this.options.requestId }) }
    catch (error) { this.transport.abort(new Error(failure(error).message)) }
    return promise
  }
  receive(message: TaskKernelMessage): void {
    if (message.type === 'task.admit') void this.admit()
    else if (message.type === 'task.started') { this.started = true; this.poll() }
    else if (message.type === 'task.promoted') { this.promotion?.resolve(message.accepted); this.promotion = undefined }
    else if (message.type === 'task.completed') {
      this.terminal = message; clearTimeout(this.timer); this.controller.abort()
      void this.finish(message)
    } else if (message.type === 'task.unavailable') {
      this.unavailable = message.error; this.disconnectCleanup = message.cleanupConfirmed; this.disconnect()
      this.promotion?.resolve(false); this.promotion = undefined
    }
  }
  private async admit(): Promise<void> {
    try {
      const launch = await this.options.admit(this.controller.signal)
      if (this.terminal || this.controller.signal.aborted) return
      this.transport.send({ type: 'task.admission', requestId: this.options.requestId, decision: 'launch', launch })
    } catch (error) {
      if (this.terminal || this.controller.signal.aborted) return
      try { this.transport.send({ type: 'task.admission', requestId: this.options.requestId, decision: 'reject', error: failure(error) }) }
      catch (sendError) { this.transport.abort(new Error(failure(sendError).message)) }
    }
  }
  private async snapshot(final?: TaskCompleted): Promise<void> {
    const results = await Promise.allSettled((['stdout', 'stderr'] as const).map(async stream => {
      const value = await this.transport.read(this.options.requestId, stream, 0, 65536)
      if (final && !value.error && (!value.eof || value.nextOffset !== (stream === 'stdout' ? final.stdoutTotal : final.stderrTotal))) {
        throw new Error('Task terminal output disagrees with completion')
      }
      if (final && value.spillPath && value.spillSealed !== true) throw new Error('Task terminal spill was not sealed')
      this.observed[stream].update(value)
    }).map(work => work.catch(error => {
      // Stop a contradictory connection before joining a sibling read still awaiting a receipt.
      if (this.transport.available) this.transport.abort(new Error(failure(error).message))
      throw error
    })))
    const error = results.find(result => result.status === 'rejected')
    if (error?.status === 'rejected') throw error.reason
  }
  private poll(): void {
    if (this.terminal || this.polling) return
    this.polling = this.snapshot().catch(error => {
      this.transport.abort(new Error(failure(error).message))
      return this.disconnected
    }).finally(() => {
      this.polling = undefined
      if (!this.terminal) { this.timer = setTimeout(() => this.poll(), 150); this.timer.unref?.() }
    })
  }
  private async finish(completed: TaskCompleted): Promise<void> {
    try {
      await this.polling
      if (!this.transport.available) throw new Error('Task output connection is unavailable')
      await this.snapshot(completed)
    } catch (error) {
      if (this.transport.available) this.transport.abort(new Error(failure(error).message))
      // available=false means teardown began, not that the outer range joined.
      await this.disconnected
      this.observed.stdout.fail(this.unavailable ?? failure(error), completed.stdoutTotal)
      this.observed.stderr.fail(this.unavailable ?? failure(error), completed.stderrTotal)
    }
    // A promotion can race terminal receipt; native still owes its correlated refusal.
    await this.promotion?.promise
    if (this.transport.available) {
      try { this.transport.send({ type: 'task.release', requestId: this.options.requestId }) }
      catch (error) { this.transport.abort(new Error(failure(error).message)); await this.disconnected }
    }
    this.settle({ ...completed, cleanupConfirmed: this.disconnectCleanup ?? completed.cleanupConfirmed })
  }
  private settle(completed: TaskCompleted): void {
    this.options.signal?.removeEventListener('abort', this.callerAbort)
    clearTimeout(this.timer)
    this.effectState = completed.effectState; this.cleanupConfirmed = completed.cleanupConfirmed
    const outputError = this.observed.stdout.error ?? this.observed.stderr.error
    const error = completed.error ?? outputError ?? this.unavailable
    const value: ShellResult = {
      exitCode: completed.exitCode, signal: completed.signal ?? null,
      timedOut: completed.error?.code === 'TIMEOUT', timeoutMs: this.options.spec.timeoutMs,
      ...(completed.status === 'cancelled' && completed.error?.code !== 'TIMEOUT' ? { cancelled: true } : {}),
      ...(error ? { error: `${error.code}: ${error.message}`, failure: { ...error, effectState: completed.effectState, retry: 'never' } } : {}),
      ...(this.stopped ? { stopped: this.stopped } : {}),
      stdout: settledStream(this.observed.stdout, this.options.spec.includeDiagnostics),
      stderr: settledStream(this.observed.stderr, this.options.spec.includeDiagnostics),
      ...(this.options.spec.includeDiagnostics ? { diagnostics: { durationMs: Math.round(performance.now() - this.startedAt),
        executor: { kind: 'resident-task', source: this.options.source } } } : {}),
    }
    this.status = value.error || value.cancelled || value.timedOut || value.signal ? 'killed' : 'completed'
    this.exitCode = value.exitCode; this.signal = value.signal
    this.resolve(value)
  }
  result(): Promise<ShellResult> { return this.value }
}
