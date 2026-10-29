import { useEffect, useState } from 'react'
import type { ConfigPageForm, PluginConfigViewProps } from '../adapter/dsh/types.js'
import type { SettingsPathOpView } from '../adapter/dsh/types.js'
import type { Translator } from './locales.js'
export type SettingsProps = PluginConfigViewProps & { t: Translator }
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
export const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value)
export const checked = (values: string[], key: string, enabled: boolean): string[] => enabled ? [...new Set([...values, key])] : values.filter(value => value !== key)
export function useEditor<T>(form: ConfigPageForm | undefined, read: (value: Record<string, unknown>) => T, t: Translator) {
  const [draft, setDraft] = useState(() => read(form?.state.value ?? {}))
  const [revision, setRevision] = useState(form?.state.revision)
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  // DSH 0.2.2 dropped the snapshot's `mode: 'host' | 'memory'` field: a memory-backed
  // form never reports `writable`, so the writable flag alone keeps the same gate.
  const ready = form?.state.status === 'ready' && form.state.writable
  useEffect(() => {
    if (!dirty) { setDraft(read(form?.state.value ?? {})); setRevision(form?.state.revision) }
  }, [form?.state.revision, form?.state.status, read, dirty])
  const edit = (value: T) => { setDraft(value); setDirty(true); setMessage('') }
  const reset = () => { setDraft(read(form?.state.value ?? {})); setRevision(form?.state.revision); setDirty(false); setMessage('') }
  const save = async (operations: readonly SettingsPathOpView[]) => {
    if (!form || !ready || busy || revision === undefined) return
    setBusy(true); setMessage('')
    try {
      const accepted = await form.mutate(operations, revision)
      setMessage(t(accepted ? 'saved' : 'rejected'))
      if (accepted) setDirty(false)
    } catch (error) { setMessage(errorText(error)) }
    finally { setBusy(false) }
  }
  return { draft, edit, dirty, busy, ready, message, reset, save }
}
export function Unavailable({ form, t }: SettingsProps) {
  return <p role="status">{t(form?.state.status === 'loading' ? 'loading' : 'unavailable')}</p>
}
export function FormActions({ busy, dirty, valid = true, reset, message, t }: {
  busy: boolean; dirty: boolean; valid?: boolean; reset(): void; message: string; t: Translator
}) {
  return <><div className="ops-settings-actions">
    <button type="submit" className="ops-settings-primary" disabled={busy || !dirty || !valid}>{t(busy ? 'saving' : 'save')}</button>
    <button type="button" onClick={reset} disabled={busy}>{t('reset')}</button>
  </div>{message && <p role="status">{message}</p>}</>
}
