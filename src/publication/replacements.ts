/** Scoped replacement controller. Missing counterparts always leave official tools available. */
import type { Agent, Context, ToolDefinition } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import { onToolChange, withToolChange } from './changes.js'
import { publicationPending, publicationRegistration } from './reentry.js'
import { publicationAdmission } from './registrar.js'
import { loadScopes } from '../adapter/dsh/host.js'
import type { PublicationGate } from './types.js'

interface Shadow { source: ToolDefinition; definition: ToolDefinition; dispose(): void }
interface Entry { shadows: Map<string, Shadow>; probe: object }

/** Product-independent mapping; publication and replacement remain separate choices. */
export interface ReplacementPublication {
  id: string
  targets: ReadonlyMap<string, string>
  gate: PublicationGate
  keepOfficial(): boolean
}

/** Select the official fallback and its counterpart in the same host resolve. */
export function mountReplacements(root: Context, publication: ReplacementPublication): void {
  const { id: mode, targets, gate, keepOfficial } = publication
  if (targets.size === 0) return
  root.inject(['tools'], async ctx => {
    const tools = ctx.get('tools')
    if (!tools) return
    const { scopeChainOf, bindScopeParent } = await loadScopes()
    const sources = new WeakSet<ToolDefinition>()
    const entries = new Map<Agent, Entry>()
    // Disposed agents and agents with unlinked host scopes must not receive shadows.
    const inactive = new WeakSet<Agent>()
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
          if (inactive.has(agent)) return
          const source = sourceFor(agent, official)
          const old = entry.shadows.get(official)
          const current = tools.get(official, agent)
          // A same-scope foreign registration cannot be shadowed; never replace its policy.
          const canShadow = current !== undefined && tools.get(official, entry.probe) !== undefined
            && (sources.has(current) || current === source)
          if (old && old.source === source && canShadow) continue
          if (old) { old.dispose(); entry.shadows.delete(official) }
          if (!source || !canShadow) continue
          const definition = { ...source }
          sources.add(definition)
          const dispose = publicationRegistration(agent.ctx, () => {
            const unregister = agent.ctx.get('tools')!.register(definition, { when: async activation => {
              // Own registrations bypass restrictions in the host view. The empty descendant
              // probe makes our shadow inherited, so even agent-local restrictions still apply.
              if (tools.get(official, entry.probe) !== definition || sourceFor(activation.agent, official) !== source) return false
              if (keepOfficial() || !gate.allows(activation.agent)) return true
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
          if (inactive.has(agent)) { dispose(); return }
          entry.shadows.set(official, { source, definition, dispose })
        }
      })
    }
    const reconcileAgent = (agent: Agent): void => {
      if (stopped || mutating || inactive.has(agent) || !gate.allows(agent)) return
      let entry = entries.get(agent)
      if (!entry) {
        const probe = {}
        bindScopeParent(probe, agent)
        entry = { shadows: new Map(), probe }
        entries.set(agent, entry)
      }
      mutating = true
      try { apply(agent, entry) }
      catch (error) { ctx.logger.warn(`dsh-ops: ${mode} replacement publication failed: ${String(error)}`) }
      finally { mutating = false }
    }
    const reconcile = (scopes?: readonly object[]): void => {
      if (stopped) return
      if (mutating) { defer(); return }
      for (const agent of ctx.get('agents')?.list?.() ?? []) {
        if (scopes?.length && !scopes.some(scope => scopeChainOf(agent).includes(scope))) continue
        reconcileAgent(agent)
      }
      for (const [agent, entry] of entries) if (!gate.allows(agent)) {
        mutating = true
        try { lift(agent, entry); entries.delete(agent) } finally { mutating = false }
      }
    }
    ctx.on('agent/created', ({ agent }) => { inactive.delete(agent); reconcileAgent(agent) })
    ctx.on('agent/disposed', ({ agent }) => {
      inactive.add(agent)
      const entry = entries.get(agent)
      if (entry) { entries.delete(agent); lift(agent, entry) }
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
        for (const [agent, entry] of entries) {
          if (scopes?.length && !scopes.some(scope => scopeChainOf(agent).includes(scope))) continue
          let changed = false
          withToolChange([agent], () => {
            for (const name of targets.keys()) {
              const shadow = entry.shadows.get(name)
              if (shadow && publicationPending(shadow.dispose)) continue
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
        }
      } finally { mutating = false }
      // Other global layer bursts coalesce; scoped changes only visit their own chains.
      if (scopes?.length) reconcile(scopes)
      else defer()
    })
    ctx.effect(() => () => {
      stopped = true
      if (scheduled !== undefined) clearImmediate(scheduled)
      for (const [agent, entry] of entries) lift(agent, entry)
      entries.clear()
    }, `dsh-ops: ${mode} replacements`)
    reconcile()
  })
}
