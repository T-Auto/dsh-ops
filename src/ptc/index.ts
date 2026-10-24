/** Independent PTC SDK: scoped publication through public host APIs only. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { inspectPresentation, isPresentationProbe } from '../presentation.js'
import { WORKER_TIMEOUT_MS } from '../worker-protocol.js'
import { FILE_TOOLS, PTC_TOOLS } from '../capabilities/registry.js'
import { PTC_SECTION, definition } from './contract.js'
import { publicToolName } from '../policy.js'
import { resolveWorker, failure } from './worker.js'
import { mountWorkspacePreparation } from '../workspace-preparation.js'
import { mountResultLifecycle } from '../kernel/result-lifecycle.js'
import { nativeProviders, claimPtcSurface, trackNativeShadow } from '../file/result-provider.js'
import { resolvePtcConfig } from '../config.js'
import { PTC_RESIDENT_TOOLS } from './config.js'
import type { ApiName } from './config.js'
import { sdkDefinition, requestedApis } from './sdk.js'
import { ownPtcScopes } from './ownership.js'
import { surfaceOf as toolSurface } from '../surface.js'
import { monitoredInvoke } from './invoke.js'
export { resolvePtcConfig } from '../config.js'
export const name = 'dsh-ops-ptc'
const apiTools = [...FILE_TOOLS, ...PTC_TOOLS]
const publishedNames = [...apiTools, 'load_sdk'].map(publicToolName)
const ptcDefinitions = new WeakSet<ToolDefinition>()
interface Entry {
  ctx?: Context; fiber?: Fiber; ready: Promise<void>; disposers: (() => void)[]
  selected: Set<ApiName>; pending: Set<ApiName>; owned: Map<string, ToolDefinition>; ptc: boolean
  /**
   * Tool names this agent published when `ptc` was last probed; a change re-probes.
   *
   * Names are the whole memo key, and `isPtc` reads more than names: it also asks whether
   * the `tools:ptc-only` section is non-empty. A verdict that flips without the name set
   * moving is missed here. Both self-heal on the next step — the assemble-withdraw handler
   * re-probes a scope whose assembly stopped being PTC-only, and `discovery` re-probes on
   * every step — so the stale verdict costs one pass, never a permanently wrong surface.
   */
  surface?: string
}
const isPtc = (assembly: PromptAssembly): boolean => assembly.tools.length === 1 && assembly.tools[0]?.name === 'run_code'
  && assembly.sections.some(section => section.name === 'tools:ptc-only' && section.text.trim() !== '')

