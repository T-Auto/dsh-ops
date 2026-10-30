/**
 * Binds the Host's native Switch to the row form.
 *
 * This is the only module in the bundle that names the primitives client module,
 * so the form logic stays importable (and drivable) without the Host's module
 * loader — see `row-form.tsx`.
 */
import { useEffect, useState } from 'react'
import { Switch } from '../adapter/dsh/browser.js'
import type { SettingsProps } from './forms.js'
import type { PluginInstaller } from './detail.js'
import { RowForm } from './row-form.js'

export function RowSettings(props: SettingsProps & { pwsh7Installed?: boolean; plugins?: PluginInstaller }) {
  const { plugins, pwsh7Installed, ...rest } = props
  // Installed state changes while the host runs (the status card can install it), so the
  // page resolves it on open instead of trusting the value captured at boot.
  const [installed, setInstalled] = useState<boolean | undefined>(pwsh7Installed)
  const [checked, setChecked] = useState(plugins === undefined)
  useEffect(() => {
    if (plugins === undefined) return
    let current = true
    void plugins.listPlugins().then(list => {
      if (!current) return
      const rows = Array.isArray(list) ? list : (list as { value?: unknown } | undefined)?.value
      if (Array.isArray(rows)) setInstalled(rows.some(row => typeof row === 'object' && row !== null
        && ['entryId', 'moduleName', 'patchId'].some(key => typeof (row as Record<string, unknown>)[key] === 'string'
          && ((row as Record<string, string>)[key]).includes('dsh-win-pwsh7'))))
      setChecked(true)
    }).catch(() => { if (current) setChecked(true) })
    return () => { current = false }
  }, [plugins])
  // The draft is read once when the form mounts; wait for the real answer so the
  // detection-driven default is not baked in as "absent".
  // A visible, honest state instead of an empty slot while the host answers.
  if (!checked) return <p className="ops-note" role="status">{rest.t('loading')}</p>
  return <RowForm {...rest} pwsh7Installed={installed} Switch={Switch} />
}
