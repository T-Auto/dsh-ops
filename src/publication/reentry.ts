/**
 * The host's append-reentry refusal: one classifier, one cooldown ladder and one log aggregator
 * for every registry publication path (#579, second slice).
 *
 * A host that is publishing an append refuses a nested registry write with
 * `cannot reenter while another append is being published`. Retrying inside the same microtask
 * hits the same lock, and a pass that visits many sessions multiplies the refusals by the session
 * count. Every publication path therefore needs the same three things: tell this refusal apart
 * from a real failure, stop the pass and try once after a bounded cooldown, and say the window
 * once instead of once per attempt or per session.
 *
 * The classifier is total on purpose: a host error whose `message` is a throwing getter must
 * degrade to the unclassified path, never raise a second exception out of the caller's `catch`.
 *
 * @module dsh-ops/publication/reentry
 */
import { errorMessage } from '../shells/types.js'

/** The host's refusal while it publishes an append; the wording lives outside this repository. */
const HOST_REENTRY_TEXT = 'cannot reenter while another append is being published'

/** The default cooldown ladder in milliseconds; the last step repeats. */
export const REENTRY_COOLDOWN_STEPS_MS: readonly number[] = Object.freeze([25, 100, 400, 1000])

/**
 * The warning budget, per publication path (#579).
 *
 * A jittering lock — one short window per new session — used to print one line per session. The
 * aggregator therefore allows {@link REENTRY_WARN_WINDOW_MS} to carry one deferral line and one
 * recovery line, in that order, and counts everything it drops; that is the "at most two warnings"
 * acceptance the suites measure. The recovery line is exempt from the deferral budget on purpose:
 * it is the line that carries the folded count, so a lock that releases quickly must still make
 * its refusals readable instead of leaving them in a counter nobody ever prints.
 */
const REENTRY_WARN_WINDOW_MS = 1000

/**
 * Read an error's message without letting a hostile getter throw.
 *
 * `errorMessage` reads `.message`, so an object whose getter throws would raise from inside the
 * caller's `catch` block — the failure this package must never produce while reporting another
 * one (#579). The fallback line is deliberate: an unreadable message is reported, not dropped.
 * @param {unknown} error - any thrown value.
 * @returns {string} the message, or a line saying it could not be read.
 */
export function safeMessage(error: unknown): string {
  try { return errorMessage(error) } catch { return 'error message unavailable' }
}

/**
 * Whether a failure is the host refusing a nested append.
 *
 * Deliberate false negatives: only a top-level message matches. A `cause`-nested text or a
 * capitalised variant stays unclassified (the host's reported failure was `new Error(<literal>)`);
 * walking `cause` recursively would widen the match to unrelated errors.
 * @param {unknown} error - the value the registry or a disposer threw.
 * @returns {boolean} whether this is the host's reentry refusal.
 */
export function classifyHostReentry(error: unknown): boolean {
  return safeMessage(error).includes(HOST_REENTRY_TEXT)
}

/** The outcome the aggregator is told about. */
export type ReentryOutcome = 'failed' | 'recovered'

export interface ReentryCoolingOptions {
  /** Which publication path this cooling serves; part of every aggregated line. */
  label: string
  /** One deferred pass per expired cooldown step. Must not throw. */
  retry: () => void
  /** Cooldown ladder; the last step repeats. Defaults to {@link REENTRY_COOLDOWN_STEPS_MS}. */
  steps?: readonly number[]
  /** Clock seam, read at call time; defaults to `Date.now`. */
  now?: () => number
  /** Sink for the aggregated lines; defaults to a no-op. */
  report?: (message: string) => void
}

/**
 * One publication path's reentry cooldown plus the warnings it owes.
 *
 * Lifecycle: `failed(error)` on a classified refusal — it notes the refusal and arms (or keeps)
 * the single cooldown timer; `deferred()` when a pass could not run at all (still cooled) and owes
 * another; `succeeded()` when a pass completed, which resets the ladder and flushes the summary;
 * `dispose()` when the row goes away.
 */
export interface ReentryCooling {
  /** Whether this failure is the host's reentry refusal (total; never throws). */
  classify(error: unknown): boolean
  /** Whether the cooldown is still running: a pass must not touch the registry. */
  cooled(): boolean
  /** Milliseconds left in the current cooldown step, 0 when it expired. */
  remaining(): number
  /** Register one classified refusal, arm the next step and return its delay in milliseconds. */
  failed(error: unknown): number
  /** A pass could not run and owes another: arm the next step (fresh deadline), say nothing new. */
  deferred(): number
  /** A completed pass: reset the ladder and flush the suppression summary. */
  succeeded(): void
  /** Feed the aggregator directly, for callers that separate timing from reporting. */
  note(outcome: ReentryOutcome): void
  /** Refusals counted since the last aggregated line (they appear in the next one). */
  suppressed(): number
  /** Clear the armed timer; the row is going away. */
  dispose(): void
}

