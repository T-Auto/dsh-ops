import { randomUUID } from 'node:crypto'
import type { Context } from '../adapter/dsh/types.js'
import type { ResultCleanupAuthority } from './result-storage.js'
import { CallBudgetError } from './call-budget.js'
import { completeCleanupRoot, recordCleanupFailure, type CleanupReason } from './result-cleanup-registry.js'
import { runConfiguredResultCacheGc, scheduleStartupResultCacheGc } from './result-cache-gc.js'

export interface ResultSession { id: string; header?: { cwd?: string } }
export interface LifecycleHost {
  root?: object
  on(name: 'session/disposed', callback: (session: ResultSession) => void): unknown
  on(name: 'session/event', callback: (session: ResultSession, event: { type: string }) => void): unknown
  effect(callback: () => (() => Promise<void>), label: string): unknown
  logger?: { warn?: (message: string) => void }
}
interface CleanupEntry {
  run: () => Promise<void>
  /** The absolute cache root this cleanup owns, when the caller supplied one. */
  root?: string
}
interface LiveSession {
  nonce: string
  stopped: boolean
  work: Map<AbortController, Promise<unknown>>
  cleanup: Map<string, CleanupEntry>
  closing?: Promise<void>
}
interface Owner { mounts: number; sessions: Map<ResultSession, LiveSession>; expired: WeakSet<ResultSession>
  closing?: boolean; cleaning?: Promise<void>; cleanupAuthority?: ResultCleanupAuthority }
const owners = new WeakMap<object, Owner>()
function owner(ctx: Pick<LifecycleHost, 'root'>): Owner {
  const key = ctx.root ?? ctx
  let state = owners.get(key)
  if (!state) { state = { mounts: 0, sessions: new Map(), expired: new WeakSet() }; owners.set(key, state) }
  return state
}
function live(ctx: Pick<LifecycleHost, 'root'>, session: ResultSession): LiveSession {
  const state = owner(ctx)
  if (state.closing) throw new Error('Result owner is closing')
  if (state.expired.has(session)) throw new Error('Result session has expired')
  // The pinned SessionStore emits its exact stored Session object throughout one lifetime.
  if ([...state.sessions].some(([other, entry]) => other !== session && other.id === session.id && !entry.stopped)) {
    throw new Error('Another live session owns this identity')
  }
  let entry = state.sessions.get(session)
  if (!entry) {
    entry = { nonce: randomUUID(), stopped: false, work: new Map(), cleanup: new Map() }
    state.sessions.set(session, entry)
  }
  if (entry.stopped) throw new Error('Result session is closing')
  return entry
}
/** A reopened persisted session receives a fresh authority binding, even with the same id. */
export function resultSessionNonce(ctx: Pick<LifecycleHost, 'root'>, session: ResultSession): string {
  return live(ctx, session).nonce
}
/** A retained public dependency context remains valid through its awaited teardown. */
export function resultCleanupAuthority(ctx: Pick<LifecycleHost, 'root'>): ResultCleanupAuthority | undefined {
  return owner(ctx).cleanupAuthority
}
/** Keep current policy and its cache grants alive until the same owned purge barrier joins. */
export function mountResidentResultLifecycle(ctx: Context): void {
  const state = owner(ctx)
  state.closing = false
  // Full-access POSIX cache cleanup does not require a sandbox provider.
  for (const name of ['sandboxPolicy', 'sandbox'] as const) ctx.inject([name], inner => {
    // Injected properties retain the committed implementation until this disposer joins.
    // ctx.get() would hide a withdrawing service before its grants are actually released.
    const service = inner[name]
    state.cleanupAuthority = { ...state.cleanupAuthority, [name]: service }
    inner.effect(() => async () => {
      await drainResultSessions(ctx)
      if (state.cleanupAuthority?.[name] === service) delete state.cleanupAuthority[name]
    }, 'dsh-ops: result cleanup authority')
  })
}
/** The resident owner seals new work before draining sessions, then closes its transport. */
export async function drainResultSessions(ctx: Pick<LifecycleHost, 'root' | 'logger'>, seal = false): Promise<void> {
  const state = owner(ctx)
  if (seal) state.closing = true
  await Promise.allSettled([...state.sessions.keys()].map(session => expireResultSession(ctx, session, false)))
  await retryDeferredResultCleanup(ctx).catch(() => undefined)
}
/**
 * Register the physical cleanup of one cache root.
 * @param ctx - the lifecycle owner.
 * @param session - the live session that owns the root.
 * @param key - the in-process cache identity.
 * @param cleanup - the purge; it must throw when physical cleanup did not complete.
 * @param root - the absolute cache root, recorded when cleanup is deferred.
 */
