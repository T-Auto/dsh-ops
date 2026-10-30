import type { Context, Fiber } from '../adapter/dsh/types.js'
import type { Agent } from '../adapter/dsh/types.js'
import type { ToolDefinition } from '../adapter/dsh/types.js'
import type { PromptAssembly } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import { resolveDiscoveryConfig } from '../config.js'
import { NativeFileTools } from '../projections/native/runtime.js'
import { nativeProviders, registerNativeProviderAtScope, claimNativeSelection } from '../publication/providers.js'
import { loadScopes } from '../adapter/dsh/host.js'
import { onToolChange } from '../publication/changes.js'
import { ownScopes } from '../publication/ownership.js'
import { isNativePresentation, isPresentationProbe } from '../publication/presentation.js'
import { mountResultLifecycle } from '../kernel/result-lifecycle.js'
import { failure, resolveWorker } from '../execution/files.js'
import { capability, DISCOVERY_TOOL_NAME } from '../capabilities/registry.js'
import { DISCOVERY_DESCRIPTION, DISCOVERY_PARAMETERS, DISCOVERY_OUTPUT } from '../capabilities/discovery.js'
import { publicToolName, renderToolingPolicy } from '../policy.js'
import { DISCOVERABLE_TOOLS } from './config.js'
import type { DiscoverableName } from './config.js'
import { prepareProviders, providers, onProvidersChange, type Provider } from './providers.js'
import { searchCapabilities } from './candidates.js'
import { parseRequest } from './search.js'
import { InvocationLifetime, InvocationNotStarted } from '../lifecycle/invocations.js'
import { observeSelection } from './observations.js'
import { scopedReconciliation, scopeFamilies } from '../publication/reconciliation.js'

export interface DiscoveryGate {
  allows(agent: Agent): boolean; watch?(notify: () => void): () => void; guidance?: boolean; extraGuidance?: string
  residentTools?(agent: Agent): ReadonlySet<string> | readonly string[]
  external?: { allowed: readonly string[]; alwaysLoaded: readonly string[]; disabled: readonly string[] }
}
interface Entry {
  ctx?: Context
  fiber?: Fiber
  externalSelected: Set<string>
  externalPending: Set<string>
  runtime: NativeFileTools
  calls: InvocationLifetime
  selected: Set<DiscoverableName>
  pending: Set<DiscoverableName>
  disposers: (() => void)[]
  owned: Set<string>
  ready: Promise<void>
  revision: number
  presentation?: { inputs: unknown[]; native: boolean }
  releaseObservation?: () => void
  releaseSelection?: () => void
}
const DISCOVER = publicToolName(DISCOVERY_TOOL_NAME)
const advanced = DISCOVERABLE_TOOLS.map(publicToolName)

