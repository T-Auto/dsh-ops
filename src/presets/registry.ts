/** Built-in consumer state; Compatibility is retired by the single-row model. */
import type { Context } from '../adapter/dsh/types.js'
import type { ModeConfig } from './config.js'
import type { ModeId } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A built-in consumer changed its enabled state or configuration. */
    'dsh-ops/modes'(): void
  }
}

interface State {
  modes: Map<ModeId, ModeConfig>
}

const states = new WeakMap<object, State>()

/** The shared state of one Cordis root. */
function stateOf(ctx: Context): State {
  const key: object = ctx.root ?? ctx
  let state = states.get(key)
  if (state === undefined) { state = { modes: new Map() }; states.set(key, state) }
  return state
}

/** Emit a built-in consumer change. */
function notify(ctx: Context): void {
  try { ctx.emit('dsh-ops/modes') } catch { /* an observer's failure is reported by that observer */ }
}

/**
 * Register one enabled mode row.
 * @param ctx - the row's context.
 * @param id - the mode the row enables.
 * @param config - the row's resolved configuration.
 * @returns the disposer that unregisters the mode.
 */
export function joinMode(ctx: Context, id: ModeId, config: ModeConfig): () => void {
  const state = stateOf(ctx)
  state.modes.set(id, config)
  notify(ctx)
  return () => {
    if (state.modes.get(id) !== config) return
    state.modes.delete(id)
    notify(ctx)
  }
}

/**
 * The enabled modes and their configuration.
 * @param ctx - any context on the root.
 * @returns a snapshot keyed by mode id.
 */
export function enabledModes(ctx: Context): ReadonlyMap<ModeId, ModeConfig> {
  return new Map(stateOf(ctx).modes)
}

/**
 * Observe built-in consumer changes.
 * @param ctx - the row's context; the listener is disposed with it.
 * @param listener - the callback to run after a change.
 * @returns the unsubscribe function.
 */
export function onModesChange(ctx: Context, listener: () => void): () => void {
  return ctx.on('dsh-ops/modes', listener)
}
