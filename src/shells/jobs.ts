// Adapted from @deepseek-ai/dsh-tool-bash 0.2.0-rc.2 (MIT). See licenses/deepseek-harness/LICENSE.
/** Adapt one OPS execution to the host job registry without replacing its lifecycle. */
import type { ShellJobs, ShellCall, StartShell, ShellExecution, ShellJobView, HostBashResult } from './types.js'
import { errorMessage } from './types.js'
import { hostForeground } from './host-contract.js'

/** A run hook may have been accepted even when admission itself throws. */
export class BashJobAdmissionError extends Error {
  constructor(cause: unknown, readonly runInvoked: boolean) { super(errorMessage(cause), { cause }); this.name = 'BashJobAdmissionError' }
}

const running = (view: ShellJobView): boolean => ['running', 'stopping'].includes(view.status)

export function startBashJob(jobs: ShellJobs, args: { description?: string; command?: string; script_path?: string }, exec: ShellCall, start: StartShell) {
  const label = args.description ?? args.command ?? args.script_path ?? 'Bash'
  let process: ShellExecution | undefined
  let stopped: string | undefined
  let runInvoked = false
  let attempted = false
  const cancellation = new AbortController()
  const output = (['stdout', 'stderr'] as const).map(stream => ({
    channel: stream,
    read: (offset: number) => process?.observed[stream].readFrom(offset) ?? { text: '', nextOffset: offset, lossy: false },
  }))
  let id: string
  try { id = jobs.start({ kind: 'bash', label,
    ...(exec.agent ? { owner: exec.agent.id } : {}),
    ...(typeof exec.callId === 'string' && exec.callId.length > 0 && typeof exec.rootCallId === 'string' && exec.rootCallId.length > 0
      ? { toolCall: { callId: exec.callId, rootCallId: exec.rootCallId } } : {}),
    output,
    run: () => {
      runInvoked = true
      const done = Promise.resolve().then(async () => {
        cancellation.signal.throwIfAborted()
        attempted = true
        process = await start({ ...exec, signal: cancellation.signal }, { onExpiry: 'none' })
        if (cancellation.signal.aborted) process.kill(stopped)
        const value = await process.result()
        const state: 'killed' | 'failed' | 'completed' = value.cancelled || value.signal || value.timedOut ? 'killed' : value.error ? 'failed' : 'completed'
        const detail = value.error ?? (value.signal ? `signal: ${value.signal}` : `exit code: ${value.exitCode ?? 0}`)
        const sandbox = value.sandbox?.runnerFailed ? '; sandbox runner failed before the command ran'
          : value.sandbox?.denied ? `; sandbox denied file access under ${value.sandbox.mode} mode` : ''
        return { status: state, detail: detail + sandbox }
      }).catch((error: unknown): { status: 'killed' | 'failed'; detail: string } => ({ status: cancellation.signal.aborted ? 'killed' : 'failed', detail: errorMessage(error) }))
      return { done, cancel: reason => { stopped = reason; cancellation.abort(new Error(reason)); process?.kill(reason) } }
    },
  }) } catch (error) {
    // Cancel the queued microtask before a refused admission can orphan a command.
    cancellation.abort(error)
    process?.kill('job admission failed')
    throw new BashJobAdmissionError(error, runInvoked)
  }
  return { id, label, process: () => process, stopped: () => stopped,
    effects: (): 'none' | 'unknown' => process ? (process.started ? 'unknown' : 'none') : attempted ? 'unknown' : 'none' }
}

export async function waitOnBashJob(jobs: ShellJobs, attached: ReturnType<typeof startBashJob>, exec: ShellCall, timeoutMs: number): Promise<HostBashResult> {
  const owner = exec.agent?.id
  const stop = async (reason: string) => {
    jobs.kill(attached.id, owner, reason)
    const settled = await jobs.wait(attached.id, timeoutMs, owner)
    if (!running(settled)) jobs.remove(attached.id, owner)
  }
  let view
  try { view = await jobs.wait(attached.id, timeoutMs, owner, exec.signal) }
  catch (error) { await stop('tool call aborted'); throw error }
  if (running(view)) {
    if (!attached.process()?.started) {
      await stop('timed out during preparation')
      return hostForeground({ timedOut: true, timeoutMs,
        stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }, attached.effects())
    }
    const read = jobs.read(attached.id, owner)
    const stdout = read.chunks.filter(chunk => chunk.channel !== 'stderr').map(chunk => chunk.text).join('')
    const stderr = read.chunks.filter(chunk => chunk.channel === 'stderr').map(chunk => chunk.text).join('')
    const text = stdout + (stderr ? `${stdout && !stdout.endsWith('\n') ? '\n' : ''}[stderr]\n${stderr}` : '')
    const loss = read.lossy ? '\n[some output was dropped from memory; full output: '
      + ((read.job.output.spillPaths ?? []).join(', ') || '(unavailable)') + ']' : ''
    return { kind: 'promoted', jobId: attached.id, label: attached.label, timeoutMs, output: text + loss }
  }
  jobs.remove(attached.id, owner)
  const process = attached.process()
  if (!process) throw new Error(view.detail ?? 'Bash job preparation failed')
  return hostForeground({ ...await process.result(), ...(attached.stopped() ? { stopped: attached.stopped() } : {}) }, process.started ? 'unknown' : 'none')
}
