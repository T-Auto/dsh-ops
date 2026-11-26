/** Scoped replacement controller. Missing counterparts always leave official tools available. */
import type { Agent, Context, ToolActivationContext, ToolDefinition } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import { onToolChange, withToolChange } from './changes.js'
import { publicationError, publicationLeaseState, publicationOwnerLive, publicationRegistration } from './reentry.js'
import { publicationAdmission } from './registrar.js'
import { loadScopes } from '../adapter/dsh/host.js'
import { RAW_OFFICIAL_REPLACEMENTS } from '../capabilities/replacements.js'
import type { ApiName } from '../ptc/config.js'
import type { PtcServability } from './ptc.js'
import type { PublicationGate } from './types.js'

/** Bash preparation stages that no retry of the same call can repair; each lifts the official fallback (#962). */
const UNRECOVERABLE_BASH_STAGES = new Set(['bash-runtime-missing', 'bash-ipc-mismatch', 'bash-lifecycle-lock-busy', 'bash-cache-unusable'])

/**
 * Whether one settled replacement-counterpart value reports a runtime failure that
 * retrying the same call cannot repair (#962). Only Bash preparation stages without a
 * retry remedy qualify: a staging interruption is repaired by the next call, and lifting
 * the shadow for it would flap between two tool sets. The stage is the stable second
 * segment of the model-facing EXECUTOR_UNAVAILABLE text (src/bash-runtime-failure.ts);
 * bash-runtime-incompatible keeps its own complete message without that prefix, so its
 * stage name inside the message is its identifier. PTC Outcome failures carry a structured
 * error object, never this text, so they never classify.
 * @param value - one settled tool-call value.
 * @returns whether the official fallback must be restored for the calling agent.
 */
export function unrecoverableCounterpartRuntime(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const error = (value as { error?: unknown }).error
  if (typeof error !== 'string') return false
  const stage = /^EXECUTOR_UNAVAILABLE:\s*([a-z-]+):/.exec(error)
  if (stage !== null) return UNRECOVERABLE_BASH_STAGES.has(stage[1]!)
  return error.includes('bash-runtime-incompatible')
}

interface Shadow { source: ToolDefinition; definition: ToolDefinition; dispose(): void }
interface Entry { shadows: Map<string, Shadow>; probe: object }

/** Product-independent mapping; publication and replacement remain separate choices. */
export interface ReplacementPublication {
  id: string
  targets: ReadonlyMap<string, string>
  gate: PublicationGate
  keepOfficial(): boolean
  /** PTC projection reachability; absent for native consumers, which keep the old path. */
  ptc?: PtcServability
}

