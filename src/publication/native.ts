/** Scoped Native file publication. Callers supply policy; this controller owns lifecycle. */
import type { Context, Fiber } from '../adapter/dsh/types.js'
import type { Agent } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import { NativeFileTools } from '../projections/native/runtime.js'
import { registerNativeProviderAtScope, nativeProviderReady } from './providers.js'
import { resolveWorker } from '../execution/files.js'
import { mountResultLifecycle } from '../kernel/result-lifecycle.js'
import { publicToolName, modeSectionName, MODE_SECTION_ORDERS, renderToolingPolicy } from '../policy.js'
import { visibleNames } from './surface.js'
import { activationIsPtc, isNativePresentation, isPresentationProbe } from './presentation.js'
import type { ResolvedConfig } from '../config.js'
import { ownScopes } from './ownership.js'
import { failure } from '../execution/files.js'
import { acquireSharedFile, isSharedFileApi } from './scope-owner.js'
import type { PublicationGate } from './types.js'
import { publicationError, publicationReady, publicationRegistration } from './reentry.js'
import type { PublicationLease } from './registrar.js'

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
  extraGuidanceOwner?(agent: Agent): boolean
}

export function mountNative(root: Context, config: ResolvedConfig, publication: NativePublication): (agent: Agent) => boolean {
  const { id: mode, tools: names, section, gate } = publication
  let ownsGuidance: (agent: Agent) => boolean = () => false
  let worker: string
  try { worker = resolveWorker({ binaryPath: config.binaryPath }) } catch (error) {
    if (config.required) throw error
    root.logger.warn(`dsh-ops: ${mode} mode cannot resolve its native worker; native file tools stay unpublished. ${String((error as Error)?.message ?? error)}`)
    return () => false
  }
  root.inject(['tools', 'systemPrompt', 'sandboxPolicy', 'subprocess'], async ctx => {
    const tools = ctx.get('tools')
    const prompt = ctx.get('systemPrompt')
    if (!tools || !prompt) return
    mountResultLifecycle(ctx)
    const entries = new Map<Agent, Entry>()
    let stopped = false, mutating = false
    const ownership = await ownScopes(ctx, 'native-files', () => reconcile(), gate.allows)
    const clear = (entry: Entry): void => {
      entry.owned.clear()
      for (const dispose of entry.disposers.splice(0)) {
        try { dispose() } catch (error) { ctx.logger.warn(`dsh-ops: ${mode} native publication cleanup failed: ${String(error)}`) }
      }
      entry.runtime.cancel('Mode row ownership changed')
      void entry.runtime.stop().catch(error => ctx.logger.warn(`dsh-ops: ${mode} native runtime stop failed: ${String(error)}`))
    }
    const publish = async (agent: Agent, entry: Entry): Promise<void> => {
      if (!entry.ctx) return
      const scope = agent
      const leases: PublicationLease[] = [], registrations: (() => void)[] = []
      for (const api of names.filter(isSharedFileApi)) {
        const lease = await acquireSharedFile(agent, api, { workerPath: worker, required: true, denyCredentialReads: config.denyCredentialReads })
        if (stopped || entries.get(agent) !== entry || !cover(agent)) { lease.dispose(); return }
        entry.disposers.push(() => lease.dispose())
        lease.grant({ consumer: entry, agent, token: {}, entitled: true,
          dispatch: async () => undefined,
          present: async activation => activation.agent === agent && cover(agent) && !await activationIsPtc(prompt, activation) })
        leases.push(lease)
        entry.owned.add(publicToolName(api))
      }
      const definitions = names.filter(name => !isSharedFileApi(name)).map(name => {
        const definition = entry.runtime.definition(name)
        return { ...definition, execute: async (args: unknown, exec: Parameters<typeof definition.execute>[1]) => {
          if (stopped || entries.get(agent) !== entry || !cover(agent) || exec.agent !== agent
            || !await isNativePresentation(prompt, agent, exec.signal).catch(() => false) || stopped || !cover(agent)
            || tools.executable(definition.name, agent, exec.toolSet) !== registration(definition.name)) {
            return failure('POLICY_DENIED', 'Native capability belongs to a different or inactive scope.')
          }
          return definition.execute(args, exec)
        } }
      })
      const registration = (name: string) => definitions.find(definition => definition.name === name)
      if (definitions.length) {
        const dispose = registerNativeProviderAtScope(entry.ctx, scope, definitions, tool => {
          const remove = publicationRegistration(entry.ctx!, () => entry.ctx!.tools.register(tool, { when: async activation => activation.agent === agent && cover(agent)
            && !await activationIsPtc(prompt, activation) }))
          registrations.push(remove)
          return remove
        }, { inheritable: false, priority: 10 })
        entry.disposers.push(dispose)
      }
      for (const definition of definitions) entry.owned.add(definition.name)
      await Promise.all([...leases.map(lease => lease.ready()), ...registrations.map(publicationReady), ...entry.disposers.map(nativeProviderReady)])
    }
    const cover = (agent: Agent): boolean => gate.allows(agent) && ownership.owns(agent)
    const attach = (agent: Agent): void => {
      if (stopped || entries.has(agent) || !agent?.ctx) return
      const entry: Entry = { agent, runtime: new NativeFileTools({ ctx, config: { workerPath: worker, required: config.required, denyCredentialReads: config.denyCredentialReads } }),
        owned: new Set(), disposers: [], ready: Promise.resolve() }
      entries.set(agent, entry)
      entry.ready = Promise.resolve().then(async () => {
        if (stopped || entries.get(agent) !== entry || !cover(agent)) return
        entry.fiber = agent.ctx!.plugin({ inject: ['tools'], apply(scoped) { entry.ctx = scoped } })
        await entry.fiber
        if (stopped || entries.get(agent) !== entry || !entry.ctx) return
        await entry.runtime.start([])
        if (stopped || entries.get(agent) !== entry || !cover(agent)) return
        await publish(agent, entry)
      }).catch(async error => {
        try {
          if (entries.get(agent) === entry) { detach(agent); await entry.fiber?.dispose() }
        } catch { ctx.logger.warn(`dsh-ops: ${mode} native attachment cleanup failed`) }
        ctx.logger.warn(`dsh-ops: ${mode} mode publication failed: ${publicationError(error)}`)
        throw error
      })
      void entry.ready.catch(() => {})
    }
    const detach = (agent: Agent): void => {
      const entry = entries.get(agent)
      if (!entry) return
      entries.delete(agent)
      clear(entry)
      void Promise.resolve().then(() => entry.fiber?.dispose()).catch(error => {
        ctx.logger.warn(`dsh-ops: ${mode} native scope disposal failed: ${String(error)}`)
      })
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
      const result = await next()
      if (!isPresentationProbe(context) && result.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))) {
        entries.get(context.scope as Agent)?.runtime.cancel('Native presentation withdrawn')
      }
      return result
    })
    ctx.on('agent/created', async ({ agent }) => {
      if (cover(agent)) { attach(agent); await entries.get(agent)?.ready }
    })
    ctx.on('agent/disposed', ({ agent }) => detach(agent))
    ctx.on('session/event', (_session, event) => {
      // A blank session may select another preset before its first turn; the mode
      // that no longer matches must withdraw its surface.
      if ((event as { type: string }).type === 'agent-preset/selected') reconcile()
    })
    if (gate.watch) ctx.effect(() => gate.watch!(reconcile), `dsh-ops: ${mode} publication observer`)
    for (const agent of ctx.get('agents')?.list?.() ?? []) if (cover(agent)) attach(agent)
    const renderGuidance = (agent: Agent, toolSet?: import('../adapter/dsh/types.js').ResolvedToolSet): string => {
      if (!agent || stopped || section === null || !config.promptPolicy || !cover(agent)) return ''
      const entry = entries.get(agent)
      if (!entry || entry.owned.size === 0) return ''
      const visible = new Set(visibleNames(tools, agent, toolSet))
      const published = [...entry.owned].filter(name => visible.has(name))
      // The same consumer's live Bash section owns deployment guidance first.
      return renderToolingPolicy({ published, shellComponent: false,
        extraGuidance: publication.extraGuidanceOwner?.(agent) ? '' : config.extraGuidance })
    }
    ownsGuidance = agent => !publication.extraGuidanceOwner?.(agent) && Boolean(renderGuidance(agent))
    if (section !== null) {
      const suffix = section
      ctx.effect(() => prompt.section({
        name: modeSectionName(suffix), order: MODE_SECTION_ORDERS[suffix] ?? 3250, interpolate: false,
        text: context => renderGuidance(context.agent ?? context.scope as Agent, context.toolSet),
      }), `dsh-ops: ${mode} tooling guidance`)
    }
    ctx.effect(() => () => {
      stopped = true
      for (const agent of [...entries.keys()]) detach(agent)
      ownership.dispose()
    }, `dsh-ops: ${mode} native lifecycle`)
    await Promise.all([...entries.values()].map(entry => entry.ready))
    ownership.refresh()
  })
  return agent => ownsGuidance(agent)
}
