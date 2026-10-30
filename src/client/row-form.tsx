/**
 * The configuration page of the single `dsh-ops` row.
 *
 * Two bundle switches, four per preset, and one card for the opt-in features.
 * Presets start on, so they also start collapsed: a card is one line until the
 * operator opens it, and the enable switch stays outside the disclosure so a click
 * never changes both at once.
 */
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { FormActions, Unavailable, useEditor } from './forms.js'
import type { SettingsProps } from './forms.js'
import { GROUPS, bundleGates, changedFields, flatKey, readRowValues, type FieldSpec } from './row-schema.js'
import type { Translator } from './locales.js'

/** The subset of the native Switch this page binds. */
export interface SwitchBinding {
  (props: { checked: boolean; label: string; disabled?: boolean; onChange(checked: boolean): void }): ReactElement
}

/** Configuration page of the row; `row-settings.tsx` binds the native Switch. */
export function RowForm(props: SettingsProps & { Switch: SwitchBinding; pwsh7Installed?: boolean }) {
  const { form, t, Switch, pwsh7Installed } = props
  // A stable reader: a fresh closure would re-run the editor's effect every render.
  const read = useMemo(() => (value: Record<string, unknown>) => readRowValues(value, { pwsh7Installed }), [pwsh7Installed])
  const editor = useEditor(form, read, t)
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  if (!editor.ready) return <Unavailable {...props} />
  const draft = editor.draft, gates = bundleGates(draft)
  // The companion linkage locks every host-PowerShell hide switch to off.
  const pwsh7Link = draft['other.pwsh7Link'] === true
  // Detection would turn this on; an explicit off is worth naming so it is not read as a bug.
  const explicitOff = pwsh7Installed === true && draft['other.pwsh7Link'] === false
  const set = (flat: string, value: boolean) => editor.edit({ ...draft, [flat]: value })
  return <form className="ops-settings" onSubmit={event => { event.preventDefault(); void editor.save(changedFields(draft, editor.baseline)) }}>
    {GROUPS.map(group => {
      const enabled = group.toggle ? draft[`${group.id}.enabled`] !== false : true
      // Disabling a preset greys its switches; it does not close the card.
      const expanded = opened[group.id] ?? !group.toggle
      const showBody = group.fields.length > 0 && expanded
      const head = <>
        <h4 className="ops-group-title">{t(group.label)}</h4>
        {/* Wrapped, not clamped: the descriptions name the exact behaviour a preset
            changes, and a truncated line hides the part that explains Windows. */}
        {group.hint !== undefined && <p className="ops-field-hint">{t(group.hint)}</p>}
      </>
      return <section className="ops-group ops-card" key={group.id}>
        <div className="ops-group-head">
          {group.toggle ? <button type="button" className="ops-disclosure"
            aria-expanded={expanded} aria-label={`${t(expanded ? 'collapseGroup' : 'expandGroup')} ${t(group.label)}`}
            onClick={() => setOpened({ ...opened, [group.id]: !expanded })}>
            <Chevron open={expanded} />
            <span className="ops-field-text">{head}</span>
          </button> : <div className="ops-field-text">{head}</div>}
          {group.toggle && <Switch checked={enabled} label={t(group.label)} disabled={editor.busy}
            onChange={(checked: boolean) => set(`${group.id}.enabled`, checked)} />}
        </div>
        {group.id === 'other' && explicitOff && <p className="ops-field-hint">{t('pwsh7ExplicitOffHint')}</p>}
        {showBody && <div className="ops-card-body">
          {group.fields.map(spec => {
            const locked = pwsh7Link && spec.path[1] === 'hidePwsh'
            return <SwitchRow key={flatKey(spec.path)} spec={spec}
              checked={locked ? false : draft[flatKey(spec.path)] !== false}
              gate={!locked && (spec.gatedBy === undefined || gates[spec.gatedBy]) && enabled}
              busy={editor.busy} t={t} Switch={Switch} onChange={checked => set(flatKey(spec.path), checked)} />
          })}
        </div>}
      </section>
    })}
    <FormActions busy={editor.busy} dirty={editor.dirty} valid reset={editor.reset} message={editor.message} t={t} />
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
