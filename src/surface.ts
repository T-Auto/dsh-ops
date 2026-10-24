/** The tool surface a presentation probe reads, shared by both PTC rows. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type ToolRuntime from '@deepseek-ai/dsh-tools'

/**
 * The part of a scope view this module reads: the names and definitions a scope can see.
 *
 * `ToolRuntime.view` is declared `private`, yet it is `schemas()`'s own implementation —
 * `schemas()` is `[...this.view(scope).visible.values()].map(schemaOf)` — so its entries
 * ARE the visible definitions, before any `snapshotJsonValue` copy. A structural local
 * type keeps that read honest: it names only what is used, and the `schemas()` branch
 * below holds if a host stops serving it.
 */
interface ScopeView {
  visible?: {
    entries?: () => Iterable<[string, unknown]>
    keys?: () => Iterable<string>
  }
}
type Viewable = { view?: (scope?: object) => ScopeView | undefined }

/** Stable per-definition identities, so a swapped definition cannot reuse its predecessor's. */
const identities = new WeakMap<object, number>()
let sequence = 0

/**
 * The identity of one visible definition.
 *
 * Only object definitions can carry identity; anything else (an absent entry) folds to 0
 * so the key stays a plain string.
 * @param definition - the value a scope view holds under a tool name.
 * @returns a process-unique index for that exact object.
 */
const identityOf = (definition: unknown): number => {
  if (definition === null || typeof definition !== 'object') return 0
  const known = identities.get(definition as object)
  if (known !== undefined) return known
  const next = ++sequence
  identities.set(definition as object, next)
  return next
}

/**
 * The surface of one agent, the memo key a presentation probe is cached under.
 *
 * Two things move a `ptcOnly`/`native` verdict, and the key must see both:
 *
 * - **which names are visible.** `run_code` exists only outside `native`, so a mode flip
 *   adds or drops it.
 * - **which definition each name resolves to.** A same-named registration shadows the one
 *   it replaces, and the publish that follows captures the definition inside its shadow's
 *   closure. A names-only key returns a stale hit there and publishes nothing, leaving the
 *   cached verdict standing for a surface it never described.
 *
 * Both are read from ONE `view()` call. `view()` hands back the definitions themselves, so
 * identity costs a `WeakMap` lookup against an object already in hand — measurably cheaper
 * than pairing `schemas()` with a `tools.get()` per name, because that `get()` rebuilds the
 * whole scope view and turns the key into O(names²).
 *
 * The cost is what makes this safe to memoize at all: reading through `schemas()` deep-copies
 * every visible schema — 24.1 ms for 258 tools on the pinned host, 30.9 ms once the per-name
 * `get()` is added — against 0.073 ms here, both including identity. A key that costs more
 * than the assembly it skips turns the memo into a slowdown. `schemas()` survives only as
 * the fallback for a host whose view is not reachable, where correctness outranks the cost.
 * @param tools - the tool registry.
 * @param agent - the scope to read.
 * @returns per-entry `name\u0001identity` joined by NUL, usable as a memo key.
 */
export const surfaceOf = (tools: Pick<ToolRuntime, 'schemas'>, agent: Agent): string => {
  // Duck-typed rather than `instanceof Map`: a host may serve the view through a subclass
  // or a proxy, and a failed instanceof would silently take the expensive branch forever.
  const visible = (tools as unknown as Viewable).view?.(agent)?.visible
  if (typeof visible?.entries === 'function') {
    const parts: string[] = []
    for (const [name, definition] of visible.entries()) parts.push(`${name}\u0001${identityOf(definition)}`)
    return parts.join('\u0000')
  }
  // A view that publishes names only still beats a projection: a mode flip moves names even
  // where a same-named swap cannot be seen.
  if (typeof visible?.keys === 'function') return [...visible.keys()].join('\u0000')
  return tools.schemas(agent).map(schema => schema.name).join('\u0000')
}

/**
 * The tool names a surface names, in view order.
 *
 * Callers that only need the name set (diagnostics, assertions) read it back out of a key
 * rather than paying for a second `view()`.
 * @param surface - a key produced by {@link surfaceOf}.
 * @returns the names, in the order the view reported them.
 */
export const surfaceNames = (surface: string): string[] =>
  surface === '' ? [] : surface.split('\u0000').map(entry => entry.split('\u0001')[0]!)
