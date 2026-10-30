/**
 * The Host runtime seam shared by a row's configuration page and the detail section.
 *
 * One hook owns the snapshot, the write actions and their honest result states, so
 * the status card and the configuration page cannot disagree about what the Host
 * reported. Every refresh carries the epoch it started in: a slow old response can
 * never overwrite a newer one.
 */
import { useEffect, useRef, useState } from 'react'
import type { RuntimeAction, RuntimePlan, RuntimeRemote, RuntimeResult, RuntimeSnapshot } from '../settings/runtime-contract.js'
import { errorText } from './forms.js'

/** What a mounted runtime surface can read and ask the Host to do. */
export interface RuntimeState {
  readonly snapshot: RuntimeSnapshot | undefined
  /** Local time of the accepted snapshot; absent until the first answer. */
  readonly at: string | undefined
  readonly busy: boolean
  /** Last transport or planning failure, shown inline. */
  readonly message: string
  readonly plan: RuntimePlan | undefined
  readonly result: RuntimeResult | undefined
  refresh(): Promise<void>
  preview(action: RuntimeAction): Promise<void>
  execute(): Promise<void>
  cancel(): void
  dismiss(): void
}

/**
 * Mount the runtime remote for one page.
 * @param api - the typed remote the browser half mounted at apply time.
 * @returns the snapshot, the pending plan and the actions that operate on them.
 */
export function useRuntime(api: RuntimeRemote): RuntimeState {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(), [at, setAt] = useState<string>()
  const [plan, setPlan] = useState<RuntimePlan>(), [result, setResult] = useState<RuntimeResult>()
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const cancellation = useRef<AbortController>(), mounted = useRef(true), epoch = useRef(0)

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false; cancellation.current?.abort() }
    // The remote identity is the mount boundary: a replaced service restarts the read.
  }, [api])

  async function refresh(clearMessage = true): Promise<void> {
    const current = ++epoch.current
    try {
      const response = await api.snapshot()
      if (!mounted.current || current !== epoch.current) return
      if (response.ok) { setSnapshot(response.value); setAt(new Date().toLocaleTimeString()); if (clearMessage) setMessage('') }
      else { setSnapshot(undefined); setMessage(response.error.message) }
    } catch (error) { if (mounted.current && current === epoch.current) setMessage(errorText(error)) }
  }

  async function preview(action: RuntimeAction): Promise<void> {
    setBusy(true); setMessage(''); setResult(undefined); setPlan(undefined)
    try {
      const response = await api.plan(action)
      if (!mounted.current) return
      if (response.ok) setPlan(response.value)
      else setMessage(response.error.message)
    } catch (error) { if (mounted.current) setMessage(errorText(error)) }
    finally { if (mounted.current) setBusy(false) }
  }

  async function execute(): Promise<void> {
    if (plan?.available !== true || busy) return
    const controller = new AbortController(); cancellation.current = controller; setBusy(true); setMessage('')
    try {
      const response = await api.execute(plan.id, controller.signal)
      if (!mounted.current) return
      setResult(response.ok ? response.value : { status: controller.signal.aborted ? 'cancelled' : 'failed', effectState: 'unknown', message: response.error.message })
      setPlan(undefined)
      await refresh(false)
    } catch (error) {
      if (mounted.current) setResult({ status: controller.signal.aborted ? 'cancelled' : 'failed', effectState: 'unknown', message: errorText(error) })
    } finally {
      cancellation.current = undefined
      if (mounted.current) { setPlan(undefined); setBusy(false) }
    }
  }

  return {
    snapshot, at, busy, message, plan, result,
    refresh: () => refresh(), preview, execute,
    cancel: () => cancellation.current?.abort(),
    dismiss: () => setPlan(undefined),
  }
}

/** One detected executor the operator may copy into the row's own configuration. */
export interface DetectedBash {
  /** Absolute path the Host reported. */
  readonly path: string
  /** Where it came from, as a short operator-facing label. */
  readonly source: 'managed' | 'git'
  /** Managed installation version, when the Host reports one. */
  readonly version?: string
}
