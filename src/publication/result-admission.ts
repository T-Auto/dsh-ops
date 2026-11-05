/** Public execution events prove a live run_code parent, not merely a truthy token. */
import type { Context, ToolRunContext, ToolExecution } from '../adapter/dsh/types.js'
import { inspectPresentation } from './presentation.js'
const owners = new WeakMap<object, { refs: number; active: Map<symbol, ToolExecution>; dispose(): void }>()
export function acquireResultAdmission(ctx: Context): { allows(exec: ToolRunContext): Promise<boolean>; dispose(): void } {
  const root = ctx.root ?? ctx
  let owner = owners.get(root)
  if (!owner) {
    const active = new Map<symbol, ToolExecution>()
    const unwatch = root.on('tools/execute', async (exec, next) => {
      if (exec.name !== 'run_code' || exec.parent || !exec.agent || !exec.toolSet) return next()
      active.set(exec.token, exec)
      try { return await next() } finally { active.delete(exec.token) }
    })
    owner = { refs: 0, active, dispose: unwatch }
    owners.set(root, owner)
  }
  const owned = owner
  ++owned.refs
  let disposed = false
  return {
    async allows(exec) {
      const parent = exec.parent && owned.active.get(exec.parent)
      if (disposed || !parent || parent.agent !== exec.agent || parent.toolSet !== exec.toolSet
        || parent.rootCallId !== exec.rootCallId || parent.signal.aborted || exec.signal.aborted) return false
      const prompt = ctx.get('systemPrompt')
      if (!prompt || !exec.agent) return false
      const assembly = await inspectPresentation(prompt, exec.agent, exec.signal)
      return !disposed && owned.active.get(parent.token) === parent && !parent.signal.aborted && !exec.signal.aborted
        && assembly.tools.length === 1 && assembly.tools[0]?.name === 'run_code'
        && assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (--owned.refs === 0) { owned.dispose(); owned.active.clear(); owners.delete(root) }
    },
  }
}