export function apply(root: Context, rawConfig: unknown): void {
  const config = resolvePtcConfig(rawConfig)
  mountWorkspacePreparation(root)
  let file: string
  try { file = resolveWorker(config) } catch (error) {
    if (config.required) throw error
    root.logger.warn('dsh-ops: ' + String(error)); return
  }
  root.inject(['tools', 'systemPrompt', 'sandboxPolicy', 'subprocess'], async ctx => {
    const tools = ctx.get('tools'), prompt = ctx.get('systemPrompt')
    if (!tools || !prompt) return
    mountResultLifecycle(ctx)
    const entries = new Map<Agent, Entry>()
    const active = new Map<AbortController, { owner: Agent; promise: Promise<unknown> }>()
    let stopped = false, mutating = false, epoch = 0, published = 0, chain = Promise.resolve()
    let settled = chain
    const drain = async () => {
      let current: Promise<void>
      do { current = chain; await current } while (current !== chain)
      settled = current
    }
    const surfaceOf = (agent: Agent): string => toolSurface(tools, agent)
    const clear = (entry: Entry) => {
      entry.owned.clear()
      for (const dispose of entry.disposers.splice(0)) {
        try { dispose() } catch (error) { ctx.logger.warn('dsh-ops: PTC teardown failed; continuing:', error) }
      }
    }
    const ptcOnly = async (agent: Agent, signal?: AbortSignal): Promise<boolean> => Boolean(ctx.get('ptcRuntime')) && isPtc(await inspectPresentation(prompt, agent, signal))
    const abortOwner = (agent: Agent, reason: string) => {
      for (const [controller, work] of active) if (work.owner === agent) controller.abort(new Error(reason))
    }
    let ownership: Awaited<ReturnType<typeof ownPtcScopes>> | undefined
    const execute = (agent: Agent, entry: Entry, tool: ApiName | 'load_sdk'): ToolDefinition['execute'] => async (args, exec) => {
      await chain
      // A call reads the live epoch: any later reconcile invalidates it, whether or not that
      // pass ended up publishing.
      const version = epoch
      const available = () => !stopped && entries.get(agent) === entry && ownership?.owns(agent) && exec.agent === agent && entry.ptc && entry.owned.has(publicToolName(tool))
      if (!available() || !await ptcOnly(agent, exec.signal).catch(() => false) || !available() || version !== epoch) {
        return failure('POLICY_DENIED', 'The calling scope must own this API in authoritative PTC-only presentation.')
      }
      if (tool === 'load_sdk') {
        const requested = requestedApis(args, config.allowedTools)
        if (typeof requested === 'string') return failure('INVALID_ARGUMENT', requested)
        for (const name of requested) entry.pending.add(name)
        return { status: 'completed', tools: requested, nextTurn: true }
      }
      const controller = new AbortController(), abort = () => controller.abort(exec.signal?.reason)
      if (exec.signal?.aborted) abort(); else exec.signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error('Worker deadline exceeded')), WORKER_TIMEOUT_MS); timer.unref()
      const work = monitoredInvoke(ctx, file, tool, args, exec as ToolRunContext, controller, config)
      active.set(controller, { owner: agent, promise: work })
      try { return await work }
      finally { clearTimeout(timer); active.delete(controller); exec.signal?.removeEventListener('abort', abort) }
    }
    /**
     * Republish the PTC surface.
     *
     * `targets` narrows only what is *probed*: each agent's `ptcOnly` answer depends on that
     * agent's own tools and assembly, so an agent outside the set keeps the `ptc` it already
     * has. Publication itself always covers every entry, because the Native snapshot below is
     * exact only once every agent's masks are lifted — a partial pass would read the remaining
     * agents through their live overrides and register a short shadow set.
     *
     * An empty set is a probe-free pass, not an absent one: it names no agent to probe
     * while still asking for the republish a departure owes. `undefined` is the opposite
     * request — probe every agent — and is what a registry change passes, because the
     * event does not say which scope moved.
     */
    const reconcile = (force = false, targets?: ReadonlySet<Agent>): Promise<void> => {
      if (stopped || mutating) return chain
      const probed = (agent: Agent) => targets === undefined || targets.has(agent)
      // A probe-free pass (agent disposal) still owes the republish: the remaining agents'
      // masks and shadows were computed against the departee's registrations.
      const republishAnyway = targets !== undefined && targets.size === 0
      const version = ++epoch
      chain = chain.then(async () => {
        if (stopped || version !== epoch) return
        const ready = new Set<Agent>()
        // A republish re-registers every agent's definitions. It is only owed when some
        // agent's published surface or PTC verdict actually moved; `force` asks for a
        // fresh probe of the selected agents, not for an unconditional rewrite.
        // Probed surfaces stay pending until the republish that consumes them runs. A pass
        // a later reconcile supersedes publishes nothing, so recording its surfaces would
        // leave the next pass reading an unpublished surface as already current and
        // returning early forever.
        const surfaces = new Map<Agent, string>()
        let dirty = false
        for (const [agent, entry] of entries) {
          if (stopped || version !== epoch) return
          if (!entry.ctx || !ownership?.owns(agent)) continue
          if (!probed(agent)) { if (entry.ptc) ready.add(agent); continue }
          const surface = surfaceOf(agent)
          if (!force && entry.surface === surface) { if (entry.ptc) ready.add(agent); continue }
          if (entry.surface !== surface) dirty = true
          surfaces.set(agent, surface)
          const next = await ptcOnly(agent).catch(() => false)
          if (next !== entry.ptc) dirty = true
          if (next) ready.add(agent)
        }
        if (stopped || version !== epoch) return
        if (!dirty && !force && !republishAnyway) return
        mutating = true; ownership?.begin(); published = version
        try {
          for (const [agent, surface] of surfaces) { const entry = entries.get(agent); if (entry) entry.surface = surface }
          for (const entry of entries.values()) clear(entry)
          // Snapshot exact Native visibility only after all our masks/overrides have lifted.
          const native = new Map([...entries].map(([agent, entry]) => [agent, nativeProviders(entry.ctx ?? ctx, agent, true)]))
          for (const [agent, entry] of entries) {
            if (!entry.ctx || !ownership?.owns(agent)) continue
            entry.ptc = ready.has(agent)
            if (!entry.ptc) { entry.pending.clear(); abortOwner(agent, 'PTC presentation withdrawn'); continue }
            const releaseNative = claimPtcSurface(entry.ctx, agent)
            try {
              const wanted = new Set([...PTC_RESIDENT_TOOLS, ...config.alwaysLoaded, ...entry.selected])
              const definitions = [...wanted].map(tool => definition(tool, execute(agent, entry, tool)))
              definitions.push(sdkDefinition(config.allowedTools, execute(agent, entry, 'load_sdk')))
              for (const def of definitions) { ptcDefinitions.add(def); entry.disposers.push(entry.ctx.tools.register(def)); entry.owned.set(def.name, def) }
              entry.disposers.push(releaseNative)
            } catch (error) { releaseNative(); throw error }
          }
          for (const [agent, entry] of entries) {
            if (!entry.ctx || !ownership?.owns(agent)) continue
            if (!entry.ptc) for (const provider of native.get(agent) ?? []) {
              if (!provider.inheritable && provider.scope !== agent) continue
              const def = provider.definition
              if (provider.scope === agent || tools.get(def.name, agent) === def) continue
              const shadow: ToolDefinition = { ...def, execute: async (args, exec) => {
                const version = published
                if (stopped || !provider.active || entries.get(agent) !== entry || exec.agent !== agent || await ptcOnly(agent, exec.signal).catch(() => true)
                  || stopped || !provider.active || version !== published) return failure('POLICY_DENIED', 'Native projection or owning scope is unavailable.')
                return def.execute(args, exec)
              } }
              entry.disposers.push(entry.ctx.tools.register(shadow), trackNativeShadow(entry.ctx, agent, shadow, provider)); entry.owned.set(def.name, shadow)
            }
            const nativeNames = new Set((native.get(agent) ?? []).map(provider => provider.definition.name))
            const ownedNative = new Set(nativeProviders(ctx, agent).map(provider => provider.definition))
            const deny = publishedNames.filter(name => {
              const visible = tools.get(name, agent)
              return visible && !entry.owned.has(name) && (entry.ptc || !nativeNames.has(name))
                && (ptcDefinitions.has(visible) || entry.ptc && ownedNative.has(visible))
            })
            if (deny.length) entry.disposers.push(entry.ctx.tools.restrict({ deny }))
          }
        } catch (error) {
          for (const entry of entries.values()) clear(entry)
          throw error
        } finally { ownership?.end(); mutating = false }
        ownership?.changedBelow()
      }).catch(error => ctx.logger.warn('dsh-ops: PTC publication failed: ' + String(error)))
      return chain
    }
    const attach = (agent: Agent): Promise<void> => {
      if (stopped || entries.has(agent) || !agent.ctx) return entries.get(agent)?.ready ?? Promise.resolve()
      const entry: Entry = { disposers: [], selected: new Set(), pending: new Set(), owned: new Map(), ptc: false, ready: Promise.resolve() }
      entries.set(agent, entry); ownership?.track(agent)
      entry.fiber = agent.ctx.plugin({ inject: ['tools'], apply(scoped) { entry.ctx = scoped } })
      entry.ready = Promise.resolve(entry.fiber).then(() => reconcile(true, new Set([agent])))
      return entry.ready
    }
    ctx.on('agent/created', async ({ agent }) => { await attach(agent); return undefined })
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      await attach(agent)
      const entry = entries.get(agent)
      if (entry && !signal.aborted && await ptcOnly(agent, signal).catch(() => false)) {
        for (const tool of entry.pending) entry.selected.add(tool)
        const changed = entry.pending.size > 0; entry.pending.clear()
        if (changed) entry.surface = undefined
        await reconcile(changed, new Set([agent]))
      }
      return next()
    })
    ctx.on('agent/disposed', async ({ agent }) => {
      const entry = entries.get(agent); if (!entry) return
      entries.delete(agent); ownership?.forget(agent); abortOwner(agent, 'Owning agent disposed'); mutating = true
      try { clear(entry) } finally { mutating = false }
      // Other agents' published surfaces are untouched here, so republish none of them.
      await entry.fiber?.dispose(); await reconcile(true, new Set())
    })
    // A registry change only owes a republish when some agent's probed surface moved,
    // so the change listener probes and lets the dirty check decide.
    ctx.on('tools/change', () => { if (!ownership?.publishing()) void reconcile(false) })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      // The pinned host assembles BEFORE agent/pre-step. Wait for publication
      // queued by the previous committed step, then obtain a fresh public assembly.
      if (!isPresentationProbe(context)) {
        const entry = entries.get(context.scope as Agent), before = chain, pending = chain !== settled
        await entry?.ready; await drain()
        if (pending || before !== chain) return prompt.assemble(context)
      }
      const entry = entries.get(context.scope as Agent), heldPtc = Boolean(entry?.ptc && entry.owned.size)
      const result = await next()
      if (!entry || !heldPtc || isPtc(result)) return result
      mutating = true
      try { entry.ptc = false; entry.surface = undefined; entry.pending.clear(); abortOwner(context.scope as Agent, 'PTC presentation withdrawn'); clear(entry) }
      finally { mutating = false }
      void reconcile(true, new Set([context.scope as Agent]))
      return prompt.assemble(context)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'step/end') {
        let changed = false
        const affected = new Set<Agent>()
        for (const [agent, entry] of entries) if (agent.session === session && ownership?.owns(agent) && entry.pending.size) {
          for (const tool of entry.pending) if (entry.ptc) entry.selected.add(tool)
          entry.pending.clear(); entry.surface = undefined; affected.add(agent); changed = true
        }
        if (changed) void reconcile(true, affected)
        return
      }
      if (event.type !== 'sandbox/mode') return
      const affected = new Set<Agent>()
      for (const [agent, entry] of entries) if (agent.session === session) { entry.pending.clear(); entry.surface = undefined; abortOwner(agent, 'Sandbox authority changed'); affected.add(agent) }
      // An unknown session keeps the unqualified (whole-fleet) pass.
      void reconcile(true, affected.size ? affected : undefined)
    })
    ownership = await ownPtcScopes(ctx, () => {
      mutating = true
      try {
        for (const [agent, entry] of entries) if (!ownership?.owns(agent)) {
          entry.ptc = false; entry.pending.clear(); abortOwner(agent, 'PTC row ownership changed'); clear(entry)
        }
      } finally { mutating = false }
      void reconcile(true)
    })
    ctx.effect(() => prompt.section({ name: ownership.sectionName(PTC_SECTION), order: 3252, interpolate: false, text: context => {
      const entry = entries.get(context.scope as Agent)
      return entry?.ptc && entry.owned.has(publicToolName('load_sdk'))
        ? 'OPS APIs return typed Outcome values. Inspect status before data; preserve partial coverage and continuation. Use ' + publicToolName('load_sdk') + ' to request advanced APIs by raw name; they become callable on the next model step. Process results locally in run_code and return only needed summaries. References do not grant authority.' : ''
    } }), 'dsh-ops: progressive PTC guidance')
    ctx.effect(() => async () => {
      stopped = true; ++epoch; mutating = true
      for (const controller of active.keys()) controller.abort(new Error('PTC component unloaded'))
      for (const entry of entries.values()) clear(entry)
      await Promise.allSettled([...active.values()].map(work => work.promise))
      await Promise.allSettled([...entries.values()].map(entry => entry.fiber?.dispose()))
      entries.clear(); ownership?.dispose(); await chain
    }, 'dsh-ops: PTC lifecycle')
    for (const agent of entries.keys()) ownership.track(agent)
    ownership.refresh()
    for (const agent of new Set([...(ctx.get('agents')?.list() ?? []), ...ownership.agents()])) void attach(agent)
  })
}
