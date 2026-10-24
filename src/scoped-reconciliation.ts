/** Host probes may never resolve. Only their inheritance family may wait for them. */
export interface Reconciliation {
  signal: AbortSignal
  current(): boolean
  wait<T>(promise: Promise<T>): Promise<T>
}
interface Work extends Reconciliation { controller: AbortController; promise: Promise<void>; pending: boolean }
const cancelled = new Error('Superseded scope reconciliation')
export function scopedReconciliation<K>(failed: (error: unknown) => void) {
  const states = new Map<K, Work>()
  const cancel = (members: Iterable<K>) => {
    for (const member of members) states.get(member)?.controller.abort(cancelled)
  }
  return {
    cancel,
    forget(member: K): void { cancel([member]); states.delete(member) },
    version: (member: K): unknown => states.get(member),
    run(members: Iterable<K>, action: (work: Reconciliation) => Promise<void>): Promise<void> {
      const keys = [...members]
      cancel(keys)
      const controller = new AbortController(), { signal } = controller
      const work: Work = { controller, signal, pending: true, promise: Promise.resolve(),
        current: () => !signal.aborted,
        wait: <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
          const abort = () => reject(cancelled)
          // Attach both continuations even if already cancelled: a late host
          // rejection is observed, and can neither publish nor go unhandled.
          promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
            error => { signal.removeEventListener('abort', abort); reject(error) })
          if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
        }),
      }
      for (const key of keys) states.set(key, work)
      work.promise = Promise.resolve().then(() => { if (work.current()) return action(work) })
        .catch(error => { if (work.current()) failed(error) }).finally(() => { work.pending = false })
      return work.promise
    },
    async drain(member: K): Promise<boolean> {
      const before = states.get(member), pending = before?.pending === true
      let current: Work | undefined
      do { current = states.get(member); await current?.promise } while (current !== states.get(member))
      return pending || current !== before
    },
    async stop(): Promise<void> {
      cancel(states.keys())
      await Promise.all([...new Set(states.values())].map(work => work.promise))
      states.clear()
    },
  }
}
/** Ancestor overlays and their descendants commit together; roots stay independent. */
export function scopeFamilies<K extends object>(members: Iterable<K>, targets: Iterable<K>, ancestors: (scope: K) => object[]): Set<K>[] {
  const all = new Set(members), groups = new Map<K, Set<K>>()
  const root = (member: K): K => (ancestors(member).filter(scope => all.has(scope as K)).at(-1) as K | undefined) ?? member
  const selected = new Set([...targets].map(root))
  for (const member of all) {
    const key = root(member)
    if (!selected.has(key)) continue
    let family = groups.get(key)
    if (!family) { family = new Set(); groups.set(key, family) }
    family.add(member)
  }
  return [...groups.values()]
}
