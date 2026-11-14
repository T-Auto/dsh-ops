/** Public execution events prove a live run_code parent, not merely a truthy token. */
import type { Context, ToolRunContext, ToolExecution } from '../adapter/dsh/types.js'
import { inspectPresentation } from './presentation.js'
interface AdmissionOwner { refs: number; active: Map<symbol, ToolExecution>; revision(): number; bump(): void }
const owners = new WeakMap<object, AdmissionOwner>()
export function acquireResultAdmission(ctx: Context): { authorize(exec: ToolRunContext): Promise<(() => boolean) | undefined>; dispose(): void } {
  const root = ctx.root ?? ctx
  let owner = owners.get(root)
  if (!owner) {
    let revision = 0
    owner = { refs: 0, active: new Map(), revision: () => revision, bump() { ++revision } }
    owners.set(root, owner)
  }
  const owned = owner
  // Subscribe on the caller's own context, never on the root: dsh-tui's
  // root-capability guard refuses `root.events.on` from a plugin activation, and
  // the row that attaches the native tools runs as one, which failed the whole
  // agent mount. `global` keeps the root-level dispatch these listeners were
  // written against.
  const unwatchPrompt = ctx.on('system-prompt/change', () => { owned.bump() }, { global: true })
  const unwatch = ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'run_code' || exec.parent || !exec.agent || !exec.toolSet) return next()
    owned.active.set(exec.token, exec)
    try { return await next() } finally { owned.active.delete(exec.token) }
  }, { global: true })
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
      if (typeof unwatch === 'function') unwatch()
      if (typeof unwatchPrompt === 'function') unwatchPrompt()
      if (--owned.refs === 0) {
        owned.active.clear()
        if (owners.get(root) === owned) owners.delete(root)
      }
    },
  }
}