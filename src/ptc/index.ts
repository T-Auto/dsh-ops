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
import { nativeProviders, nativeProviderRevision, claimPtcSurface, trackNativeShadow } from '../file/result-provider.js'
import { resolvePtcConfig } from '../config.js'
import { PTC_RESIDENT_TOOLS } from './config.js'
import type { ApiName } from './config.js'
import { sdkDefinition, requestedApis } from './sdk.js'
import { ownPtcScopes } from './ownership.js'
import { surfaceOf as toolSurface } from '../surface.js'
import { onToolChange, withToolChange } from '../tool-changes.js'
import { monitoredInvoke } from './invoke.js'
import { scopedReconciliation, scopeFamilies } from '../scoped-reconciliation.js'
export { resolvePtcConfig } from '../config.js'
export const name = 'dsh-ops-ptc'
const apiTools = [...FILE_TOOLS, ...PTC_TOOLS]
const publishedNames = [...apiTools, 'load_sdk'].map(publicToolName)
const ptcDefinitions = new WeakSet<ToolDefinition>()
interface Entry {
  agent: Agent; ctx?: Context; fiber?: Fiber; ready: Promise<void>; disposers: (() => void)[]
  selected: Set<ApiName>; pending: Set<ApiName>; owned: Map<string, ToolDefinition>; ptc: boolean
  /**
   * Committed view identity plus Native source-provider revisions. A prompt-only
   * change is checked afresh at pre-step/execution and by the assembly withdrawal
   * guard; background memoization alone never authorizes execution.
   */
  surface?: string
  published?: number
  revision: number
}
type Presentation = Pick<PromptAssembly, 'sections'> & Partial<Pick<PromptAssembly, 'tools'>>
const hasPtcInstruction = (presentation: Presentation): boolean =>
  presentation.sections.some(section => section.name === 'tools:ptc-only' && section.text.trim() !== '')
const isPtc = (assembly: Presentation): boolean => Array.isArray(assembly.tools)
  && assembly.tools.length === 1 && assembly.tools[0]?.name === 'run_code' && hasPtcInstruction(assembly)
