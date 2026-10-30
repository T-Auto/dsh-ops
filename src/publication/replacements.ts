/** Scoped replacement controller. Missing counterparts always leave official tools available. */
import type { Context } from '../adapter/dsh/types.js'
import type { Agent } from '../adapter/dsh/types.js'
import type { ToolGuard } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import { onToolChange, withToolChange } from './changes.js'
import { visibleNames } from './surface.js'
import { loadScopes } from '../adapter/dsh/host.js'
import type { PublicationGate } from './types.js'

interface Entry { lifts: (() => void)[]; deny: string[] }

/** Product-independent mapping; publication and replacement remain separate choices. */
export interface ReplacementPublication {
  id: string
  targets: ReadonlyMap<string, string>
  gate: PublicationGate
  keepOfficial(): boolean
}

/** Hide only ready replacements. All registrations and guards follow the row lifetime. */
export function mountReplacements(root: Context, publication: ReplacementPublication): void {
  const { id: mode, targets, gate, keepOfficial } = publication
  if (targets.size === 0) return
  root.inject(['tools'], async ctx => {
    const tools = ctx.get('tools')
    if (!tools || typeof tools.restrict !== 'function') return
    // Every Agent's own chain decides whether a registry change can move it.
    // Without it each change would re-plan every live Agent; the host reports one
    // `tools/change` per registration, so a session that registers a handful of
    // tools would otherwise pay O(live sessions) scans per tool.
    let scopeChainOf: (scope: object) => readonly object[] = scope => [scope]
    const entries = new Map<Agent, Entry>()
    let stopped = false, mutating = false
    // A pass that had to be declined (another pass was committing) leaves its
    // reason behind, so a later pass can run exactly that work instead of losing
    // it — or, worse, replacing it with a full scan of every live Agent.
    let pendingAll = true
    const pendingScopes = new Set<object>()
    // Host layer changes arrive unattributed, several per session creation. One
    // coalesced pass serves the whole burst: the states are the same, and the
    // pass reads every live Agent's tool view.
    let scheduled: ReturnType<typeof setImmediate> | undefined
    const defer = (scopes?: readonly object[]): void => {
      if (scopes === undefined || scopes.length === 0) pendingAll = true
      else for (const scope of scopes) pendingScopes.add(scope)
      if (stopped || scheduled !== undefined) return
      scheduled = setImmediate(() => {
        scheduled = undefined
        flush()
      })
      scheduled.unref?.()
    }
    /** Run whatever earlier passes left owed. */
    const flush = (): void => {
      if (pendingAll) { reconcile(); return }
      if (pendingScopes.size === 0) return
      const scopes = [...pendingScopes]
      pendingScopes.clear()
      reconcileScopes(scopes)
    }
    const matches = (agent: Agent): boolean => gate.allows(agent)
    /**
     * Lift one entry's masks.
     *
     * The lift itself dispatches `tools/change`. Publishing it unattributed would
     * send every listener — this controller included — looking for an Agent that
     * moved, so the mask is attributed to the one Agent it belongs to.
     */
    const lift = (agent: Agent, entry: Entry): void => {
      entry.deny = []
      withToolChange([agent], () => {
        for (const dispose of entry.lifts.splice(0)) {
          try { dispose() } catch (error) { ctx.logger.warn(`dsh-ops: ${mode} replacement cleanup failed: ${String(error)}`) }
        }
      })
    }
    // A hidden official tool disappears from the visible view, so "still visible"
    // cannot decide whether to keep hiding: a target stays denied while its OPS
    // counterpart is visible and it is either still visible or already denied by
    // this row. Reading only current visibility would lift and re-apply the mask
    // on every registry change and oscillate forever.
    const plan = (agent: Agent, entry: Entry): string[] => {
      if (keepOfficial()) return []
      const visible = new Set(visibleNames(tools, agent))
      return [...targets]
        .filter(([official, counterpart]) => visible.has(counterpart) && (visible.has(official) || entry.deny.includes(official)))
        .map(([official]) => official)
    }
    /** Bring one entry's mask in line with the surface it currently resolves. */
    const apply = (agent: Agent, entry: Entry): void => {
      const deny = plan(agent, entry)
      if (deny.length === entry.deny.length && deny.every(name => entry.deny.includes(name))) return
      lift(agent, entry)
      if (deny.length === 0) return
      try {
        // Attributed like the lift: this registration is this Agent's own change,
        // not a global one that every other live Agent has to be re-checked for.
        entry.lifts.push(withToolChange([agent], () => agent.ctx.tools.restrict({ deny })))
        entry.deny = deny
      } catch (error) { ctx.logger.warn(`dsh-ops: ${mode} replacement could not hide ${deny.join(', ')}: ${String(error)}`) }
    }
    /**
     * Reconcile every live Agent.
     *
     * This is the expensive pass: each entry's `plan` reads that Agent's tool
     * view, which the host materialises per call. Run it where a surface can
     * actually have moved — a tool change, a preset selection, a Compatibility
     * flip, a row mount — never per created Agent.
     */
    const reconcile = (): void => {
      if (stopped || mutating) { defer(); return }
      mutating = true
      try {
        for (const agent of ctx.get('agents')?.list?.() ?? []) if (matches(agent) && !entries.has(agent)) entries.set(agent, { lifts: [], deny: [] })
        for (const [agent, entry] of entries) {
          if (!matches(agent)) { lift(agent, entry); entries.delete(agent); continue }
          apply(agent, entry)
        }
        pendingAll = false
        // Scopes deferred while this pass ran are not dropped: the coalesced pass
        // `defer` scheduled re-checks exactly those Agents. Clearing them here
        // would lose a change that landed in a scope this pass never iterated.
      } finally { mutating = false }
    }
    /**
     * Reconcile the one Agent a lifecycle event introduced.
     *
     * The full pass above scans every live Agent's tool view, so running it per
     * creation makes starting a session cost O(live sessions) `tools.view()`
     * copies and grows without bound as sessions accumulate. A newly created
     * Agent has no mask to inherit and no sibling's surface can change because
     * it appeared, so only its own entry needs planning here. Every event that
     * can move another Agent's surface (a tool change, a preset selection, a
     * Compatibility flip, a row mount or unload) still runs the full pass.
     */
    const reconcileAgent = (agent: Agent): void => {
      if (stopped || mutating || !matches(agent)) return
      let entry = entries.get(agent)
      if (entry === undefined) { entry = { lifts: [], deny: [] }; entries.set(agent, entry) }
      mutating = true
      try { apply(agent, entry) } finally { mutating = false }
    }
    ctx.on('agent/created', ({ agent }) => { reconcileAgent(agent) })
    /**
     * Reconcile only the Agents a registry change can have reached.
     *
     * The host reports one `tools/change` per registration, so the attributed
     * scope is available. A change inside another session's chain leaves every
     * unrelated Agent's surface exactly as it was, and re-planning them anyway is
     * what turned a session's own tool registrations into O(live sessions) work.
     * An unattributed change (another component's, or a global one) still needs
     * the full pass, since nothing says which Agents it could have reached.
     */
    const reconcileScopes = (scopes?: readonly object[]): void => {
      if (stopped || mutating) { defer(scopes); return }
      if (scopes === undefined || scopes.length === 0) { reconcile(); return }
      mutating = true
      try {
        for (const agent of ctx.get('agents')?.list?.() ?? []) {
          if (!matches(agent)) continue
          const chain = scopeChainOf(agent)
          if (!scopes.some(scope => chain.includes(scope))) continue
          let entry = entries.get(agent)
          if (entry === undefined) { entry = { lifts: [], deny: [] }; entries.set(agent, entry) }
          apply(agent, entry)
        }
        for (const scope of scopes) pendingScopes.delete(scope)
      } finally { mutating = false }
    }
    ctx.on('agent/disposed', ({ agent }) => {
      const entry = entries.get(agent)
      if (!entry) return
      lift(agent, entry)
      entries.delete(agent)
    })
    ctx.on('session/event', (_session, event) => { if ((event as { type: string }).type === 'agent-preset/selected') reconcile() })
    if (gate.watch) ctx.effect(() => gate.watch!(reconcile), `dsh-ops: ${mode} replacement observer`)
    // An unattributed change (a host layer swap) may have reached any Agent, so it
    // owes the full pass — but several arrive together, and each pass reads every
    // live Agent's tool view. Coalescing them into one pass per burst keeps a
    // session's own creation from costing O(live sessions) scans per host event.
    onToolChange(ctx, scopes => { if (scopes === undefined || scopes.length === 0) defer(); else reconcileScopes(scopes) })
    // Reconcile on the way into an assembly so a Compatibility change is visible
    // for the request being assembled, not one request later — but only when a
    // full pass is actually owed. The pass scans every live Agent's tool view, so
    // an unconditional call makes every assembly (and therefore every new
    // session's first request) cost O(live sessions), which is exactly the cost
    // this controller must not add.
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { flush(); return next() })
    const refusal: ToolGuard = exec => {
      if (stopped || keepOfficial()) return undefined
      const agent = exec?.agent
      if (!agent || !matches(agent)) return undefined
      const counterpart = targets.get(String(exec.name ?? ''))
      if (counterpart === undefined) return undefined
      if (!visibleNames(tools, agent).includes(counterpart)) return undefined
      return `dsh-ops ${mode} mode replaced the official tool ${String(exec.name)} with ${counterpart}; call ${counterpart} or ask the operator to enable Compatibility mode.`
    }
    ctx.on('tools/pre-execute', async (exec, next) => {
      const reason = refusal(exec)
      return reason ? { kind: 'deny', reason, info: { name: 'ReplacementError', code: 'MODE_REPLACEMENT' } } : next()
    })
    const guard = (tools as unknown as { guard?: (listener: ToolGuard) => (() => void) | void }).guard
    if (typeof guard === 'function') ctx.effect(() => {
      const dispose = guard.call(tools, refusal)
      return typeof dispose === 'function' ? dispose : () => {}
    }, `dsh-ops: ${mode} replacement guard`)
    ctx.effect(() => () => {
      stopped = true
      if (scheduled !== undefined) clearImmediate(scheduled)
      scheduled = undefined
      for (const [agent, entry] of entries) lift(agent, entry)
      entries.clear()
    }, `dsh-ops: ${mode} replacements`)
    ;({ scopeChainOf } = await loadScopes())
    reconcile()
  })
}
