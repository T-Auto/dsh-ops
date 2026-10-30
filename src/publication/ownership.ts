import type { Context, Agent } from '../adapter/dsh/types.js'
import { loadScopes } from '../adapter/dsh/host.js'
interface Row { scope?: object; changed(): void; allows(agent: Agent): boolean }
interface State { rows: Row[]; agents: Set<Agent>; publishing: number; sequence: number }
const roots = new WeakMap<object, Map<string, State>>()
/** The nearest plugin row owns the SDK; overlapping rows never double-register one layer. */
export async function ownScopes(ctx: Context, family: string, changed: () => void, allows: (agent: Agent) => boolean = () => true) {
  const { scopeOf, scopeChainOf } = await loadScopes()
  const key = ctx.root ?? ctx
  let families = roots.get(key)
  if (!families) { families = new Map(); roots.set(key, families) }
  let state = families.get(family)
  if (!state) { state = { rows: [], agents: new Set(), publishing: 0, sequence: 0 }; families.set(family, state) }
  const shared = state, row: Row = { scope: scopeOf(ctx), changed, allows }
  shared.rows.push(row)
  const ordinal = ++shared.sequence
  const notify = () => {
    ++shared.publishing
    try { for (const owner of shared.rows) owner.changed() } finally { --shared.publishing }
  }
  const owns = (agent: Agent): boolean => {
    for (const scope of [...scopeChainOf(agent), undefined]) {
      const matching = shared.rows.filter(candidate => candidate.scope === scope && candidate.allows(agent))
      // Last mounted row wins only within the same explicit scope; unload restores the previous row.
      if (matching.length) return matching.at(-1) === row
    }
    return false
  }
  // Call refresh after the caller has installed its ownership handle.
  return { owns, sectionName: (base: string) => ordinal === 1 ? base : base + ':' + ordinal, refresh: notify, publishing: () => shared.publishing > 0,
    begin: () => { ++shared.publishing }, end: () => { --shared.publishing },
    changedBelow: () => {
      for (const owner of shared.rows) if (owner !== row && owner.scope && owner.scope !== row.scope
        && (!row.scope || scopeChainOf(owner.scope).includes(row.scope))) owner.changed()
    }, agents: () => [...shared.agents],
    track: (agent: Agent) => { shared.agents.add(agent) },
    forget: (agent: Agent) => { shared.agents.delete(agent) },
    dispose: () => { shared.rows.splice(shared.rows.indexOf(row), 1); notify(); if (!shared.rows.length) families.delete(family) },
  }
}
