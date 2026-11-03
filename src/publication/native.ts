/** Scoped Native file publication. Callers supply policy; this controller owns lifecycle. */
import type { Context, Fiber } from '../adapter/dsh/types.js'
import type { Agent } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import { NativeFileTools } from '../projections/native/runtime.js'
import { registerNativeProviderAtScope } from './providers.js'
import { resolveWorker } from '../execution/files.js'
import { mountResultLifecycle } from '../kernel/result-lifecycle.js'
import { modeSectionName, MODE_SECTION_ORDERS, renderToolingPolicy } from '../policy.js'
import { visibleNames } from './surface.js'
import { claimPresentationRebuild, isNativePresentation, isPresentationProbe } from './presentation.js'
import { onToolChange } from './changes.js'
import type { ResolvedConfig } from '../config.js'
import { ownScopes } from './ownership.js'
import { failure } from '../execution/files.js'
import { createReentryCooling, safeMessage } from './reentry.js'
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
  /** A publication still owed after a cooldown-deferred refusal (#579). */
  owed?: boolean
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
    const native = new Map<Agent, boolean>()
    // The host's append window is process-global, so one cooldown serves every session of this
    // row: a refusal stops the pass and the expiry re-runs only the owed publications (#579).
    const cooling = createReentryCooling({
      label: `${mode} native`,
      report: message => ctx.logger.warn(message),
      retry: () => { void resumeOwed() },
    })
    const clear = (entry: Entry): void => {
      entry.owned.clear()
      entry.owed = false
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
    /** What one attempt settled to; the pass above decides whether to keep going. */
    type AttemptOutcome = 'published' | 'refused' | 'deferred' | 'failed' | 'skipped'
    /**
     * Try to publish one session's resident tools.
     *
     * A classified host refusal is no longer terminal: the entry records that it still owes its
     * publication and the shared cooldown schedules exactly one deferred pass (#579). Any other
     * failure keeps the old shape — one warn, no retry — because only the append window is
     * transient by construction. Never rejects.
     * @param agent - the session's agent scope.
     * @param entry - its publication entry.
     * @returns what this attempt settled to.
     */
    const attempt = async (agent: Agent, entry: Entry): Promise<AttemptOutcome> => {
      if (stopped || entries.get(agent) !== entry || !entry.ctx || entry.owned.size > 0) return 'skipped'
      if (!cover(agent)) return 'skipped'
      // Inside the cooldown the registry must not be touched at all — but the publication is
      // still owed, so a session that arrives during the cooldown is queued instead of dropped.
      if (cooling.cooled()) { entry.owed = true; return 'deferred' }
      if (native.get(agent) === false) return 'skipped'
      if (!await isNativePresentation(prompt, agent).catch(() => false)) return 'skipped'
      if (stopped || entries.get(agent) !== entry || entry.owned.size > 0 || !cover(agent)) return 'skipped'
      if (cooling.cooled()) { entry.owed = true; return 'deferred' }
      try {
        publish(agent, entry)
        entry.owed = false
        return 'published'
      } catch (error) {
        if (!cooling.classify(error)) {
          entry.owed = false
          ctx.logger.warn(`dsh-ops: ${mode} mode publication failed: ${safeMessage(error)}`)
          return 'failed'
        }
        // Only the session whose own attempt was refused stays owed; the pass ends here because
        // the host's reentry lock is process-global, not per session.
        entry.owed = true
        cooling.failed(error)
        return 'refused'
      }
    }
    /** Reset the ladder once nothing is owed anymore; a partial pass must keep escalating. */
    const settle = (): void => {
      if (![...entries.values()].some(entry => entry.owed)) cooling.succeeded()
    }
    /**
     * One deferred pass over the sessions that still owe a publication.
     *
     * Serial on purpose: the refusal is process-global, so the first one ends the pass and the
     * cost of a locked window stays one touch per cooldown step instead of one per session.
     * @returns resolves when the pass ended (also when a refusal stopped it).
     */
    let resuming = false
    const resumeOwed = async (): Promise<void> => {
      if (stopped || resuming) return
      resuming = true
      try {
        for (const [agent, entry] of entries) {
          if (stopped || cooling.cooled()) return
          if (!entry.owed || !cover(agent)) continue
          if (await attempt(agent, entry) === 'refused') return
        }
        settle()
      } finally { resuming = false }
    }
    /** Coalesced resume for a cover flip; the cooldown timer stays the primary driver. */
    let queued = false
    const queueResume = (): void => {
      if (queued) return
      queued = true
      setImmediate(() => { queued = false; void resumeOwed() })
    }
    const attach = (agent: Agent): void => {
      if (stopped || entries.has(agent) || !agent?.ctx) return
      const entry: Entry = { agent, runtime: new NativeFileTools({ ctx, config: { workerPath: worker, required: config.required, denyCredentialReads: config.denyCredentialReads } }),
        owned: new Set(), disposers: [], ready: Promise.resolve(), owed: false }
      entries.set(agent, entry)
      entry.fiber = agent.ctx.plugin({ inject: ['tools'], apply(scoped) { entry.ctx = scoped } })
      entry.ready = Promise.resolve(entry.fiber).then(async () => {
        if (stopped || entries.get(agent) !== entry || !entry.ctx) return
        await entry.runtime.start([])
        await attempt(agent, entry)
        settle()
      }).catch(error => {
        // The startup chain itself failed (fiber or worker start). A refusal is still an owed
        // publication; anything else keeps its single line and no retry.
        if (cooling.classify(error)) { entry.owed = true; cooling.failed(error) }
        else ctx.logger.warn(`dsh-ops: ${mode} mode publication failed: ${safeMessage(error)}`)
      })
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
      // Owed publications are driven by the shared cooldown timer. The only extra trigger is a
      // cover flip (a preset/ownership change restored an owed session): one coalesced pass, and
      // never while the cooldown is running.
      if (!cooling.cooled() && [...entries.values()].some(entry => entry.owed)) queueResume()
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
        // Same one-rebuild budget as every other publication hook: the surface
        // this hook reacts to is the one another hook is retiring right now.
        return claimPresentationRebuild(context) ? prompt.assemble(context) : result
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
    const renderGuidance = (agent: Agent): string => {
      if (!agent || stopped || section === null || !config.promptPolicy || !cover(agent)) return ''
      const entry = entries.get(agent)
      if (!entry || entry.owned.size === 0) return ''
      const visible = new Set(visibleNames(tools, agent))
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
        text: context => renderGuidance(context.agent ?? context.scope as Agent),
      }), `dsh-ops: ${mode} tooling guidance`)
    }
    ctx.effect(() => () => {
      stopped = true
      cooling.dispose()
      for (const agent of [...entries.keys()]) detach(agent)
      ownership.dispose()
    }, `dsh-ops: ${mode} native lifecycle`)
    ownership.refresh()
  })
  return agent => ownsGuidance(agent)
}