/** Mount the owned service for an explicit preset integration. */
export function mountDiscovery(root: Context, raw: unknown, gate: DiscoveryGate): void {
  const config = resolveDiscoveryConfig(raw)
  let worker: string | undefined
  const externalEnabled = Boolean(gate.external?.allowed.length)
  try { if (config.allowedTools.length || config.alwaysLoaded.length) worker = resolveWorker(config) }
  catch (error) {
    if (config.required) throw error
    root.logger.warn('dsh-ops: discovery worker unavailable; built-in tools stay unpublished.')
    if (!externalEnabled) return
  }
  root.inject(externalEnabled ? ['tools', 'systemPrompt'] : ['tools', 'systemPrompt', 'sandboxPolicy', 'subprocess'], async ctx => {
    const tools = ctx.get('tools'), prompt = ctx.get('systemPrompt')
    if (!tools || !prompt || !externalEnabled && !ctx.get('sandboxPolicy')) return
    const entries = new Map<Agent, Entry>()
    const retired = new WeakSet<Agent>()
    let scopeChainOf: (scope: object) => object[] = scope => [scope]
    mountResultLifecycle(ctx)
    let ownership: Awaited<ReturnType<typeof ownScopes>> | undefined
    let stopped = false, mutating = false
    const work = scopedReconciliation<Agent>(() => ctx.logger.warn('dsh-ops: discovery publication unavailable; tools remain withdrawn.'))
    const cancelEntry = (entry: Entry, reason: string) => {
      entry.calls.cancel(reason)
      entry.runtime.cancel(reason)
    }
    const retireExternal = async (entry: Entry) => {
      const remaining = await entry.calls.stop('Consumer disposed', false)
      if (remaining) ctx.logger.warn('dsh-ops: external calls were cancelled but may still be running; provider effects are unknown. No operation was replayed.')
    }
    const clear = (entry: Entry) => {
      entry.owned.clear()
      for (const dispose of entry.disposers.splice(0)) {
        try { dispose() } catch { ctx.logger.warn('dsh-ops: discovery registration cleanup failed.') }
      }
    }
    // Dynamic loading is its own switch: it serves every native session, independent
    // of the mode rows. Only capabilities a running mode already publishes resident
    // are excluded from the discovery pool.
    const residentSet = (agent: Agent): ReadonlySet<string> => new Set(gate.residentTools?.(agent) ?? [])
    const permitted = (agent: Agent, rawName?: DiscoverableName): boolean => {
      if (!gate.allows(agent)) return false
      try {
        const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
        return policy !== undefined && Boolean(worker && ctx.get('subprocess')) && ['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)
          && (!rawName || rawName === 'result' || !capability(rawName)?.mutates || policy.mode !== 'read-only')
      } catch { return false }
    }
    // A tool the mode already publishes resident is not a discovery choice.
    const selectable = (agent: Agent, rawName: DiscoverableName): boolean =>
      !residentSet(agent).has(publicToolName(rawName)) && permitted(agent, rawName)
    const externalPool = (agent: Agent): Provider[] => providers(ctx, agent).filter(provider => gate.allows(agent)
      && gate.external?.allowed.includes(provider.capability.definition.name) && !gate.external.disabled.includes(provider.capability.definition.name))
    const externalAvailable = (provider: Provider, agent: Agent): boolean => {
      try { return provider.active && provider.capability.available?.(agent) !== false } catch { return false }
    }
    const ptcOnly = (assembly: PromptAssembly): boolean => assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
    const invalidate = (entry: Entry) => { ++entry.revision; entry.presentation = undefined }
    // A session this component can actually coordinate: it has a scope context, this
    // component owns it, and its mode keeps discovery tools in play. Both the
    // reconcile loop and the unattributed branch must agree on it — a representative
    // that reconcile would filter out leaves the "at least one probe" contract
    // silently degraded to zero probes.
    const coordinable = (agent: Agent, entry: Entry | undefined): boolean =>
      Boolean(entry?.ctx && ownership?.owns(agent) && (externalEnabled ? gate.allows(agent) : permitted(agent)))
    const inputs = (agent: Agent): unknown[] => {
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      return [agent.ctx, agent.session, currentSessionDirectory(ctx, agent), policy?.mode, policy?.workspaceRoot, policy?.sessionId]
    }
    const same = (left: unknown[], right: unknown[]) => left.length === right.length && left.every((value, index) => value === right[index])
    // Only background reconciliation reuses a probe. A step or execution can
    // observe arbitrary dynamic prompt providers with no registry notification.
    const native = async (agent: Agent, fresh = false, signal?: AbortSignal): Promise<boolean> => {
      const entry = entries.get(agent)
      if (!entry || !gate.allows(agent)) return false
      if (fresh) invalidate(entry)
      const current = inputs(agent), revision = entry.revision
      if (entry.presentation && same(entry.presentation.inputs, current)) return entry.presentation.native
      const result = await isNativePresentation(prompt, agent, signal)
      if (!stopped && !signal?.aborted && entries.get(agent) === entry && revision === entry.revision && same(current, inputs(agent))) {
        entry.presentation = { inputs: current, native: result }
      }
      return result
    }
    const own = (agent: Agent, entry: Entry, tool: ToolDefinition): void => {
      if (!entry.ctx) return
      const execute = tool.execute
      const registration: ToolDefinition = { ...tool, execute: async (args, exec) => {
        await work.drain(agent)
        const version = work.version(agent)
        const available = () => ownership?.owns(agent) && !stopped && !exec.signal?.aborted && entries.get(agent) === entry && exec.agent === agent && entry.owned.has(tool.name) && tools.get(tool.name, agent) === registration
        if (!available() || !(externalEnabled ? gate.allows(agent) : permitted(agent)) || !await native(agent, true, exec.signal).catch(() => false) || !available() || version !== work.version(agent)) {
          return failure('POLICY_DENIED', 'Discovery capability belongs to a different or inactive scope.')
        }
        return execute(args, exec)
      } }
      const dispose = registerNativeProviderAtScope(entry.ctx, agent, [registration], tool => entry.ctx!.tools.register(tool), { inheritable: false, priority: 10 })
      if (stopped || entries.get(agent) !== entry || !ownership?.owns(agent)) { dispose(); return }
      entry.disposers.push(dispose)
      entry.owned.add(tool.name)
    }
    // Resident mode tools are published by the mode row itself; they are neither
    // discovery choices nor inherited duplicates to hide.
    const foreignAdvanced = (agent: Agent): string[] => {
      const resident = residentSet(agent)
      return advanced.filter(name => !resident.has(name))
    }
    const inheritedNative = (agent: Agent, entry: Entry): string[] => {
      const foreign = new Set([...foreignAdvanced(agent), ...providers(ctx, agent).map(provider => provider.capability.definition.name)])
      return nativeProviders(ctx, agent).map(provider => provider.definition.name)
        .filter(name => (foreign.has(name) || name === DISCOVER) && !entry.owned.has(name))
    }
    const reconcile = (targets: Iterable<Agent> = entries.keys()): Promise<void> => {
      if (stopped) return Promise.resolve()
      const families = scopeFamilies(entries.keys(), targets, scopeChainOf)
      return Promise.all(families.map(family => work.run(family, async task => {
        const ready = new Set<Agent>()
        for (const agent of family) {
          if (stopped || !task.current()) return
          const entry = entries.get(agent)
          if (coordinable(agent, entry) && await task.wait(native(agent, false, task.signal)).catch(() => false)) ready.add(agent)
        }
        if (stopped || !task.current()) return
        mutating = true; ownership?.begin()
        try {
          for (const [agent, entry] of entries) {
            if (!family.has(agent)) continue
            if (!ownership?.owns(agent)) { cancelEntry(entry, 'Consumer ownership withdrawn'); clear(entry); entry.releaseSelection?.(); entry.releaseSelection = undefined; continue }
            entry.releaseSelection ??= claimNativeSelection(ctx, agent, new Set(foreignAdvanced(agent)))
            const isReady = ready.has(agent)
            if (!isReady) cancelEntry(entry, 'Consumer presentation or authority withdrawn')
            const wanted = isReady ? [...new Set([...config.alwaysLoaded, ...entry.selected])].filter(tool => selectable(agent, tool)) : []
            const external = isReady ? externalPool(agent).filter(provider => externalAvailable(provider, agent) && (entry.externalSelected.has(provider.token)
              || gate.external?.alwaysLoaded.includes(provider.capability.definition.name) || provider.capability.disclosure === 'resident')) : []
            const desired = new Set([...(isReady && config.enabled ? [DISCOVER] : []), ...wanted.map(publicToolName), ...external.map(provider => provider.capability.definition.name)])
            const inherited = inheritedNative(agent, entry)
            // Registry changes from other components must not republish an unchanged
            // surface, or independent lifecycle listeners can amplify one another.
            if (desired.size === entry.owned.size && [...desired].every(tool => entry.owned.has(tool)) && !inherited.length) continue
            clear(entry)
            if (isReady && config.enabled) own(agent, entry, {
              name: DISCOVER, description: DISCOVERY_DESCRIPTION, parameters: DISCOVERY_PARAMETERS,
              output: { schema: DISCOVERY_OUTPUT, render: (_args, value) => [{ type: 'text', text: typeof value === 'object' && value && 'message' in value ? String(value.message) : JSON.stringify(value) }] },
              execute: async args => {
                const request = parseRequest(args)
                if (typeof request === 'string') return failure('INVALID_ARGUMENT', request)
                const maximum = Math.min(request.maxResults, config.maxResults)
                const candidates = searchCapabilities(request.query, config.allowedTools.filter(tool => selectable(agent, tool)),
                  externalPool(agent).filter(provider => externalAvailable(provider, agent)), maximum)
                const matches = candidates.builtins, externalMatches = candidates.providers
                const activated = matches.filter(tool => !entry.selected.has(tool) && !config.alwaysLoaded.includes(tool))
                const externalActivated = externalMatches.filter(provider => !entry.owned.has(provider.capability.definition.name))
                for (const provider of externalActivated) entry.externalPending.add(provider.token)
                for (const tool of activated) entry.pending.add(tool)
                const selected = [...matches.map(publicToolName), ...externalMatches.map(provider => provider.capability.definition.name)]
                return { status: 'completed', activated: [...activated.map(publicToolName), ...externalActivated.map(provider => provider.capability.definition.name)],
                  alreadyActive: [...matches.filter(tool => !activated.includes(tool)).map(publicToolName), ...externalMatches.filter(provider => !externalActivated.includes(provider)).map(provider => provider.capability.definition.name)],
                  message: selected.length ? `Selected ${selected.join(', ')}. Newly selected tools become available on the next model step; no tool action was executed.` : 'No allowed, implemented capability matched. Refine the query; unavailable formats cannot be activated.' }
              },
            })
            for (const tool of wanted) own(agent, entry, entry.runtime.definition(tool))
            for (const provider of external) {
              const definition = provider.capability.definition
              const existing = tools.get(definition.name, agent)
              if (existing && !nativeProviders(ctx, agent).some(source => source.definition === existing && !source.inheritable)) continue
              const registration: ToolDefinition = { ...definition,
                output: definition.output,
                execute: async (args, exec) => {
                const current = () => provider.active && externalPool(agent).includes(provider) && externalAvailable(provider, agent)
                  && gate.allows(agent) && ownership?.owns(agent) && !stopped && entries.get(agent) === entry && exec.agent === agent
                  && tools.get(definition.name, agent)?.output === registration.output
                  && (entry.externalSelected.has(provider.token) || gate.external?.alwaysLoaded.includes(definition.name) || provider.capability.disclosure === 'resident')
                if (!current() || !await Promise.resolve().then(() => provider.capability.authorize(exec)).catch(() => false) || !current()) return failure('POLICY_DENIED', 'External provider is inactive, disabled or unauthorized; no action executed.')
                try {
                  return await entry.calls.run(exec.signal, signal => Promise.resolve(definition.execute(args, { ...exec, signal })), provider.calls)
                } catch (error) {
                  if (error instanceof InvocationNotStarted) return failure('ABORTED', error.message)
                  return failure('RESULT_UNKNOWN', 'External invocation did not settle; effects may be unknown.', 'execute', 'unknown')
                }
              } }
              own(agent, entry, registration)
            }
          }
          // A child must not inherit its parent's activation or an old global advanced surface.
          for (const [agent, entry] of entries) if (family.has(agent) && entry.ctx) {
            const deny = ownership?.owns(agent) ? inheritedNative(agent, entry)
              : nativeProviders(ctx, agent).filter(provider => provider.scope !== agent && providers(ctx, agent).some(external => external.capability.definition.name === provider.definition.name)).map(provider => provider.definition.name)
            if (deny.length) entry.disposers.push(entry.ctx.tools.restrict({ deny }))
          }
        } catch (error) {
          for (const agent of family) { const entry = entries.get(agent); if (entry) clear(entry) }
          throw error
        } finally { ownership?.end(); mutating = false }
        ownership?.changedBelow()
      }))).then(() => undefined)
    }
    const attach = (agent: Agent): Promise<void> => {
      if (stopped || retired.has(agent) || entries.has(agent) || !agent.ctx) return entries.get(agent)?.ready ?? Promise.resolve()
      // Preserve observation of mutable host session inputs without awaiting
      // another root's probe. Unchanged roots retain their cached verdicts.
      const changed = new Set<Agent>()
      for (const [other, prior] of entries) if (prior.presentation) {
        let fresh = false
        try { fresh = same(prior.presentation.inputs, inputs(other)) } catch { /* fail closed */ }
        if (!fresh) { invalidate(prior); changed.add(other) }
      }
      if (changed.size) void reconcile(changed)
      const entry: Entry = { runtime: new NativeFileTools({ ctx, config: { ...config, required: Boolean(worker) && config.required, workerPath: worker }, report: undefined }),
        calls: new InvocationLifetime(), selected: new Set(), pending: new Set(), externalSelected: new Set(), externalPending: new Set(), disposers: [], owned: new Set(), ready: Promise.resolve(), revision: 0 }
      entry.releaseObservation = observeSelection(ctx, agent, entry.externalPending)
      entries.set(agent, entry); ownership?.track(agent)
      entry.fiber = agent.ctx.plugin({ inject: ['tools'], apply(scoped) { entry.ctx = scoped } })
      entry.ready = Promise.resolve(entry.fiber).then(async () => { await entry.runtime.start([]); await reconcile([agent]) })
      return entry.ready
    }
    ctx.on('agent/created', async ({ agent }) => { await attach(agent); await work.drain(agent); return undefined })
    ctx.on('agent/pre-step', async (payload, next) => {
      await attach(payload.agent)
      const entry = entries.get(payload.agent)
      if (entry && ownership?.owns(payload.agent) && !payload.signal.aborted && await native(payload.agent, true, payload.signal).catch(() => false)
        && !payload.signal.aborted && entries.get(payload.agent) === entry && ownership?.owns(payload.agent)) {
        for (const tool of entry.pending) if (permitted(payload.agent, tool)) entry.selected.add(tool)
        for (const provider of externalPool(payload.agent)) if (entry.externalPending.has(provider.token) && externalAvailable(provider, payload.agent)) entry.externalSelected.add(provider.token)
        entry.externalPending.clear(); entry.pending.clear()
        await reconcile([payload.agent])
      }
      return next()
    })
    ctx.on('agent/disposed', async ({ agent }) => {
      retired.add(agent); work.forget(agent)
      const entry = entries.get(agent)
      if (!entry) return
      const affected = scopeFamilies(entries.keys(), [agent], scopeChainOf).flatMap(family => [...family]).filter(member => member !== agent)
      entries.delete(agent); entry.releaseObservation?.(); ownership?.forget(agent); mutating = true
      try { clear(entry); entry.releaseSelection?.() } finally { mutating = false }
      await Promise.allSettled([entry.runtime.stop(), retireExternal(entry)]); await entry.fiber?.dispose(); await reconcile(affected)
    })
    const refresh = () => {
      if (stopped) return
      for (const entry of entries.values()) invalidate(entry)
      void reconcile()
    }
    // A prompt-driven change can move any scope's presentation, but paying one
    // synchronous assembly per live session is what made session creation scale
    // with the live count. Probe a single representative — the conservative
    // contract is "at least one probe", not "every session" — and leave the rest
    // stale: each re-observes its presentation at its next real assembly, and a
    // tool call still re-probes before executing (`native(agent, true, ...)`).
    // Publication-set changes (modes, runtime, configuration) keep using
    // `refresh`, which must visit every entry to withdraw stale registrations.
    const staleAll = () => {
      if (stopped) return
      const representative = [...entries].find(([agent, entry]) => coordinable(agent, entry))
      if (!representative) {
        for (const entry of entries.values()) invalidate(entry)
        return
      }
      // Invalidate the representative alone first. `reconcile` runs its body on a
      // later microtask and walks the representative's whole scope family; clearing
      // the siblings here would empty their caches before that walk starts and the
      // family would be re-probed member by member. The siblings keep their cached
      // verdict for this round, then go stale below once the probe has run.
      invalidate(representative[1])
      void reconcile([representative[0]]).finally(() => {
        if (stopped) return
        for (const [agent, entry] of entries) if (agent !== representative[0]) invalidate(entry)
      })
    }
    ;({ scopeChainOf } = await loadScopes())
    if (externalEnabled) {
      await prepareProviders(ctx)
      ctx.effect(() => onProvidersChange(ctx, () => {
        mutating = true
        try {
          for (const [agent, entry] of entries) {
            const active = new Set(externalPool(agent).map(provider => provider.token))
            for (const token of entry.externalSelected) if (!active.has(token)) entry.externalSelected.delete(token)
            for (const token of entry.externalPending) if (!active.has(token)) entry.externalPending.delete(token)
            clear(entry)
          }
        } finally { mutating = false }
        refresh()
      }), 'dsh-ops: external provider lifecycle')
    }
    onToolChange(ctx, (scopes, origin) => {
      if (mutating || ownership?.publishing()) return
      if (!scopes?.length) { staleAll(); return }
      const affected = new Set<Agent>()
      for (const [agent, entry] of entries) if (scopes.some(scope => scopeChainOf(agent).includes(scope))) { invalidate(entry); affected.add(agent) }
      if (!affected.size) {
        // This package's own window named a scope it knows is unrelated to every
        // tracked session — a sibling row's registration. It cannot have moved this
        // row's verdicts, so leaving the cache intact is the whole point of the
        // attribution. A scope the HOST named that sits on no tracked chain is the
        // opposite case: host state this row has not admitted yet, which may already
        // have changed the registry, so it takes the conservative path.
        if (origin !== 'host') return
        staleAll()
        return
      }
      void reconcile(affected)
    })
    if (externalEnabled) {
      ctx.inject(['sandboxPolicy', 'subprocess'], inner => {
        refresh(); inner.effect(() => () => refresh())
      })
    }
    // A prompt change moves presentation only, so it takes the lazy path.
    ctx.on('system-prompt/change', staleAll)
    // A mode row toggling changes which capabilities stay resident and therefore
    // must leave the discovery pool.
    if (gate.watch) ctx.effect(() => gate.watch!(refresh), 'dsh-ops: discovery integration observer')
    // Observe in-place hooks and the default asynchronous Fiber.restart().
    // Await the runtime result even though the pinned next() type says void.
    ctx.on('internal/update', async (_config, _noSave, next) => {
      try { return await next() } finally { refresh() }
    }, { global: true, prepend: true })
    // This optional service is not an injection prerequisite: native agents
    // work without it, while failed PTC probes must recover when it arrives.
    ctx.inject(['ptcRuntime'], inner => {
      refresh()
      inner.effect(() => () => { refresh() })
    })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      // The pinned host assembles BEFORE agent/pre-step. Wait for publication
      // queued by the previous committed step, then obtain a fresh public assembly.
      if (!isPresentationProbe(context)) {
        const agent = context.scope as Agent, entry = entries.get(agent), before = work.version(agent)
        await entry?.ready
        if (await work.drain(agent) || before !== work.version(agent)) return prompt.assemble(context)
      }
      const entry = entries.get(context.scope as Agent)
      // Snapshot ownership before yielding: another assembly may withdraw it while
      // this request still contains an already-rendered Native SDK section.
      const heldNative = Boolean(entry?.owned.size)
      const result = await next()
      if (!entry || context.signal?.aborted || entries.get(context.scope as Agent) !== entry || !heldNative || !ptcOnly(result)) return result
      mutating = true
      try { cancelEntry(entry, 'Native presentation withdrawn'); clear(entry) }
      finally { mutating = false }
      // Rebuild through the public host service after removing only our tools.
      // This cannot activate pending requests or rewrite another provider's text.
      return prompt.assemble(context)
    })
    ctx.on('session/event', (session, event) => {
      if ((event as { type: string }).type === 'agent-preset/selected') {
        const affected = new Set<Agent>()
        for (const [agent, entry] of entries) if (agent.session === session) {
          cancelEntry(entry, 'Consumer preset changed')
          entry.pending.clear(); entry.selected.clear(); entry.externalSelected.clear(); entry.externalPending.clear(); invalidate(entry); affected.add(agent)
        }
        void reconcile(affected); return
      }
      if (event.type === 'step/end') {
        const affected = new Set<Agent>()
        for (const [agent, entry] of entries) if (agent.session === session && ownership?.owns(agent) && (entry.pending.size || entry.externalPending.size)) {
          for (const provider of externalPool(agent)) if (entry.externalPending.has(provider.token) && externalAvailable(provider, agent)) entry.externalSelected.add(provider.token)
          entry.externalPending.clear()
          for (const tool of entry.pending) if (permitted(agent, tool)) entry.selected.add(tool)
          entry.pending.clear(); affected.add(agent)
        }
        if (affected.size) void reconcile(affected)
        return
      }
      if (event.type !== 'sandbox/mode') return
      const affected = new Set<Agent>()
      mutating = true
      try {
        for (const [agent, entry] of entries) if (agent.session === session) {
          invalidate(entry)
          affected.add(agent)
          entry.pending.clear(); entry.externalPending.clear(); cancelEntry(entry, 'Sandbox authority changed'); clear(entry)
        }
      } finally { mutating = false }
      void reconcile(affected)
    })
    ownership = await ownScopes(ctx, 'discovery', () => {
      for (const entry of entries.values()) invalidate(entry)
      mutating = true
      try {
        for (const [agent, entry] of entries) if (!ownership?.owns(agent)) {
          entry.pending.clear(); entry.externalPending.clear(); entry.externalSelected.clear(); cancelEntry(entry, 'Consumer ownership changed'); clear(entry)
          entry.releaseSelection?.(); entry.releaseSelection = undefined
        }
      } finally { mutating = false }
      void reconcile()
    }, gate.allows)
    ctx.effect(() => prompt.section({
      name: ownership.sectionName('dsh-ops:discovery-tools'), order: 3253, interpolate: false,
      text: context => {
        const entry = entries.get(context.scope as Agent)
        return gate.guidance !== false && entry ? renderToolingPolicy({ published: entry.owned, shellComponent: false, extraGuidance: gate.extraGuidance }) : ''
      },
    }), 'dsh-ops: discovered capability guidance')
    ctx.effect(() => async () => {
      stopped = true; mutating = true
      const cancelled = work.stop()
      for (const entry of entries.values()) { clear(entry); entry.releaseSelection?.(); entry.releaseObservation?.() }
      await Promise.allSettled([...entries.values()].map(async entry => { await Promise.allSettled([retireExternal(entry), entry.runtime.stop()]); await entry.fiber?.dispose() }))
      entries.clear(); ownership?.dispose(); await cancelled
    }, 'dsh-ops: discovery lifecycle')
    for (const agent of entries.keys()) ownership.track(agent)
    ownership.refresh()
    for (const agent of new Set([...(ctx.get('agents')?.list() ?? []), ...ownership.agents()])) void attach(agent)
  })
}
import { currentSessionDirectory } from '../adapter/dsh/working-directory.js'
