/** Scripted native boundary for deterministic transport/host assertions, never a process proof. */
import { ResidentTaskChannel } from '../../lib/execution/resident/task-channel.js'

export const turn = () => new Promise(resolve => setImmediate(resolve))
export const executeTask = (requestId, ownerKey = 'owner') => ({ type: 'task.execute', requestId, ownerKey,
  lifetime: 'foreground', graceMs: 0.5, timeoutMs: 1.25, output: { memoryBytes: 64000, spillBytes: 67108864 } })
export const completedTask = (requestId, changes = {}) => ({ type: 'task.completed', requestId, status: 'completed',
  exitCode: 0, effectState: 'unknown', cleanupConfirmed: true, stdoutTotal: 0, stderrTotal: 0, ...changes })
export const outputTask = (read, bytes = Buffer.alloc(0), changes = {}) => ({ type: 'task.output', requestId: read.requestId,
  stream: read.stream, offset: read.offset, retainedOffset: read.offset, nextOffset: read.offset + bytes.length,
  bytesBase64: bytes.toString('base64'), lossy: false, eof: true, ...changes })
export function taskTransport({ held = false, cleanup = true, autoRead = true } = {}) {
  let available = true, waitingCleanup = false
  const frames = [], queued = [], events = [], failures = [], watchers = new Set()
  const transport = new ResidentTaskChannel(() => available, (value, sending = () => {}) => {
    const entry = { value, sending }
    if (held) queued.push(entry)
    else { sending(); frames.push(value); for (const watcher of [...watchers]) watcher(value) }
    return () => { const index = queued.indexOf(entry); if (index < 0) return false; queued.splice(index, 1); return true }
  }, error => { failures.push(error); available = false; waitingCleanup = true; if (cleanup) queueMicrotask(() => finishCleanup(true)) }, () => 123)
  transport.capabilities = ['task-v1']
  function emit(value) { try { transport.receive(value) } catch (error) { transport.abort(error) } }
  function finishCleanup(confirmed) { if (!waitingCleanup) return; waitingCleanup = false; transport.unavailable(failures[0]?.message ?? 'lost', confirmed) }
  if (autoRead) watchers.add(value => { if (value.type === 'task.read') queueMicrotask(() => emit(outputTask(value))) })
  return { transport, frames, queued, events, failures, emit, finishCleanup,
    subscribe() { return transport.subscribe(value => events.push(value)) },
    onFrame(listener) { watchers.add(listener); return () => watchers.delete(listener) },
    release() { held = false; while (queued.length) { const entry = queued.shift(); entry.sending(); frames.push(entry.value); for (const watcher of [...watchers]) watcher(entry.value) } },
  }
}
