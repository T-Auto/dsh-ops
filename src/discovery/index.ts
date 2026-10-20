import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { resolveDiscoveryConfig } from '../config.js'
import { NativeFileTools } from '../file/runtime.js'
import { nativeProviders, registerNativeProvider, claimNativeSelection } from '../file/result-provider.js'
import { ownScopes } from '../scoped-ownership.js'
import { clearNativePresentationCache, invalidateNativePresentation, isNativePresentation, isPresentationProbe, layerFingerprint } from '../presentation.js'
import { mountResultLifecycle } from '../kernel/result-lifecycle.js'
import { failure, resolveWorker } from '../file/worker.js'
import { capability } from '../capabilities/registry.js'
import { DISCOVERY_DESCRIPTION, DISCOVERY_PARAMETERS, DISCOVERY_OUTPUT } from '../capabilities/discovery.js'
import { publicToolName, renderToolingPolicy } from '../policy.js'
import { DISCOVERABLE_TOOLS } from './config.js'
import type { DiscoverableName } from './config.js'
import { parseRequest, search } from './search.js'

interface Entry {
  ctx?: Context
  fiber?: Fiber
  runtime: NativeFileTools
  selected: Set<DiscoverableName>
  pending: Set<DiscoverableName>
  disposers: (() => void)[]
  owned: Set<string>
  ready: Promise<void>
  releaseSelection?: () => void
  /** Tool-layer fingerprint at the last observation; changes drive directed
   * tools/change invalidation. */
  layers?: string
  /** Whether the surface was withdrawn because the scope presented ptc-only;
   * cleared by the symmetric restore branch on the next real assembly. */
  withdrawn: boolean
}
const DISCOVER = publicToolName('discover_tools')
const advanced = DISCOVERABLE_TOOLS.map(publicToolName)
export const name = 'dsh-ops-discovery'

