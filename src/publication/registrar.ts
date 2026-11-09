/** Source-layer publication only; no provider or projection policy lives here. */
import type { Agent, Context, ToolDefinition, ToolRunContext, ToolActivationContext } from '../adapter/dsh/types.js'
import type { Outcome } from '../kernel/outcome.js'
import { loadScopes } from '../adapter/dsh/host.js'
import { publicationReady, publicationRegistration } from './reentry.js'

export interface PublicationGrant {
  readonly consumer: object
  readonly agent: Agent
  readonly token: object
  /** Captured at grant creation; changing entitlement/token requires revoke + grant. */
  readonly entitled: boolean
  dispatch(args: unknown, exec: ToolRunContext): Promise<unknown>
  /** Presentation may only narrow this captured grant; it never chooses dispatch. */
  present?(activation: ToolActivationContext): boolean | Promise<boolean>
  cancel?(): void
}
export interface PublicationLease {
  grant(grant: PublicationGrant): () => void
  ready(): Promise<void>
  dispose(): void
}
const denied = (code: 'PUBLICATION_IDENTITY_MISMATCH' | 'PUBLICATION_GRANT_UNAVAILABLE'): Outcome<never> => ({
  status: 'rejected', error: { code, effectState: 'none', retry: 'never',
    message: code === 'PUBLICATION_IDENTITY_MISMATCH'
      ? 'Publication definition is stale or is not admitted for this agent and tool set.'
      : 'Publication has no eligible grant or has conflicting dispatch grants for this agent.' },
})
const cancelled = (started: boolean): Outcome<never> => ({ status: started ? 'unknown' : 'rejected', error: {
  code: started ? 'RESULT_UNKNOWN' : 'ABORTED', effectState: started ? 'unknown' : 'none', retry: 'never',
  message: started ? 'Invocation cancelled after dispatch; background work may continue.' : 'Invocation cancelled before dispatch.',
  nextAction: started ? 'Inspect effects before taking further action; do not automatically replay.' : 'Do not retry this cancelled invocation.',
} })
type Canonical = Omit<ToolDefinition, 'name' | 'execute'>
interface Entry {
  canonical: Canonical
  owner: Context
  lease(ctx: Context): PublicationLease
}
const roots = new WeakMap<object, Map<object | undefined, Map<string, Entry>>>()
const published = new WeakMap<ToolDefinition, { root: object; current(): boolean }>()
const admissions = new WeakMap<ToolDefinition, (activation: ToolActivationContext) => Promise<boolean>>()
/** Reuse the source registration's exact decision for a conditional official fallback. */
export function publicationAdmission(tool: ToolDefinition): ((activation: ToolActivationContext) => Promise<boolean>) | undefined {
  return admissions.get(tool)
}
/** Exact live source identity; a matching name or output contract grants nothing. */
export function ownsPublication(ctx: Context, tool: ToolDefinition): boolean {
  const owner = published.get(tool)
  return owner?.root === (ctx.root ?? ctx) && owner.current()
}

/**
 * Acquire under a stable plugin-owned scoped context, whose lifetime must cover
 * every consumer. All acquires for a scope/name must share that owner context
 * and canonical object. Only explicit grant membership changes rotate identity.
 *
 * Entitlement and dispatch are snapshotted on grant insertion. There are no live
 * positive predicates: narrowing or transferring authority requires explicit
 * revocation and regrant, rotating the definition outside step preparation.
 * A source discovered in this lifecycle permanently suppresses fallback.
 * Descendant leases share the ancestor source owner and its single definition.
 * Same-layer foreign insertion still fails at the host's duplicate check before
 * tools/change; transparent takeover of that case is deliberately unsupported.
 */
