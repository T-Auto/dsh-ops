/** Bound host file admission before resolving authority or creating a native request. */
export const MAX_ACTIVE_CALLS = 2
export const MAX_WAITING_CALLS = 8

export class CallBudgetError extends Error {
  constructor(readonly code: 'CALL_LIMIT' | 'CANCELLED', message: string) { super(message) }
}
type Ticket = { resolve: (release: () => void) => void, reject: (reason: unknown) => void,
  signal?: AbortSignal, abort: () => void }
type Lane = { active: number, queue: Ticket[] }

function cancelled(): CallBudgetError { return new CallBudgetError('CANCELLED', 'OPS call cancelled before worker admission; no effects.') }

/** One existing resident client owns Native/PTC pre-admission permits for its sessions. */
export class CallBudget {
  private readonly sessions = new Map<string, Lane>()
  private closed?: Error

  close(reason: Error): void {
    if (this.closed) return
    this.closed = reason
    for (const [id, lane] of this.sessions) {
      for (const ticket of lane.queue.splice(0)) {
        ticket.signal?.removeEventListener('abort', ticket.abort)
        ticket.reject(reason)
      }
      if (lane.active === 0) this.sessions.delete(id)
    }
  }

  private async acquire(sessionId: string, signal?: AbortSignal): Promise<() => void> {
    if (this.closed) throw this.closed
    if (signal?.aborted) throw cancelled()
    const sessions = this.sessions
    let lane = sessions.get(sessionId)
    if (!lane) { lane = { active: 0, queue: [] }; sessions.set(sessionId, lane) }
    const current = lane
    const cleanup = () => { if (current.active === 0 && current.queue.length === 0) sessions.delete(sessionId) }
    const releaseOnce = (): (() => void) => {
      let released = false
      return () => {
        if (released) return
        released = true
        current.active--
        const next = current.queue.shift()
        if (next) {
          next.signal?.removeEventListener('abort', next.abort)
          current.active++
          next.resolve(releaseOnce())
        }
        cleanup()
      }
    }
    if (current.active < MAX_ACTIVE_CALLS) { current.active++; return releaseOnce() }
    if (current.queue.length >= MAX_WAITING_CALLS) {
      throw new CallBudgetError('CALL_LIMIT', 'OPS call queue is full. Wait for current calls to finish before submitting more work; no effects.')
    }
    return new Promise((resolve, reject) => {
      const ticket: Ticket = { resolve, reject, ...(signal ? { signal } : {}), abort: () => {
        const index = current.queue.indexOf(ticket)
        if (index < 0) return
        current.queue.splice(index, 1)
        reject(cancelled()); cleanup()
      } }
      current.queue.push(ticket)
      signal?.addEventListener('abort', ticket.abort, { once: true })
      if (signal?.aborted) ticket.abort()
    })
  }

  async run<T>(sessionId: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const release = await this.acquire(sessionId, signal)
    try {
      if (this.closed) throw this.closed
      if (signal?.aborted) throw cancelled()
      return await run()
    } finally { release() }
  }
}
