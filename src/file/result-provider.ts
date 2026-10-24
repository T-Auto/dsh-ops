/** Exact visible OPS registrations supply Native projections; no shared registry mutation. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { withToolChange } from '../tool-changes.js'
interface Host { root?: object; emit?(name: 'tools/change'): unknown; get(name: 'tools'): { get(name: string, scope?: unknown): ToolDefinition | undefined } | undefined }
export interface NativeProvider { definition: ToolDefinition; scope: unknown; active: boolean; inheritable: boolean; priority: number }
interface Provider extends NativeProvider { publish(visible: boolean): void }
interface State { providers: Set<Provider>; shadows: Set<NativeProvider>; ptc: Set<unknown>; revisions: WeakMap<object, number>; globalRevision: number; selections: Set<{ scope: unknown; names: ReadonlySet<string> }> }
const owners = new WeakMap<object, State>()
function state(ctx: Host): State {
  const key = ctx.root ?? ctx
  let entry = owners.get(key)
  if (!entry) { entry = { providers: new Set(), shadows: new Set(), ptc: new Set(), revisions: new WeakMap(), globalRevision: 0, selections: new Set() }; owners.set(key, entry) }
  return entry
}
function changed(owner: State, scope: unknown): void {
  if (scope && typeof scope === 'object') owner.revisions.set(scope, (owner.revisions.get(scope) ?? 0) + 1)
  else ++owner.globalRevision
}
/** Source-provider revisions include hidden registrations, unlike the projected tool view. */
export function nativeProviderRevision(ctx: Host, chain: readonly unknown[]): string {
  const owner = state(ctx)
  return [owner.globalRevision, ...chain.map(scope => scope && typeof scope === 'object' ? owner.revisions.get(scope) ?? 0 : 0)].join(':')
}
function refresh(owner: State, scope: unknown): void {
  withToolChange(scope && typeof scope === 'object' ? [scope] : [], () => {
    const providers = [...owner.providers].filter(provider => provider.scope === scope)
    const chosen = new Map<string, Provider>()
    if (!owner.ptc.has(scope)) for (const provider of providers) {
      if (!selectionAllows(owner, scope, provider)) continue
      if ((chosen.get(provider.definition.name)?.priority ?? -Infinity) <= provider.priority) chosen.set(provider.definition.name, provider)
    }
    // Withdraw the previous owned registration before publishing its replacement in the same layer.
    for (const provider of providers) if (chosen.get(provider.definition.name) !== provider) provider.publish(false)
    for (const provider of chosen.values()) provider.publish(true)
  })
}
export async function registerNativeProvider(ctx: Host, definitions: ToolDefinition[], register: (tool: ToolDefinition) => (() => void), options: { inheritable?: boolean; priority?: number } = {}): Promise<() => void> {
  const { scopeOf } = await import('@deepseek-ai/dsh-scope')
  return registerNativeProviderAtScope(ctx, scopeOf(ctx as Context), definitions, register, options)
}
/** Callers that already resolved the public scope API can commit synchronously. */
export function registerNativeProviderAtScope(ctx: Host, scope: unknown, definitions: ToolDefinition[], register: (tool: ToolDefinition) => (() => void), options: { inheritable?: boolean; priority?: number } = {}): () => void {
  const owner = state(ctx)
  const providers = definitions.map(definition => {
    let dispose: (() => void) | undefined
    const provider: Provider = { definition, scope, active: true, inheritable: options.inheritable ?? true, priority: options.priority ?? 0, publish(visible) {
      if (visible && provider.active && !dispose) dispose = register(definition)
      else if (!visible && dispose) { const remove = dispose; dispose = undefined; remove() }
    } }
    owner.providers.add(provider)
    return provider
  })
  changed(owner, scope)
  const stop = () => {
    changed(owner, scope)
    const errors: unknown[] = []
    for (const provider of providers) {
      provider.active = false; owner.providers.delete(provider)
      try { withToolChange(scope && typeof scope === 'object' ? [scope] : [], () => provider.publish(false)) } catch (error) { errors.push(error) }
    }
    try { refresh(owner, scope) } catch (error) { errors.push(error) }
    withToolChange(scope && typeof scope === 'object' ? [scope] : [], () => ctx.emit?.('tools/change'))
    if (errors.length) throw new AggregateError(errors, 'Native provider teardown failed')
  }
  try { refresh(owner, scope) } catch (error) { stop(); throw error }
  withToolChange(scope && typeof scope === 'object' ? [scope] : [], () => ctx.emit?.('tools/change'))
  return stop
}
function selectionAllows(owner: State, scope: unknown, provider: NativeProvider): boolean {
  return ![...owner.selections].some(selection => selection.scope === scope && selection.names.has(provider.definition.name)
    && (provider.scope !== scope || provider.priority < 10))
}
/** Discovery controls only owned advanced Native providers in its exact layer. */
export function claimNativeSelection(ctx: Host, scope: unknown, names: ReadonlySet<string>): () => void {
  const owner = state(ctx), selection = { scope, names }
  owner.selections.add(selection); changed(owner, scope); refresh(owner, scope)
  return () => { owner.selections.delete(selection); changed(owner, scope); refresh(owner, scope) }
}
/** Yield only this plugin's registrations in the exact layer being claimed. */
export function claimPtcSurface(ctx: Host, scope: unknown): () => void {
  const owner = state(ctx)
  owner.ptc.add(scope); refresh(owner, scope)
  return () => { owner.ptc.delete(scope); refresh(owner, scope) }
}
/** Keep an exact origin for Native shadows; ancestor discovery activations are never inheritable. */
export function trackNativeShadow(ctx: Host, scope: unknown, definition: ToolDefinition, source: NativeProvider): () => void {
  const owner = state(ctx), shadow: NativeProvider = { definition, scope, inheritable: source.inheritable, priority: source.priority, get active() { return source.active } }
  owner.shadows.add(shadow)
  return () => { owner.shadows.delete(shadow) }
}
/** Capture before publishing PTC: external restrictions and sibling scopes remain authoritative. */
export function nativeProviders(ctx: Host, scope: unknown, respectSelections = false): NativeProvider[] {
  const tools = ctx.get('tools'), owner = state(ctx)
  return [...owner.providers, ...owner.shadows].filter(provider => provider.active && tools?.get(provider.definition.name, scope) === provider.definition
    && (!respectSelections || selectionAllows(owner, scope, provider)))
}
