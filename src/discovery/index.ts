import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { resolveDiscoveryConfig } from '../config.js'
import { NativeFileTools } from '../file/runtime.js'
import { nativeProviders, registerNativeProviderAtScope, claimNativeSelection } from '../file/result-provider.js'
import { onToolChange } from '../tool-changes.js'
import { ownScopes } from '../scoped-ownership.js'
import { isNativePresentation, isPresentationProbe } from '../presentation.js'
import { mountResultLifecycle } from '../kernel/result-lifecycle.js'
import { failure, resolveWorker } from '../file/worker.js'
import { capability, DISCOVERY_TOOL_NAME } from '../capabilities/registry.js'
import { DISCOVERY_DESCRIPTION, DISCOVERY_PARAMETERS, DISCOVERY_OUTPUT } from '../capabilities/discovery.js'
import { publicToolName, renderToolingPolicy } from '../policy.js'
import { DISCOVERABLE_TOOLS } from './config.js'
import type { DiscoverableName } from './config.js'
import { parseRequest, search } from './search.js'
import { scopedReconciliation, scopeFamilies } from '../scoped-reconciliation.js'

interface Entry {
  ctx?: Context
  fiber?: Fiber
  runtime: NativeFileTools
  selected: Set<DiscoverableName>
  pending: Set<DiscoverableName>
  disposers: (() => void)[]
  owned: Set<string>
  ready: Promise<void>
  revision: number
  presentation?: { inputs: unknown[]; native: boolean }
  releaseSelection?: () => void
}
const DISCOVER = publicToolName(DISCOVERY_TOOL_NAME)
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
    const retired = new WeakSet<Agent>()
    let scopeChainOf: (scope: object) => object[] = scope => [scope]
    mountResultLifecycle(ctx)
    let ownership: Awaited<ReturnType<typeof ownScopes>> | undefined
    let stopped = false, mutating = false
    const work = scopedReconciliation<Agent>(() => ctx.logger.warn('dsh-ops: discovery publication unavailable; tools remain withdrawn.'))
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
    const invalidate = (entry: Entry) => { ++entry.revision; entry.presentation = undefined }
    const inputs = (agent: Agent): unknown[] => {
      const policy = policyService.resolve({ session: agent.session })
      return [agent.ctx, agent.session, agent.session.header.cwd, policy.mode, policy.workspaceRoot, policy.sessionId]
    }
    const same = (left: unknown[], right: unknown[]) => left.length === right.length && left.every((value, index) => value === right[index])
    // Only background reconciliation reuses a probe. A step or execution can
    // observe arbitrary dynamic prompt providers with no registry notification.
    const native = async (agent: Agent, fresh = false, signal?: AbortSignal): Promise<boolean> => {
      const entry = entries.get(agent)
      if (!entry) return false
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
        const available = () => ownership?.owns(agent) && !stopped && !exec.signal?.aborted && entries.get(agent) === entry && exec.agent === agent && entry.owned.has(tool.name)
        if (!available() || !permitted(agent) || !await native(agent, true, exec.signal).catch(() => false) || !available() || version !== work.version(agent)) {
          return failure('POLICY_DENIED', 'Discovery capability belongs to a different or inactive scope.')
        }
        return execute(args, exec)
      } }
      const dispose = registerNativeProviderAtScope(entry.ctx, agent, [registration], tool => entry.ctx!.tools.register(tool), { inheritable: false, priority: 10 })
      if (stopped || entries.get(agent) !== entry || !ownership?.owns(agent)) { dispose(); return }
      entry.disposers.push(dispose)
      entry.owned.add(tool.name)
    }
    const inheritedNative = (agent: Agent, entry: Entry): string[] => nativeProviders(ctx, agent)
      .map(provider => provider.definition.name).filter(name => (advanced.includes(name) || name === DISCOVER) && !entry.owned.has(name))
    const reconcile = (targets: Iterable<Agent> = entries.keys()): Promise<void> => {
      if (stopped) return Promise.resolve()
      const families = scopeFamilies(entries.keys(), targets, scopeChainOf)
      return Promise.all(families.map(family => work.run(family, async task => {
        const ready = new Set<Agent>()
        for (const agent of family) {
          if (stopped || !task.current()) return
          const entry = entries.get(agent)
          if (entry?.ctx && ownership?.owns(agent) && permitted(agent) && await task.wait(native(agent, false, task.signal)).catch(() => false)) ready.add(agent)
        }
        if (stopped || !task.current()) return
        mutating = true; ownership?.begin()
        try {
          for (const [agent, entry] of entries) {
            if (!family.has(agent)) continue
            if (!ownership?.owns(agent)) { clear(entry); entry.releaseSelection?.(); entry.releaseSelection = undefined; continue }
            entry.releaseSelection ??= claimNativeSelection(ctx, agent, new Set(advanced))
            const isReady = ready.has(agent)
            const wanted = isReady ? [...new Set([...config.alwaysLoaded, ...entry.selected])].filter(tool => permitted(agent, tool)) : []
            const desired = new Set([...(isReady && config.enabled ? [DISCOVER] : []), ...wanted.map(publicToolName)])
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
                const matches = search(request.query, config.allowedTools.filter(tool => permitted(agent, tool)), Math.min(request.maxResults, config.maxResults))
                const activated = matches.filter(tool => !entry.selected.has(tool) && !config.alwaysLoaded.includes(tool))
                for (const tool of activated) entry.pending.add(tool)
                return { status: 'completed', activated: activated.map(publicToolName),
                  alreadyActive: matches.filter(tool => !activated.includes(tool)).map(publicToolName),
                  message: matches.length ? `Selected ${matches.map(publicToolName).join(', ')}. Newly selected tools become available on the next model step; no file action was executed.` : 'No allowed, implemented capability matched. Refine the query; unavailable formats cannot be activated.' }
              },
            })
            for (const tool of wanted) {
              own(agent, entry, entry.runtime.definition(tool))
            }
          }
          // A child must not inherit its parent's activation or an old global advanced surface.
          for (const [agent, entry] of entries) if (family.has(agent) && entry.ctx && ownership?.owns(agent)) {
            const deny = inheritedNative(agent, entry)
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
      const entry: Entry = { runtime: new NativeFileTools({ ctx, config: { ...config, workerPath: worker }, report: undefined }),
        selected: new Set(), pending: new Set(), disposers: [], owned: new Set(), ready: Promise.resolve(), revision: 0 }
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
        entry.pending.clear()
        await reconcile([payload.agent])
      }
      return next()
    })
    ctx.on('agent/disposed', async ({ agent }) => {
      retired.add(agent); work.forget(agent)
      const entry = entries.get(agent)
      if (!entry) return
      const affected = scopeFamilies(entries.keys(), [agent], scopeChainOf).flatMap(family => [...family]).filter(member => member !== agent)
      entries.delete(agent); ownership?.forget(agent); mutating = true
      try { clear(entry); entry.releaseSelection?.() } finally { mutating = false }
      await entry.runtime.stop(); await entry.fiber?.dispose(); await reconcile(affected)
    })
    const refresh = () => {
      if (stopped) return
      for (const entry of entries.values()) invalidate(entry)
      void reconcile()
    }
    ;({ scopeChainOf } = await import('@deepseek-ai/dsh-scope'))
    onToolChange(ctx, scopes => {
      if (mutating || ownership?.publishing()) return
      if (!scopes?.length) { refresh(); return }
      const affected = new Set<Agent>()
      for (const [agent, entry] of entries) if (scopes.some(scope => scopeChainOf(agent).includes(scope))) { invalidate(entry); affected.add(agent) }
      void reconcile(affected)
    })
    ctx.on('system-prompt/change', refresh)
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
      try { entry.runtime.cancel('Native presentation withdrawn'); clear(entry) }
      finally { mutating = false }
      // Rebuild through the public host service after removing only our tools.
      // This cannot activate pending requests or rewrite another provider's text.
      return prompt.assemble(context)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'step/end') {
        const affected = new Set<Agent>()
        for (const [agent, entry] of entries) if (agent.session === session && ownership?.owns(agent) && entry.pending.size) {
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
          entry.pending.clear(); entry.runtime.cancel('Sandbox authority changed'); clear(entry)
        }
      } finally { mutating = false }
      void reconcile(affected)
    })
    ownership = await ownScopes(ctx, 'discovery', () => {
      for (const entry of entries.values()) invalidate(entry)
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
      stopped = true; mutating = true
      const cancelled = work.stop()
      for (const entry of entries.values()) { clear(entry); entry.releaseSelection?.() }
      await Promise.allSettled([...entries.values()].map(async entry => { await entry.runtime.stop(); await entry.fiber?.dispose() }))
      entries.clear(); ownership?.dispose(); await cancelled
    }, 'dsh-ops: discovery lifecycle')
    for (const agent of entries.keys()) ownership.track(agent)
    ownership.refresh()
    for (const agent of new Set([...(ctx.get('agents')?.list() ?? []), ...ownership.agents()])) void attach(agent)
  })
}
