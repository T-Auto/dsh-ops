/** Bounded correlation only; native owns task scheduling, promotion and process lifetime. */
import { record } from '../boundary.js'
import type { TaskHostMessage, TaskKernelMessage, TaskOutput, TaskStream, TaskTransport } from './task-protocol.js'

interface Request { sent: boolean; started: boolean; admitted?: boolean; awaitingAdmission?: boolean
  completed?: boolean; local?: boolean; cancelled?: boolean; promoting?: boolean; remove?: () => boolean }
interface Read { offset: number; maxBytes: number; resolve(value: TaskOutput): void; reject(error: Error): void }
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const count = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0
const failure = (value: unknown): boolean => record(value) && typeof value.code === 'string' && typeof value.message === 'string'

export class ResidentTaskChannel implements TaskTransport {
  capabilities: readonly string[] = []
  private readonly requests = new Map<string, Request>()
  private readonly controls = new Map<string, string>()
  private readonly owners = new Set<string>()
  private readonly reads = new Map<string, Read>()
  private listener?: (message: TaskKernelMessage) => void
  private terminal?: Extract<TaskKernelMessage, { type: 'task.unavailable' }>
  constructor(private readonly isAvailable: () => boolean,
    private readonly write: (value: TaskHostMessage, sending?: () => void) => () => boolean,
    readonly abort: (error: Error) => void, private readonly kernelPid: () => number) {}
  get available(): boolean { return !this.terminal && this.isAvailable() }
  subscribe(listener: (message: TaskKernelMessage) => void): () => void {
    if (this.listener) throw new Error('Resident task channel already has an owner')
    this.listener = listener
    if (this.terminal) queueMicrotask(() => { if (this.listener === listener) listener(this.terminal!) })
    return () => { if (this.listener === listener) this.listener = undefined }
  }
  send(message: TaskHostMessage): void {
    if (!this.available || !this.capabilities.includes('task-v1')) throw new Error('Resident task capability is unavailable')
    if (!identity(message.requestId)) throw new Error('Invalid task request identity')
    if (message.type === 'task.execute') {
      const duration = (value: number) => Number.isFinite(value) && value > 0 && value <= 2147483647
      if (!['foreground', 'job'].includes(message.lifetime) || !duration(message.graceMs)
        || (message.timeoutMs !== undefined && !duration(message.timeoutMs))
        || !Number.isInteger(message.output.memoryBytes) || message.output.memoryBytes < 1 || message.output.memoryBytes > 131072
        || !Number.isInteger(message.output.spillBytes) || message.output.spillBytes < 0 || message.output.spillBytes > 67108864) throw new Error('Invalid task execution limits')
      if (this.requests.size >= 32 || this.requests.has(message.requestId) || this.controls.has(message.requestId)) throw new Error('Resident task admission is full or identity is duplicated')
      if (!identity(message.ownerKey) || (!this.owners.has(message.ownerKey) && this.owners.size >= 32)) throw new Error('Resident task owner capacity is full or invalid')
      const newOwner = !this.owners.has(message.ownerKey), request: Request = { sent: false, started: false }
      this.owners.add(message.ownerKey); this.requests.set(message.requestId, request)
      try { request.remove = this.write(message, () => { request.sent = true }) }
      catch (error) { this.requests.delete(message.requestId); if (newOwner) this.owners.delete(message.ownerKey); throw error }
      return
    }
    if (message.type === 'task.closeOwner') {
      if (!identity(message.ownerKey) || this.controls.size >= 64 || this.controls.has(message.requestId)
        || this.requests.has(message.requestId) || [...this.controls.values()].includes(message.ownerKey)) throw new Error('Invalid or duplicate task owner control')
      this.controls.set(message.requestId, message.ownerKey)
      try { this.write(message) } catch (error) { this.controls.delete(message.requestId); throw error }
      return
    }
    const request = this.requests.get(message.requestId)
    if (!request) throw new Error('Unknown resident task request')
    if (message.type === 'task.release') {
      if (!request.completed || request.promoting || ['stdout', 'stderr'].some(stream => this.reads.has(`${message.requestId}:${stream}`))) throw new Error('Task output or promotion is still active')
      if (!request.local) this.write(message)
      this.requests.delete(message.requestId)
      return
    }
    if (message.type === 'task.read') throw new Error('Task reads require the correlated read() method')
    if (message.type === 'task.promote') {
      if (request.promoting || request.completed || !request.started) throw new Error('Task is not eligible for promotion')
      this.write(message); request.promoting = true; return
    }
    if (request.completed) return // A racing idempotent cancel/admission cannot revive terminal work.
    if (message.type === 'task.admission') {
      if (!request.awaitingAdmission) throw new Error('Task admission reply was not requested')
      this.write(message); request.awaitingAdmission = false; return
    }
    if (request.cancelled) return
    request.cancelled = true
    if (!request.sent && request.remove?.()) {
      request.completed = true; request.local = true
      this.listener?.({ type: 'task.completed', requestId: message.requestId, status: 'cancelled', exitCode: null,
        effectState: 'none', cleanupConfirmed: true, stdoutTotal: 0, stderrTotal: 0,
        error: { code: 'CANCELLED', message: 'Cancelled before the execution frame was written.' } })
    } else this.write(message)
  }
  read(requestId: string, stream: TaskStream, offset: number, maxBytes: number): Promise<TaskOutput> {
    const key = `${requestId}:${stream}`
    if (!this.available || !this.capabilities.includes('task-v1')) return Promise.reject(new Error('Resident task capability is unavailable'))
    const request = this.requests.get(requestId)
    if (!request || !['stdout', 'stderr'].includes(stream) || !count(offset) || !Number.isInteger(maxBytes)
      || maxBytes < 1 || maxBytes > 65536 || this.reads.has(key)) return Promise.reject(new Error('Invalid or concurrent task stream read'))
    if (request.local) return Promise.resolve({ type: 'task.output', requestId, stream,
      offset, retainedOffset: offset, nextOffset: offset, bytesBase64: '', lossy: offset !== 0, eof: true })
    return new Promise((resolve, reject) => {
      this.reads.set(key, { offset, maxBytes, resolve, reject })
      try { this.write({ type: 'task.read', requestId, stream, offset, maxBytes }) }
      catch (error) { this.reads.delete(key); reject(error) }
    })
  }
  receive(value: Record<string, unknown>): boolean {
    if (typeof value.type !== 'string' || !value.type.startsWith('task.')) return false
    if (!this.capabilities.includes('task-v1') || !identity(value.requestId)) throw new Error('Unnegotiated or invalid task response')
    if (value.type === 'task.output') {
      const key = `${value.requestId}:${value.stream}`, read = this.reads.get(key)
      if (!read || value.offset !== read.offset || !count(value.retainedOffset) || !count(value.nextOffset)
        || Number(value.retainedOffset) < read.offset || Number(value.nextOffset) < Number(value.retainedOffset)
        || typeof value.lossy !== 'boolean' || typeof value.eof !== 'boolean' || typeof value.bytesBase64 !== 'string'
        || (value.error !== undefined && !failure(value.error))
        || (value.spillError !== undefined && typeof value.spillError !== 'string')
        || (value.spillPath === undefined
          ? [value.spillOrigin, value.spillPid, value.spillSealed].some(item => item !== undefined)
          : value.spillOrigin !== 'ops-native-v1' || value.spillPid !== this.kernelPid() || typeof value.spillSealed !== 'boolean')
        || (value.spillPath !== undefined && (typeof value.spillPath !== 'string' || value.spillPath.length > 4096 || value.spillPath.includes('\0')))) throw new Error('Invalid task output receipt')
      const bytes = Buffer.from(value.bytesBase64, 'base64')
      if (bytes.length > read.maxBytes || bytes.toString('base64') !== value.bytesBase64
        || Number(value.retainedOffset) + bytes.length > Number(value.nextOffset)
        || (!value.lossy && (value.retainedOffset !== read.offset || Number(value.nextOffset) - read.offset !== bytes.length))) throw new Error('Invalid task output bytes or offsets')
      this.reads.delete(key); read.resolve(value as unknown as TaskOutput); return true
    }
    if (value.type === 'task.ownerClosed') {
      const owner = this.controls.get(value.requestId)
      if (!owner || typeof value.cleanupConfirmed !== 'boolean' || (!value.cleanupConfirmed && !failure(value.error))) throw new Error('Invalid task owner cleanup receipt')
      this.controls.delete(value.requestId)
      if (value.cleanupConfirmed) this.owners.delete(owner)
    } else {
      const request = this.requests.get(value.requestId)
      if (!request?.sent) throw new Error('Unknown or unwritten task response identity')
      if (value.type === 'task.promoted') {
        if (!request.promoting || typeof value.accepted !== 'boolean') throw new Error('Invalid task promotion receipt')
        request.promoting = false
      } else if (request.completed) throw new Error('Task execution already completed')
      else if (value.type === 'task.admit') {
        if (request.started || request.admitted) throw new Error('Repeated task admission')
        request.admitted = true; request.awaitingAdmission = true
      } else if (value.type === 'task.started') {
        if (request.started || !request.admitted || request.awaitingAdmission) throw new Error('Invalid physical task start')
        request.started = true
      } else if (value.type === 'task.completed') {
        if (!['completed', 'failed', 'cancelled', 'rejected'].includes(String(value.status))
          || !(value.exitCode === null || Number.isSafeInteger(value.exitCode))
          || (value.signal !== undefined && value.signal !== null && typeof value.signal !== 'string')
          || !['none', 'unknown'].includes(String(value.effectState)) || typeof value.cleanupConfirmed !== 'boolean'
          || !count(value.stdoutTotal) || !count(value.stderrTotal) || (value.error !== undefined && !failure(value.error))
          || (value.status !== 'completed' && !failure(value.error))
          || (value.status === 'completed' && (!request.started || !value.cleanupConfirmed))
          || (value.status === 'rejected' && (request.started || value.effectState !== 'none'))) throw new Error('Invalid task completion receipt')
        request.completed = true
      } else throw new Error('Unknown resident task response')
    }
    if (!this.listener) throw new Error('Resident task response has no owner')
    this.listener(value as unknown as TaskKernelMessage); return true
  }
  /** All accepted executions remain unsettled until the outer managed range was joined. */
  unavailable(message: string, cleanupConfirmed: boolean): void {
    if (this.terminal) return
    const error = { code: 'EXECUTOR_UNAVAILABLE', message }
    this.terminal = { type: 'task.unavailable', cleanupConfirmed, error }
    const requests = [...this.requests]
    this.requests.clear(); this.controls.clear(); this.owners.clear()
    for (const read of this.reads.values()) read.reject(new Error(message))
    this.reads.clear()
    for (const [requestId, request] of requests) if (!request.completed) this.listener?.({ type: 'task.completed', requestId,
      status: request.sent ? 'failed' : 'rejected', exitCode: null, effectState: request.sent ? 'unknown' : 'none',
      cleanupConfirmed, stdoutTotal: 0, stderrTotal: 0, error })
    this.listener?.(this.terminal)
  }
}