export function registerResultCleanup(ctx: Pick<LifecycleHost, 'root'>, session: ResultSession, key: string,
  cleanup: () => Promise<void>, root?: string): void {
  live(ctx, session).cleanup.set(key, { run: cleanup, root })
}
export async function withResultSession<T>(ctx: Pick<LifecycleHost, 'root'>, session: ResultSession,
  signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const entry = live(ctx, session), controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  // Defer invocation so teardown always sees the promise before any worker can start.
  const preceding = [...owner(ctx).sessions].filter(([other]) => other !== session && other.id === session.id)
    .map(([, entry]) => entry.closing)
  const work = Promise.resolve().then(async () => {
    await Promise.allSettled(preceding)
    if (controller.signal.aborted) throw new CallBudgetError('CANCELLED', 'OPS call cancelled before worker admission; no effects.')
    return run(controller.signal)
  })
  entry.work.set(controller, work)
  try { return await work }
  finally { entry.work.delete(controller); signal?.removeEventListener('abort', abort) }
}
/** Deferred cleanup attempts kept in memory; the registry keeps the durable record. */
const MAX_DEFERRED_CLEANUPS = 256
const MAX_DEFERRED_ATTEMPTS = 6
const MAX_RETRIES_PER_PASS = 8
const RETRY_BASE_MS = 100
const RETRY_CAP_MS = 5000
interface DeferredCleanup { run: () => Promise<void>; attempts: number; nextAt: number; reason: CleanupReason }
const deferred = new Map<string, DeferredCleanup>()
/** Exposed for diagnostics and the lifecycle tests. */
export function deferredCleanupCount(): number {
  return deferred.size
}
function backoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_CAP_MS)
}
/** Classify a cleanup failure into the bounded reason vocabulary the registry stores. */
export function classifyCleanupFailure(error: unknown): CleanupReason {
  const message = error instanceof Error ? error.message : String(error)
  if (/cache grant changed/i.test(message)) return 'cache-grant-changed'
  if (/authority changed/i.test(message)) return 'authority-changed'
  if (/read-only|authority unavailable/i.test(message)) return 'read-only'
  if (/abort|cancel|timeout/i.test(message)) return 'timeout'
  if (/EPERM|EACCES|EBUSY/.test(message)) return 'eperm'
  return 'other'
}
function reportDeferred(ctx: Pick<LifecycleHost, 'logger'>, message: string): void {
  ctx.logger?.warn?.(message)
}
/**
 * Retry deferred cleanups whose backoff has elapsed.
 *
 * A deferred entry keeps the whole closure, so a retry runs the real purge and therefore the real
 * host authority check — read-only still refuses, and that refusal is recorded, not hidden.
 * @param ctx - the lifecycle owner.
 * @param now - current time; tests pass a later value instead of sleeping.
 * @returns how many were attempted, how many completed and how many remain.
 */
