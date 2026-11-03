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
  let roundOpen = false
  let roundSuppressed = 0
  let suppressed = 0
  let lastDeferralAt = -Infinity
  let lastRecoveryAt = -Infinity
  const windowFree = (at: number, last: number) => at - last >= REENTRY_WARN_WINDOW_MS
  /**
   * The deferral line: one per window, and silent once the burst has folded refusals.
   *
   * A deferral printed before anything was folded cannot state a count, and a second deferral
   * would spend the slot the closing summary needs; a burst therefore speaks once at its start and
   * once at its end (#579).
   */
  const sayDeferral = () => {
    const at = now()
    if (suppressed > 0 || !windowFree(at, lastDeferralAt)) { suppressed += 1; return }
    lastDeferralAt = at
    report(`dsh-ops: the host is publishing an append; ${label} publication was deferred and will retry after a cooldown.`)
  }
  /**
   * The recovery line: it carries the folded count and is exempt from the deferral budget.
   *
   * It has to be out of budget, because a short lock prints its deferral before anything was
   * folded; it is allowed either when the round itself folded several refusals (a sustained lock)
   * or once the deferral window has gone by (a jitter of one-refusal rounds), so a jitter's count
   * is stated at its end instead of at its start (#579).
   */
  const sayRecovery = () => {
    if (suppressed === 0) return
    const at = now()
    if (!windowFree(at, lastRecoveryAt)) return
    if (roundSuppressed < 2 && !windowFree(at, lastDeferralAt)) return
    const folded = suppressed
    lastRecoveryAt = at
    // The summary spends the deferral slot as well: one deferral plus one recovery is the budget.
    lastDeferralAt = at
    suppressed = 0
    report(`dsh-ops: ${label} publication recovered after ${folded} suppressed refusal(s) during the cooldown.`)
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
   * retried (#579). A deadline further away than the step itself means the wall clock jumped
   * backwards: advance the ladder instead of parking for the jumped distance.
   */
  const tick = () => {
    timer = undefined
    const left = coolUntil - now()
    if (left > 0) {
      if (left <= armedStep) armTimer(left)
      else armStep()
      return
    }
    options.retry()
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
    if (outcome === 'failed') {
      if (!roundOpen) {
        roundOpen = true
        roundSuppressed = 0
        sayDeferral()
        return
      }
      roundSuppressed += 1
      suppressed += 1
      return
    }
    roundOpen = false
    // The recovery line is what makes an aggregated burst readable: it states how many refusals
    // were folded away while the throttle was closed (#579).
    sayRecovery()
  }
  return {
    classify: classifyHostReentry,
    cooled: () => now() < coolUntil,
    remaining: () => Math.max(0, coolUntil - now()),
    failed: (_error: unknown) => { note('failed'); return armStep() },
    deferred: () => armStep(),
    succeeded: () => { attempt = 0; coolUntil = 0; note('recovered') },
    note,
    suppressed: () => suppressed,
    dispose: () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined } coolUntil = 0 },
  }
}
