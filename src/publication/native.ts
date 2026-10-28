/** Scoped Native file publication. Callers supply policy; this controller owns lifecycle. */
import type { Context, Fiber } from '../adapter/dsh/types.js'
import type { Agent } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import { NativeFileTools } from '../file/runtime.js'
import { registerNativeProviderAtScope } from '../file/result-provider.js'
import { resolveWorker } from '../file/worker.js'
import { mountResultLifecycle } from '../kernel/result-lifecycle.js'
import { BASH_TOOL, modeSectionName, MODE_SECTION_ORDERS, renderToolingPolicy } from '../policy.js'
import { visibleNames } from '../surface.js'
import { isNativePresentation, isPresentationProbe } from '../presentation.js'
import { onToolChange } from '../tool-changes.js'
import type { ResolvedConfig } from '../config.js'
import { ownScopes } from '../scoped-ownership.js'
import { failure } from '../file/worker.js'
import type { PublicationGate } from './types.js'

type ResidentName = Parameters<NativeFileTools['definition']>[0]

interface Entry {
  agent: Agent
  ctx?: Context
  fiber?: Fiber
  runtime: NativeFileTools
  owned: Set<string>
  disposers: (() => void)[]
  ready: Promise<void>
}

/** The names, guidance and eligibility supplied by one composition. */
export interface NativePublication {
  id: string
  tools: readonly ResidentName[]
  section: string | null
  gate: PublicationGate
}

