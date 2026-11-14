/** Bounded shell correlation on the existing resident control pipe; scheduling stays native. */
import { record } from '../boundary.js'
import { validShellBootstrap } from './shell-protocol.js'
import type { ShellCompleted, ShellHostMessage, ShellKernelMessage, ShellOutput, ShellStream, ShellTransport } from './shell-protocol.js'

interface Request { sent: boolean; started: boolean; completed?: boolean; local?: boolean; cancelled?: boolean; awaitingAdmission?: boolean; remove?: () => boolean }
interface Read { offset: number; maxBytes: number; resolve(value: ShellOutput): void; reject(error: Error): void }
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const count = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0
const error = (value: unknown): boolean => record(value) && typeof value.code === 'string' && typeof value.message === 'string'

export class ResidentShellChannel implements ShellTransport {
  capabilities: readonly string[] = []
  private readonly requests = new Map<string, Request>()
  private readonly controls = new Map<string, { sessionKey: string; close: boolean }>()
  private readonly sessions = new Set<string>()
  private readonly reads = new Map<string, Read>()
  private listener?: (message: ShellKernelMessage) => void
  private terminal?: Extract<ShellKernelMessage, { type: 'shell.unavailable' }>
  constructor(private readonly isAvailable: () => boolean,
    private readonly write: (value: ShellHostMessage, sending?: () => void) => () => boolean,
    readonly abort: (error: Error) => void, private readonly kernelPid: () => number) {}
  get available(): boolean { return !this.terminal && this.isAvailable() }
  subscribe(listener: (message: ShellKernelMessage) => void): () => void {
    if (this.listener) throw new Error('Resident shell already has an admission owner')
    this.listener = listener
    if (this.terminal) queueMicrotask(() => { if (this.listener === listener) listener(this.terminal!) })
    return () => { if (this.listener === listener) this.listener = undefined }
  }
  send(message: ShellHostMessage): void {
    if (!this.available || !this.capabilities.includes('shell-v1')) throw new Error('Resident shell capability is unavailable')
    if (!identity(message.requestId)) throw new Error('Invalid shell request identity')
    if (message.type === 'shell.execute') {
      if (this.requests.size >= 32 || this.requests.has(message.requestId) || this.controls.has(message.requestId)) throw new Error('Resident shell admission is full or request identity is duplicated')
      if (!identity(message.sessionKey) || (!this.sessions.has(message.sessionKey) && this.sessions.size >= 32)) throw new Error('Resident shell owner capacity is full or invalid')
      const newSession = !this.sessions.has(message.sessionKey)
      this.sessions.add(message.sessionKey)
      const request: Request = { sent: false, started: false }
      this.requests.set(message.requestId, request)
      try { request.remove = this.write(message, () => { request.sent = true }) }
      catch (error) { this.requests.delete(message.requestId); if (newSession) this.sessions.delete(message.sessionKey); throw error }
      return
    }
    if (message.type === 'shell.retire' || message.type === 'shell.close') {
      if (this.controls.size >= 64 || this.controls.has(message.requestId) || this.requests.has(message.requestId)) throw new Error('Resident shell control capacity is full or identity is duplicated')
      if ([...this.controls.values()].some(control => control.sessionKey === message.sessionKey && control.close === (message.type === 'shell.close'))) throw new Error('Duplicate pending shell owner control')
      this.controls.set(message.requestId, { sessionKey: message.sessionKey, close: message.type === 'shell.close' })
      try { this.write(message) } catch (error) { this.controls.delete(message.requestId); throw error }
      return
    }
    const request = this.requests.get(message.requestId)
    if (!request) throw new Error('Unknown resident shell request')
    if (message.type === 'shell.release') {
      if (!request.completed || ['stdout', 'stderr'].some(stream => this.reads.has(`${message.requestId}:${stream}`))) throw new Error('Shell output is still active')
      if (!request.local) this.write(message)
      this.requests.delete(message.requestId)
      return
    }
    if (message.type === 'shell.read') {
      throw new Error('Shell reads require the offset-correlated read() method')
    }
    if (request.completed) throw new Error('Shell execution already completed')
    if (message.type === 'shell.admission') {
      if (!request.awaitingAdmission) throw new Error('Shell admission reply was not requested')
      this.write(message)
      request.awaitingAdmission = false
      return
    }
    if (message.type === 'cancel' && request.cancelled) return
    if (message.type === 'cancel') request.cancelled = true
    if (message.type === 'cancel' && !request.sent && request.remove?.()) {
      request.completed = true
      request.local = true
      this.listener?.({ type: 'shell.completed', requestId: message.requestId, status: 'cancelled', exitCode: null,
        effectState: 'none', shellState: 'preserved', cleanupConfirmed: true, stdoutTotal: 0, stderrTotal: 0,
        error: { code: 'CANCELLED', message: 'Cancelled before the execution frame was written.' } })
      return
    }
    this.write(message)
  }
  read(requestId: string, stream: ShellStream, offset: number, maxBytes: number): Promise<ShellOutput> {
    const key = `${requestId}:${stream}`
    if (!this.available || !this.capabilities.includes('shell-v1')) return Promise.reject(new Error('Resident shell capability is unavailable'))
    if (!this.requests.has(requestId)) return Promise.reject(new Error('Unknown resident shell request'))
    if (!['stdout', 'stderr'].includes(stream) || !count(offset) || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536
      || this.reads.has(key)) return Promise.reject(new Error('Invalid or concurrent shell stream read'))
    if (this.requests.get(requestId)?.local) return Promise.resolve({ type: 'shell.output', requestId, stream,
      offset, nextOffset: offset, bytesBase64: '', lossy: offset !== 0, eof: true })
    return new Promise((resolve, reject) => {
      this.reads.set(key, { offset, maxBytes, resolve, reject })
      try { this.write({ type: 'shell.read', requestId, stream, offset, maxBytes }) }
      catch (error) { this.reads.delete(key); reject(error) }
    })
  }
  receive(value: Record<string, unknown>): boolean {
    if (typeof value.type !== 'string' || !value.type.startsWith('shell.')) return false
    if (!this.capabilities.includes('shell-v1') || !identity(value.requestId)) throw new Error('Unnegotiated or invalid shell response')
    if (value.type === 'shell.output') {
      const key = `${value.requestId}:${value.stream}`, read = this.reads.get(key)
      if (!read || value.offset !== read.offset || !count(value.nextOffset) || Number(value.nextOffset) < read.offset
        || typeof value.lossy !== 'boolean' || typeof value.eof !== 'boolean' || typeof value.bytesBase64 !== 'string'
        || (value.error !== undefined && !error(value.error))
        || (value.spillError !== undefined && typeof value.spillError !== 'string')
        || (value.spillPath === undefined
          ? [value.spillOrigin, value.spillPid, value.spillSealed].some(item => item !== undefined)
          : !this.capabilities.includes('shell-spill-v1') || value.spillOrigin !== 'ops-native-v1'
            || value.spillPid !== this.kernelPid() || typeof value.spillSealed !== 'boolean'
            || typeof value.spillPath !== 'string' || !value.spillPath || value.spillPath.length > 4096
            || value.spillPath.includes('\0'))) throw new Error('Invalid shell output receipt')
      const bytes = Buffer.from(value.bytesBase64, 'base64'), delta = Number(value.nextOffset) - read.offset
      if (bytes.length > read.maxBytes || bytes.toString('base64') !== value.bytesBase64 || delta < bytes.length
        || (!value.lossy && delta !== bytes.length)) throw new Error('Invalid shell output bytes or offsets')
      this.reads.delete(key)
      read.resolve(value as unknown as ShellOutput)
      return true
    }
    if (value.type === 'shell.closed') {
      const control = this.controls.get(value.requestId)
      if (!control || typeof value.cleanupConfirmed !== 'boolean'
        || (!value.cleanupConfirmed && !error(value.error))) throw new Error('Invalid shell cleanup receipt')
      this.controls.delete(value.requestId)
      if (control.close && value.cleanupConfirmed) this.sessions.delete(control.sessionKey)
    } else {
      const request = this.requests.get(value.requestId)
      if (!request?.sent || request.completed) throw new Error('Unknown, completed or unwritten shell response identity')
      if (value.type === 'shell.admit') {
        if (request.started || request.awaitingAdmission || typeof value.hasShell !== 'boolean' || (!value.hasShell && !validShellBootstrap(value.bootstrap))) {
          throw new Error('Invalid shell admission request')
        }
        request.awaitingAdmission = true
      } else if (value.type === 'shell.started') {
        if (request.started) throw new Error('Resident shell command started twice')
        request.started = true
      } else if (value.type === 'shell.completed') {
        if (!['completed', 'failed', 'cancelled', 'rejected'].includes(String(value.status))
          || !(value.exitCode === null || Number.isSafeInteger(value.exitCode))
          || !['none', 'unknown'].includes(String(value.effectState)) || !['preserved', 'reset'].includes(String(value.shellState))
          || typeof value.cleanupConfirmed !== 'boolean' || !count(value.stdoutTotal) || !count(value.stderrTotal)
          || (value.status !== 'completed' && !error(value.error))
          || (value.status === 'completed' && (!request.started || !value.cleanupConfirmed))
          || (value.status === 'rejected' && (request.started || value.effectState !== 'none'))) throw new Error('Invalid shell completion receipt')
        request.completed = true
      } else throw new Error('Unknown resident shell response')
    }
    if (!this.listener) throw new Error('Resident shell response has no admission owner')
    this.listener(value as unknown as ShellKernelMessage)
    return true
  }
  /** Called only once outer managed-range cleanup has finished, including its failure result. */
  unavailable(message: string, cleanupConfirmed: boolean): void {
    if (this.terminal) return
    const failure = { code: 'EXECUTOR_UNAVAILABLE', message }
    this.terminal = { type: 'shell.unavailable', cleanupConfirmed, error: failure }
    const requests = [...this.requests]
    this.requests.clear(); this.controls.clear(); this.sessions.clear()
    for (const read of this.reads.values()) read.reject(new Error(message))
    this.reads.clear()
    for (const [requestId, request] of requests) {
      if (request.completed) continue
      const result: ShellCompleted = { type: 'shell.completed', requestId, status: request.sent ? 'failed' : 'rejected', exitCode: null,
        effectState: request.sent ? 'unknown' : 'none', shellState: 'reset', cleanupConfirmed,
        stdoutTotal: 0, stderrTotal: 0, error: failure }
      this.listener?.(result)
    }
    this.listener?.(this.terminal)
  }
}
