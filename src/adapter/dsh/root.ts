/**
 * The application root of a plugin context, used as the key for per-host state.
 *
 * Cordis 4.1 exposes it as the plain `ctx.root` property. Cordis 4.2 removed the
 * property and guards unknown reads with "cannot get property without inject",
 * keeping only the `Symbol.for('cordis.root')` key. The symbol is read first and
 * the legacy property second, so one build serves both hosts; a context with
 * neither is its own root.
 */
const ROOT = Symbol.for('cordis.root')

export function rootOf<T extends object>(ctx: T): T {
  const modern = (ctx as Record<symbol, unknown>)[ROOT]
  if (typeof modern === 'object' && modern !== null) return modern as T
  try {
    const legacy = (ctx as { root?: unknown }).root
    if (typeof legacy === 'object' && legacy !== null) return legacy as T
  } catch { /* Cordis 4.2 refuses undeclared properties; the context is then its own root. */ }
  return ctx
}
