/** Read-only projection of live DSH tool events; never executes or retains tool input/output. */
import { FILE_TOOLS, IN_PROCESS_TOOLS, publicToolName } from '../policy.js'
import { PTC_TOOLS } from '../projections/ptc/contract.js'
import type { BusinessOutcome, ResultDetails } from './result.js'
import { record, resultDetails } from './result.js'

const OWN_TOOLS = new Set([...FILE_TOOLS, ...IN_PROCESS_TOOLS, ...PTC_TOOLS].map(publicToolName))
export interface ActivityConfig { maxSessions: number; maxActive: number; recentLimit: number }
export type ActiveCall = Readonly<{ id: string; name: string; startedAt: number; status: 'running' }>
export type SettledCall = Readonly<Omit<ActiveCall, 'status'> & ResultDetails & { status: 'error' | 'returned'; durationMs: number }>
export type ActivityRow = ActiveCall | SettledCall
export interface ActivitySnapshot {
  readonly business: Readonly<Record<BusinessOutcome, number>>
  readonly total: number; readonly running: number; readonly returned: number; readonly errors: number
  readonly limited: boolean; readonly since: number | undefined
  readonly active: readonly ActiveCall[]; readonly recent: readonly SettledCall[]
}
export interface ActivityStore {
  observe(sessionId: unknown, event: unknown): boolean
  snapshot(sessionId?: string): ActivitySnapshot
  subscribe(listener: () => void): () => void
  dispose(): void
}
interface ActivityState {
  seq: number; since: number; total: number; returned: number; errors: number; limited: boolean
  active: Map<string, ActiveCall>; recent: SettledCall[]; snapshot: ActivitySnapshot
  business: Record<BusinessOutcome, number>
}
export const ACTIVITY_DEFAULTS = Object.freeze({ maxSessions: 32, maxActive: 128, recentLimit: 8 })
const emptyBusiness = (): Record<BusinessOutcome, number> => ({ completed: 0, planned: 0, rejected: 0, error: 0, partial: 0, unknown: 0, unconfirmed: 0 })
const EMPTY: ActivitySnapshot = Object.freeze({ business: Object.freeze(emptyBusiness()), total: 0, running: 0, returned: 0, errors: 0, limited: false,
  since: undefined, active: Object.freeze([]), recent: Object.freeze([]) })

function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1024 }
function validTime(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }

/** Native and PTC results share transport facts, but a normal return is NOT business success. */
function transportFailed(data: Record<string, unknown>, nested: boolean): boolean {
  if (data.error !== undefined) return true
  if (nested) return data.isError === true
  return record(data.message) && data.message.isError === true
}

/** Validate retention settings shared by the optional observer and its bundle row. */
export function resolveActivityConfig(options: unknown = {}): Readonly<ActivityConfig> {
  if (!record(options)) throw new Error('TUI activity config must be an object')
  for (const key of Object.keys(options)) if (!Object.hasOwn(ACTIVITY_DEFAULTS, key)) throw new Error('Unknown TUI activity config key: ' + key)
  const config: ActivityConfig = { ...ACTIVITY_DEFAULTS }
  for (const [key, ceiling] of [['maxSessions', 256], ['maxActive', 1024], ['recentLimit', 64]] as const) {
    const value = Object.hasOwn(options, key) ? options[key] : config[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new Error(key + ' must be an integer from 1 to ' + ceiling)
    }
    config[key] = value
  }
  return Object.freeze(config)
}

/**
 * Bounded, instance-owned activity for events observed after mounting, not session-history replay.
 * At capacity, new active calls are omitted and limited is set; existing calls still settle.
 * Session LRU eviction drops statistics only, never running work. Call IDs are opaque.
 */
export function createActivityStore(options: Partial<ActivityConfig> = {}): ActivityStore {
  const config = resolveActivityConfig(options)
  const sessions = new Map<string, ActivityState>(), listeners = new Set<() => void>()
  let disposed = false

  function publish(state: ActivityState): void {
    state.snapshot = Object.freeze({ business: Object.freeze({ ...state.business }), total: state.total, running: state.active.size,
      returned: state.returned, errors: state.errors, limited: state.limited, since: state.since,
      active: Object.freeze([...state.active.values()]), recent: Object.freeze([...state.recent]) })
    for (const listener of [...listeners]) {
      try { listener() } catch { /* Observers cannot affect a committed tool result or one another. */ }
    }
  }

  function observe(sessionId: unknown, event: unknown): boolean {
    if (disposed || !validId(sessionId) || !record(event) || typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0 || !validTime(event.time)) return false
    const data = event.data
    if (!record(data)) return false
    if (typeof event.type !== 'string') return false
    const start = event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start'
    const settle = event.type === 'tool/result' || event.type === 'tool/ptc-dispatch'
    if (!start && !settle) return false
    const nested = event.type.startsWith('tool/ptc-')
    const message = record(data.message) ? data.message : undefined
    const source = record(message?.source) ? message.source : undefined
    const id = nested ? data.subCallId : start ? data.callId : source?.callId
    const ownName = typeof data.name === 'string' && OWN_TOOLS.has(data.name)
    if (!validId(id)) return false
    let state = sessions.get(sessionId)
    // Only tracked native results belong to us; do not allocate state for arbitrary tools.
    if ((start || nested) && !ownName) return false
    if (!start && !state?.active.has(id)) {
      if (state && event.seq > state.seq && (nested && ownName)) {
        state.seq = event.seq; state.limited = true; publish(state)
      }
      return false
    }
    if (!state) {
      if (sessions.size >= config.maxSessions) {
        const oldest = sessions.keys().next().value
        if (oldest !== undefined) sessions.delete(oldest)
      }
      state = { seq: -1, since: event.time, total: 0, returned: 0, errors: 0, limited: false,
        active: new Map(), recent: [], snapshot: EMPTY, business: emptyBusiness() }
      sessions.set(sessionId, state)
    }
    if (event.seq <= state.seq) return false
    state.seq = event.seq
    sessions.delete(sessionId); sessions.set(sessionId, state)
    if (start) {
      if (typeof data.name !== 'string') return false
      if (state.active.has(id)) return false
      if (state.active.size >= config.maxActive) { state.limited = true; publish(state); return false }
      state.active.set(id, Object.freeze({ id, name: data.name, startedAt: event.time, status: 'running' }))
      state.total += 1
    } else {
      const call = state.active.get(id)
      if (!call) return false
      if (nested && call.name !== data.name) return false
      state.active.delete(id)
      const failed = transportFailed(data, nested)
      state[failed ? 'errors' : 'returned'] += 1
      const details = resultDetails(call.name, data, nested)
      state.business[details.outcome] += 1
      state.recent.unshift(Object.freeze({ ...call, ...details, status: failed ? 'error' : 'returned',
        durationMs: Math.max(0, event.time - call.startedAt) }))
      state.recent.length = Math.min(state.recent.length, config.recentLimit)
    }
    publish(state)
    return true
  }

  return Object.freeze({
    observe,
    snapshot: (sessionId?: string) => (sessionId === undefined ? undefined : sessions.get(sessionId)?.snapshot) ?? EMPTY,
    subscribe(listener: () => void) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true; sessions.clear()
      for (const listener of [...listeners]) {
        try { listener() } catch { /* Disposal remains best effort for observers. */ }
      }
      listeners.clear()
    },
  })
}