/** Select the official fallback and its counterpart in the same host resolve. */
export function mountReplacements(root: Context, publication: ReplacementPublication): void {
  const { id: mode, targets, gate, keepOfficial, ptc } = publication
  if (targets.size === 0) return
  root.inject(['tools'], async ctx => {
    const tools = ctx.get('tools')
    if (!tools) return
    const { scopeChainOf, bindScopeParent } = await loadScopes()
    const sources = new WeakSet<ToolDefinition>()
    const entries = new Map<Agent, Entry>()
    // One line per agent, name and state: mixed states on one agent are normal
    // (a resident read is hidden while glob/grep stay official), and a
    // per-activation warning would flood the log.
    const ptcState = new WeakMap<Agent, Map<string, string>>()
    const probeFailures = new WeakSet<Agent>()
    const notePtc = (agent: Agent, name: string, state: string): boolean => {
      let states = ptcState.get(agent)
      if (!states) { states = new Map(); ptcState.set(agent, states) }
      if (states.get(name) === state) return false
      states.set(name, state)
      ctx.logger.info(`dsh-ops: ${mode} PTC official-tool hiding for ${name}: ${state}`)
      return true
    }
    // One presentation probe per activation: the predicate runs once per target
    // name inside the same resolve, and every call assembles the prompt.
    const ptcPresentation = new WeakMap<ToolActivationContext, Promise<boolean>>()
    const ptcNow = (activation: ToolActivationContext): Promise<boolean> => {
      let pending = ptcPresentation.get(activation)
      if (!pending) { pending = ptc!.isPtc(activation); ptcPresentation.set(activation, pending) }
      return pending
    }
    /** The PTC hiding verdict shared by the shadow `when` and the guidance assembly below. */
    const hiddenByPtc = (agent: Agent, official: string, counterpart: string): { hidden: boolean; state: string } => {
      const raw = (RAW_OFFICIAL_REPLACEMENTS as Record<string, ApiName>)[official]
      // A counterpart the publisher registered (even before the model selects it)
      // proves a replacement exists; the value of its admission is not consulted,
      // so loading the SDK cannot change this decision.
      const served = ptc!.servable(agent)
      const published = tools.get(counterpart, agent)
      const candidate = served !== undefined && served.has(raw)
      const hidden = candidate && published !== undefined && publicationAdmission(published) !== undefined
      const state = served === undefined ? 'unattached'
        : !candidate ? 'not-servable'
        : hidden ? 'hidden'
        : 'counterpart-missing'
      return { hidden, state }
    }
    // Disposed agents and agents with unlinked host scopes must not receive shadows.
    const inactive = new WeakSet<Agent>()
    // Agents whose counterpart reported an unrecoverable runtime failure keep their official tools (#962).
    const broken = new WeakSet<Agent>()
    const counterparts = new Set(targets.values())
    let stopped = false, mutating = false
    let scheduled: ReturnType<typeof setImmediate> | undefined
    const defer = (): void => {
      if (stopped || scheduled !== undefined) return
      scheduled = setImmediate(() => { scheduled = undefined; reconcile() })
      scheduled.unref?.()
    }
    const lift = (agent: Agent, entry: Entry): void => {
      withToolChange([agent], () => {
        for (const shadow of entry.shadows.values()) shadow.dispose()
        entry.shadows.clear()
      })
    }
    const warn = (agent: Agent, error: unknown): void => {
      ctx.logger.warn(`dsh-ops: ${mode} replacement publication failed for agent ${agent.id}: ${publicationError(error)}`)
    }
    const retire = (agent: Agent): void => {
      inactive.add(agent)
      const entry = entries.get(agent)
      entries.delete(agent)
      try { if (entry) lift(agent, entry) } catch (error) { warn(agent, error) }
    }
    const isCurrent = (agent: Agent, entry: Entry): boolean => !stopped && !inactive.has(agent)
      && entries.get(agent) === entry && publicationOwnerLive(agent.ctx)
    const refresh = (agent: Agent, action: () => void): void => {
      try {
        if (publicationOwnerLive(agent.ctx)) action()
      } catch (error) {
        if (publicationOwnerLive(agent.ctx)) warn(agent, error)
      }
      // A scoped registry write can synchronously dispose its owner.
      if (agent.ctx.fiber.uid === null) retire(agent)
    }
    /** Skip this controller's ancestor shadows and inspect the actual inherited official source. */
    const sourceFor = (agent: Agent, name: string): ToolDefinition | undefined => {
      for (const scope of [...scopeChainOf(agent).slice(1), undefined]) {
        const source = tools.get(name, scope)
        if (!source || sources.has(source)) continue
        // The host has no public predicate reader for foreign conditional tools.
        // Leave an official tool with its own unknown condition untouched.
        return tools.executable(name, scope) === source ? source : undefined
      }
      return undefined
    }
    const apply = (agent: Agent, entry: Entry): void => {
      withToolChange([agent], () => {
        for (const [official, counterpart] of targets) {
          if (!isCurrent(agent, entry)) return
          const source = sourceFor(agent, official)
          const old = entry.shadows.get(official)
          const current = tools.get(official, agent)
          // A same-scope foreign registration cannot be shadowed; never replace its policy.
          const canShadow = current !== undefined && tools.get(official, entry.probe) !== undefined
            && (sources.has(current) || current === source)
          if (old && old.source === source && canShadow
            && (current === old.definition || publicationLeaseState(old.dispose) === 'pending')) continue
          if (old) { old.dispose(); entry.shadows.delete(official) }
          if (!source || !canShadow) continue
          const definition = { ...source }
          sources.add(definition)
          const dispose = publicationRegistration(agent.ctx, () => {
            if (!isCurrent(agent, entry)) return () => {}
            const unregister = agent.ctx.get('tools')!.register(definition, { when: async activation => {
              // Own registrations bypass restrictions in the host view. The empty descendant
              // probe makes our shadow inherited, so even agent-local restrictions still apply.
              if (tools.get(official, entry.probe) !== definition || sourceFor(activation.agent, official) !== source) return false
              if (keepOfficial() || broken.has(activation.agent) || !gate.allows(activation.agent)) return true
              if (ptc && Object.hasOwn(RAW_OFFICIAL_REPLACEMENTS, official)) {
                let ptcNowValue: boolean
                try { ptcNowValue = await ptcNow(activation) }
                catch (error) {
                  // A probe failure carries no replacement proof. Verified host behaviour:
                  // a rejected `when` fails the whole step resolve, so the documented
                  // fail-open contract must be enforced here. Keep the official tool.
                  notePtc(activation.agent, official, 'probe-failed')
                  if (!probeFailures.has(activation.agent)) {
                    probeFailures.add(activation.agent)
                    ctx.logger.warn(`dsh-ops: ${mode} PTC presentation probe failed for ${official}: ${String(error)}`)
                  }
                  return true
                }
                if (ptcNowValue) {
                  // Explicit implementation faults below must surface, not masquerade as a probe failure.
                  const { hidden, state } = hiddenByPtc(activation.agent, official, counterpart)
                  notePtc(activation.agent, official, state)
                  return !hidden
                }
              }
              const replacement = tools.get(counterpart, activation.agent)
              if (!replacement) return true
              const admission = publicationAdmission(replacement)
              return admission ? !await admission(activation) : tools.executable(counterpart, activation.agent) === undefined
            } })
            const probe = tools.get(official, entry.probe)
            if (probe !== undefined && probe !== definition) {
              inactive.add(agent)
              unregister()
              lift(agent, entry)
              entries.delete(agent)
              ctx.logger.warn(`dsh-ops: ${mode} replacement scope linkage unavailable; keeping official tools for this agent`)
            }
            return unregister
          })
          const lease = publicationLeaseState(dispose)
          // Never cache a lease the host never admitted: a cancelled registration
          // (owner unloading) or a failed one would shadow nothing while the
          // controller believed the official tool was replaced.
          if (!isCurrent(agent, entry) || lease === 'cancelled' || lease === 'failed') { dispose(); return }
          entry.shadows.set(official, { source, definition, dispose })
        }
      })
    }
    const reconcileAgent = (agent: Agent, scopes?: readonly object[]): void => {
      if (stopped || mutating || inactive.has(agent)) return
      mutating = true
      try { refresh(agent, () => {
        if (scopes?.length && !scopes.some(scope => scopeChainOf(agent).includes(scope))) return
        if (!gate.allows(agent)) return
        let entry = entries.get(agent)
        if (!entry) {
          const probe = {}
          bindScopeParent(probe, agent)
          entry = { shadows: new Map(), probe }
          entries.set(agent, entry)
        }
        apply(agent, entry)
      }) } finally { mutating = false }
    }
    const reconcile = (scopes?: readonly object[]): void => {
      if (stopped) return
      if (mutating) { defer(); return }
      for (const agent of ctx.get('agents')?.list?.() ?? []) reconcileAgent(agent, scopes)
      for (const [agent, entry] of entries) {
        mutating = true
        try { refresh(agent, () => {
          if (!gate.allows(agent)) { entries.delete(agent); lift(agent, entry) }
        }) } finally { mutating = false }
      }
    }
    ctx.on('agent/created', ({ agent }) => { inactive.delete(agent); reconcileAgent(agent) })
    ctx.on('agent/disposed', ({ agent }) => retire(agent))
    // Fail open (#962): a counterpart that settled with an unrecoverable runtime failure
    // stops hiding the official tool from the agent's next model step. The latch is per
    // agent: the payload is shared, but each agent's own accepted call is the evidence
    // that its shadow is a dead end, and one agent's repair never guesses for another.
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (decision.kind !== 'accept' || !exec.agent || !counterparts.has(exec.name)) return decision
      const value = (result as { value?: unknown } | undefined)?.value
      if (!unrecoverableCounterpartRuntime(value) || broken.has(exec.agent)) return decision
      broken.add(exec.agent)
      ctx.logger.warn(`dsh-ops: ${mode} replacement counterpart ${exec.name} reported an unrecoverable runtime failure; the official tools stay available for this agent`)
      return decision
    })
    // Guidance written for a hidden name is a dead pointer: the host renders its
    // `tool:<name>` sections from registry visibility, and the shadow keeps the name
    // resolvable, so the text survives hiding. The presentation waterfall is the
    // supported scope extension point: it retires such sections for the assembly at
    // hand, and one note names the executable counterpart for a kept official whose
    // section pointed at a hidden name. Restoring the official entry (row disposed,
    // switch off, probe failure, unattached projection) restores the text untouched.
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (stopped || !ptc) return result
      // The publisher's own assembly handler uses the same presentation predicate;
      // sections are evaluated before this waterfall, so this cannot recurse.
      if (!result.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))) return result
      const agent = context.scope as Agent | undefined
      if (!agent || keepOfficial() || !gate.allows(agent)) return result
      const hidden: string[] = []
      for (const [official, counterpart] of targets) {
        if (!Object.hasOwn(RAW_OFFICIAL_REPLACEMENTS, official)) continue
        if (hiddenByPtc(agent, official, counterpart).hidden) hidden.push(official)
      }
      if (hidden.length === 0) return result
      const drop = new Set(hidden.map(name => 'tool:' + name))
      // A kept official's own section may still teach a hidden name (the pinned host
      // grep text cross-references read). The text belongs to its provider and is not
      // rewritten here; the section retires and the note below supplies the alternative.
      const pointer = new RegExp('\\b(?:' + hidden.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b')
      const crossReferences: string[] = []
      for (const [official] of targets) {
        if (hidden.includes(official) || !Object.hasOwn(RAW_OFFICIAL_REPLACEMENTS, official)) continue
        const section = result.sections.find(candidate => candidate.name === 'tool:' + official)
        if (section && section.text && pointer.test(section.text)) { drop.add('tool:' + official); crossReferences.push(official) }
      }
      const note = crossReferences.length === 0 ? undefined
        : `Official ${hidden.join(', ')} ${hidden.length === 1 ? 'is' : 'are'} hidden in this scope; call ${hidden.map(name => targets.get(name)!).join(', ')} instead. ${crossReferences.join(', ')} ${crossReferences.length === 1 ? 'stays' : 'stay'} callable through the tools:sdk declaration.`
      let noted = false
      const sections = result.sections.flatMap(section => {
        if (!drop.has(section.name)) return [section]
        if (noted || note === undefined) return []
        noted = true
        return [{ ...section, name: `dsh-ops:replaced-official:${mode}`, text: note, interpolate: false as const }]
      })
      return { ...result, sections }
    })
    ctx.on('session/event', (_session, event) => { if ((event as { type: string }).type === 'agent-preset/selected') reconcile() })
    if (gate.watch) ctx.effect(() => gate.watch!(() => reconcile()), `dsh-ops: ${mode} replacement observer`)
    // A held step must lose a newly restricted fallback just as it loses an inherited official.
    // The host emits tools/change synchronously after changing its restriction layer.
    onToolChange(ctx, scopes => {
      if (stopped) return
      if (mutating) { defer(); return }
      mutating = true
      try {
        for (const [agent, entry] of entries) refresh(agent, () => {
          if (scopes?.length && !scopes.some(scope => scopeChainOf(agent).includes(scope))) return
          let changed = false
          withToolChange([agent], () => {
            for (const name of targets.keys()) {
              const shadow = entry.shadows.get(name)
              const lease = shadow === undefined ? undefined : publicationLeaseState(shadow.dispose)
              // A deferred registration is not visible yet: wait for its own notification.
              if (lease === 'pending') continue
              // A cancelled or failed lease never became live: drop the cached ghost
              // so the apply below registers again instead of trusting it.
              if (shadow && lease !== 'settled') {
                shadow.dispose()
                entry.shadows.delete(name)
                changed = true
                continue
              }
              const source = sourceFor(agent, name)
              if (!shadow) { if (source && tools.get(name, agent) === source) changed = true; continue }
              if (tools.get(name, entry.probe) !== shadow.definition || source !== shadow.source) {
                shadow.dispose()
                entry.shadows.delete(name)
                changed = true
              }
            }
            if (changed) apply(agent, entry)
          })
        })
      } finally { mutating = false }
      // Other global layer bursts coalesce; scoped changes only visit their own chains.
      if (scopes?.length) reconcile(scopes)
      else defer()
    })
    ctx.effect(() => () => {
      stopped = true
      if (scheduled !== undefined) clearImmediate(scheduled)
      for (const agent of entries.keys()) retire(agent)
    }, `dsh-ops: ${mode} replacements`)
    reconcile()
  })
}
