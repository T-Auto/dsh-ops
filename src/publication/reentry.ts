/** Registry writes share one refusal window across all rows in a host root. */
import type { Context } from '../adapter/dsh/types.js'

const REFUSAL = 'session append cannot reenter while another append is being published'
const delays = [25, 100, 400, 1000] as const
// Cordis FiberState.UNLOADING rejects effects even while uid is retained for restart.
const UNLOADING: Context['fiber']['state'] = 5
export function publicationError(error: unknown): string {
  try {
    if (error !== null && typeof error === 'object' && 'message' in error) return String(error.message)
    return String(error)
  } catch { return '<unprintable publication error>' }
}
export function appendReentry(error: unknown): boolean { return publicationError(error).includes(REFUSAL) }

interface Work {
  wanted: boolean
  active(): boolean
  apply(): () => void
  undo?: () => void
  running?: boolean
  failed?: boolean
  ready: Promise<void>
  resolve(): void
  reject(error: unknown): void
}
interface Queue { retain(ctx: Context): void; submit(work: Work, immediate: boolean): void; pending: Set<Work> }
const queues = new WeakMap<object, Queue>()
const registrations = new WeakMap<() => void, Work>()
const cancel = (work: Work, reason: string): void => { work.wanted = false; work.reject(new Error(reason)) }
function inactiveEffect(error: unknown): boolean {
  try { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'INACTIVE_EFFECT' }
  catch { return false }
}

function queueFor(ctx: Context): Queue {
  const root = ctx.root ?? ctx
  const existing = queues.get(root)
  if (existing) { existing.retain(ctx); return existing }
  const pending = new Set<Work>()
  let timer: NodeJS.Timeout | undefined
  let busy = false, stopped = false, rootOwned = false, level = 0, refusals = 0, reported = 0, warnings = 0, lastWarning = -Infinity
  const owners = new Set<Context['fiber']>()
  const warn = (message: string): void => { root.logger.warn(message) }
  const arm = (): void => {
    if (timer || !pending.size) return
    timer = setTimeout(() => { timer = undefined; flush() }, delays[Math.min(level++, delays.length - 1)])
    timer.unref?.()
  }
  const flush = (propagate?: Work): void => {
    if (busy || timer) return
    busy = true
    try {
      // Leave a refusing operation at the front. A later replacement must not
      // race its owed withdrawal and hit the host's same-layer duplicate check.
      for (const work of pending) {
        if (stopped && work.wanted) cancel(work, 'Publication root disposed')
        work.running = true
        try {
          if (work.wanted && !work.undo) {
            if (!work.active()) cancel(work, 'Publication owner inactive before registration')
            else {
              work.undo = work.apply()
              if (!work.active()) cancel(work, 'Publication owner inactive during registration')
              else if (work.wanted) work.resolve()
              else work.reject(new Error('Publication cancelled during registration'))
            }
          }
          if (!work.wanted && work.undo) { work.undo(); work.undo = undefined }
          pending.delete(work)
          // A synchronous tools/change observer can revoke during registration.
          if (!work.wanted && work.undo) pending.add(work)
        } catch (error) {
          if (!work.active() && !work.undo && inactiveEffect(error)) {
            cancel(work, 'Publication owner inactive during registration')
            pending.delete(work)
            continue
          }
          if (appendReentry(error)) {
            pending.add(work)
            ++refusals
            const now = performance.now()
            if (now - lastWarning >= 1000) {
              warn(`dsh-ops: registry publication deferred: ${REFUSAL}; ${refusals - reported - 1} earlier refusal(s) suppressed`)
              lastWarning = now; reported = refusals; ++warnings
            }
            arm()
            return
          }
          pending.delete(work)
          work.failed = true
          work.reject(error)
          // Configuration/readiness errors never enter the refusal retry loop.
          if (work === propagate) throw error
          warn(`dsh-ops: deferred registry publication failed: ${publicationError(error)}`)
        } finally { work.running = false }
      }
      if (!pending.size) {
        if (refusals) warn(`dsh-ops: registry publication recovered after ${refusals} refusal(s) (${refusals - warnings} suppressed)`)
        level = 0; refusals = 0; reported = 0; warnings = 0; lastWarning = -Infinity
        if (stopped && queues.get(root) === queue) queues.delete(root)
      }
    } finally { busy = false }
  }
  const queue: Queue = { pending, retain(owner) {
    if (rootOwned || owners.has(owner.fiber)) return
    owners.add(owner.fiber)
    try {
      owner.effect(() => () => {
        owners.delete(owner.fiber)
        if (!rootOwned && !owners.size) teardown()
      }, 'dsh-ops: registry refusal queue')
      // A new live fallback owner inherits the same queue and its owed withdrawals.
      if (owner.fiber.uid !== null && owner.fiber.state !== UNLOADING) stopped = false
    } catch (error) { owners.delete(owner.fiber); throw error }
  }, submit(work, immediate) {
    if (stopped && work.wanted) cancel(work, 'Publication root disposed')
    if (!work.wanted && !work.undo && !work.running) { pending.delete(work); work.reject(new Error('Publication cancelled before registration')) }
    else pending.add(work)
    if (!pending.size && timer) { clearTimeout(timer); timer = undefined; level = 0 }
    if (immediate) flush(work)
    else flush()
  } }
  queues.set(root, queue)
  const teardown = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = undefined
    for (const work of pending) {
      cancel(work, 'Publication root disposed')
      if (!work.undo && !work.running) pending.delete(work)
    }
    // Stopping publication must not discard exact undo operations owed to the registry.
    if (!pending.size && queues.get(root) === queue) queues.delete(root)
    flush()
  }
  // The queue belongs to the root, but dsh-tui's root-capability guard refuses
  // `root.effect` from a plugin activation, which the native-tools row is. The
  // caller's own lifetime hook keeps the queue teardown reachable there.
  try {
    try { root.effect(() => teardown, 'dsh-ops: registry refusal queue'); rootOwned = true }
    catch { queue.retain(ctx) }
  } catch (error) { teardown(); throw error }
  return queue
}

