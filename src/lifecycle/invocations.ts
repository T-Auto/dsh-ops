/** Known cancellation before user code starts: no operation effects are possible. */
export class InvocationNotStarted extends Error {
  constructor() { super('Invocation cancelled before execution'); this.name = 'InvocationNotStarted' }
}

/** Provider-neutral in-flight invocation ownership. Cancellation is cooperative, never a sandbox. */
export class InvocationLifetime {
  readonly active = new Map<AbortController, Promise<unknown>>()
  private stopped = false

  async run<T>(signal: AbortSignal | undefined, execute: (signal: AbortSignal, controller: AbortController) => Promise<T>, provider?: Set<AbortController>, timeoutMs?: number): Promise<T> {
    if (this.stopped) throw new InvocationNotStarted()
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    provider?.add(controller)
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new Error('Invocation deadline exceeded')), timeoutMs)
    timer?.unref?.()
    // Register before scheduling user code: synchronous disposal cannot miss this call.
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new InvocationNotStarted()
      return execute(controller.signal, controller)
    })
    this.active.set(controller, work)
    try { return await work }
    finally {
      clearTimeout(timer)
      this.active.delete(controller)
      provider?.delete(controller)
      signal?.removeEventListener('abort', abort)
    }
  }

  cancel(reason: string): void {
    for (const controller of this.active.keys()) controller.abort(new Error(reason))
  }

  async stop(reason = 'Invocation owner disposed', drain = true): Promise<number> {
    this.stopped = true
    this.cancel(reason)
    const pending = [...this.active.values()]
    // Observe foreign work even when its provider ignores cancellation. Publication can retire
    // without awaiting arbitrary code forever; this does not claim its effects have stopped.
    const settled = Promise.allSettled(pending)
    if (drain) { await settled; return 0 }
    void settled
    return pending.length
  }
}