export function mountNative(root: Context, config: ResolvedConfig, publication: NativePublication): void {
  const { id: mode, tools: names, section, gate } = publication
  let worker: string
  try { worker = resolveWorker({ binaryPath: config.binaryPath }) } catch (error) {
    if (config.required) throw error
    root.logger.warn(`dsh-ops: ${mode} mode cannot resolve its native worker; native file tools stay unpublished. ${String((error as Error)?.message ?? error)}`)
    return
  }
  root.inject(['tools', 'systemPrompt', 'sandboxPolicy', 'subprocess'], async ctx => {
    const tools = ctx.get('tools')
    const prompt = ctx.get('systemPrompt')
    if (!tools || !prompt) return
    mountResultLifecycle(ctx)
    const entries = new Map<Agent, Entry>()
    let stopped = false, mutating = false
    const ownership = await ownScopes(ctx, 'native-files', () => reconcile(), gate.allows)
    const native = new Map<Agent, boolean>()
    const clear = (entry: Entry): void => {
      entry.owned.clear()
      for (const dispose of entry.disposers.splice(0)) {
        try { dispose() } catch (error) { ctx.logger.warn(`dsh-ops: ${mode} native publication cleanup failed: ${String(error)}`) }
      }
      entry.runtime.cancel('Mode row ownership changed')
      void entry.runtime.stop().catch(error => ctx.logger.warn(`dsh-ops: ${mode} native runtime stop failed: ${String(error)}`))
    }
    const publish = (agent: Agent, entry: Entry): void => {
      if (!entry.ctx) return
      const scope = agent
      const definitions = names.map(name => {
        const definition = entry.runtime.definition(name)
        return { ...definition, execute: async (args: unknown, exec: Parameters<typeof definition.execute>[1]) => {
          if (stopped || entries.get(agent) !== entry || !cover(agent) || exec.agent !== agent
            || !await isNativePresentation(prompt, agent, exec.signal).catch(() => false) || stopped || !cover(agent)
            || tools.get(definition.name, agent) !== registration(definition.name)) {
            return failure('POLICY_DENIED', 'Native capability belongs to a different or inactive scope.')
          }
          return definition.execute(args, exec)
        } }
      })
      const registration = (name: string) => definitions.find(definition => definition.name === name)
      const dispose = registerNativeProviderAtScope(entry.ctx, scope, definitions,
        tool => entry.ctx!.tools.register(tool), { inheritable: false, priority: 10 })
      entry.disposers.push(dispose)
      for (const definition of definitions) entry.owned.add(definition.name)
    }
    const cover = (agent: Agent): boolean => gate.allows(agent) && ownership.owns(agent)
    const attach = (agent: Agent): void => {
      if (stopped || entries.has(agent) || !agent?.ctx) return
      const entry: Entry = { agent, runtime: new NativeFileTools({ ctx, config: { workerPath: worker, required: config.required, denyCredentialReads: config.denyCredentialReads } }),
        owned: new Set(), disposers: [], ready: Promise.resolve() }
      entries.set(agent, entry)
      entry.fiber = agent.ctx.plugin({ inject: ['tools'], apply(scoped) { entry.ctx = scoped } })
      entry.ready = Promise.resolve(entry.fiber).then(() => {
        if (stopped || entries.get(agent) !== entry || !entry.ctx) return
        return entry.runtime.start([]).then(async () => {
          if (native.get(agent) === false || !await isNativePresentation(prompt, agent).catch(() => false)) return
          if (stopped || entries.get(agent) !== entry || !cover(agent)) return
          publish(agent, entry)
        })
      }).catch(error => ctx.logger.warn(`dsh-ops: ${mode} mode publication failed: ${String(error)}`))
    }
    const detach = (agent: Agent): void => {
      const entry = entries.get(agent)
      if (!entry) return
      entries.delete(agent)
      clear(entry)
      void entry.fiber?.dispose()
    }
    const reconcile = (): void => {
      if (stopped || mutating) return
      mutating = true
      try {
        for (const [agent, entry] of entries) if (!cover(agent)) detach(agent)
        for (const agent of ctx.get('agents')?.list?.() ?? []) if (cover(agent)) attach(agent)
      } finally { mutating = false }
    }
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (isPresentationProbe(context)) return next()
      const agent = context.scope as Agent
      await entries.get(agent)?.ready
      const result = await next()
      if (!agent || !gate.allows(agent)) return result
      const allowed = !result.sections.some(section => section.name === 'tools:ptc-only' && section.text.trim())
      if (native.get(agent) !== allowed) {
        native.set(agent, allowed)
        if (!allowed) detach(agent)
        else attach(agent)
        if (entries.has(agent)) await entries.get(agent)?.ready
        return prompt.assemble(context)
      }
      return result
    })
    ctx.on('agent/created', ({ agent }) => { if (cover(agent)) attach(agent) })
    ctx.on('agent/disposed', ({ agent }) => detach(agent))
    ctx.on('session/event', (_session, event) => {
      // A blank session may select another preset before its first turn; the mode
      // that no longer matches must withdraw its surface.
      if ((event as { type: string }).type === 'agent-preset/selected') reconcile()
    })
    if (gate.watch) ctx.effect(() => gate.watch!(reconcile), `dsh-ops: ${mode} publication observer`)
    for (const agent of ctx.get('agents')?.list?.() ?? []) if (cover(agent)) attach(agent)
    if (section !== null) {
      const suffix = section
      ctx.effect(() => prompt.section({
        name: modeSectionName(suffix), order: MODE_SECTION_ORDERS[suffix] ?? 3250, interpolate: false,
        text: context => {
          const agent = context.agent
          if (agent === undefined || !config.promptPolicy) return ''
          const entry = entries.get(agent)
          if (!entry || entry.owned.size === 0) return ''
          const visible = new Set(visibleNames(tools, agent))
          const published = [...entry.owned].filter(name => visible.has(name))
          // The Windows shell replacement is published by the shared shell row;
          // name it here when it is visible so routing text stays complete.
          if (visible.has(BASH_TOOL)) published.push(BASH_TOOL)
          return renderToolingPolicy({ published, shellComponent: true, extraGuidance: config.extraGuidance })
        },
      }), `dsh-ops: ${mode} tooling guidance`)
    }
    ctx.effect(() => () => {
      stopped = true
      for (const agent of [...entries.keys()]) detach(agent)
      ownership.dispose()
    }, `dsh-ops: ${mode} native lifecycle`)
    ownership.refresh()
  })
}
