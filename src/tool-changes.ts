/** One-shot attribution captured at dispatch entry, before arbitrary event listeners run. */
import type { Context } from '@deepseek-ai/cordis'
interface Attribution { scopes: readonly object[]; consumed: boolean }
let changing: Attribution | undefined
const dispatches = new WeakMap<object, readonly object[] | undefined>()
export function toolChangeScopes(): readonly object[] | undefined { return changing?.consumed ? undefined : changing?.scopes }
export function withToolChange<T>(scopes: readonly object[], action: () => T): T {
  const previous = changing
  changing = { scopes: previous && !previous.consumed ? previous.scopes.length && scopes.length ? [...previous.scopes, ...scopes] : [] : scopes, consumed: false }
  try { return action() } finally { changing = previous }
}
/** Every dispatch has its own args array; nested unwrapped mutations receive no attribution. */
export function onToolChange(ctx: Context, callback: (scopes?: readonly object[]) => void): void {
  ctx.on('internal/dispatch', (_type, name, args) => {
    if (name !== 'tools/change') return
    if (!dispatches.has(args)) {
      const scopes = toolChangeScopes()
      dispatches.set(args, scopes)
      if (changing) changing.consumed = true
    }
    callback(dispatches.get(args))
  }, { prepend: true, global: true })
}