export async function retryDeferredResultCleanup(ctx: Pick<LifecycleHost, 'root' | 'logger'>,
  now = Date.now()): Promise<{ attempted: number; completed: number; pending: number }> {
  let attempted = 0, completed = 0
  for (const [root, entry] of [...deferred]) {
    if (entry.nextAt > now || attempted >= MAX_RETRIES_PER_PASS) continue
    attempted += 1
    try {
      await entry.run()
      deferred.delete(root)
      completeCleanupRoot(root)
      completed += 1
    } catch (error) {
      const reason = classifyCleanupFailure(error)
      recordCleanupFailure(root, reason, now)
      const attempts = entry.attempts + 1
      if (attempts > MAX_DEFERRED_ATTEMPTS) {
        deferred.delete(root)
        reportDeferred(ctx, `dsh-ops: deferred result-cache cleanup for ${root} gave up after ${attempts} attempts (${reason}); the record stays for operator review.`)
      } else deferred.set(root, { ...entry, attempts, reason, nextAt: now + backoffMs(attempts) })
    }
  }
  return { attempted, completed, pending: deferred.size }
}
export function expireResultSession(ctx: Pick<LifecycleHost, 'root' | 'logger'>, session: ResultSession, disposed = true): Promise<void> {
  const state = owner(ctx), entry = state.sessions.get(session)
  if (disposed) state.expired.add(session)
  if (!entry) return Promise.resolve()
  if (entry.closing) return entry.closing
  entry.stopped = true
  // Publish the barrier before abort listeners can synchronously reopen the same id.
  entry.closing = Promise.resolve().then(async () => {
    await Promise.allSettled(entry.work.values())
    // Session notifications may all precede provider teardown. Sequence only their
    // cache purges, so they cannot overflow the resident request window together.
    const preceding = state.cleaning
    let release!: () => void
    state.cleaning = new Promise<void>(resolve => { release = resolve })
    await preceding
    try {
      for (const cleanup of entry.cleanup.values()) {
        try {
          await cleanup.run()
          if (cleanup.root !== undefined) completeCleanupRoot(cleanup.root)
        } catch (error) {
          const reason = classifyCleanupFailure(error)
          if (cleanup.root !== undefined) {
            recordCleanupFailure(cleanup.root, reason)
            const attempts = (deferred.get(cleanup.root)?.attempts ?? 0) + 1
            if (deferred.size < MAX_DEFERRED_CLEANUPS && attempts <= MAX_DEFERRED_ATTEMPTS) {
              deferred.set(cleanup.root, { run: cleanup.run, attempts, reason, nextAt: Date.now() + backoffMs(attempts) })
            }
          }
          reportDeferred(ctx, `dsh-ops: session result references expired; physical cache cleanup did not complete under current host authority (${reason}). Deferred cleanup is recorded and retried when this host regains write authority or at the next start-up sweep.`)
        }
      }
    } finally { release() }
    entry.cleanup.clear(); state.sessions.delete(session)
  })
  for (const controller of entry.work.keys()) controller.abort(new Error('Result session disposed'))
  return entry.closing
}
/** Each component owns its listeners. Last-owner teardown expires remaining sessions. */
export function mountResultLifecycle(ctx: LifecycleHost): void {
  const state = owner(ctx); state.mounts++
  // The first owner schedules the bounded start-up sweep; the deferred timer keeps startup fast.
  if (state.mounts === 1) {
    scheduleStartupResultCacheGc()
    void retryDeferredResultCleanup(ctx).catch(() => undefined)
  }
  ctx.on('session/disposed', session => { void expireResultSession(ctx, session) })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'sandbox/mode') return
    for (const [other, entry] of state.sessions) if (other === session) {
      for (const controller of entry.work.keys()) controller.abort(new Error('Sandbox authority changed'))
    }
    // Regaining write authority is the moment a deferred cleanup may legally run.
    void retryDeferredResultCleanup(ctx).catch(() => undefined)
  })
  ctx.effect(() => async () => {
    if (--state.mounts !== 0) return
    await Promise.allSettled([...state.sessions.keys()].map(session => expireResultSession(ctx, session, false)))
    await retryDeferredResultCleanup(ctx).catch(() => undefined)
    // Shutdown only reclaims roots this process created; the global sweep owns the rest.
    await Promise.resolve(runConfiguredResultCacheGc('owned')).catch(() => undefined)
  }, 'dsh-ops: session result lifecycle')
}
