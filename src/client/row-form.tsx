/**
 * The configuration page of the single `dsh-ops` row.
 *
 * Two bundle switches, four per preset, and one card for the opt-in features.
 * Presets start on, so they also start collapsed: a card is one line until the
 * operator opens it, and the enable switch stays outside the disclosure so a click
 * never changes both at once.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { RuntimeRemote, RuntimeSnapshot } from '../settings/runtime-contract.js'
import { FormActions, Unavailable, errorText, useEditor } from './forms.js'
import type { SettingsProps } from './forms.js'
import { groupsFor, bundleGates, changedFields, executorDiffers, executorOps, flatKey, readExecutor, readRowValues, type FieldSpec } from './row-schema.js'
import type { ExecutorChoice } from './row-schema.js'
import type { Translator } from './locales.js'

/** The subset of the native Switch this page binds. */
export interface SwitchBinding {
  (props: { checked: boolean; label: string; disabled?: boolean; onChange(checked: boolean): void }): ReactElement
}

/** What the executor card reads: the Host's own resolution and its one write-validation call. */
export interface ExecutorSurface {
  readonly api: RuntimeRemote
  readonly snapshot: RuntimeSnapshot | undefined
  readonly busy: boolean
  refresh(): void
}

/** Configuration page of the row; `row-settings.tsx` binds the native Switch. */
export function RowForm(props: SettingsProps & { Switch: SwitchBinding; pwsh7Installed?: boolean; executor: ExecutorSurface }) {
  const { form, t, Switch, pwsh7Installed, executor } = props
  // A stable reader: a fresh closure would re-run the editor's effect every render.
  const read = useMemo(() => (value: Record<string, unknown>) => readRowValues(value, { pwsh7Installed }), [pwsh7Installed])
  const editor = useEditor(form, read, t)
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [choice, setChoice] = useState<ExecutorChoice>(() => readExecutor(form?.state.value ?? {}))
  const [check, setCheck] = useState<{ ok: boolean; text: string }>()
  const [saving, setSaving] = useState(false)
  // The saved row is the baseline: a Host reload while the page is dirty must not
  // silently adopt somebody else's executor.
  useEffect(() => {
    if (editor.dirty) return
    setChoice(readExecutor(editor.baseline))
    setCheck(undefined)
  }, [editor.baseline, editor.dirty])
  if (!editor.ready) return <Unavailable {...props} />
  const draft = editor.draft, gates = bundleGates(draft)
  const savedChoice = readExecutor(editor.baseline)
  const executorDirty = executorDiffers(choice, editor.baseline)
  const candidates = executor.snapshot?.git ?? []

  /** Ask the Host what a path resolves to; nothing is written by this call. */
  async function inspectPath(value: string): Promise<void> {
    const candidate = value.trim()
    if (candidate === '') { setCheck(undefined); return }
    try {
      const answer = await executor.api.select({ source: 'git', path: candidate })
      setCheck(answer.ok
        ? { ok: true, text: answer.value.restriction === '' ? answer.value.detail : answer.value.restriction }
        : { ok: false, text: answer.error.message })
    } catch (error) { setCheck({ ok: false, text: errorText(error) }) }
  }

  /** Save switches and the executor in one revision-checked write. */
  async function submit(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault()
    if (editor.busy || saving) return
    const operations = changedFields(draft, editor.baseline, { pwsh7Installed })
    if (executorDirty) {
      setSaving(true)
      try {
        const answer = choice.engine === 'niubash'
          ? await executor.api.select({ source: 'niubash' })
          : await executor.api.select({ source: 'git', path: choice.path.trim() })
        if (!answer.ok) { setCheck({ ok: false, text: answer.error.message }); return }
        setCheck({ ok: true, text: answer.value.restriction === '' ? answer.value.detail : answer.value.restriction })
        // The Host's answer is authoritative: it decides whether the choice clears
        // bashPath or pins the exact executable it verified.
        operations.push(...executorOps(editor.baseline, { clear: answer.value.clear,
          ...(answer.value.file === undefined ? {} : { file: answer.value.file }) }))
      } catch (error) { setCheck({ ok: false, text: errorText(error) }); return }
      finally { setSaving(false) }
    }
    await editor.save(operations)
  }
  // The companion linkage locks every host-PowerShell hide switch to off.
  const pwsh7Link = draft['other.pwsh7Link'] === true
  // Detection would turn this on; an explicit off is worth naming so it is not read as a bug.
  const explicitOff = pwsh7Installed === true && draft['other.pwsh7Link'] === false
  const set = (flat: string, value: boolean) => editor.edit({ ...draft, [flat]: value })
  return <form className="ops-settings" onSubmit={event => { void submit(event) }}>
    {groupsFor(editor.baseline).map(group => {
      const enabled = group.toggle ? draft[`${group.id}.enabled`] !== false : true
      // Disabling a preset greys its switches; it does not close the card.
      const expanded = opened[group.id] ?? !group.toggle
      const showBody = group.fields.length > 0 && expanded
      const head = <>
        <h4 className="ops-group-title">{group.labelText ?? t(group.label)}</h4>
        {/* Wrapped, not clamped: the descriptions name the exact behaviour a preset
            changes, and a truncated line hides the part that explains Windows. */}
        {group.hint !== undefined && <p className="ops-field-hint">{t(group.hint)}</p>}
      </>
      return <section className="ops-group ops-card" key={group.id}>
        <div className="ops-group-head">
          {group.toggle ? <button type="button" className="ops-disclosure"
            aria-expanded={expanded} aria-label={`${t(expanded ? 'collapseGroup' : 'expandGroup')} ${group.labelText ?? t(group.label)}`}
            onClick={() => setOpened({ ...opened, [group.id]: !expanded })}>
            <Chevron open={expanded} />
            <span className="ops-field-text">{head}</span>
          </button> : <div className="ops-field-text">{head}</div>}
          {group.toggle && <Switch checked={enabled} label={group.labelText ?? t(group.label)} disabled={editor.busy}
            onChange={(checked: boolean) => set(flatKey(group.togglePath ?? [group.id, 'enabled']), checked)} />}
        </div>
        {group.id === 'other' && explicitOff && <p className="ops-field-hint">{t('pwsh7ExplicitOffHint')}</p>}
        {showBody && <div className="ops-card-body">
          {group.fields.map(spec => {
            const shellOff = spec.path[0] === 'presets' && spec.path.at(-1) === 'hidePwsh' && draft[flatKey(['presets', spec.path[1]!, 'shell'])] === false
            const locked = shellOff || pwsh7Link && spec.path.at(-1) === 'hidePwsh'
            return <SwitchRow key={flatKey(spec.path)} spec={spec}
              checked={locked ? false : draft[flatKey(spec.path)] !== false}
              gate={!spec.disabled && !locked && (spec.gatedBy === undefined || gates[spec.gatedBy]) && enabled}
              busy={editor.busy} t={t} Switch={Switch} onChange={checked => set(flatKey(spec.path), checked)} />
          })}
        </div>}
      </section>
    })}
    <section className="ops-group ops-card" key="bash-executor">
      <div className="ops-group-head"><div className="ops-field-text">
        <h4 className="ops-group-title">{t('executorTitle')}</h4>
        <p className="ops-field-hint">{t('executorHint')}</p>
      </div></div>
      <div className="ops-card-body">
        {savedChoice.engine === 'mixed' && <p className="ops-field-hint">{t('executorMixed')}</p>}
        <label className="ops-choice">
          <input type="radio" name="ops-executor" checked={choice.engine === 'niubash'} disabled={editor.busy || saving}
            onChange={() => { setChoice({ engine: 'niubash', path: '' }); setCheck(undefined) }} />
          <span className="ops-field-text">
            <span className="ops-field-label">{t('executorNiubash')}</span>
            <span className="ops-field-hint">{t('executorNiubashHint')}</span>
          </span>
        </label>
        <label className="ops-choice">
          <input type="radio" name="ops-executor" checked={choice.engine === 'git'} disabled={editor.busy || saving}
            onChange={() => setChoice({ engine: 'git', path: savedChoice.engine === 'git' ? savedChoice.path : '' })} />
          <span className="ops-field-text">
            <span className="ops-field-label">{t('executorGit')}</span>
            <span className="ops-field-hint">{t('executorGitHint')}</span>
          </span>
        </label>
        {choice.engine === 'git' && <>
          <div className="ops-field">
            <span className="ops-field-label">{t('executorCandidates')}</span>
            {candidates.length === 0
              ? <p className="ops-field-hint">{t('executorNoCandidates')}</p>
              : <div className="ops-actions">{candidates.map(file => <button type="button" key={file}
                className="ops-text-button ops-candidate" title={file} disabled={editor.busy || saving}
                onClick={() => { setChoice({ engine: 'git', path: file }); void inspectPath(file) }}>{file}</button>)}</div>}
            <div className="ops-actions">
              <button type="button" className="ops-text-button" disabled={editor.busy || saving || executor.busy}
                onClick={() => executor.refresh()}>{t('executorScan')}</button>
            </div>
          </div>
          <label className="ops-field">
            <span className="ops-field-label">{t('executorPath')}</span>
            <input className="ops-input" type="text" value={choice.path} placeholder={t('executorPathPlaceholder')}
              disabled={editor.busy || saving} aria-invalid={check?.ok === false}
              onChange={event => setChoice({ engine: 'git', path: event.target.value })}
              onBlur={() => void inspectPath(choice.path)} />
            <div className="ops-actions">
              <button type="button" className="ops-text-button" disabled={editor.busy || saving || choice.path.trim() === ''}
                onClick={() => void inspectPath(choice.path)}>{t('executorCheck')}</button>
            </div>
            {check !== undefined && <p className={check.ok ? 'ops-field-hint' : 'ops-field-error'} role="status">{check.text}</p>}
          </label>
        </>}
        <p className="ops-field-hint">{t('executorAppliesOnSave')}</p>
      </div>
    </section>
    <FormActions busy={editor.busy || saving} dirty={editor.dirty || executorDirty} valid
      reset={() => { editor.reset(); setChoice(savedChoice); setCheck(undefined) }} message={editor.message} t={t} />
  </form>
}

function SwitchRow(props: {
  spec: FieldSpec; checked: boolean; gate: boolean; busy: boolean; t: Translator; Switch: SwitchBinding
  onChange(checked: boolean): void
}) {
  const { spec, checked, gate, busy, t, Switch, onChange } = props
  return <div className="ops-field">
    <div className="ops-switch-row">
      <div className="ops-field-text">
        <span className="ops-field-label">{t(spec.label)}</span>
        {spec.hint !== undefined && <p className="ops-field-hint">{t(spec.hint)}</p>}
      </div>
      <Switch checked={checked} label={t(spec.label)} disabled={busy || !gate} onChange={onChange} />
    </div>
  </div>
}

/** The host's disclosure chevron, copied from the native group toggle (12px, 1px stroke). */
function Chevron({ open }: { open: boolean }) {
  return <svg className="ops-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none"
    strokeWidth="1" aria-hidden="true" style={{ transform: open ? 'none' : 'rotate(-90deg)' }}>
    <path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" stroke="currentColor" />
  </svg>
}
