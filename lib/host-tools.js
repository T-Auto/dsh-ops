/** Reversible model-facing masks; never unregister or patch another plugin's tools. */
import { renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import { safeDisposeAll } from './teardown.js'

export const BUILTIN_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'pwsh_persistent']

export function mountHostToolPolicy(ctx, { denied, enabled = () => true, reason, owner = ctx }) {
  const names = new Set(denied)
  const agents = new Map()
  let refreshing = false, stopped = false
  const warn = error => ctx.logger?.warn?.(`dsh-ops: host tool restriction failed: ${error.message ?? error}`)
  const clear = lifts => { safeDisposeAll(lifts.values(), warn); lifts.clear() }
  const refresh = () => {
    if (refreshing || stopped) return
    refreshing = true
    try {
      if (!enabled()) {
        for (const entry of agents.values()) clear(entry.lifts)
        return
      }
      for (const [agent, entry] of agents) {
        if (!entry.ctx) continue
        const visible = ctx.tools.schemas(agent).map(tool => tool.name)
        for (const name of visible.filter(name => names.has(name) && !entry.lifts.has(name))) {
          try { entry.lifts.set(name, entry.ctx.tools.restrict({ deny: [name] })) }
          catch (error) {
            // Own-scope definitions cannot be masked. Assembly and the guard still cover them.
            if (!/^tools\.restrict\(\) names unknown global tool/.test(error.message)) warn(error)
          }
        }
      }
    } finally { refreshing = false }
  }
  const attach = agent => {
    if (!agent?.ctx || agents.has(agent)) return
    const entry = { lifts: new Map(), ctx: undefined, fiber: undefined }
    agents.set(agent, entry)
    entry.fiber = agent.ctx.plugin(child => {
      child.inject(['tools'], inner => { entry.ctx = inner; refresh() })
    })
  }
  ctx.on('agent/created', ({ agent }) => attach(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const entry = agents.get(agent)
    agents.delete(agent)
    if (entry) {
      refreshing = true
      try { clear(entry.lifts) } finally { refreshing = false }
      void entry.fiber?.dispose()
      refresh()
    }
  })
  ctx.on('tools/change', refresh)
  ctx.effect(() => owner.on('loader/volatile-update', refresh), 'dsh-ops: live host tool policy')
  ctx.effect(() => ctx.tools.guard(exec => enabled() && names.has(exec.name) ? reason(exec.name) : undefined), 'dsh-ops: host tool guard')
  ctx.on('tools/pre-execute', (exec, next) => enabled() && names.has(exec.name)
    ? { kind: 'deny', reason: reason(exec.name) } : next())
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    if (!enabled()) return result
    const scope = context.scope ?? context.agent
    return {
      ...result,
      tools: result.tools.filter(tool => !names.has(tool.name)),
      sections: result.sections.filter(section => ![...names].some(name => section.name === `tool:${name}`))
        .map(section => {
          if (section.name !== 'tools:sdk' || !section.text.trim()) return section
          const render = ctx.get('ptcRuntime')?.language === 'python' ? renderToolsSdkPy : renderToolsSdk
          const schemas = ctx.tools.schemas(scope).filter(tool => tool.name !== 'run_code' && !names.has(tool.name))
            .map(tool => ({ ...tool, output: ctx.tools.get(tool.name, scope).output.schema }))
          return { ...section, text: render(schemas) }
        }),
    }
  })
  ctx.effect(() => async () => {
    stopped = true
    for (const entry of agents.values()) clear(entry.lifts)
    await Promise.allSettled([...agents.values()].map(entry => entry.fiber?.dispose()))
    agents.clear()
  }, 'dsh-ops: host tool masks')
  for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent)
}

export function mountBuiltinTools(ctx, raw, owner) {
  mountHostToolPolicy(ctx, {
    denied: BUILTIN_TOOLS,
    enabled: () => (typeof raw?.get === 'function' ? raw.get() : raw) === true,
    owner,
    reason: name => `Host tool ${name} is hidden by dsh-ops hideBuiltinTools. Use the available ops_* tools instead; if none cover this task, ask the operator to turn off hideBuiltinTools.`,
  })
}
