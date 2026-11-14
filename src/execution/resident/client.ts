/** One activation-owned resident kernel. No process globals, replay or reconnect. */
import type { Context, SubprocessHandle } from '../../adapter/dsh/types.js'
import { InvocationNotStarted } from '../../lifecycle/invocations.js'
import { record } from '../boundary.js'
import { workerEnvelope, type WorkerStorage } from '../protocol.js'
import { drainResultSessions, mountResidentResultLifecycle } from '../../kernel/result-lifecycle.js'
import { CallBudget } from '../../kernel/call-budget.js'
import type { WorkerExchange } from '../transport.js'
import { ENVELOPE_BYTES, ResidentFrames, encodeFrame } from './frames.js'
import { ResidentShellChannel } from './shell-channel.js'
import type { ShellTransport } from './shell-protocol.js'
import { ResidentTaskChannel } from './task-channel.js'
import type { TaskTransport } from './task-protocol.js'
import { validateWorkerLaunch, type ConfinedWorkerLaunch } from './worker-launch.js'

type Envelope = ReturnType<typeof workerEnvelope>
interface Pending {
  resolve(value: WorkerExchange): void
  reject(error: Error): void
  cleanup(): void
  started?: () => void
  sent: boolean
  began: boolean
  cancelled: boolean
  removeQueued?: () => boolean
}
export interface ResidentClient {
  readonly file: string
  readonly pid: number
  readonly available: boolean
  readonly shell: ShellTransport
  readonly task: TaskTransport
  admitFileCall<T>(sessionId: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T>
  invoke(envelope: Envelope, signal?: AbortSignal, started?: () => void): Promise<WorkerExchange>
  invokeConfined(envelope: Envelope, launch: ConfinedWorkerLaunch, signal?: AbortSignal, started?: () => void): Promise<WorkerExchange>
  purgeResults(root: string, scope: string, storage: WorkerStorage, signal: AbortSignal): Promise<WorkerExchange>
  stop(): Promise<void>
}

/** Pre-admission refusal; the request has not been written to the kernel. */
export class ResidentNotStarted extends Error {
  constructor(message: string) { super(message); this.name = 'ResidentNotStarted' }
}

function exchange(value: unknown): value is WorkerExchange {
  return record(value) && (value.exitCode === null || Number.isSafeInteger(value.exitCode))
    && typeof value.interrupted === 'boolean' && typeof value.readers === 'boolean'
    && typeof value.lossy === 'boolean' && typeof value.stderr === 'string'
    && (value.value === undefined || record(value.value))
    && (value.invalid === undefined || value.invalid === 'json' || value.invalid === 'shape')
}

class Client implements ResidentClient {
  pid = 0
  readonly shell: ResidentShellChannel
  readonly task: ResidentTaskChannel
  private readonly pending = new Map<string, Pending>()
  private readonly fileAdmission = new CallBudget()
  private readonly frames: ResidentFrames
  private readonly hello: Promise<void>
  private ready!: () => void
  private refused!: (error: Error) => void
  private terminal?: Error
  private failureDrain?: Promise<void>
  private closing = false
  private stopping?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  constructor(readonly file: string, private readonly handle: SubprocessHandle, private readonly assertActive: () => void) {
    this.hello = new Promise((resolve, reject) => { this.ready = resolve; this.refused = reject })
    // The startup waiter is installed immediately; all paths also await it below.
    void this.hello.catch(() => {})
    if (!handle.control) throw new Error('The host did not provide a resident control pipe')
    this.shell = new ResidentShellChannel(() => this.available, (value, sending) => this.frames.send(encodeFrame(value), sending), error => this.fail(error), () => this.pid)
    this.task = new ResidentTaskChannel(() => this.available, (value, sending) => this.frames.send(encodeFrame(value), sending), error => this.fail(error), () => this.pid)
    this.frames = new ResidentFrames(handle.control, value => this.receive(value), error => this.fail(error),
      // 32 file + 32 shell executions, their 64 cancels, 32 admissions,
      // 64 retire/close controls, 64 stream reads, 32 releases and shutdown.
      // Each frame remains byte-bounded; one outstanding write preserves backpressure.
      // Task negotiation reserves another 288 writes for accepted executions,
      // promotion/admission/cancel/release, owner cleanup and both live readers.
      () => 65 + (this.shell.capabilities.includes('shell-v1') ? 256 : 0)
        + (this.task.capabilities.includes('task-v1') ? 288 : 0))
    this.timer = setTimeout(() => this.fail(new Error('Resident kernel handshake exceeded 10000ms')), 10_000)
    handle.done.then(() => this.fail(new Error('Resident kernel exited')), error => this.fail(new Error(`Resident kernel failed: ${String(error)}`)))
  }
  get available(): boolean {
    if (!this.pid || this.closing || this.terminal) return false
    try { this.assertActive(); return true } catch { return false }
  }
  async handshake(): Promise<void> { await this.hello }
  private receive(value: unknown): void {
    if (!record(value)) throw new Error('Resident message is not an object')
    if (value.type === 'ready') {
      if (this.pid || value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1) throw new Error('Invalid resident handshake')
      if (value.capabilities !== undefined && (!Array.isArray(value.capabilities) || value.capabilities.length > 16
        || value.capabilities.some(capability => typeof capability !== 'string' || capability.length > 64))) throw new Error('Invalid resident capabilities')
      this.shell.capabilities = Object.freeze([...(value.capabilities as string[] | undefined) ?? []])
      this.task.capabilities = this.shell.capabilities
      this.pid = Number(value.pid)
      clearTimeout(this.timer)
      this.ready()
      return
    }
    if (!this.pid || typeof value.requestId !== 'string') throw new Error('Resident message precedes handshake or lacks requestId')
    if (this.shell.receive(value)) return
    if (this.task.receive(value)) return
    const pending = this.pending.get(value.requestId)
    if (!pending) throw new Error('Resident message has an unknown requestId')
    if (value.type === 'started') {
      if (pending.began) throw new Error('Resident request started twice')
      pending.began = true
      pending.started?.()
    } else if (value.type === 'completed' && exchange(value.exchange)) {
      this.pending.delete(value.requestId)
      pending.cleanup()
      pending.resolve(value.exchange)
    } else throw new Error('Invalid resident response')
  }
  private fail(error: Error): void {
    if (this.terminal) return
    this.terminal = error
    this.closing = true
    this.fileAdmission.close(new ResidentNotStarted(error.message))
    clearTimeout(this.timer)
    this.frames.stop()
    this.refused(error)
    const pending = [...this.pending.values()]
    for (const request of pending) request.cleanup()
    this.pending.clear()
    // Frames discarded before the writable boundary could not cause effects.
    // Only sent requests need the conservative interrupted/unknown outcome.
    for (const request of pending) if (!request.sent) request.reject(new ResidentNotStarted(error.message))
    let cleanupFailure = ''
    try { this.handle.terminate() } catch (failure) { cleanupFailure = `Termination failed: ${String(failure)}` }
    this.failureDrain = (async () => {
      // Lost protocol receipts do not prove effects stopped. Hold admitted
      // promises until the provider joins the whole range, or reports that
      // quiescence cannot be observed; that failure stays explicitly unknown.
      try {
        if (!await this.handle.waitForExit()) cleanupFailure += '\nOwned range cleanup was not confirmed'
      } catch (failure) { cleanupFailure += `\nOwned range cleanup is unknown: ${String(failure)}` }
      let diagnostic = ''
      try { diagnostic = this.handle.collected.stderr?.readFrom(0).text ?? '' } catch { /* provider failure */ }
      for (const request of pending) if (request.sent) request.resolve({ exitCode: null, interrupted: true, readers: true, lossy: false,
        stderr: [error.message.slice(0, 1000), cleanupFailure.slice(0, 1000), diagnostic.slice(-2000)].join('\n') })
      this.shell.unavailable(error.message.slice(0, 1000), cleanupFailure === '')
      this.task.unavailable(error.message.slice(0, 1000), cleanupFailure === '')
    })()
  }
  async admitFileCall<T>(sessionId: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    if (!this.available) throw new ResidentNotStarted('Resident kernel is unavailable before file admission')
    return this.fileAdmission.run(sessionId, signal, () => {
      if (!this.available) throw new ResidentNotStarted('Resident kernel is unavailable before file admission')
      return run()
    })
  }
  invoke(envelope: Envelope, signal?: AbortSignal, started?: () => void): Promise<WorkerExchange> {
    return this.dispatch(envelope, signal, started)
  }
  invokeConfined(envelope: Envelope, launch: ConfinedWorkerLaunch, signal?: AbortSignal, started?: () => void): Promise<WorkerExchange> {
    try {
      if (!this.task.capabilities.includes('confined-worker-v1')) throw new ResidentNotStarted('Resident kernel does not support confined-worker-v1; update its runtime before executing restricted batch/result calls')
      if (envelope.component !== 'ptc' || !['batch', 'result'].includes(String(envelope.request.tool))) throw new ResidentNotStarted('Confined execution requires a trusted batch/result envelope')
      validateWorkerLaunch(launch)
      return this.dispatch(envelope, signal, started, false, launch)
    } catch (error) { return Promise.reject(error) }
  }
  /** Only already-owned cache teardown may use the live connection after ordinary admission closes. */
  purgeResults(root: string, scope: string, storage: WorkerStorage, signal: AbortSignal): Promise<WorkerExchange> {
    const envelope = workerEnvelope('ptc', { root, scope, tool: 'result', args: { action: 'purge' }, read_only: false }, 5000, storage)
    envelope.budget.maxBytes = 4096
    return this.dispatch(envelope, signal, undefined, true)
  }
  private dispatch(envelope: Envelope, signal?: AbortSignal, started?: () => void, cleanup = false, launch?: ConfinedWorkerLaunch): Promise<WorkerExchange> {
    if (signal?.aborted) return Promise.reject(new InvocationNotStarted())
    if (!(cleanup ? this.pid && !this.closing && !this.terminal : this.available)) return Promise.reject(new ResidentNotStarted('Resident kernel is unavailable; reload the plugin to start a new instance'))
    if (this.pending.size >= 32) return Promise.reject(new ResidentNotStarted('Resident kernel has 32 in-flight requests; admission is full'))
    let bytes: Buffer
    try {
      if (envelope.version !== 1 || typeof envelope.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(envelope.requestId)
        || this.pending.has(envelope.requestId)) throw new ResidentNotStarted('Invalid or duplicate resident request identity')
      if (Buffer.byteLength(JSON.stringify(envelope)) > ENVELOPE_BYTES) throw new ResidentNotStarted('Resident request exceeds the 2 MiB byte budget')
      bytes = encodeFrame({ type: 'execute', envelope, ...(launch ? { launch } : {}) })
    } catch (error) { return Promise.reject(error) }
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (pending.cancelled || !this.pending.has(envelope.requestId)) return
        pending.cancelled = true
        if (!pending.sent && pending.removeQueued?.()) {
          this.pending.delete(envelope.requestId); pending.cleanup(); reject(new InvocationNotStarted())
        } else {
          try { this.frames.send(encodeFrame({ type: 'cancel', requestId: envelope.requestId })) }
          catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
        }
      }
      const pending: Pending = { resolve, reject, started, sent: false, began: false, cancelled: false,
        cleanup: () => signal?.removeEventListener('abort', abort) }
      this.pending.set(envelope.requestId, pending)
      try {
        pending.removeQueued = this.frames.send(bytes, () => { pending.sent = true })
        if (this.pending.has(envelope.requestId)) {
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        }
      } catch (error) {
        this.pending.delete(envelope.requestId); pending.cleanup()
        reject(error)
      }
    })
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.closing = true
    this.fileAdmission.close(new ResidentNotStarted('Resident kernel stopped before file admission'))
    clearTimeout(this.timer)
    this.stopping = (async () => {
      if (!this.terminal) {
        try {
          for (const [requestId, pending] of this.pending) if (!pending.cancelled) {
            pending.cancelled = true
            if (!pending.sent && pending.removeQueued?.()) {
              this.pending.delete(requestId); pending.cleanup(); pending.reject(new InvocationNotStarted())
            } else this.frames.send(encodeFrame({ type: 'cancel', requestId }))
          }
          this.frames.send(encodeFrame({ type: 'shutdown' }))
          if (!await this.handle.waitForExit(AbortSignal.timeout(1000))) this.handle.terminate()
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
      }
      this.handle.terminate()
      try {
        if (!await this.handle.waitForExit()) throw new Error('Resident kernel range did not become empty')
        await this.handle.done.catch(() => {})
      } finally {
        this.fail(new Error('Resident kernel stopped'))
        await this.failureDrain
        this.handle.control?.destroy()
      }
    })()
    return this.stopping
  }
}

/** Start exactly one kernel; the calling activation owns startup and awaited teardown. */
export async function startResident(ctx: Context, file: string, cwd: string): Promise<ResidentClient> {
  const subprocess = ctx.get('subprocess')
  if (!subprocess) throw new Error('Resident kernel requires the public subprocess service')
  let client: Client | undefined, handle: SubprocessHandle | undefined
  mountResidentResultLifecycle(ctx)
  ctx.effect(() => async () => {
    if (client) {
      try { await drainResultSessions(ctx, true) } finally { await client.stop() }
    }
    else if (handle) { handle.terminate(); await handle.waitForExit(); await handle.done.catch(() => {}) }
  }, 'dsh-ops: resident kernel')
  try {
    handle = subprocess.spawn({ argv: [file, '--serve'], cwd, graceMs: 100,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' } })
    client = new Client(file, handle, () => ctx.fiber.assertActive())
    await client.handshake()
    ctx.fiber.assertActive()
    return client
  } catch (error) {
    if (client) await client.stop()
    else if (handle) { handle.terminate(); await handle.waitForExit(); await handle.done.catch(() => {}) }
    throw error
  }
}