export function apply(root: Context, raw: unknown): void {
  const config = resolveDiscoveryConfig(raw)
  let worker: string
  try { worker = resolveWorker(config) }
  catch (error) {
    if (config.required) throw error
    root.logger.warn('dsh-ops: discovery worker unavailable; no tools published.')
    return
  }
  root.inject(['tools', 'systemPrompt', 'sandboxPolicy', 'subprocess'], async ctx => {
    const tools = ctx.get('tools'), prompt = ctx.get('systemPrompt'), policyService = ctx.get('sandboxPolicy')
    if (!tools || !prompt || !policyService) return
    const entries = new Map<Agent, Entry>()
    mountResultLifecycle(ctx)
    let ownership: Awaited<ReturnType<typeof ownScopes>> | undefined
    let stopped = false, mutating = false, epoch = 0, chain = Promise.resolve()
    let settled = chain
    const drain = async () => {
      let current: Promise<void>
      do { current = chain; await current } while (current !== chain)
      settled = current
    }
    const clear = (entry: Entry) => {
      entry.owned.clear()
      for (const dispose of entry.disposers.splice(0)) {
        try { dispose() } catch { ctx.logger.warn('dsh-ops: discovery registration cleanup failed.') }
      }
    }
    const permitted = (agent: Agent, rawName?: DiscoverableName): boolean => {
      try {
        const policy = policyService.resolve({ session: agent.session })
        return ['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)
          && (!rawName || rawName === 'result' || !capability(rawName)?.mutates || policy.mode !== 'read-only')
      } catch { return false }
    }
    const ptcOnly = (assembly: PromptAssembly): boolean => assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
    const native = (agent: Agent): Promise<boolean> => isNativePresentation(prompt, agent)
    /** Record an agent's current tool-layer fingerprint after any discovery
     * publish, so the next external tools/change can diff against it. */
    const rememberLayers = (agent: Agent, entry: Entry): void => {
      if (entry.ctx) entry.layers = layerFingerprint(agent, scope => tools.schemas(scope))
    }
    const own = async (agent: Agent, entry: Entry, tool: ToolDefinition): Promise<void> => {
      if (!entry.ctx) return
      const execute = tool.execute
      const registration: ToolDefinition = { ...tool, execute: async (args, exec) => {
        await chain
        const version = epoch
        const available = () => ownership?.owns(agent) && !stopped && entries.get(agent) === entry && exec.agent === agent && entry.owned.has(tool.name)
        if (!available() || !await native(agent).catch(() => false) || !available() || version !== epoch) {
          return failure('POLICY_DENIED', 'Discovery capability belongs to a different or inactive scope.')
        }
        return execute(args, exec)
      } }
      entry.disposers.push(await registerNativeProvider(entry.ctx, [registration], tool => entry.ctx!.tools.register(tool), { inheritable: false, priority: 10 }))
      entry.owned.add(tool.name)
    }
    const inheritedNative = (agent: Agent, entry: Entry): string[] => nativeProviders(ctx, agent)
      .map(provider => provider.definition.name).filter(name => (advanced.includes(name) || name === DISCOVER) && !entry.owned.has(name))
    /** Publish one agent's surface from its cached/recomputed readiness verdict.
     * The equality check is the no-behaviour-change gate: registry changes from
     * other components must not republish an unchanged surface, or independent
     * lifecycle listeners can amplify one another. */
    const publishEntry = async (agent: Agent, entry: Entry, isReady: boolean): Promise<void> => {
      if (!ownership?.owns(agent)) { clear(entry); entry.releaseSelection?.(); entry.releaseSelection = undefined; return }
      entry.releaseSelection ??= claimNativeSelection(ctx, agent, new Set(advanced))
      const wanted = isReady ? [...new Set([...config.alwaysLoaded, ...entry.selected])].filter(tool => permitted(agent, tool)) : []
      const desired = new Set([...(isReady && config.enabled ? [DISCOVER] : []), ...wanted.map(publicToolName)])
      const inherited = inheritedNative(agent, entry)
      if (desired.size === entry.owned.size && [...desired].every(tool => entry.owned.has(tool)) && !inherited.length) return
      clear(entry)
      if (isReady && config.enabled) await own(agent, entry, {
        name: DISCOVER, description: DISCOVERY_DESCRIPTION, parameters: DISCOVERY_PARAMETERS,
        output: { schema: DISCOVERY_OUTPUT, render: (_args, value) => [{ type: 'text', text: typeof value === 'object' && value && 'message' in value ? String(value.message) : JSON.stringify(value) }] },
        execute: async args => {
          const request = parseRequest(args)
          if (typeof request === 'string') return failure('INVALID_ARGUMENT', request)
          const matches = search(request.query, config.allowedTools.filter(tool => permitted(agent, tool)), Math.min(request.maxResults, config.maxResults))
          const activated = matches.filter(tool => !entry.selected.has(tool) && !config.alwaysLoaded.includes(tool))
          for (const tool of activated) entry.pending.add(tool)
          return { status: 'completed', activated: activated.map(publicToolName),
            alreadyActive: matches.filter(tool => !activated.includes(tool)).map(publicToolName),
            message: matches.length ? `Selected ${matches.map(publicToolName).join(', ')}. Newly selected tools become available on the next model step; no file action was executed.` : 'No allowed, implemented capability matched. Refine the query; unavailable formats cannot be activated.' }
        },
      })
      for (const tool of wanted) {
        await own(agent, entry, entry.runtime.definition(tool))
      }
    }
    const reconcile = (): Promise<void> => {
      if (stopped || mutating) return chain
      const version = ++epoch
      chain = chain.then(async () => {
        if (stopped || version !== epoch) return
        // Incremental readiness: memoized verdicts (per agent) reuse the cached
        // assembly; only new, invalidated, or previously failed agents recompute.
        const ready = new Set<Agent>()
        for (const [agent, entry] of entries) {
          if (!entry.ctx || !ownership?.owns(agent) || !permitted(agent)) continue
          if (await native(agent).catch(() => false)) ready.add(agent)
        }
        if (stopped || version !== epoch) return
        mutating = true; ownership?.begin()
        try {
          for (const [agent, entry] of entries) await publishEntry(agent, entry, ready.has(agent))
          // A child must not inherit its parent's activation or an old global advanced surface.
          for (const [agent, entry] of entries) if (entry.ctx && ownership?.owns(agent)) {
            const deny = inheritedNative(agent, entry)
            if (deny.length) entry.disposers.push(entry.ctx.tools.restrict({ deny }))
          }
        } finally { ownership?.end(); mutating = false }
        for (const [agent, entry] of entries) rememberLayers(agent, entry)
        ownership?.changedBelow()
      }).catch(() => {
        mutating = true
        try { for (const entry of entries.values()) clear(entry) } finally { mutating = false }
        ctx.logger.warn('dsh-ops: discovery publication unavailable; tools remain withdrawn.')
      })
      return chain
    }
    /** Publish only one agent (agent/pre-step activation): no full reconcile,
     * so a step never re-probes every active agent. Falls back to the global
     * reconcile when the chain is already mutating (ownership teardown). */
    const reconcileAgent = (agent: Agent): Promise<void> => {
      if (stopped || mutating) return chain
      const version = ++epoch
      chain = chain.then(async () => {
        if (stopped || version !== epoch) return
        const entry = entries.get(agent)
        if (!entry?.ctx || !ownership?.owns(agent)) return
        const isReady = await native(agent).catch(() => false)
        if (stopped || version !== epoch) return
        mutating = true; ownership?.begin()
        try {
          await publishEntry(agent, entry, isReady)
          // A parent activation can introduce inheritable native providers;
          // re-apply the child-denial restriction for every other entry so no
          // child inherits an activation outside its own scope.
          for (const [candidate, child] of entries) {
            if (candidate === agent || !child.ctx || !ownership?.owns(candidate)) continue
            const deny = inheritedNative(candidate, child)
            if (deny.length) child.disposers.push(child.ctx.tools.restrict({ deny }))
          }
        } finally { ownership?.end(); mutating = false }
        rememberLayers(agent, entry)
        ownership?.changedBelow()
      })
      return chain
    }
    const attach = (agent: Agent): Promise<void> => {
      if (stopped || entries.has(agent) || !agent.ctx) return entries.get(agent)?.ready ?? Promise.resolve()
      const entry: Entry = { runtime: new NativeFileTools({ ctx, config: { ...config, workerPath: worker }, report: undefined }),
        selected: new Set(), pending: new Set(), disposers: [], owned: new Set(), ready: Promise.resolve(), withdrawn: false }
      entries.set(agent, entry); ownership?.track(agent)
      entry.fiber = agent.ctx.plugin({ inject: ['tools'], apply(scoped) { entry.ctx = scoped } })
      entry.ready = Promise.resolve(entry.fiber).then(async () => {
        // Starting the runtime re-registers native providers; that own publish
        // must not invalidate every cached verdict through tools/change. Cover
        // it with the publishing gate; the reconcile below computes the new
        // agent exactly once while older agents reuse their cached verdicts.
        mutating = true; ownership?.begin()
        try { await entry.runtime.start([]) } finally { ownership?.end(); mutating = false }
        await reconcile()
      })
      return entry.ready
    }
    ctx.on('agent/created', async ({ agent }) => { await attach(agent); return undefined })
    ctx.on('agent/pre-step', async (payload, next) => {
      await attach(payload.agent)
      const entry = entries.get(payload.agent)
      if (entry && ownership?.owns(payload.agent) && !payload.signal.aborted && await native(payload.agent).catch(() => false)) {
        for (const tool of entry.pending) if (permitted(payload.agent, tool)) entry.selected.add(tool)
        entry.pending.clear()
        // The step publishes only this agent's pending activation; a full
        // reconcile would re-probe every active agent on every step.
        await reconcileAgent(payload.agent)
      }
      return next()
    })
    ctx.on('agent/disposed', async ({ agent }) => {
      invalidateNativePresentation(agent)
      const entry = entries.get(agent)
      if (!entry) return
      entries.delete(agent); ownership?.forget(agent); mutating = true
      try { clear(entry); entry.releaseSelection?.() } finally { mutating = false }
      await entry.runtime.stop(); await entry.fiber?.dispose(); await reconcile()
    })
    ctx.on('tools/change', () => {
      if (ownership?.publishing()) return
      // Directed invalidation: only an agent whose tool-layer fingerprint moved
      // can have a different tools:ptc-only section. Unchanged agents keep the
      // cached verdict, so a session-shells bash registration for one new
      // session neither re-probes nor re-assembles every active agent.
      for (const [agent, entry] of entries) {
        if (!entry.ctx) continue
        const current = layerFingerprint(agent, scope => tools.schemas(scope))
        if (entry.layers !== undefined && current !== entry.layers) invalidateNativePresentation(agent)
        entry.layers = current
      }
      void reconcile()
    })
    ctx.on('system-prompt/change', () => {
      if (ownership?.publishing()) return
      // Preview sections, variables and contexts change through
      // system-prompt/change and not via tools/change; a ptc-only section
      // appearing or vanishing there must re-verify every cached verdict.
      for (const agent of entries.keys()) invalidateNativePresentation(agent)
      void reconcile()
    })
    ctx.on('app-boot/config-reload', () => {
      // Host configuration reloads can rewrite prompt-visible inputs
      // (settings.describe() sections and similar); drop every verdict.
      for (const agent of entries.keys()) invalidateNativePresentation(agent)
      void reconcile()
    })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      // The pinned host assembles BEFORE agent/pre-step. Wait for publication
      // queued by the previous committed step, then obtain a fresh public assembly.
      if (!isPresentationProbe(context)) {
        const entry = entries.get(context.scope as Agent), before = chain, pending = chain !== settled
        await entry?.ready; await drain()
        if (pending || before !== chain) return prompt.assemble(context)
      }
      const entry = entries.get(context.scope as Agent)
      // Snapshot ownership before yielding: another assembly may withdraw it while
      // this request still contains an already-rendered Native SDK section.
      const heldNative = Boolean(entry?.owned.size)
      const result = await next()
      if (!entry) return result
      if (heldNative && ptcOnly(result)) {
        mutating = true
        try { entry.runtime.cancel('Native presentation withdrawn'); entry.withdrawn = true; clear(entry) }
        finally { mutating = false }
        // Rebuild through the public host service after removing only our tools.
        // This cannot activate pending requests or rewrite another provider's text.
        return prompt.assemble(context)
      }
      // Symmetric restore: a real assembly is a fresh view of the pinned prompt.
      // When the ptc-only section has vanished from a scope we withdrew, drop
      // the stale verdict and republish through the single-agent path (never a
      // full reconcile). This is the only recovery from presentation changes
      // (e.g. presentAs lifts) that emit no tools/change or system-prompt/change.
      if (entry.withdrawn && !ptcOnly(result)) {
        entry.withdrawn = false
        invalidateNativePresentation(context.scope as Agent)
        void reconcileAgent(context.scope as Agent)
      }
      return result
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'step/end') {
        let changed = false
        for (const [agent, entry] of entries) if (agent.session === session && ownership?.owns(agent) && entry.pending.size) {
          for (const tool of entry.pending) if (permitted(agent, tool)) entry.selected.add(tool)
          entry.pending.clear(); changed = true
        }
        if (changed) void reconcile()
        return
      }
      if (event.type !== 'sandbox/mode') return
      mutating = true
      try {
        for (const [agent, entry] of entries) if (agent.session === session) {
          entry.pending.clear(); entry.runtime.cancel('Sandbox authority changed'); clear(entry)
        }
      } finally { mutating = false }
      void reconcile()
    })
    ownership = await ownScopes(ctx, 'discovery', () => {
      mutating = true
      try {
        for (const [agent, entry] of entries) if (!ownership?.owns(agent)) {
          entry.pending.clear(); entry.runtime.cancel('Discovery row ownership changed'); clear(entry)
          entry.releaseSelection?.(); entry.releaseSelection = undefined
        }
      } finally { mutating = false }
      void reconcile()
    })
    ctx.effect(() => prompt.section({
      name: ownership.sectionName('dsh-ops:discovery-tools'), order: 3253, interpolate: false,
      text: context => {
        const entry = entries.get(context.scope as Agent)
        return entry ? renderToolingPolicy({ published: entry.owned, shellComponent: false }) : ''
      },
    }), 'dsh-ops: discovered capability guidance')
    ctx.effect(() => async () => {
      stopped = true; ++epoch; mutating = true
      for (const entry of entries.values()) { clear(entry); entry.releaseSelection?.() }
      await Promise.allSettled([...entries.values()].map(async entry => { await entry.runtime.stop(); await entry.fiber?.dispose() }))
      entries.clear(); ownership?.dispose(); clearNativePresentationCache(); await chain
    }, 'dsh-ops: discovery lifecycle')
    for (const agent of entries.keys()) ownership.track(agent)
    ownership.refresh()
    for (const agent of new Set([...(ctx.get('agents')?.list() ?? []), ...ownership.agents()])) void attach(agent)
  })
}
