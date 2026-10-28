/** Scoped replacement controller. Missing counterparts always leave official tools available. */
import type { Context } from '../adapter/dsh/types.js'
import type { Agent } from '../adapter/dsh/types.js'
import type { ToolGuard } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import { onToolChange } from '../tool-changes.js'
import { visibleNames } from '../surface.js'
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
  root.inject(['tools'], ctx => {
    const tools = ctx.get('tools')
    if (!tools || typeof tools.restrict !== 'function') return
    const entries = new Map<Agent, Entry>()
    let stopped = false, mutating = false
    const matches = (agent: Agent): boolean => gate.allows(agent)
    const lift = (entry: Entry): void => {
      entry.deny = []
      for (const dispose of entry.lifts.splice(0)) {
        try { dispose() } catch (error) { ctx.logger.warn(`dsh-ops: ${mode} replacement cleanup failed: ${String(error)}`) }
      }
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
    const reconcile = (): void => {
      if (stopped || mutating) return
      mutating = true
      try {
        for (const agent of ctx.get('agents')?.list?.() ?? []) if (matches(agent) && !entries.has(agent)) entries.set(agent, { lifts: [], deny: [] })
        for (const [agent, entry] of entries) {
          if (!matches(agent)) { lift(entry); entries.delete(agent); continue }
          const deny = plan(agent, entry)
          if (deny.length === entry.deny.length && deny.every(name => entry.deny.includes(name))) continue
          lift(entry)
          if (deny.length === 0) continue
          try {
            entry.lifts.push(agent.ctx.tools.restrict({ deny }))
            entry.deny = deny
          } catch (error) { ctx.logger.warn(`dsh-ops: ${mode} replacement could not hide ${deny.join(', ')}: ${String(error)}`) }
        }
      } finally { mutating = false }
    }
    ctx.on('agent/created', ({ agent }) => { if (matches(agent)) { entries.set(agent, { lifts: [], deny: [] }); reconcile() } })
    ctx.on('agent/disposed', ({ agent }) => {
      const entry = entries.get(agent)
      if (!entry) return
      lift(entry)
      entries.delete(agent)
    })
    ctx.on('session/event', (_session, event) => { if ((event as { type: string }).type === 'agent-preset/selected') reconcile() })
    if (gate.watch) ctx.effect(() => gate.watch!(reconcile), `dsh-ops: ${mode} replacement observer`)
    onToolChange(ctx, () => reconcile())
    // Reconcile on the way into an assembly so a Compatibility change is visible
    // for the request being assembled, not one request later.
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { reconcile(); return next() })
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
      for (const entry of entries.values()) lift(entry)
      entries.clear()
    }, `dsh-ops: ${mode} replacements`)
    reconcile()
  })
}
