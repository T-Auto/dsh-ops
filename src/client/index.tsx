import type { Context, PluginDetailProps } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import { RUNTIME_REMOTE } from '../settings/runtime-contract.js'
import type { BashSource, RuntimeAction, RuntimeRemote } from '../settings/runtime-contract.js'
import { en, zh } from './locales.js'
import type { Translator } from './locales.js'

/** The slice of the host's remote gateway this half needs. */
interface RemoteHost {
  readonly opsSettings?: RuntimeRemote
  $mount(remote: typeof RUNTIME_REMOTE): Promise<unknown>
}
import { RowSettings } from './row-settings.js'
import { DiagnosticsSection } from './detail.js'
import type { PluginInstaller } from './detail.js'
import type { SettingsProps } from './forms.js'
import { ROW_ID } from './row-schema.js'
import { SETTINGS_CSS } from './styles.js'
export const name = 'dsh-ops-settings'
export const inject = ['slots', 'locale', 'remote']
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register('dshOps', { en, zh }), 'dsh-ops: settings dictionaries')
  // Reach the remote through the service object, not through `ctx.remote.*`: the
  // dotted property is traced and only readable from a context that injects that
  // service, which a render callback is not.
  const remote = ctx.get('remote') as unknown as RemoteHost
  // A missing remote must not blank the page: configuration still works, and the
  // status card reports the failure instead of pretending the runtime is fine.
  let mountError: string | undefined
  try { await remote.$mount(RUNTIME_REMOTE) } catch (error) { mountError = error instanceof Error ? error.message : String(error) }
  // Resolve the namespace once, here: `remote.opsSettings` is traced, so it may
  // only be read from this context. A render callback is not this context, and a
  // lazy read there is exactly what used to crash the status card.
  // The client-side service key is `remote.<namespace>`; read it through the
  // registry (`ctx.get`) because the dotted *property* is traced and throws
  // outside this context. Package name is the documented alias.
  const lookup = (): RuntimeRemote | undefined => (ctx.get('remote.opsSettings') as RuntimeRemote | undefined)
    ?? (ctx.get('remote.dsh-ops') as RuntimeRemote | undefined)
  let mounted: RuntimeRemote | undefined
  try { mounted = lookup() } catch { mounted = undefined }
  // The components already treat a thrown call as a reported failure, so the
  // fallback throws rather than inventing a remote error envelope.
  const reason = mounted === undefined
    ? `dsh-ops: the opsSettings remote is unavailable${mountError === undefined ? '' : `: ${mountError}`}`
    : ''
  const miss = async (): Promise<never> => { throw new Error(reason) }
  const api: RuntimeRemote = mounted ?? { snapshot: miss, plan: miss, select: miss, execute: miss }
  // The host's own installer; a slot render may not read it, so resolve it here.
  const plugins = (ctx.get('remote.pluginManager') ?? undefined) as PluginInstaller | undefined
  let pwsh7Installed: boolean | undefined
  try {
    const list = await plugins?.listPlugins()
    const rows = Array.isArray(list) ? list : (list as { value?: unknown } | undefined)?.value
    if (Array.isArray(rows)) pwsh7Installed = rows.some(row => typeof row === 'object' && row !== null
      && ['entryId', 'moduleName', 'patchId'].some(key => typeof (row as Record<string, unknown>)[key] === 'string'
        && ((row as Record<string, string>)[key]).includes('dsh-win-pwsh7')))
  } catch { pwsh7Installed = undefined }
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshOpsSettings = 'true'; style.textContent = SETTINGS_CSS; document.head.append(style)
    return () => style.remove()
  }, 'dsh-ops: settings styles')
  // One page for the one row the bundle inserts. The row carries the whole
  // configuration, so a saved row override still opens this page.
  ctx.slots.inject('plugins.row.config', function* () {
    yield ctx.slots.register({ name: 'plugins.row.config', key: `${ROW_ID}#${ROW_ID}`, locale: 'dshOps' },
      (props: SettingsProps) => props.view === 'summary'
        ? <>{props.t('rowSummary')}</>
        : <RowSettings {...props} pwsh7Installed={pwsh7Installed} plugins={plugins} />)
  })
  // The status card reports the Host runtime; a row without runtime facts renders
  // nothing, and a disabled bundle or row renders nothing either. Configuration
  // stays on the row's own page, which is the one native slot that hands a page a
  // writable form for this row; the bundle page only carries this card.
  ctx.slots.inject('plugins.detail.section', function* () {
    yield ctx.slots.register({ name: 'plugins.detail.section', id: 'dsh-ops.diagnostics', order: 50, locale: 'dshOps' },
      (props: PluginDetailProps & { t: Translator }) => <DiagnosticsSection {...props} api={api} plugins={plugins} />)
  })
}
