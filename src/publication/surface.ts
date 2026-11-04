/** The tool surface a presentation probe reads, shared by both PTC rows. */
import type { Agent } from '../adapter/dsh/types.js'
import type { ToolRuntime } from '../adapter/dsh/types.js'

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

/**
 * The visible entries a scope's view publishes, or `undefined` when this host serves no `view()`.
 *
 * The single place this module reaches past `schemas()` for the private `view()`: both readers
 * go through it, so the duck-typed read and its assertions exist once. Duck-typed rather than
 * `instanceof Map` because a host may serve the view through a subclass or a proxy, and a failed
 * `instanceof` would silently take the expensive branch forever.
 * @param tools - the tool registry.
 * @param scope - the scope to read, or `undefined` for the global layer.
 * @returns the visible entries, or `undefined` when the host does not expose them.
 */
const viewOf = (tools: Pick<ToolRuntime, 'schemas'>, scope?: object): ScopeView['visible'] =>
  (tools as unknown as Viewable).view?.(scope)?.visible

/**
 * The schemas this registry projects for a scope, or `undefined` when it cannot project at all.
 *
 * The fallback both readers share, so the "can this run at all" test is written once: two
 * independent `typeof tools.schemas` tests would drift, and only one of the two paths would
 * notice. `ToolRuntime.schemas()` is declared over `Agent` while the assemble waterfall hands out
 * an opaque scope key, so this is also the one place the module widens it back — the same widening
 * the host's own `schemas()` performs internally.
 * @param tools - the tool registry.
 * @param scope - the scope to project, or `undefined` for the global layer.
 * @returns the projected schemas, or `undefined` when the registry has no projection.
 */
const project = (tools: Pick<ToolRuntime, 'schemas'>, scope?: object) =>
  typeof tools.schemas === 'function' ? tools.schemas(scope as Agent) : undefined

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
 * Escape the two characters a key uses as separators.
 *
 * Entries are joined with NUL and a name is split from its payload with SOH, so a payload that
 * carried either one would forge an entry: a description reading `before\u0000after` makes
 * `surfaceNames` report three tools for two registrations. Backslashes escape first so the
 * mapping stays single-valued, and names are never passed through here — they are what callers
 * read back out.
 *
 * The argument is `unknown` on purpose: `tools.register()` validates the output schema and the
 * timeout but not the type of `description` (`dsh-tools` `index.js`), and `schemaOf` forwards it
 * unchanged, so a host can hand this a value that is not a string. Coercing keeps the key total
 * instead of throwing on a dispatch path.
 * @param text - the payload to make separator-safe.
 * @returns the text with NUL and SOH written as two-character escapes.
 */
const flatten = (text: unknown): string =>
  String(text ?? '').replaceAll('\\', '\\\\').replaceAll('\u0000', '\\0').replaceAll('\u0001', '\\1')

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
 * every visible schema — 34.2 ms for 258 tools at the issue's own surface shape on the
 * published runtime — against ~0.05 ms here, identity included. A key that costs more
 * than the assembly it skips turns the memo into a slowdown. `schemas()` survives only as
 * the fallback for a host whose view is not reachable, where correctness outranks the cost.
 * @param tools - the tool registry.
 * @param scope - the scope to read, or `undefined` for the global layer.
 * @returns per-entry `name\u0001identity` joined by NUL, usable as a memo key.
 */
export const surfaceOf = (tools: Pick<ToolRuntime, 'schemas'>, scope?: object): string => {
  const visible = viewOf(tools, scope)
  if (typeof visible?.entries === 'function') {
    const parts: string[] = []
    for (const [name, definition] of visible.entries()) parts.push(`${name}\u0001${identityOf(definition)}`)
    return parts.join('\u0000')
  }
  // A view that publishes names only still beats a projection: a mode flip moves names even
  // where a same-named swap cannot be seen.
  if (typeof visible?.keys === 'function') return [...visible.keys()].join('\u0000')
  // A host without a reachable view still has to describe the surface. Pairing each name with
  // the description it projects costs one concat rather than a copy — `schemaOf` already
  // detached the parameters, and this description is the original reference — which is enough
  // to see a same-named swap that ships a different description, without a second pass over
  // the tree. Names alone would have missed it; a content fingerprint would have paid for it.
  // The payload is escaped so a description carrying a separator cannot forge an entry.
  // A caller may still hold a registry whose view publishes no `keys()` and which offers no
  // projection at all — a test stand-in, or a host this module was never told about: an empty
  // key beats throwing on a dispatch path.
  const projected = project(tools, scope)
  if (!projected) return ''
  return projected.map(schema => `${schema.name}\u0001${flatten(schema.description)}`).join('\u0000')
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

/**
 * The visible tool names of one scope, without copying any schema.
 *
 * `schemas()` deep-copies every definition's parameters (34.2 ms for 258 tools at the
 * issue's own surface shape on the official host) just to hand back names; the view
 * reports the same names, in the same order, for ~0.043 ms. Name-only readers (prompt
 * sections, restriction planning) pay the copy for nothing. Cost tracks nested schema
 * nodes rather than payload bytes, so both figures are for the shape the issue measured.
 * `undefined` reads the global layer on both paths, and a host without a reachable view
 * falls back to the projection — correctness outranks the cost.
 * @param tools - the tool registry.
 * @param scope - the scope to read, or `undefined` for the global layer.
 * @returns the visible tool names, in view order.
 */
export const visibleNames = (tools: Pick<ToolRuntime, 'schemas'>, scope?: object): string[] => {
  const visible = viewOf(tools, scope)
  // Entries first, exactly as `surfaceOf` reads them: a view that publishes entries publishes the
  // names with them, and answering from `keys()` alone would report "no names" for that host while
  // the key built from the same read carries them — the two readers would describe different
  // surfaces, and the planner would call every selected replacement absent.
  if (typeof visible?.entries === 'function') return [...visible.entries()].map(([name]) => name)
  if (typeof visible?.keys === 'function') return [...visible.keys()]
  // Same reason as `surfaceOf`: a view that publishes no names leaves nothing to project, and
  // a registry with no projection either has nothing to fall back on — naming nothing beats
  // throwing here.
  const projected = project(tools, scope)
  if (!projected) return []
  return projected.map(schema => schema.name)
}
