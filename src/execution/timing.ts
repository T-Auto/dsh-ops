/** Bounded, invocation-local observations. This module owns no timers, processes or files. */
export const EXECUTION_PHASES = [
  'admission', 'policy', 'queue', 'prepare', 'launch', 'hostWait', 'outputFinalize', 'resultReturn',
] as const
export type ExecutionPhase = typeof EXECUTION_PHASES[number]
export interface PhaseTiming {
  status: 'not-observed' | 'running' | 'completed'
  startMs: number | null
  durationMs: number | null
}
export interface ExecutionTimingSnapshot {
  version: 1
  scope: 'tool-call' | 'executor'
  wallMs: number
  phases: Record<ExecutionPhase, PhaseTiming>
  /** The public collect-mode host contract does not expose these independent events. */
  unavailable: {
    firstByte: 'host-collect-api'
    targetExit: 'host-done-is-not-target-exit'
    treeSettle: 'not-observed-without-changing-lifecycle'
  }
  hostDoneMs: number | null
}

/** All timestamps use the same monotonic origin; snapshots never share mutable state. */
export class ExecutionTiming {
  private readonly origin: number
  private readonly phases = new Map<ExecutionPhase, { start: number; end?: number }>()
  private hostDone: number | null = null

  constructor(private readonly scope: ExecutionTimingSnapshot['scope'], private readonly now = () => performance.now()) {
    this.origin = now()
  }

  begin(phase: ExecutionPhase): void {
    // A refused host-job admission may fall back to foreground, but never restarts the clock.
    if (!this.phases.has(phase)) this.phases.set(phase, { start: this.now() })
  }

  end(phase: ExecutionPhase): void {
    const observation = this.phases.get(phase)
    if (observation && observation.end === undefined) observation.end = this.now()
  }

  observeHostDone(): void { this.hostDone ??= this.now() - this.origin }

  snapshot(): ExecutionTimingSnapshot {
    const now = this.now()
    const phases = Object.fromEntries(EXECUTION_PHASES.map(name => {
      const phase = this.phases.get(name)
      return [name, phase ? {
        status: phase.end === undefined ? 'running' : 'completed',
        startMs: Math.max(0, phase.start - this.origin),
        durationMs: Math.max(0, (phase.end ?? now) - phase.start),
      } : { status: 'not-observed', startMs: null, durationMs: null }]
    })) as Record<ExecutionPhase, PhaseTiming>
    return { version: 1, scope: this.scope, wallMs: Math.max(0, now - this.origin), phases,
      hostDoneMs: this.hostDone,
      unavailable: { firstByte: 'host-collect-api', targetExit: 'host-done-is-not-target-exit',
        treeSettle: 'not-observed-without-changing-lifecycle' } }
  }
}
