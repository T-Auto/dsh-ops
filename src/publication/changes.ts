/** One-shot attribution captured at dispatch entry, before arbitrary event listeners run. */
import type { Context } from '../adapter/dsh/types.js'
interface Attribution { scopes: readonly object[]; consumed: boolean }
let changing: Attribution | undefined
const dispatches = new WeakMap<object, readonly object[] | undefined>()
const origins = new WeakMap<object, 'host' | 'local' | undefined>()
export function toolChangeScopes(): readonly object[] | undefined { return changing?.consumed ? undefined : changing?.scopes }
export function withToolChange<T>(scopes: readonly object[], action: () => T): T {
  const previous = changing
  changing = { scopes: previous && !previous.consumed ? previous.scopes.length && scopes.length ? [...previous.scopes, ...scopes] : [] : scopes, consumed: false }
  try { return action() } finally { changing = previous }
}
/**
 * Read the scope the HOST attributed a change to, when it names one.
 *
 * Newer hosts emit `tools/change` with a payload naming the changed scope, which
 * beats this plugin's own `withToolChange` window: the payload survives arbitrary
 * third-party registrations that never call into dsh-ops. A payload that names no
 * scope — an older host's bare emit, or a global-plane change — carries nothing
 * this plugin can narrow with, so the caller falls back to its own attribution
 * rather than treating the change as global.
 * @param args - the dispatch argument array.
 * @returns the single attributed scope, or `undefined` when the host named none.
 */
function hostScope(args: readonly unknown[]): object | undefined {
  if (args.length === 0) return undefined
  const payload = args[0]
  if (payload === null || typeof payload !== 'object') return undefined
  const scope = (payload as { scope?: unknown }).scope
  // A scope is one object identity and a chain walk compares identity, so a
  // malformed payload matches no agent.
  return scope === undefined || scope === null || typeof scope !== 'object' ? undefined : scope
}
/**
 * Every dispatch has its own args array; nested unwrapped mutations receive no
 * attribution.
 *
 * `origin` tells the caller who spoke: `'host'` when the host named a scope in its
 * payload, `'local'` when this package's own {@link withToolChange} window supplied
 * it, and `undefined` when nobody did. The distinction matters because a local
 * declaration is authoritative — the package knows it changed something unrelated to
 * any tracked session — while an unrecognized host scope is host state this row has
 * not admitted yet and must be treated conservatively.
 */
export function onToolChange(
  ctx: Context,
  callback: (scopes?: readonly object[], origin?: 'host' | 'local') => void,
): void {
  ctx.on('internal/dispatch', (_type, name, args) => {
    if (name !== 'tools/change') return
    if (!dispatches.has(args)) {
      const host = hostScope(args)
      const local = host === undefined ? toolChangeScopes() : undefined
      dispatches.set(args, host !== undefined ? [host] : local)
      origins.set(args, host !== undefined ? 'host' : local !== undefined ? 'local' : undefined)
      if (changing) changing.consumed = true
    }
    callback(dispatches.get(args), origins.get(args))
  }, { prepend: true, global: true })
}