/**
 * Retain the exact scoped registry action and undo. Only a host append refusal
 * is deferred; ordinary errors remain synchronous for lifecycle rollback.
 * A queued registration is not visible/admitted until the host accepts it.
 * Disposed owners return a tracked cancelled lease; readiness never reports success.
 * Cancel before disposing a row so pending work can never revive its context.
 */
export function publicationRegistration(ctx: Context, apply: () => (() => void)): () => void {
  let resolve!: () => void, reject!: (error: unknown) => void
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  // Synchronous grant changes cannot await publication. Lifecycle callers can
  // still await this original promise and roll back a later permanent failure.
  void ready.catch(() => {})
  const work: Work = { wanted: true, active: () => ctx.fiber.uid !== null && ctx.fiber.state !== UNLOADING, apply, ready, resolve, reject }
  let lifetime: (() => void) | undefined
  const dispose = () => { lifetime?.() }
  registrations.set(dispose, work)
  if (!work.active()) { cancel(work, 'Publication owner inactive before registration'); return dispose }
  let queue: Queue
  try {
    queue = queueFor(ctx)
    lifetime = ctx.effect(() => () => { work.wanted = false; queue.submit(work, true) }, 'dsh-ops: registry publication lease')
  } catch (error) {
    if (!work.active() && inactiveEffect(error)) {
      cancel(work, 'Publication owner inactive before registration')
      return dispose
    }
    work.failed = true
    work.reject(error)
    throw error
  }
  try { queue.submit(work, true) } catch (error) { dispose(); throw error }
  return dispose
}

/** Immediate verification must wait for an owed registry write to settle. */
export function publicationPending(dispose: () => void): boolean {
  const work = registrations.get(dispose)
  return work !== undefined && work.wanted && !work.failed && work.undo === undefined
}

export function publicationReady(dispose: () => void): Promise<void> {
  return registrations.get(dispose)?.ready ?? Promise.resolve()
}
