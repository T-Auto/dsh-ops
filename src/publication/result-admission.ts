/** Public execution events prove a live run_code parent, not merely a truthy token. */
import type { Context, ToolRunContext, ToolExecution } from '../adapter/dsh/types.js'
import { inspectPresentation } from './presentation.js'
const owners = new WeakMap<object, { refs: number; active: Map<symbol, ToolExecution>; revision(): number; dispose(): void }>()
/**
 * Track the live `run_code` parent behind one execution surface.
 *
 * `ctx` answers the authorization questions (the prompt service and the
 * agent/toolSet identity) and, by default, also receives the two event
 * subscriptions that key the shared ledger, so the ledger is released with the
 * listeners that feed it. `subscribe` exists for a caller that needs a different
 * lifetime than the context it authorizes through.
 * @param ctx - the context that serves authorization.
 * @param subscribe - the context that receives events; defaults to `ctx`.
 * @returns the per-surface admission handle.
 */
export function acquireResultAdmission(ctx: Context, subscribe: Context = ctx): { authorize(exec: ToolRunContext): Promise<(() => boolean) | undefined>; dispose(): void } {
  let owner = owners.get(subscribe)
  if (!owner) {
    const active = new Map<symbol, ToolExecution>()
    let revision = 0
    const unwatchPrompt = subscribe.on('system-prompt/change', () => { ++revision })
    const unwatch = subscribe.on('tools/execute', async (exec, next) => {
      if (exec.name !== 'run_code' || exec.parent || !exec.agent || !exec.toolSet) return next()
      active.set(exec.token, exec)
      try { return await next() } finally { active.delete(exec.token) }
    })
    owner = { refs: 0, active, revision: () => revision, dispose() { unwatch(); unwatchPrompt() } }
    owners.set(subscribe, owner)
  }
  const owned = owner
  ++owned.refs
  let disposed = false
  return {
    async authorize(exec) {
      const parent = exec.parent && owned.active.get(exec.parent)
      if (disposed || !parent || parent.agent !== exec.agent || parent.toolSet !== exec.toolSet
        || parent.rootCallId !== exec.rootCallId || parent.signal.aborted || exec.signal.aborted) return undefined
      const prompt = ctx.get('systemPrompt')
      if (!prompt || !exec.agent) return undefined
      const revision = owned.revision()
      // Carry the same grant through later asynchronous preflight. A successful
      // probe is not a permanent authorization to touch result storage.
      const current = () => !disposed && revision === owned.revision() && owned.active.get(parent.token) === parent
        && parent.token === exec.parent && parent.agent === exec.agent && parent.toolSet === exec.toolSet
        && parent.rootCallId === exec.rootCallId && !parent.signal.aborted && !exec.signal.aborted
      let assembly: Awaited<ReturnType<typeof inspectPresentation>>
      try { assembly = await inspectPresentation(prompt, exec.agent, exec.signal) }
      catch { return undefined }
      return current()
        && assembly.tools.length === 1 && assembly.tools[0]?.name === 'run_code'
        && assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
        ? current : undefined
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (--owned.refs === 0) { owned.dispose(); owned.active.clear(); owners.delete(subscribe) }
    },
  }
}
