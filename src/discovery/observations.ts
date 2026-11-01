/** Read-only discovery observations; diagnostics consume this state, never own its lifecycle. */
import type { Context, Agent } from '../adapter/dsh/types.js'
const observers = new WeakMap<object, Map<Agent, { pending: ReadonlySet<string> }>>()
export function observeSelection(ctx: Context, agent: Agent, pending: ReadonlySet<string>): () => void {
  const key = ctx.root ?? ctx
  let state = observers.get(key)
  if (!state) { state = new Map(); observers.set(key, state) }
  const row = { pending }; state.set(agent, row)
  return () => { if (state.get(agent) === row) state.delete(agent) }
}
export function pendingSelection(ctx: Context, agent: Agent): ReadonlySet<string> | undefined {
  return observers.get(ctx.root ?? ctx)?.get(agent)?.pending
}