export async function acquire(ctx: Context, scope: object | undefined, name: string, canonical: Canonical): Promise<PublicationLease> {
  const { scopeOf, scopeChainOf } = await loadScopes()
  ctx.fiber.assertActive()
  if (scopeOf(ctx) !== scope) throw new Error('Publication scope must match its registration context')
  const root = ctx.root ?? ctx
  let scopes = roots.get(root)
  if (!scopes) { scopes = new Map(); roots.set(root, scopes) }
  let names = scopes.get(scope)
  if (!names) { names = new Map(); scopes.set(scope, names) }
  const existing = names.get(name)
  if (existing) {
    if (existing.canonical !== canonical) throw new Error('Conflicting canonical publication definition')
    return existing.lease(ctx)
  }
  // Route before creating a child definition: host inheritance must retain all
  // restrictions between the source owner and the consuming agent.
  for (const ancestor of [...scopeChainOf(scope).slice(1), undefined]) {
    if (ancestor === scope) continue
    const source = scopes.get(ancestor)?.get(name)
    if (!source) continue
    if (source.canonical !== canonical) throw new Error('Conflicting canonical publication definition')
    const lease = source.lease(source.owner)
    ctx.effect(() => () => lease.dispose())
    return lease
  }
  const availableTools = ctx.get('tools')
  if (!availableTools) throw new Error('Publication requires the tools service')
  const tools = availableTools
  const grants = new Set<PublicationGrant>()
  const owned = new Set<ToolDefinition>()
  // Public toolSet exposes the admitted definition, not which `when` contribution
  // admitted it. Conservatively bind every eligible same-agent grant as a veto:
  // losing any captured grant cancels; no hidden or later grant can sustain work.
  const active = new Map<AbortController, ReadonlySet<PublicationGrant>>()
  const cancelGrant = (grant: PublicationGrant) => {
    for (const [controller, captured] of active) if (captured.has(grant)) {
      controller.abort(new Error('Publication authorization withdrawn'))
    }
  }
  let unregister: (() => void) | undefined
  let definition: ToolDefinition | undefined
  let retired = false, busy = false, closed = false, leases = 0
  const eligible = (agent: Agent) => [...grants].filter(grant => grant.agent === agent && grant.entitled)
  const attempt = (errors: unknown[], action: () => void) => {
    try { action() } catch (error) { errors.push(error) }
  }
  const finish = (errors: unknown[]) => {
    if (errors.length) throw new AggregateError(errors, 'Publication lifecycle cleanup failed')
  }
  const withdraw = () => {
    const undo = unregister
    unregister = undefined
    definition = undefined
    undo?.()
  }
  const sourceExists = () => {
    // Scan each ancestor independently: a child restriction cannot hide its source.
    for (const ancestor of [...scopeChainOf(scope), undefined]) {
      if (tools.definitions(ancestor).some(candidate => candidate.name === name && !owned.has(candidate))) return true
    }
    return false
  }
  const refresh = (rotate = false) => {
    if (busy || closed) return
    busy = true
    try {
      if (sourceExists()) retired = true
      if (rotate || retired || grants.size === 0) withdraw()
      if (retired || grants.size === 0 || unregister) return
      const next: ToolDefinition = { ...canonical, name, execute: async (args, exec) => {
        if (definition !== next || !exec.agent || !exec.toolSet || tools.executable(name, exec.agent, exec.toolSet) !== next) {
          return denied('PUBLICATION_IDENTITY_MISMATCH')
        }
        const matching = eligible(exec.agent)
        if (!matching.length || matching.some(grant => grant.dispatch !== matching[0].dispatch)) return denied('PUBLICATION_GRANT_UNAVAILABLE')
        const controller = new AbortController()
        const caller = exec.signal
        const abort = () => controller.abort(caller?.reason)
        let onCancel: () => void = () => {}
        const cancellation = new Promise<Outcome<never>>(resolve => {
          onCancel = () => resolve(cancelled(true))
          controller.signal.addEventListener('abort', onCancel, { once: true })
        })
        active.set(controller, new Set(matching))
        if (caller?.aborted) abort()
        else caller?.addEventListener('abort', abort, { once: true })
        try {
          if (controller.signal.aborted) return cancelled(false)
          // Race observes late success/rejection without retaining the active grant or
          // caller listener. Cancellation cannot prove arbitrary provider effects stopped.
          // InvocationLifetime.run awaits foreign work, so it cannot bound this handoff.
          const work = Promise.resolve(matching[0].dispatch(args, { ...exec, signal: controller.signal }))
          return await Promise.race([work, cancellation])
        } finally {
          active.delete(controller)
          caller?.removeEventListener('abort', abort)
          controller.signal.removeEventListener('abort', onCancel)
        }
      } }
      owned.add(next)
      definition = next
      published.set(next, { root, current: () => definition === next && !closed && !retired })
      const decisions = new WeakMap<ToolActivationContext, Promise<boolean>>()
      const admission = (activation: ToolActivationContext): Promise<boolean> => {
        let decision = decisions.get(activation)
        if (!decision) {
          decision = (async () => {
            const matching = eligible(activation.agent)
            if (!matching.length || matching.some(grant => grant.dispatch !== matching[0].dispatch)) return false
            for (const grant of matching) if (!grant.present || await grant.present(activation)) return true
            return false
          })()
          decisions.set(activation, decision)
        }
        return decision
      }
      admissions.set(next, admission)
      unregister = publicationRegistration(ctx, () => tools.register(next, { when: admission }))
      // Registration emits synchronously; recheck after its guarded notification.
      if (sourceExists()) { retired = true; withdraw() }
    } catch (error) {
      const errors: unknown[] = [error]
      attempt(errors, withdraw)
      finish(errors)
    } finally { busy = false }
  }
  const unwatch = ctx.on('tools/change', () => refresh(), { global: true, prepend: true })
  const entry: Entry = { canonical, owner: ctx, lease(owner) {
    if (owner !== ctx) throw new Error('Publication consumers must share a stable owner context')
    ++leases
    let disposed = false
    const local = new Set<() => void>()
    return {
      grant(grant) {
        if (disposed || closed) throw new Error('Publication lease is disposed')
        if ([...grants].some(candidate => candidate.consumer === grant.consumer && candidate.agent === grant.agent)) {
          throw new Error('Duplicate publication consumer grant')
        }
        // Do not retain the caller's mutable object or callback properties.
        const captured = Object.freeze({ ...grant })
        grants.add(captured)
        try { refresh(true) } catch (error) {
          grants.delete(captured)
          const errors: unknown[] = [error]
          attempt(errors, withdraw)
          attempt(errors, () => captured.cancel?.())
          finish(errors)
        }
        let active = true
        const revoke = () => {
          if (!active) return
          active = false
          local.delete(revoke)
          if (!grants.delete(captured)) return
          const errors: unknown[] = []
          attempt(errors, () => cancelGrant(captured))
          attempt(errors, () => refresh(true))
          attempt(errors, () => captured.cancel?.())
          finish(errors)
        }
        local.add(revoke)
        return revoke
      },
      async ready() {
        for (;;) {
          if (disposed || closed) throw new Error('Publication lease is disposed')
          const pending = unregister
          if (!pending) return
          try { await publicationReady(pending) }
          catch (error) { if (pending === unregister) throw error }
          // Another consumer can rotate this shared source while it is queued.
          // Its replacement, rather than the cancelled generation, owns readiness.
          if (pending === unregister) return
        }
      },
      dispose() {
        if (disposed) return
        disposed = true
        const errors: unknown[] = []
        for (const revoke of [...local]) attempt(errors, revoke)
        if (--leases === 0) attempt(errors, close)
        finish(errors)
      },
    }
  } }
  const close = () => {
    if (closed) return
    closed = true
    const remaining = [...grants]
    grants.clear()
    for (const grant of remaining) cancelGrant(grant)
    if (names!.get(name) === entry) names!.delete(name)
    const errors: unknown[] = []
    attempt(errors, unwatch)
    attempt(errors, withdraw)
    for (const grant of remaining) attempt(errors, () => grant.cancel?.())
    finish(errors)
  }
  names.set(name, entry)
  ctx.effect(() => close)
  refresh()
  return entry.lease(ctx)
}
