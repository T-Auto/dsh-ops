/** Per-tool replacement through the host's scoped restriction and guard APIs.
 * Only explicit reviewed selections are masked. Missing selected counterparts
 * block the affected scope and restore its official tools until readiness returns.
 */
import type { Context } from './adapter/dsh/types.js'
import type { ToolGuard } from './adapter/dsh/types.js'
import type { OfficialReplacement } from './official-tool-catalog.js'
import { nativeProviders } from './publication/providers.js'
import { isPresentationProbe } from './publication/presentation.js'
import { resolveHidingConfig } from './config.js'
export { resolveHidingConfig } from './config.js'
import { OFFICIAL_REPLACEMENTS } from './official-tool-catalog.js'
import { surfaceOf, visibleNames } from './publication/surface.js'
import { safeDispose } from './teardown.js'
import { retired as retiredLegacyRow } from './settings/legacy.js'
import { publicationRegistration, publicationPending } from './publication/reentry.js'
import { ownsPublication } from './publication/registrar.js'

interface Entry { context: Context; lifts: (() => void)[]; cleanupError?: string; error?: string; reported?: string
  /** Set from the assembled surface: this scope presents one program entry, so its
   * selected official names are not native duplicates and must stay dispatchable. */
  collapsed?: boolean }
interface Plan { deny: string[]; failure?: string }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const name = 'dsh-ops-hide-official'
/** The host's reserved PTC transport: the only tool a collapsed scope may call. */
const RUN_CODE = 'run_code'
const blocked = (detail: string): string => `READINESS_BLOCKED (EXECUTOR_UNAVAILABLE): dsh-ops hide-official cannot verify selected replacements: ${detail}. Restore the selected OPS tools, remove the selection from replaceTools, or disable the dsh-ops-hide-official row.`

