/**
 * Activation-scoped scheduling for spill retention.
 *
 * `spill-retention.ts` owns the pure, testable pass; this module owns when a
 * pass runs. A component activation runs one bounded pass immediately, an
 * unref'ed interval (default six hours) runs later ones, and every
 * {@link SPILL_SETTLEMENTS_PER_SWEEP} settled commands queue one more. Several
 * preset rows mount the same assembly, so the process-wide runtime is shared
 * through a refcount and stopped by the last disposer.
 *
 * Timers are unref'ed: retention must never keep a host process alive, and a
 * failed pass is reported and otherwise ignored rather than failing the host.
 *
 * @module dsh-ops/shells/spill-retention-runtime
 */

import { describeSpillError, getSpillLedger, type SpillLedger } from './spill-ledger.js'
import {
  SPILL_SETTLEMENTS_PER_SWEEP,
  SPILL_SWEEP_INTERVAL_MS,
  sweepSpills,
  type SpillFilesystem,
  type SpillPassOptions,
  type SpillReport,
  type SpillRetentionConfig,
} from './spill-retention.js'

/** Construction seams for a runtime instance. */
export interface SpillRuntimeOptions {
  ledger?: SpillLedger
  report?: (message: string) => void
  now?: () => number
  tmpdir?: string
  fs?: SpillFilesystem
  platform?: NodeJS.Platform
  uid?: number
  intervalMs?: number
  settlementsPerSweep?: number
  maxFilesPerPass?: number
}

/** One activation-scoped retention runtime. */
export interface SpillRuntime {
  /** Run one bounded pass now and return its report. */
  runPass(): SpillReport | undefined
  /** Count one settlement; every configured number triggers one bounded pass. */
  noteSettled(): void
  /** Stop the timer and the pending activation pass. */
  dispose(): void
}

/**
 * Build one runtime: an activation pass, a bounded interval, and a pass every
 * N settlements. Timers are unref'ed so retention never keeps a host alive.
 * @param config - the resolved retention configuration.
 * @param options - seams and schedule overrides.
 * @returns the runtime handle.
 */
export function createSpillRetentionRuntime(config: SpillRetentionConfig, options: SpillRuntimeOptions = {}): SpillRuntime {
  const ledger = options.ledger ?? getSpillLedger()
  const passOptions: SpillPassOptions = {
    config,
    ledger,
    ...(options.tmpdir === undefined ? {} : { tmpdir: options.tmpdir }),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.uid === undefined ? {} : { uid: options.uid }),
    ...(options.maxFilesPerPass === undefined ? {} : { maxFilesPerPass: options.maxFilesPerPass }),
  }
  const report = options.report ?? ((_message: string) => {})
  const perSweep = Math.max(1, options.settlementsPerSweep ?? SPILL_SETTLEMENTS_PER_SWEEP)
  let disposed = false
  let pending: NodeJS.Immediate | undefined
  let timer: NodeJS.Timeout | undefined
  let settlements = 0
  const announce = (result: SpillReport) => {
    if (result.fatal !== undefined) {
      report('dsh-ops: spill retention skipped: ' + result.fatal)
      return
    }
    if (result.ledger.degraded !== null) report('dsh-ops: spill ledger is memory-only: ' + result.ledger.degraded)
    if (result.failures.length > 0) {
      report('dsh-ops: spill retention kept ' + String(result.failures.length) + ' file(s) it could not delete; the next pass retries them (' + result.failures[0].error + ')')
    }
  }
  const perform = (): SpillReport | undefined => {
    try {
      const result = sweepSpills(options.now === undefined ? passOptions : { ...passOptions, now: options.now() })
      announce(result)
      return result
    } catch (error) {
      try { report('dsh-ops: spill retention pass failed: ' + describeSpillError(error)) } catch { /* never fail the host */ }
      return undefined
    }
  }
  const schedule = () => {
    if (disposed || pending !== undefined) return
    pending = setImmediate(() => {
      pending = undefined
      if (!disposed) perform()
    })
    pending.unref?.()
  }
  // Component activation runs one bounded pass immediately; later passes come
  // from the unref'ed interval and from the settlement counter.
  schedule()
  timer = setInterval(schedule, Math.max(1000, options.intervalMs ?? SPILL_SWEEP_INTERVAL_MS))
  timer.unref?.()
  return {
    runPass: () => perform(),
    noteSettled: () => {
      if (disposed) return
      settlements++
      if (settlements < perSweep) return
      settlements = 0
      schedule()
    },
    dispose: () => {
      disposed = true
      if (pending !== undefined) clearImmediate(pending)
      pending = undefined
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}

let mounted: { refs: number; runtime: SpillRuntime } | undefined

/**
 * Mount the process-wide runtime for one component row. Several rows (the four
 * presets mount the same assembly) share one timer through a refcount.
 * Automatic passes are off when the operator disabled them or chose report-only.
 * @param config - the resolved retention configuration.
 * @param options - seams and schedule overrides.
 * @returns the disposer; the last disposer stops the shared runtime.
 */
export function mountSpillRetention(config: SpillRetentionConfig, options: SpillRuntimeOptions = {}): () => void {
  if (!config.sweepEnabled || config.retentionDays <= 0) return () => {}
  if (mounted === undefined) mounted = { refs: 0, runtime: createSpillRetentionRuntime(config, options) }
  mounted.refs++
  let released = false
  return () => {
    if (released) return
    released = true
    if (mounted === undefined) return
    mounted.refs--
    if (mounted.refs > 0) return
    mounted.runtime.dispose()
    mounted = undefined
  }
}

/**
 * Tell the mounted runtime that one command settlement happened.
 * Called from the settlement point; a no-op while no component is active.
 * @returns nothing.
 */
export function noteSpillSettled(): void {
  mounted?.runtime.noteSettled()
}
