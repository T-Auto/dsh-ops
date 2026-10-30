/** Explicit preset bindings, isolated by Cordis root and host scope ancestry. */
import type { Context, Agent } from '../adapter/dsh/types.js'
import { loadScopes } from '../adapter/dsh/host.js'
import { presetOf } from './identity.js'
import type { IntegrationConfig } from './options.js'
interface Binding { config: IntegrationConfig; scope?: object; active: boolean }
interface State { bindings: Binding[]; listeners: Set<() => void>; chain(scope: object): object[] }
const states = new WeakMap<object, State>()
export function integrationFor(ctx: Context, agent: Agent): IntegrationConfig | undefined {
  const state = states.get(ctx.root ?? ctx)
  if (!state) return undefined
  const preset = presetOf(ctx, agent)
  for (const scope of [...state.chain(agent), undefined]) {
    const binding = state.bindings.filter(row => row.active && row.scope === scope && row.config.preset === preset).at(-1)
    if (binding) return binding.config
  }
  return undefined
}
export function onIntegrationsChange(ctx: Context, listener: () => void): () => void {
  const state = states.get(ctx.root ?? ctx)
  if (!state) return () => {}
  state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}
export async function joinIntegration(ctx: Context, config: IntegrationConfig) {
  const { scopeOf, scopeChainOf } = await loadScopes()
  const key = ctx.root ?? ctx
  let state = states.get(key)
  if (!state) { state = { bindings: [], listeners: new Set(), chain: scopeChainOf }; states.set(key, state) }
  const owner = state, row: Binding = { config, scope: scopeOf(ctx), active: true }
  if (owner.bindings.some(other => other.active && other.scope === row.scope && other.config.preset === config.preset)) {
    throw new Error(`OPS integration already owns preset ${config.preset} in this scope; dispose the previous instance before reconfiguration`)
  }
  owner.bindings.push(row)
  const notify = () => { for (const listener of [...owner.listeners]) listener(); ctx.emit('dsh-ops/modes') }
  notify()
  return { allows: (agent: Agent) => row.active && integrationFor(ctx, agent) === config,
    watch: (listener: () => void) => onIntegrationsChange(ctx, listener),
    dispose: () => { if (!row.active) return; row.active = false; owner.bindings.splice(owner.bindings.indexOf(row), 1); notify() } }
}