export function apply(root: Context, raw?: unknown): void {
  if (retiredLegacyRow(root, 'hide-official')) return
  const { replaceTools }: { replaceTools: OfficialReplacement[] } = resolveHidingConfig(raw)
  // Empty and legacy-only rows install no hooks and cannot block a session.
  if (!replaceTools.length) return
  const selected = new Set<string>(replaceTools)
  const hideable = (tool: string): boolean => selected.has(tool)
  root.inject(['tools', 'systemPrompt'], ctx => {
    const entries = new Map<object, Entry>()
    let stopped = false, mutating = false
    let lastSurface: string | undefined
    const tools = ctx.get('tools')!
    const apiError = (['schemas', 'get', 'restrict', 'guard'] as const).filter(api => typeof tools[api] !== 'function')
    const fail = (message: string): void => ctx.logger?.error?.(message)
    const clear = (entry: Entry): boolean => {
      const pending = entry.lifts.splice(0)
      const failed = []
      for (const lift of pending) {
        if (!safeDispose(lift, error => fail(`dsh-ops: restriction cleanup failed: ${message(error)}`), 'official-tool restriction')) failed.push(lift)
      }
      entry.lifts.push(...failed)
      entry.cleanupError = failed.length > 0 ? 'host restriction cleanup failed; retrying before proceeding' : undefined
      return failed.length === 0
    }
    // Readiness examines the unmasked scope. It never accepts ops_<same-name>
    // as an equivalence claim, nor uses run_code as a native replacement.
    const readiness = (agent: object, toolSet?: import('./adapter/dsh/types.js').ResolvedToolSet): boolean[] => {
      const owned = new Set(typeof tools.get === 'function' ? nativeProviders(ctx, agent).map(provider => provider.definition) : [])
      return replaceTools.map(tool => {
        const counterpart = OFFICIAL_REPLACEMENTS[tool]
        const visible = toolSet ? tools.executable(counterpart, agent, toolSet)
          : typeof tools.get === 'function' ? tools.get(counterpart, agent) : undefined
        return visible !== undefined && (owned.has(visible) || ownsPublication(ctx, visible))
      })
    }
    const maskable = (agent: object): Set<string> => {
      const owned = new Set(nativeProviders(ctx, agent).map(provider => provider.definition))
      return new Set(replaceTools.filter(tool => {
        const counterpart = tools.executable(OFFICIAL_REPLACEMENTS[tool], agent)
        return counterpart !== undefined && owned.has(counterpart)
      }))
    }
    const prepare = (agent: object, entry: Entry): Plan => {
      // No capability guard here: `visibleNames` already answers for a registry with no
      // projection, and gating it on `schemas` a second time reported every selected replacement
      // as absent on a host that serves a view without one — the plan then hid nothing.
      const names = visibleNames(tools, agent)
      // A conditional counterpart cannot justify an unconditional restriction.
      // Its official schema stays visible; the captured step decides dispatch.
      const masks = maskable(agent)
      const hidden = names.filter(name => masks.has(name))
      const ready = readiness(agent)
      const missing = replaceTools.flatMap((tool, index) => {
        const replacement = OFFICIAL_REPLACEMENTS[tool]
        return names.includes(replacement) && ready[index]
          ? [] : [`${tool} -> ${replacement}`]
      })
      const diagnostics = [
        ...apiError.length ? [`missing host API: ${apiError.join(', ')}`] : [],
        ...entry.cleanupError ? [entry.cleanupError] : [],
        ...missing.length ? [`missing OPS surface: ${[...new Set(missing)].join(', ')}`] : [],
      ]
      const failure = diagnostics.length ? blocked(diagnostics.join('; ')) : undefined
      // A failed plan hides nothing: no partial mask over an unready scope.
      return { deny: failure ? [] : hidden, failure }
    }
    // Compare public surfaces before touching masks. Other components also
    // reconcile tools/change; emitting a fresh restriction for an unchanged
    // surface would otherwise cause a publication/withdrawal feedback loop.
    // Names alone cannot detect a foreign tool shadowing an OPS definition, so each entry is
    // paired with the identity of the definition it currently resolves to — one view read,
    // no schema projection: the guard runs before every dispatch and this waterfall twice
    // per prompt, so a key that deep-copied the catalogue would cost more than it saves.
    const snapshot = (): string => JSON.stringify([surfaceOf(tools), ...[...entries.keys()].map(agent => [surfaceOf(tools, agent), readiness(agent)])])
    const reconcile = () => {
      if (stopped || mutating) return
      // A deferred restriction emits tools/change before its returned undo can
      // be stored. Do not revoke that in-flight mask from its own notification.
      if ([...entries.values()].some(entry => entry.lifts.some(publicationPending))) return
      try { if (snapshot() === lastSurface) return } catch { /* reported by per-agent verification below */ }
      mutating = true
      try {
        // Clear all masks first: inherited restrictions must not conceal a
        // parent's missing capability while checking a child.
        for (const entry of entries.values()) clear(entry)
        const plans: [object, Entry, Plan][] = []
        for (const [agent, entry] of entries) {
          let plan: Plan
          try { plan = prepare(agent, entry) }
          catch (error) { plan = { deny: [], failure: blocked(message(error)) } }
          plans.push([agent, entry, plan])
        }
        // Each scope owns its readiness and mask. A failed child is blocked at
        // assembly/dispatch; it does not make a healthy ancestor or root fail.
        for (const [agent, entry, plan] of plans) {
          if (plan.failure) { clear(entry); entry.error = plan.failure; continue }
          try {
            // One restriction per complete plan; never partially hide when a
            // single required replacement is absent.
            if (plan.deny.length) entry.lifts.push(publicationRegistration(entry.context, () => entry.context.tools.restrict({ deny: plan.deny })))
            if (entry.lifts.some(publicationPending)) continue
            const masks = maskable(agent)
            const leaked = visibleNames(tools, agent).filter(name => masks.has(name))
            if (leaked.length) throw new Error(`host scoped restriction cannot hide own-scope tools: ${leaked.join(', ')}`)
            entry.error = undefined
          } catch (error) { clear(entry); entry.error = blocked(message(error)) }
        }
        for (const entry of entries.values()) {
          if (entry.error !== entry.reported) {
            if (entry.error) fail(entry.error)
            entry.reported = entry.error
          }
        }
        try { lastSurface = snapshot() } catch { lastSurface = undefined }
      } finally { mutating = false }
    }
    const block = (agent: object, detail: string): Error => {
      const message = blocked(detail)
      // Tool providers run before this waterfall, so keep the verified mask in
      // place for the next request's schema collection. Only this assembly
      // fails; invalidate readiness so transient provider errors are retryable.
      const entry = entries.get(agent)
      if (entry) entry.error = message
      lastSurface = undefined
      return new Error(message)
    }
    const attach = (agent: object): void => {
      if (entries.has(agent) || !('ctx' in agent) || !agent.ctx || typeof agent.ctx !== 'object') return
      entries.set(agent, { context: agent.ctx as Context, lifts: [], error: blocked('surface verification pending') })
      reconcile()
    }
    const refusal: ToolGuard = exec => {
      if (stopped) return blocked('component disposed')
      if (!exec?.agent?.ctx) return blocked('calling agent scope unavailable')
      attach(exec.agent)
      reconcile() // Authority is live, not a startup snapshot.
      const entry = entries.get(exec.agent)
      // A collapsed (run_code) scope can never prove native readiness, so its error must
      // not refuse the transport itself. The selected official names stay refused: the
      // promise is that they never execute, in any presentation.
      const transport = entry?.collapsed === true && exec.name === RUN_CODE
      if (entry?.error && !transport) return entry.error
      if (!transport && !readiness(exec.agent, exec.toolSet).every(Boolean)) return blocked('selected OPS counterparts are not admitted for the captured step')
      return hideable(exec.name)
        ? blocked(`official tool ${exec.name} is selected for replacement`) : undefined
    }
    ctx.on('tools/pre-execute', async (exec, next) => {
      const reason = refusal(exec)
      return reason ? { kind: 'deny', reason, info: { name: 'ReadinessError', code: 'READINESS_BLOCKED' } } : next()
    })
    if (typeof tools.guard === 'function') ctx.effect(() => ctx.tools.guard(refusal), 'dsh-ops: replacement surface guard')
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      // Only this package's exact, short-lived inspection context may pass before
      // discovery publishes a selected replacement. Provider requests stay guarded.
      if (!context.scope || isPresentationProbe(context)) return next()
      attach(context.scope)
      reconcile()
      let result
      try { result = await next() }
      catch (error) { throw block(context.scope, `agent prompt assembly could not be verified: ${message(error)}`) }
      reconcile()
      // DSH 0.2.2 keeps tools provider-owned; this waterfall contains text only.
      const collapsed = result.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
      const entry = entries.get(context.scope)
      if (entry) entry.collapsed = collapsed
      if (entry?.error) {
        if (!collapsed) throw new Error(entry.error)
        clear(entry); entry.error = undefined
      }
      if (!collapsed && !readiness(context.scope, context.toolSet).every(Boolean)) {
        throw block(context.scope, 'selected OPS counterparts are not admitted for the captured step')
      }
      // Restrictions affect future admission; inspect this step's captured set.
      const masks = maskable(context.scope)
      const leaked = collapsed ? [] : tools.definitions(context.scope, context.toolSet).map(tool => tool.name).filter(name => masks.has(name))
      if (leaked.length) throw block(context.scope, `assembled surface still contains hidden official tools: ${leaked.join(', ')}`)
      return result
    })
    ctx.on('agent/created', ({ agent }) => { attach(agent); return undefined })
    ctx.on('agent/disposed', ({ agent }) => {
      const entry = entries.get(agent)
      if (!entry) return
      mutating = true
      try { clear(entry); entries.delete(agent) } finally { mutating = false }
      reconcile()
    })
    ctx.on('tools/change', reconcile)
    ctx.effect(() => () => {
      stopped = true; mutating = true
      for (const entry of entries.values()) clear(entry)
      entries.clear()
    }, 'dsh-ops: selected official-tool restrictions')
    for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent)
    if (apiError.length) fail(blocked(`missing host API: ${apiError.join(', ')}`))
  })
}
