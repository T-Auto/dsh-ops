/** Internal task-v1 producer for the real DSH Jobs registry; no new registry or public tool. */
import type { JobRegistry, JobId, JobOutcome } from '../../adapter/dsh/types.js'
import type { ShellCall, HostBashResult } from '../../shells/types.js'
import { hostForeground } from '../../shells/host-contract.js'
import { settledStream } from '../../shells/execution.js'
import { BashJobAdmissionError } from '../../shells/jobs.js'
import type { TaskExecution } from './task-execution.js'

/** A Jobs producer must construct its execution with onExpiry:none; waits own only observation. */
type Start = (call: ShellCall, lifetime: 'foreground' | 'job') => TaskExecution
interface Options { label: string; background: boolean; timeoutMs: number }
const running = (status: string) => status === 'running' || status === 'stopping'

export async function runTaskJob(jobs: JobRegistry, options: Options, call: ShellCall, start: Start): Promise<HostBashResult> {
  call = { ...call }; options = { ...options }
  call.signal?.throwIfAborted()
  const owner = call.agent?.id, cancellation = new AbortController()
  let id: JobId | undefined, execution: TaskExecution | undefined, invoked = false
  let producer: Promise<JobOutcome> = Promise.resolve({ status: 'failed', detail: 'Task not registered' })
  let handedOff = false
  const committed = () => {
    if (!id) return false
    try { jobs.get(id, owner); return true } catch { return false }
  }
  const cancel = (reason = 'task cancelled') => {
    cancellation.abort(new Error(reason)); execution?.kill(reason)
  }
  const abort = () => {
    // Registration is already durable during a reentrant registered event,
    // before start() returns. A published explicit background job owns itself.
    if (handedOff || options.background && committed()) return
    cancel('tool call aborted')
  }
  call.signal?.addEventListener('abort', abort, { once: true })
  try {
    try {
      id = jobs.start({ kind: 'bash', label: options.label, ...(owner ? { owner } : {}),
        output: (['stdout', 'stderr'] as const).map(stream => ({ channel: stream,
          read: offset => execution?.observed[stream].readFrom(offset) ?? { text: '', nextOffset: offset, lossy: false } })),
        run(handle) {
          invoked = true; id = handle.id
          producer = Promise.resolve().then(async (): Promise<JobOutcome> => {
            cancellation.signal.throwIfAborted()
            execution = start({ ...call, signal: cancellation.signal }, options.background ? 'job' : 'foreground')
            if (cancellation.signal.aborted) execution.kill('tool call aborted')
            const value = await execution.result()
            return { status: value.cancelled || value.timedOut || value.signal ? 'killed' : value.error ? 'failed' : 'completed',
              detail: value.error ?? (value.signal ? `signal: ${value.signal}` : `exit code: ${value.exitCode ?? 0}`) }
          }).catch(error => ({ status: cancellation.signal.aborted ? 'killed' : 'failed', detail: String(error instanceof Error ? error.message : error) }))
          return { done: producer, cancel }
        },
      })
    } catch (error) {
      cancel('job admission failed'); await producer
      throw new BashJobAdmissionError(error, invoked)
    }
    // Registry settlement follows its final source pump. Published terminal jobs
    // keep the public ring/spill metadata, not another pair of raw adapter tails.
    void producer.then(async () => {
      if (!handedOff) return
      try { await jobs.wait(id!, 2147483647, owner) } catch { /* owner/service removed the settled record */ }
      execution = undefined
    })
    if (options.background && !cancellation.signal.aborted) {
      handedOff = true
      return { kind: 'background', jobId: id, label: options.label }
    }
    const stop = async (reason: string) => {
      cancel(reason)
      jobs.kill(id!, owner, reason)
      await producer
      const view = await jobs.wait(id!, options.timeoutMs, owner)
      if (!running(view.status)) jobs.remove(id!, owner)
    }
    if (cancellation.signal.aborted) { await stop('tool call aborted'); throw cancellation.signal.reason }
    let view
    try { view = await jobs.wait(id, options.timeoutMs, owner, call.signal) }
    catch (error) { await stop('tool call aborted'); throw error }
    if (running(view.status)) {
      if (!execution?.started) {
        await stop('timed out during preparation')
        return hostForeground({ ...await execution?.result(), timedOut: true, timeoutMs: options.timeoutMs,
          stdout: settledStream(execution?.observed.stdout), stderr: settledStream(execution?.observed.stderr) }, execution?.effectState ?? 'none')
      }
      let promoted: boolean
      try { promoted = await execution.promote() }
      catch (error) { await stop('task promotion failed'); throw error }
      if (call.signal?.aborted || cancellation.signal.aborted) { await stop('tool call aborted'); throw call.signal?.reason ?? cancellation.signal.reason }
      if (promoted) {
        handedOff = true
        const read = jobs.read(id, owner)
        const stdout = read.chunks.filter(chunk => chunk.channel !== 'stderr').map(chunk => chunk.text).join('')
        const stderr = read.chunks.filter(chunk => chunk.channel === 'stderr').map(chunk => chunk.text).join('')
        const output = stdout + (stderr ? `${stdout && !stdout.endsWith('\n') ? '\n' : ''}[stderr]\n${stderr}` : '')
          + (read.lossy ? `\n[some output was dropped from memory; full output: ${(read.job.output.spillPaths ?? []).join(', ') || '(unavailable)'}]` : '')
        return { kind: 'promoted', jobId: id, label: options.label, timeoutMs: options.timeoutMs, output }
      }
      await producer
      view = await jobs.wait(id, options.timeoutMs, owner)
    }
    if (running(view.status)) throw new Error('Task producer settled without a terminal Jobs record')
    jobs.remove(id, owner)
    if (!execution) throw new Error(view.detail ?? 'Task preparation failed')
    return hostForeground(await execution.result(), execution.effectState)
  } finally { call.signal?.removeEventListener('abort', abort) }
}
