import { useEffect, useState } from 'react'
import type { ConfigPageForm, PluginConfigViewProps } from '../adapter/dsh/types.js'
import type { SettingsPathOpView } from '../adapter/dsh/types.js'
import type { Translator } from './locales.js'
export type SettingsProps = PluginConfigViewProps & { t: Translator }
export const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value)
/**
 * A whole-page editor over one row's saved values.
 *
 * `baseline` is the value the draft was read from, not the latest Host value: a
 * Host reload while the page is dirty (another surface saved, the row was
 * re-applied) must not turn an untouched field into a write. Without it, saving
 * one changed switch would also clear a field somebody else had just set.
 */
export function useEditor<T>(form: ConfigPageForm | undefined, read: (value: Record<string, unknown>) => T, t: Translator) {
  const [draft, setDraft] = useState(() => read(form?.state.value ?? {}))
  const [baseline, setBaseline] = useState<Record<string, unknown>>(() => form?.state.value ?? {})
  const [revision, setRevision] = useState(form?.state.revision)
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  // The host omits `mode` for a row page in this version; absence means "host",
  // and only an explicit non-host mode (or a read-only form) blocks editing.
  const ready = form?.state.status === 'ready' && form.state.writable !== false
    && (form.state.mode === undefined || form.state.mode === 'host')
  useEffect(() => {
    if (!dirty) { setDraft(read(form?.state.value ?? {})); setBaseline(form?.state.value ?? {}); setRevision(form?.state.revision) }
  }, [form?.state.revision, form?.state.status, read, dirty])
  const edit = (value: T) => { setDraft(value); setDirty(true); setMessage('') }
  const reset = () => {
    setDraft(read(form?.state.value ?? {})); setBaseline(form?.state.value ?? {})
    setRevision(form?.state.revision); setDirty(false); setMessage('')
  }
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
  return { draft, baseline, edit, dirty, busy, ready, message, reset, save }
}
export function Unavailable({ form, t }: SettingsProps) {
  return <p role="status">{t(form?.state.status === 'loading' ? 'loading' : 'unavailable')}</p>
}
export function FormActions({ busy, dirty, valid = true, reset, message, t }: {
  busy: boolean; dirty: boolean; valid?: boolean; reset(): void; message: string; t: Translator
}) {
  return <><div className="ops-settings-actions">
    <button type="submit" className="ops-settings-primary" disabled={busy || !dirty || !valid}>{t(busy ? 'saving' : 'save')}</button>
    <button type="button" className="ops-reset" onClick={reset} disabled={busy}>{t('reset')}</button>
  </div>{message && <p role="status" className="ops-note">{message}</p>}</>
}