/**
 * Build one cooling state machine.
 * @param {ReentryCoolingOptions} options - label, retry callback and optional seams.
 * @returns {ReentryCooling} the state machine.
 */
export function createReentryCooling(options: ReentryCoolingOptions): ReentryCooling {
  const label = options.label
  const steps = options.steps?.length ? options.steps : REENTRY_COOLDOWN_STEPS_MS
  const now = options.now ?? (() => Date.now())
  const report = options.report ?? (() => {})
  let attempt = 0
  let coolUntil = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Every refusal in the burst; reset only by a refusal that follows a quiet window. */
  let burstRefusals = 0
  /** Refusals no line has reported yet. */
  let unreported = 0
  let lastRefusalAt = -Infinity
  let lastDeferralAt = -Infinity
  let lastRecoveryAt = -Infinity
  const windowFree = (at: number, last: number) => at - last >= REENTRY_WARN_WINDOW_MS
  /**
   * The deferral line: one per window, printed when the burst opens.
   *
   * It cannot state a count — nothing has been folded when it is written — so every burst also owes
   * a closing summary.
   */
  const sayDeferral = (at: number) => {
    if (!windowFree(at, lastDeferralAt)) return
    lastDeferralAt = at
    report(`dsh-ops: the host is publishing an append; ${label} publication was deferred and will retry after a cooldown.`)
  }
  /**
   * The closing summary: the only line that can state a burst, so it is written once the burst has
   * been quiet for a full window — not when the first pass happens to succeed (#579).
   *
   * The burst is over when the surrounding system next runs a pass after that silence: a jitter's
   * episodes alternate refusal and success, so no local signal (a success, a timer) can tell the
   * tenth episode from the first. "Settled" is therefore read from the injected clock at a pass
   * boundary, never from a wall-clock timer: a timer fires mid-burst and states a prefix of it.
   * @param {number} at - the clock reading of this pass boundary.
   */
  const sayRecovery = (at: number) => {
    if (unreported === 0 || !windowFree(at, lastRecoveryAt)) return
    if (at - lastRefusalAt < REENTRY_WARN_WINDOW_MS) return
    const total = burstRefusals
    unreported = 0
    lastRecoveryAt = at
    lastDeferralAt = at
    report(`dsh-ops: ${label} publication recovered after ${total} refusal(s) during the cooldown (${Math.max(0, total - 1)} suppressed).`)
  }
  let armedStep = 0
  const armTimer = (delay: number) => {
    armedStep = delay
    timer = setTimeout(tick, delay)
    timer.unref?.()
  }
  /**
   * One timer fires; renew it if the deadline moved while it was pending.
   *
   * A later refusal extends `coolUntil` without touching the running timer, so a timer that fires
   * early must renew for the remainder instead of releasing a pass the cooldown would refuse
   * anyway — otherwise a lock that then releases with no further host event would never be
   * retried (#579). The pass is released only when the deadline really passed: releasing it while
   * still cooled would re-arm the next ladder step from a gated pass and run the ladder away.
   * A deadline further away than the step means the wall clock jumped backwards; advance instead of
   * parking for the jumped distance.
   */
  const tick = () => {
    timer = undefined
    const left = coolUntil - now()
    if (left <= 0) { options.retry(); return }
    if (left <= armedStep) { armTimer(left); return }
    armStep()
  }
  /** Advance the ladder and arm the step unless one is already pending. */
  const armStep = (): number => {
    // One timer per cooldown: a pass that already armed a step does not advance the ladder again.
    if (timer !== undefined) return Math.max(0, coolUntil - now())
    const delay = steps[Math.min(attempt, steps.length - 1)]
    attempt += 1
    coolUntil = now() + delay
    armTimer(delay)
    return delay
  }
  const note = (outcome: ReentryOutcome) => {
    if (outcome !== 'failed') return
    const at = now()
    if (at - lastRefusalAt >= REENTRY_WARN_WINDOW_MS) burstRefusals = 0
    lastRefusalAt = at
    burstRefusals += 1
    unreported += 1
    if (burstRefusals === 1) sayDeferral(at)
  }
  return {
    classify: classifyHostReentry,
    cooled: () => now() < coolUntil,
    remaining: () => Math.max(0, coolUntil - now()),
    failed: (_error: unknown) => { note('failed'); return armStep() },
    // A pass that could not run and a pass that completed are both boundaries where the burst may
    // have settled; only the second is guaranteed to happen once the window really closed.
    deferred: () => { const delay = armStep(); sayRecovery(now()); return delay },
    succeeded: () => { attempt = 0; coolUntil = 0; note('recovered'); sayRecovery(now()) },
    note,
    suppressed: () => unreported,
    dispose: () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined } coolUntil = 0 },
  }
}