// rc.3's waterfall owns text only; the host attaches authoritative tools after
// it returns. Full assemble probes still require the exact run_code surface.
const isPtcPresentation = (presentation: Presentation): boolean =>
  Object.hasOwn(presentation, 'tools') ? isPtc(presentation) : hasPtcInstruction(presentation)

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
    const retired = new WeakSet<Agent>()
    const active = new Map<AbortController, { owner: Agent; promise: Promise<unknown> }>()
    let stopped = false, mutating = false, epoch = 0, foreignDuringPublish = false
    let verifyingForeign = false
    const reconciliation = scopedReconciliation<Agent>(error => ctx.logger.warn('dsh-ops: PTC publication failed: ' + String(error)))
    let scopeChainOf: (scope: object) => object[] = scope => [scope]
    const surfaceOf = (agent: Agent): string => toolSurface(tools, agent) + '\u0002' + nativeProviderRevision(ctx, scopeChainOf(agent))
    const clear = (entry: Entry) => {
      entry.published = undefined
      entry.owned.clear()
      for (const dispose of entry.disposers.splice(0)) {
        try { withToolChange([entry.agent], dispose) } catch (error) { ctx.logger.warn('dsh-ops: PTC teardown failed; continuing:', error) }
      }
    }
    const ptcOnly = async (agent: Agent, signal?: AbortSignal): Promise<boolean> => Boolean(ctx.get('ptcRuntime')) && isPtc(await inspectPresentation(prompt, agent, signal))
    const abortOwner = (agent: Agent, reason: string) => {
      for (const [controller, work] of active) if (work.owner === agent) controller.abort(new Error(reason))
    }
    let ownership: Awaited<ReturnType<typeof ownPtcScopes>> | undefined
    const execute = (agent: Agent, entry: Entry, tool: ApiName | 'load_sdk'): ToolDefinition['execute'] => async (args, exec) => {
      await reconciliation.drain(agent)
      const version = entry.published, revision = entry.revision
      const available = () => !stopped && !exec.signal?.aborted && entries.get(agent) === entry && ownership?.owns(agent) && exec.agent === agent && entry.ptc && entry.owned.has(publicToolName(tool))
      if (!available() || !await ptcOnly(agent, exec.signal).catch(() => false) || !available() || version !== entry.published || revision !== entry.revision) {
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
    // Lift a connected inheritance family together. This keeps the pre-publication
    // Native snapshot exact without disturbing independent root sessions. Ancestors
    // may hold Native claims, so lifting only the leaf would miss their providers.
    const related = (targets: ReadonlySet<Agent>): Set<Agent> => {
      const roots = new Set<Agent>()
      for (const agent of targets) {
        const ancestors = scopeChainOf(agent).filter(scope => entries.has(scope as Agent)) as Agent[]
        roots.add(ancestors.at(-1) ?? agent)
      }
      return new Set([...entries.keys()].filter(agent => [...roots].some(root => agent === root || scopeChainOf(agent).includes(root))))
    }
    /** Probe changed scopes, then rebuild only their inheritance dependency family. */
    const queued = new Map<Agent, boolean>()
    const reconcile = (force = false, targets?: ReadonlySet<Agent>): Promise<void> => {
      if (stopped || mutating) return Promise.resolve()
      for (const agent of targets ?? entries.keys()) {
        const entry = entries.get(agent)
        if (entry) ++entry.revision
        queued.set(agent, force || queued.get(agent) === true)
      }
      const families = scopeFamilies(entries.keys(), targets ?? entries.keys(), scopeChainOf)
      return Promise.all(families.map(family => reconciliation.run(family, async task => {
        const changed = new Set<Agent>(), version = ++epoch
        const requests = new Map([...queued].filter(([agent]) => family.has(agent)))
        const probedBefore = new Set<Agent>()
        const ready = new Set<Agent>()
        // Superseded passes keep their requests queued. Commit surfaces only after
        // publishing the affected family, and retain every unprobed verdict.
        let dirty = false
        for (const [agent, entry] of entries) {
          if (stopped || !task.current()) return
          if (!family.has(agent)) continue
          if (!entry.ctx || !ownership?.owns(agent)) continue
          if (!requests.has(agent)) { if (entry.ptc) ready.add(agent); continue }
          const surface = surfaceOf(agent)
          const fresh = requests.get(agent) === true
          if (!fresh && entry.surface === surface) { if (entry.ptc) ready.add(agent); continue }
          if (entry.surface !== surface || fresh) { dirty = true; changed.add(agent) }
          probedBefore.add(agent)
          const next = await task.wait(ptcOnly(agent, task.signal)).catch(() => false)
          if (next !== entry.ptc) { dirty = true; changed.add(agent) }
          if (next) ready.add(agent)
        }
        if (stopped || !task.current()) return
        for (const agent of family) queued.delete(agent)
        if (!dirty) return
        const affected = related(changed)
        const publications = [...entries].filter(([agent]) => affected.has(agent))
        mutating = true; ownership?.begin()
        try {
          withToolChange(publications.map(([agent]) => agent), () => {
          for (const [, entry] of publications) { clear(entry); entry.published = version }
          // Every ancestor that could suppress a Native origin is lifted with its family.
          const native = new Map(publications.map(([agent, entry]) => [agent, nativeProviders(entry.ctx ?? ctx, agent, true)]))
          for (const [agent, entry] of publications) {
            if (!entry.ctx || !ownership?.owns(agent)) continue
            if (entry.ptc) { if (!probedBefore.has(agent)) ready.add(agent) }
            entry.ptc = ready.has(agent)
            if (!entry.ptc) { entry.pending.clear(); abortOwner(agent, 'PTC presentation withdrawn'); continue }
            const releaseNative = claimPtcSurface(entry.ctx, agent)
            try {
              const wanted = new Set([...PTC_RESIDENT_TOOLS, ...config.alwaysLoaded, ...entry.selected])
              const definitions = [...wanted].map(tool => definition(tool, execute(agent, entry, tool)))
              definitions.push(sdkDefinition(config.allowedTools, execute(agent, entry, 'load_sdk')))
              for (const def of definitions) { ptcDefinitions.add(def); entry.disposers.push(withToolChange([agent], () => entry.ctx!.tools.register(def))); entry.owned.set(def.name, def) }
              entry.disposers.push(releaseNative)
            } catch (error) { releaseNative(); throw error }
          }
          for (const [agent, entry] of publications) {
            if (!entry.ctx || !ownership?.owns(agent)) continue
            if (!entry.ptc) for (const provider of native.get(agent) ?? []) {
              if (!provider.inheritable && provider.scope !== agent) continue
              const def = provider.definition
              if (provider.scope === agent || tools.get(def.name, agent) === def) continue
              const publication = entry.published
              const shadow: ToolDefinition = { ...def, execute: async (args, exec) => {
                const version = entry.published
                if (publication !== entry.published || stopped || !provider.active || entries.get(agent) !== entry || exec.agent !== agent
                  || tools.get(def.name, agent) !== shadow
                  || await ptcOnly(agent, exec.signal).catch(() => true)
                  || stopped || !provider.active || version !== entry.published) return failure('POLICY_DENIED', 'Native projection or owning scope is unavailable.')
                return def.execute(args, exec)
              } }
              entry.disposers.push(withToolChange([agent], () => entry.ctx!.tools.register(shadow)), trackNativeShadow(entry.ctx, agent, shadow, provider)); entry.owned.set(def.name, shadow)
            }
            const nativeNames = new Set((native.get(agent) ?? []).map(provider => provider.definition.name))
            const ownedNative = new Set(nativeProviders(ctx, agent).map(provider => provider.definition))
            const deny = publishedNames.filter(name => {
              const visible = tools.get(name, agent)
              return visible && !entry.owned.has(name) && (entry.ptc || !nativeNames.has(name))
                && (ptcDefinitions.has(visible) || entry.ptc && ownedNative.has(visible))
            })
            if (deny.length) entry.disposers.push(withToolChange([agent], () => entry.ctx!.tools.restrict({ deny })))
          }
          // Store the committed view, not the temporary pre-publish overlay. Otherwise
          // the next unrelated registry event mistakes our own definitions for a change.
          for (const [agent, entry] of publications) entry.surface = surfaceOf(agent)
          })
        } catch (error) {
          for (const [, entry] of publications) { clear(entry); entry.surface = undefined }
          throw error
        } finally { ownership?.end(); mutating = false }
        if (foreignDuringPublish) {
          foreignDuringPublish = false
          if (!verifyingForeign) {
            verifyingForeign = true
            void reconcile(true).finally(() => { verifyingForeign = false })
          }
        }
        ownership?.changedBelow()
      }))).then(() => undefined)
    }
    const attach = (agent: Agent): Promise<void> => {
      if (stopped || retired.has(agent) || entries.has(agent) || !agent.ctx) return entries.get(agent)?.ready ?? Promise.resolve()
      const entry: Entry = { agent, revision: 0, disposers: [], selected: new Set(), pending: new Set(), owned: new Map(), ptc: false, ready: Promise.resolve() }
      entries.set(agent, entry); ownership?.track(agent)
      entry.fiber = agent.ctx.plugin({ inject: ['tools'], apply(scoped) { entry.ctx = scoped } })
      entry.ready = Promise.resolve(entry.fiber).then(() => reconcile(true, new Set([agent])))
      return entry.ready
    }
    ctx.on('agent/created', async ({ agent }) => { await attach(agent); return undefined })
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      await attach(agent)
      const entry = entries.get(agent)
      if (entry && !signal.aborted) {
        const wasPtc = entry.ptc
        const presentationPtc = await ptcOnly(agent, signal).catch(() => false)
        if (signal.aborted || entries.get(agent) !== entry || !ownership?.owns(agent)) return next()
        if (presentationPtc) {
          for (const tool of entry.pending) entry.selected.add(tool)
        }
        const changed = entry.pending.size > 0
        entry.pending.clear()
        if (changed) entry.surface = undefined
        // A presentation transition can keep the visible tool surface unchanged
        // (for example both -> ptc with no resident tools). It still owes a publish.
        await reconcile(changed || presentationPtc !== wasPtc, new Set([agent]))
      }
      return next()
    })
    ctx.on('agent/disposed', async ({ agent }) => {
      retired.add(agent); reconciliation.forget(agent); queued.delete(agent)
      const entry = entries.get(agent); if (!entry) return
      const affected = related(new Set([agent])); affected.delete(agent)
      entries.delete(agent); ownership?.forget(agent); abortOwner(agent, 'Owning agent disposed'); mutating = true
      try { withToolChange([agent], () => clear(entry)) } finally { mutating = false }
      // Only a departed scope's inheritance family can depend on its projection.
      await entry.fiber?.dispose(); await reconcile(true, affected)
    })
    // A registry change only owes a republish when some agent's probed surface moved,
    // so the change listener probes and lets the dirty check decide.
    onToolChange(ctx, scopes => {
      if (mutating || ownership?.publishing()) {
        if (!scopes?.length) foreignDuringPublish = true
        return
      }
      const targets = scopes?.length ? new Set([...entries.keys()].filter(agent => scopes.some(scope => scopeChainOf(agent).includes(scope)))) : undefined
      // A host presentation change carries no affected scope. Probe every entry
      // because its visible names may stay identical while ptcOnly changes.
      // OPS-owned changes can still be narrowed to their scope descendants.
      for (const [agent, entry] of entries) if ((!targets || targets.has(agent)) && !entry.ptc) queued.set(agent, true)
      void reconcile(false, targets)
    })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      // The pinned host assembles BEFORE agent/pre-step. Wait for publication
      // queued by the previous committed step, then obtain a fresh public assembly.
      if (!isPresentationProbe(context)) {
        const agent = context.scope as Agent, entry = entries.get(agent), before = reconciliation.version(agent)
        await entry?.ready
        if (await reconciliation.drain(agent) || before !== reconciliation.version(agent)) return prompt.assemble(context)
      }
      const entry = entries.get(context.scope as Agent), heldPtc = Boolean(entry?.ptc && entry.owned.size)
      const result = await next()
      if (!entry || context.signal?.aborted || entries.get(context.scope as Agent) !== entry || !heldPtc || isPtcPresentation(result)) return result
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
    ;({ scopeChainOf } = await import('@deepseek-ai/dsh-scope'))
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
      stopped = true; mutating = true
      const cancelled = reconciliation.stop()
      for (const controller of active.keys()) controller.abort(new Error('PTC component unloaded'))
      for (const entry of entries.values()) clear(entry)
      await Promise.allSettled([...active.values()].map(work => work.promise))
      await Promise.allSettled([...entries.values()].map(entry => entry.fiber?.dispose()))
      entries.clear(); ownership?.dispose(); await cancelled
    }, 'dsh-ops: PTC lifecycle')
    for (const agent of entries.keys()) ownership.track(agent)
    ownership.refresh()
    for (const agent of new Set([...(ctx.get('agents')?.list() ?? []), ...ownership.agents()])) void attach(agent)
  })
}
