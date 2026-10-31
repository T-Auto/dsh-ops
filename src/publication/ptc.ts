/** Independent PTC SDK: scoped publication through public host APIs only. */
import type { Context, Fiber } from '../adapter/dsh/types.js'
import type { Agent } from '../adapter/dsh/types.js'
import type { ToolDefinition, ToolRunContext } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import type { PromptAssembly } from '../adapter/dsh/types.js'
import { loadScopes } from '../adapter/dsh/host.js'
import { inspectPresentation, isPresentationProbe } from './presentation.js'
import { InvocationLifetime, InvocationNotStarted } from '../lifecycle/invocations.js'
import { WORKER_TIMEOUT_MS } from '../execution/protocol.js'
import { FILE_TOOLS, PTC_TOOLS } from '../capabilities/registry.js'
import { PTC_SECTION, definition } from '../projections/ptc/contract.js'
import { publicToolName } from '../policy.js'
import { resolveWorker, failure } from '../execution/jobs.js'
import { mountWorkspacePreparation } from '../workspace-preparation.js'
import { mountResultLifecycle } from '../kernel/result-lifecycle.js'
import { nativeProviders, nativeProviderRevision, claimPtcSurface, trackNativeShadow } from './providers.js'
import { resolvePtcConfig } from '../config.js'
import { PTC_RESIDENT_TOOLS } from '../ptc/config.js'
import type { ApiName } from '../ptc/config.js'
import { sdkDefinition, requestedApis } from '../projections/ptc/loader.js'
import { ownPtcScopes } from '../ptc/ownership.js'
import { surfaceOf as toolSurface } from './surface.js'
import { onToolChange, withToolChange } from './changes.js'
import { monitoredInvoke } from '../execution/monitored.js'
import { scopedReconciliation, scopeFamilies } from './reconciliation.js'
import { retired as retiredLegacyRow } from '../settings/legacy.js'
export { resolvePtcConfig } from '../config.js'
export const name = 'dsh-ops-ptc'
const apiTools = [...FILE_TOOLS, ...PTC_TOOLS]
const publishedNames = [...apiTools, 'load_sdk'].map(publicToolName)
const ptcDefinitions = new WeakSet<ToolDefinition>()
interface Entry {
  calls: InvocationLifetime
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

/** A mode row's per-Agent permission to publish the PTC surface. */
export interface PtcGate {
  /** Optional public-consumer routing switch; execution remains independent. */
  guidance?: boolean
  /** Whether baseline APIs (including configured always-loaded APIs) are published. */
  resident?: boolean
  /** Whether advanced SDK selection is enabled. */
  dynamic?: boolean
  /** Whether the row owns this Agent's mode. */
  allows(agent: Agent): boolean
  /** Subscribe to gate changes; the callback runs a full reconcile. */
  watch?(notify: () => void): () => void
}

/** Legacy Loader entry; retained rows stay inert in the merged bundle. */
export function apply(root: Context, rawConfig: unknown, gate: PtcGate = { allows: () => true }): void {
  if (retiredLegacyRow(root, 'ptc')) return
  mountPtc(root, rawConfig, gate)
}

/** Mount the owned service for an explicit preset integration. */
export function mountPtc(root: Context, rawConfig: unknown, gate: PtcGate = { allows: () => true }): void {
  const config = resolvePtcConfig(rawConfig)
  const loadable = gate.resident === false ? [...new Set([...config.allowedTools, ...PTC_RESIDENT_TOOLS])] : config.allowedTools
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
    /**
     * Duck-typed access to the registry's private `modeFor` — same pattern as
     * `surfaceOf`'s `view()`. It walks the scope chain and returns the resolved
     * presentation without assembling a prompt: microseconds against the full
     * assembly a probe pays.
     */
    const modeOf = (agent: Agent): string | undefined => (tools as unknown as { modeFor?: (scope: object) => string }).modeFor?.(agent)
    const ptcOnly = async (agent: Agent, signal?: AbortSignal): Promise<boolean> => Boolean(ctx.get('ptcRuntime')) && isPtc(await inspectPresentation(prompt, agent, signal))
    const abortOwner = (agent: Agent, reason: string) => {
      entries.get(agent)?.calls.cancel(reason)
    }
    let ownership: Awaited<ReturnType<typeof ownPtcScopes>> | undefined
    const execute = (agent: Agent, entry: Entry, tool: ApiName | 'load_sdk', publication = entry.published): ToolDefinition['execute'] => async (args, exec) => {
      await reconciliation.drain(agent)
      const version = entry.published, revision = entry.revision
      const available = () => publication === entry.published && !stopped && !exec.signal?.aborted && entries.get(agent) === entry && ownership?.owns(agent) && exec.agent === agent && entry.ptc && entry.owned.has(publicToolName(tool))
      if (!available() || !await ptcOnly(agent, exec.signal).catch(() => false) || !available() || version !== entry.published || revision !== entry.revision) {
        return failure('POLICY_DENIED', 'The calling scope must own this API in authoritative PTC-only presentation.')
      }
      if (tool === 'load_sdk') {
        const requested = requestedApis(args, gate.dynamic === false ? [] : loadable)
        if (typeof requested === 'string') return failure('INVALID_ARGUMENT', requested)
        for (const name of requested) entry.pending.add(name)
        return { status: 'completed', tools: requested, nextTurn: true }
      }
      try {
        return await entry.calls.run(exec.signal, (_signal, controller) => monitoredInvoke(ctx, file, tool, args, exec as ToolRunContext, controller, config), undefined, WORKER_TIMEOUT_MS)
      } catch (error) {
        if (error instanceof InvocationNotStarted) return failure('ABORTED', error.message)
        return failure('RESULT_UNKNOWN', 'Invocation did not settle; inspect postconditions before retrying.', 'unknown')
      }
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
    const reconcile = (force = false, targets?: ReadonlySet<Agent>, verify = true): Promise<void> => {
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
          if (!entry.ctx) continue
          if (!ownership?.owns(agent)) {
            if (entry.ptc || entry.disposers.length) { dirty = true; changed.add(agent) }
            continue
          }
          if (!requests.has(agent)) { if (entry.ptc) ready.add(agent); continue }
          const surface = surfaceOf(agent)
          const fresh = requests.get(agent) === true
          if (!fresh && entry.surface === surface) { if (entry.ptc) ready.add(agent); continue }
          if (entry.surface !== surface || fresh) { dirty = true; changed.add(agent) }
          // A deferred change still republishes when the surface moved — that is the
          // only part of a publish that depends on the registry — but it keeps the
          // verdict it holds instead of paying an assembly to re-derive a mode that a
          // `tools/change` cannot have moved. The next probe confirms it at pre-step.
          if (!verify) { if (entry.ptc) ready.add(agent); continue }
          // A scope whose registry mode is not `ptc` cannot present PTC-only: the
          // collapsed section renders empty for every other mode, and `modeFor` is
          // the same source that section reads. Answering from the scope chain
          // skips an assembly that can only ever return the verdict already held.
          if (modeOf(agent) === 'native' && !entry.ptc) { continue }
          probedBefore.add(agent)
          const next = gate.allows(agent) && await task.wait(ptcOnly(agent, task.signal)).catch(() => false)
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
            if (!entry.ctx) continue
            if (!ownership?.owns(agent)) {
              entry.ptc = false; entry.pending.clear(); entry.selected.clear(); abortOwner(agent, 'PTC row ownership changed'); continue
            }
            if (entry.ptc) { if (!probedBefore.has(agent)) ready.add(agent) }
            entry.ptc = ready.has(agent)
            if (!entry.ptc) { entry.pending.clear(); abortOwner(agent, 'PTC presentation withdrawn'); continue }
            const releaseNative = claimPtcSurface(entry.ctx, agent)
            try {
              const wanted = new Set([...(gate.resident === false ? [] : [...PTC_RESIDENT_TOOLS, ...config.alwaysLoaded]), ...entry.selected])
              const definitions = [...wanted].map(tool => definition(tool, execute(agent, entry, tool)))
              if (gate.dynamic !== false) definitions.push(sdkDefinition(loadable, execute(agent, entry, 'load_sdk')))
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
      const entry: Entry = { calls: new InvocationLifetime(), agent, revision: 0, disposers: [], selected: new Set(), pending: new Set(), owned: new Map(), ptc: false, ready: Promise.resolve() }
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
      abortOwner(agent, 'Owning agent disposed'); entries.delete(agent); ownership?.forget(agent); mutating = true
      try { withToolChange([agent], () => clear(entry)) } finally { mutating = false }
      // Only a departed scope's inheritance family can depend on its projection.
      await entry.calls.stop(); await entry.fiber?.dispose(); await reconcile(true, affected)
    })
    // `presentAs(mode)` registers or drops the collapsed and SDK prompt sections, so a
    // prompt change is the only evidence that a presentation mode may have flipped while
    // the registry change that follows it stays unattributed. The evidence is a version
    // rather than a one-shot flag: the registry change can trail it by several turns of
    // the event loop, and a consumed flag would strand the flipped session until its next
    // real assembly.
    let promptEpoch = 0, rederivedEpoch = 0
    ctx.on('system-prompt/change', () => { if (!stopped) ++promptEpoch })
    // A registry change only owes a republish when some agent's surface moved, so the
    // change listener republishes and lets the dirty check decide.
    onToolChange(ctx, scopes => {
      if (mutating || ownership?.publishing()) {
        if (!scopes?.length) foreignDuringPublish = true
        return
      }
      // Nothing is attributable here: the official host emits `tools/change` with no
      // payload. A bare registration cannot move a presentation mode — the collapsed
      // section text and the wire projection depend on the mode alone — so re-deriving
      // the verdict per session is one wasted assembly each. Only a prompt change since
      // the last re-derivation can have flipped one. The republish itself is never
      // skipped: a restriction or a scoped shadow moves what a Native session sees
      // without moving the mode, and `surfaceOf` cannot see it.
      if (!scopes?.length) {
        // A probe a superseded round still owes must not be dropped here: a publish that
        // was in flight keeps its request queued, and the deferred path is the only
        // remaining chance to spend it.
        const rederive = promptEpoch > rederivedEpoch || [...queued.values()].some(value => value === true)
        if (rederive) rederivedEpoch = promptEpoch
        for (const [agent, entry] of entries) if (!entry.ptc) queued.set(agent, true)
        void reconcile(false, undefined, rederive)
        return
      }
      const targets = new Set([...entries.keys()].filter(agent => scopes.some(scope => scopeChainOf(agent).includes(scope))))
      for (const agent of targets) if (!entries.get(agent)?.ptc) queued.set(agent, true)
      void reconcile(false, targets)
    })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      // The pinned host assembles BEFORE agent/pre-step. Wait for publication
      // queued by the previous committed step, then obtain a fresh public assembly.
      const agent = context.scope as Agent
      const probing = isPresentationProbe(context)
      if (!probing) {
        const entry = entries.get(agent), before = reconciliation.version(agent)
        await entry?.ready
        if (await reconciliation.drain(agent) || before !== reconciliation.version(agent)) return prompt.assemble(context)
      }
      const entry = entries.get(agent), heldPtc = Boolean(entry?.ptc && entry.owned.size)
      const result = await next()
      // A probe assembly already carries its own verdict; re-entering here would
      // publish from inside the very assembly whose cost the probe is measuring.
      if (probing || !entry || context.signal?.aborted || entries.get(agent) !== entry) return result
      const presented = isPtcPresentation(result)
      if (heldPtc && !presented) {
        mutating = true
        try { entry.ptc = false; entry.surface = undefined; entry.pending.clear(); abortOwner(agent, 'PTC presentation withdrawn'); clear(entry) }
        finally { mutating = false }
        void reconcile(true, new Set([agent]))
        return prompt.assemble(context)
      }
      // The symmetric guard. An unattributed change is deferred to this assembly, so
      // the prompt can present PTC-only before OPS has published the APIs it promises.
      // Publish once, then re-assemble so the codes see a surface that matches the
      // instructions. A scope the gate or ownership excludes keeps the plain result,
      // which is also what stops this from retrying the same refused upgrade forever.
      if (!entry.ptc && presented && gate.allows(agent) && Boolean(ownership?.owns(agent))) {
        await reconcile(true, new Set([agent]))
        if (entries.get(agent) === entry && entry.ptc) return prompt.assemble(context)
      }
      return result
    })
    ctx.on('session/event', (session, event) => {
      if ((event as { type: string }).type === 'agent-preset/selected') {
        void reconcile(true, new Set([...entries.keys()].filter(agent => agent.session === session))); return
      }
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
    ;({ scopeChainOf } = await loadScopes())
    if (gate.watch) ctx.effect(() => gate.watch!(() => { void reconcile(true) }), 'dsh-ops: PTC mode observer')
    ownership = await ownPtcScopes(ctx, () => {
      mutating = true
      try {
        for (const [agent, entry] of entries) if (!ownership?.owns(agent)) {
          entry.ptc = false; entry.pending.clear(); abortOwner(agent, 'PTC row ownership changed'); clear(entry)
        }
      } finally { mutating = false }
      void reconcile(true)
    }, gate.allows)
    ctx.effect(() => prompt.section({ name: ownership.sectionName(PTC_SECTION), order: 3252, interpolate: false, text: context => {
      const entry = entries.get(context.scope as Agent)
      return gate.guidance !== false && entry?.ptc && entry.owned.size > 0
        ? 'OPS APIs return typed Outcome values. Inspect status before data; preserve partial coverage and continuation. ' + (gate.dynamic !== false ? 'Use ' + publicToolName('load_sdk') + ' to request advanced APIs by raw name; they become callable on the next model step. ' : '') + 'Process results locally in run_code and return only needed summaries. References do not grant authority.' : ''
    } }), 'dsh-ops: progressive PTC guidance')
    ctx.effect(() => async () => {
      stopped = true; mutating = true
      const cancelled = reconciliation.stop()
      for (const entry of entries.values()) { entry.calls.cancel('PTC component unloaded'); clear(entry) }
      await Promise.allSettled([...entries.values()].map(entry => entry.calls.stop()))
      await Promise.allSettled([...entries.values()].map(entry => entry.fiber?.dispose()))
      entries.clear(); ownership?.dispose(); await cancelled
    }, 'dsh-ops: PTC lifecycle')
    for (const agent of entries.keys()) ownership.track(agent)
    ownership.refresh()
    for (const agent of new Set([...(ctx.get('agents')?.list() ?? []), ...ownership.agents()])) void attach(agent)
  })
}
