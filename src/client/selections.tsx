import { DISCOVERY_TERMS } from '../capabilities/discovery.js'
import { OFFICIAL_REPLACEMENT_NAMES as replacements } from '../capabilities/replacements.js'
import { checked, FormActions, strings, Unavailable, useEditor } from './forms.js'
import type { SettingsProps } from './forms.js'
const readReplacement = (value: Record<string, unknown>) => strings(value.replaceTools)
export function ReplacementForm(props: SettingsProps) {
  const { form, t } = props, editor = useEditor(form, readReplacement, t)
  if (!editor.ready) return <Unavailable {...props} />
  return <form className="ops-settings" onSubmit={event => { event.preventDefault(); void editor.save([{ op: 'set', path: ['replaceTools'], value: editor.draft }]) }}>
    <p>{t('replacementsHelp')}</p><fieldset disabled={editor.busy}><legend>{t('replacements')}</legend>
      {replacements.map(name => <label className="ops-settings-choice" key={name}>
        <input type="checkbox" checked={editor.draft.includes(name)} onChange={event => editor.edit(checked(editor.draft, name, event.target.checked))} />
        <span>{t(name)} <code>{name}</code></span>
      </label>)}
    </fieldset><p className="ops-settings-note">{t('replacementPool')}</p>
    <FormActions {...editor} t={t} />
  </form>
}
const names = Object.keys(DISCOVERY_TERMS)
const readDiscovery = (value: Record<string, unknown>) => ({ allowed: strings(value.allowedTools), always: strings(value.alwaysLoaded), enabled: value.enabled !== false, limit: String(value.maxResults ?? 3) })
export function DiscoveryForm(props: SettingsProps) {
  const { form, t } = props, editor = useEditor(form, readDiscovery, t), draft = editor.draft
  const limit = Number(draft.limit), valid = Number.isInteger(limit) && limit >= 1 && limit <= 5
  if (!editor.ready) return <Unavailable {...props} />
  return <form className="ops-settings" onSubmit={event => { event.preventDefault(); if (valid) void editor.save([
    { op: 'set', path: ['enabled'], value: draft.enabled }, { op: 'set', path: ['maxResults'], value: limit },
    { op: 'set', path: ['allowedTools'], value: draft.allowed }, { op: 'set', path: ['alwaysLoaded'], value: draft.always },
  ]) }}>
    <label className="ops-settings-choice"><input type="checkbox" checked={draft.enabled} disabled={editor.busy}
      onChange={event => editor.edit({ ...draft, enabled: event.target.checked })} />{t('discoverEnabled')}</label>
    <p>{t('discoverHelp')}</p>
    <label className="ops-settings-field">{t('limit')}<input type="number" min="1" max="5" step="1" value={draft.limit} disabled={editor.busy}
      aria-invalid={!valid} onChange={event => editor.edit({ ...draft, limit: event.target.value })} /></label>
    {!valid && <p role="alert">{t('invalidLimit')}</p>}
    <p className="ops-settings-note">{t('poolHelp')}</p>
    <div className="ops-settings-columns">
      <fieldset disabled={editor.busy}><legend>{t('allowed')}</legend>{names.map(name =>
        <label className="ops-settings-choice" key={name}><input type="checkbox" checked={draft.allowed.includes(name)}
          onChange={event => editor.edit({ ...draft, allowed: checked(draft.allowed, name, event.target.checked), always: event.target.checked ? draft.always : draft.always.filter(value => value !== name) })} /><code>{name}</code></label>)}</fieldset>
      <fieldset disabled={editor.busy}><legend>{t('always')}</legend>{names.map(name =>
        <label className="ops-settings-choice" key={name}><input type="checkbox" checked={draft.always.includes(name)} disabled={!draft.allowed.includes(name)}
          onChange={event => editor.edit({ ...draft, always: checked(draft.always, name, event.target.checked) })} /><code>{name}</code></label>)}</fieldset>
    </div><FormActions {...editor} valid={valid} t={t} />
  </form>
}
