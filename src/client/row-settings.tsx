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
import { companionStatus } from './detail.js'
import type { PluginInstaller } from './detail.js'
import type { RuntimeRemote } from '../settings/runtime-contract.js'
import { useRuntime } from './runtime.js'
import { RowForm } from './row-form.js'

export function RowSettings(props: SettingsProps & { plugins?: PluginInstaller; api: RuntimeRemote }) {
  const { plugins, api, ...rest } = props
  // The executor card offers the Host's detected installations, so this page reads
  // the same snapshot the status card does instead of guessing from the config.
  const runtime = useRuntime(api)
  // Installed state changes while the host runs (the status card can install it), so the
  // page resolves it on open instead of trusting the value captured at boot.
  const [installed, setInstalled] = useState<boolean>()
  useEffect(() => {
    setInstalled(undefined)
    if (plugins === undefined) return
    let current = true
    void Promise.resolve().then(() => plugins.listPlugins()).then(list => {
      if (!current) return
      const { state } = companionStatus(list)
      setInstalled(state === 'unknown' ? undefined : state === 'present')
    }).catch(() => { if (current) setInstalled(undefined) })
    return () => { current = false }
  }, [plugins])
  return <RowForm {...rest} pwsh7Installed={installed} Switch={Switch}
    executor={{ api, snapshot: runtime.snapshot, busy: runtime.busy, refresh: () => void runtime.refresh() }} />
}
