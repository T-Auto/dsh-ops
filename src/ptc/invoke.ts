import type { Context } from '../adapter/dsh/types.js'
import type { ToolRunContext } from '../adapter/dsh/types.js'
import { FILE_TOOLS } from '../capabilities/registry.js'
import { invoke as fileInvoke } from '../file/worker.js'
import { invoke } from './worker.js'
import { record } from './projection/outcome.js'
import { publicToolName } from '../policy.js'
import type { ApiName, PtcConfig } from './config.js'
interface JobHooks { updateProgress(text: string): void }
interface Jobs {
  start(spec: { kind: string; label: string; owner: string; outputLimitBytes: number;
    run(job: JobHooks): { cancel(reason?: string): void; done: Promise<{ status: string; result?: string; detail?: string }> } }): string
  wait(id: string, timeout: number, owner: string): Promise<unknown>
  remove(id: string, owner: string): unknown
}
/** File APIs retain the same authority bridge; only batch participates in host jobs. */
export async function monitoredInvoke(ctx: Context, file: string, tool: ApiName, args: unknown, exec: ToolRunContext,
  controller: AbortController, config: PtcConfig): Promise<unknown> {
  const owner = exec.agent?.session.id
  if (!owner) return { status: 'error', error: { code: 'POLICY_DENIED', message: 'An owning agent is required.', effectState: 'none' } }
  if ((FILE_TOOLS as readonly string[]).includes(tool)) return fileInvoke(ctx, file, tool, args, exec, controller.signal, config)
  const jobs = ctx.get('jobs') as Jobs | undefined
  if (tool !== 'batch' || typeof jobs?.start !== 'function') return invoke(ctx, file, tool, args, exec, controller.signal, config)
  let work: Promise<unknown> | undefined, id: string
  const input = record(args)
  try {
    id = jobs.start({ kind: 'ops', label: publicToolName('batch') + ' ' + String(input?.action ?? ''), owner: owner, outputLimitBytes: 4096,
      run(job) {
        job.updateProgress('preflight 0/' + (Array.isArray(input?.operations) ? input.operations.length : '?') + ' errors=0')
        work = invoke(ctx, file, tool, args, exec, controller.signal, config).then((raw: unknown) => {
          const value = record(raw)
          job.updateProgress(String(value?.phase ?? 'settled') + ' ' + (value?.done ?? 0) + '/' + (value?.total ?? '?') + ' errors=' + (value?.failed ?? 0) + ' unknown=' + (value?.unknown ?? 0))
          return raw
        })
        return { cancel: reason => controller.abort(new Error(reason ?? 'Host job cancelled')),
          done: work!.then(raw => ({ status: controller.signal.aborted ? 'killed' : ['completed', 'planned'].includes(String(record(raw)?.status)) ? 'completed' : 'failed', result: JSON.stringify(raw) }),
            error => ({ status: 'failed', detail: String(error) })) }
      },
    })
  } catch (error) {
    ctx.logger.warn('dsh-ops: host job admission unavailable; using bounded foreground execution: ' + String(error))
    return work ?? invoke(ctx, file, tool, args, exec, controller.signal, config)
  }
  const value = await work
  try { await jobs.wait(id, 1000, owner); jobs.remove(id, owner) }
  catch { /* Host teardown may already have collected the owned record. */ }
  return value
}
