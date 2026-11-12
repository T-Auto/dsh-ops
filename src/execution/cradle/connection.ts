/** One private pipe generation. No reconnect/replay of a request once written. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { SubprocessHandle, SubprocessRuntime } from '../../adapter/dsh/types.js'
import { Frames, encode, type Frame } from './protocol.js'
import { OutputTail, SpillSpace } from './output.js'

type Spec = Parameters<SubprocessRuntime['spawn']>[0]
interface Pending {
  stdout: OutputTail; stderr: OutputTail
  resolve(value: { exitCode: number | null; signal: NodeJS.Signals | null }): void
  reject(error: Error): void
  detach(): void
  authorize(): void
  started: boolean
}
export class CradleConnection {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private readonly space = new SpillSpace()
  private nextId = 0
  private closed = false
  private draining = false
  private ready = false
  private readonly nonce = randomBytes(16).toString('hex')
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private readonly readiness = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
  private readonly ended: Promise<void>
  private killTimer?: ReturnType<typeof setTimeout>
  private readonly startupTimer: ReturnType<typeof setTimeout>
  private processing = Promise.resolve()

  constructor(file: string) {
    // No environment credentials or DSH_HOME are needed by the control process.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].includes(key.toUpperCase())))
    this.child = spawn(file, ['--cradle', String(process.pid), this.nonce], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env,
    })
    const frames = new Frames()
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.child.stdout.pause()
      const messages: Frame[] = []
      try { frames.feed(chunk, frame => messages.push(frame)) }
      catch (error) { void this.fail(error); return }
      // Paused reads plus serialized disk writes propagate bounded pipe backpressure.
      this.processing = this.processing.then(async () => {
        for (const frame of messages) await this.receive(frame)
        if (!this.closed) this.child.stdout.resume()
      }).catch(error => this.fail(error))
    })
    this.child.stderr.resume() // Native errors are surfaced as unknown effects, never unbounded logs.
    this.child.stdin.on('error', error => { void this.fail(error) })
    this.child.stdout.on('error', error => { void this.fail(error) })
    this.child.on('error', error => { void this.fail(error) })
    this.ended = new Promise(resolve => this.child.once('close', () => {
      clearTimeout(this.killTimer)
      void this.processing.finally(async () => { await this.fail(new Error('Cradle control connection closed')); resolve() })
    }))
    this.startupTimer = setTimeout(() => { void this.fail(new Error('Cradle startup handshake deadline expired')) }, 15_000)
    this.startupTimer.unref()
    // Failures may happen before the first caller awaits connection readiness.
    void this.readiness.catch(() => {})
  }
  get available(): boolean { return !this.closed && !this.draining }
  async connect(): Promise<void> { await this.readiness; if (!this.available) throw new Error('EXECUTOR_UNAVAILABLE: cradle is draining') }
  private send(frame: Frame): void {
    if (this.closed) throw new Error('Cradle connection is closed')
    const bytes = encode(frame)
    if (this.child.stdin.writableLength + bytes.length > 2 * 1024 * 1024) throw new Error('Cradle control queue is full')
    this.child.stdin.write(bytes)
  }
  spawn(spec: Spec, environment: NodeJS.ProcessEnv, authorize: () => void): SubprocessHandle {
    if (!this.ready || !this.available) throw new Error('EXECUTOR_UNAVAILABLE: cradle is not accepting requests')
    if (this.pending.size >= 32) throw new Error('EXECUTOR_UNAVAILABLE: cradle task capacity exhausted')
    if (spec.signal?.aborted) throw spec.signal.reason
    const id = ++this.nextId
    const stdout = new OutputTail(this.space, id, 'stdout'), stderr = new OutputTail(this.space, id, 'stderr')
    let resolve!: Pending['resolve'], reject!: Pending['reject']
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((yes, no) => { resolve = yes; reject = no })
    const cancel = () => {
      if (!this.pending.has(id) || this.closed) return
      try { this.send({ v: 1, type: 'cancel', id }) } catch (error) { void this.fail(error) }
    }
    const entry: Pending = { stdout, stderr, resolve, reject, authorize, started: false,
      detach: () => spec.signal?.removeEventListener('abort', cancel) }
    this.pending.set(id, entry)
    spec.signal?.addEventListener('abort', cancel, { once: true })
    try {
      authorize()
      this.send({ v: 1, type: 'start', id, argv: spec.argv, cwd: spec.cwd, env: environment })
    } catch (error) {
      this.pending.delete(id); entry.detach()
      void done.catch(() => {})
      // Nothing returned to the caller yet: a pre-submission failure is safe to throw.
      throw error
    }
    return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: { stdout, stderr }, done, terminate: cancel,
      waitForExit: async signal => {
        if (signal?.aborted) return false
        let stop!: () => void
        const interrupted = new Promise<false>(yes => { stop = () => yes(false); signal?.addEventListener('abort', stop, { once: true }) })
        try { return await Promise.race([done.then(() => true), interrupted]) }
        finally { signal?.removeEventListener('abort', stop) }
      },
    }
  }
  private async receive(frame: Frame): Promise<void> {
    if (this.closed) return
    if (frame.type === 'hello') {
      if (this.ready || frame.nonce !== this.nonce) throw new Error('Cradle identity mismatch')
      this.send({ v: 1, type: 'hello', nonce: this.nonce }); return
    }
    if (frame.type === 'ready') { this.ready = true; clearTimeout(this.startupTimer); this.resolveReady(); return }
    if (frame.type === 'draining') { this.draining = true; return }
    if (!this.ready || !Number.isSafeInteger(frame.id)) throw new Error('Unexpected cradle frame')
    const task = this.pending.get(frame.id!)
    if (!task) throw new Error('Cradle returned an unknown request id')
    switch (frame.type) {
      case 'accepted': return
      case 'prepared':
        try { task.authorize(); this.send({ v: 1, type: 'commit', id: frame.id }) }
        catch { this.send({ v: 1, type: 'cancel', id: frame.id }) }
        return
      case 'started': task.started = true; return
      case 'targetExit': return // A descendant may still run: only settled resolves the task.
      case 'output': {
        if (![0, 1].includes(frame.channel as number) || typeof frame.hex !== 'string'
          || frame.hex.length > 16_384 || frame.hex.length % 2 || !/^[0-9a-f]*$/.test(frame.hex)) throw new Error('Invalid cradle output frame')
        await (frame.channel === 0 ? task.stdout : task.stderr).append(Buffer.from(frame.hex, 'hex')); return
      }
      case 'streamEnd': return
      case 'rejected':
      case 'settled': {
        await task.stdout.finish(); await task.stderr.finish()
        if (frame.type === 'settled') this.send({ v: 1, type: 'ack', id: frame.id })
        task.detach(); this.pending.delete(frame.id!)
        if (frame.error || frame.outputError) task.reject(new Error(`Cradle task failed (${task.started ? 'effectState=unknown' : 'effectState=none'}): ${String(frame.error ?? 'output collection failed')}`))
        else if (frame.treeSettled !== true || !Number.isInteger(frame.exitCode)) task.reject(new Error('Cradle task settlement is incomplete; effectState=unknown'))
        else task.resolve({ exitCode: frame.exitCode as number, signal: frame.cancelled ? 'SIGTERM' : null })
        return
      }
      default: throw new Error('Unknown cradle response')
    }
  }
  private async fail(cause: unknown): Promise<void> {
    if (this.closed) return
    this.closed = true; clearTimeout(this.startupTimer)
    const error = new Error(`EXECUTOR_UNAVAILABLE: ${cause instanceof Error ? cause.message : String(cause)}; submitted requests have unknown effects and are never replayed.`)
    this.rejectReady(error)
    this.child.stdin.destroy()
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill() // Exact live child only; native kill-on-close owns task trees.
    for (const task of this.pending.values()) {
      task.detach()
      await task.stdout.finish(); await task.stderr.finish()
      task.reject(error)
    }
    this.pending.clear()
    await this.space.dispose()
  }
  async dispose(): Promise<void> {
    if (!this.closed) {
      this.draining = true
      try { this.send({ v: 1, type: 'shutdown' }) } catch { /* exact-child termination below */ }
      this.killTimer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill() }, 3000)
      this.killTimer.unref()
    }
    await this.ended
  }
}
