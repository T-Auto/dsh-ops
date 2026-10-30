/**
 * The detail-page status section: the one card a row's or the bundle's page gets.
 *
 * It reports only what the Host actually answered. The runtime snapshot exists
 * today; per-row tool-suppression facts do not, so a row without runtime facts
 * renders nothing instead of inventing a green status. A disabled bundle or row
 * renders nothing at all, matching the proposal in issue #462.
 */
import type { PluginDetailProps } from '../adapter/dsh/types.js'
import type { RuntimeRemote, RuntimeSnapshot } from '../settings/runtime-contract.js'
import { useEffect, useState } from 'react'
import { useRuntime } from './runtime.js'
import { PLAN_KEYS } from './locales.js'
import type { LocaleKey } from './row-schema.js'
import type { Translator } from './locales.js'

/** This plugin's package name; the detail slot is mounted for every plugin. */
const PACKAGE = 'dsh-ops'
/** The companion plugin this page can install; the only spec it is allowed to pass. */
const PWSH7 = 'dsh-win-pwsh7'

/** The host installer surface this page uses (a subset of `pluginManager`). */
export interface PluginInstaller {
  listPlugins(): Promise<unknown>
  /** The host requires the options object as a second argument, even when empty. */
  installBundle(spec: string, options?: Record<string, unknown>): Promise<unknown>
  /** Optional: resolve the spec first, so the preview can name the version. */
  inspect?(spec: string): Promise<unknown>
}
import { ROW_ID } from './row-schema.js'

/** One labelled fact of the status card. */
export interface StatusFact { readonly label: string; readonly value: string }
/** The status card content, derived from a snapshot alone. */
export interface StatusView { readonly summary: string; readonly facts: readonly StatusFact[]; readonly note: string }

const none = (t: Translator): string => t('statusNone')

/**
 * Map a runtime snapshot onto the facts an operator can verify.
 * @param snapshot - the Host answer, or undefined before the first one.
 * @param t - the row's locale.
 * @returns the fact list and the footnote.
 */
export function statusView(snapshot: RuntimeSnapshot | undefined, t: Translator): StatusView {
  const note = t('runtimeHelp')
  if (snapshot === undefined) return { summary: t('summaryNone'), facts: [], note }
  const managed = [...new Set(snapshot.managed.map(entry => entry.version))].join(', ')
  const facts: StatusFact[] = [
    { label: t('statusPlatform'), value: snapshot.platform },
    { label: t('statusManaged'), value: managed === '' ? none(t) : managed },
    { label: t('statusGit'), value: snapshot.git.length === 0 ? none(t) : snapshot.git.join(', ') },
    { label: t('statusPwsh'), value: snapshot.powerShell.supported
      ? `${t('statusPwshReady')}${snapshot.powerShell.version === undefined ? '' : `（${snapshot.powerShell.version}）`}`
      : (snapshot.powerShell.unavailable ?? none(t)) },
  ]
  const summary = snapshot.managed.length > 0 ? t('summaryManaged') : snapshot.git.length > 0 ? t('summaryGit') : t('summaryNone')
  return { summary, facts, note }
}


/** Translate the host's invariant plan lines, keeping any line this page cannot parse. */
export function planLine(line: string, t: Translator): string {
  const download = /^Download (\S+)$/.exec(line)
  if (download !== null) return t('planDownload', { url: download[1] })
  const version = /^Version: ([\w.]+); bytes: (\d+); SHA-256: ([0-9a-f]+)$/i.exec(line)
  if (version !== null) return t('planVersion', { version: version[1], bytes: version[2], sha: version[3] })
  const directory = /^Install into (.+)$/.exec(line)
  if (directory !== null) return t('planInstallInto', { directory: directory[1] })
  if (line.startsWith('The pinned archive and executable are verified')) return t('planVerified')
  if (line.startsWith('Stop running Bash jobs before removal')) return t('planStopJobs')
  return line
}

/** Whether this subject has a status section at all. */
export function hasStatus(subject: PluginDetailProps['subject']): boolean {
  if (subject.kind === 'item') return false
  // The section belongs to this plugin only: the slot is mounted for every detail
  // page, so matching on the subject kind alone painted the card on other plugins.
  if (subject.pkg.name !== PACKAGE) return false
  if (subject.kind === 'bundle') return true
  return subject.row.rowId === ROW_ID
}

/**
 * The `plugins.detail.section` contribution.
 * @param props - the page subject, its translator and the runtime remote.
 * @returns the section, or null on a page it has nothing for.
 */
export function DiagnosticsSection(props: PluginDetailProps & { t: Translator; api: RuntimeRemote; plugins?: PluginInstaller }) {
  const { subject, t, api, plugins } = props
  if (!hasStatus(subject)) return null
  const enabled = subject.kind === 'bundle' ? subject.pkg.enabled : subject.kind === 'row' ? subject.row.enabled : false
  if (!enabled) return null
  return <RuntimeStatus api={api} t={t} plugins={plugins} />
}

function RuntimeStatus({ api, t, plugins }: { api: RuntimeRemote; t: Translator; plugins?: PluginInstaller }) {
  const runtime = useRuntime(api)
  const view = statusView(runtime.snapshot, t)
  const [install, setInstall] = useState<'idle' | 'planned' | 'running' | 'done' | 'failed'>('idle')
  const [pwshPlan, setPwshPlan] = useState<{ version?: string; reason?: string }>({})
  const [elapsed, setElapsed] = useState(0)
  const [installError, setInstallError] = useState('')
  // installBundle blocks until the host applies it; a ticking line is the only honest
  // progress signal a page has, and it proves the action is not frozen.
  useEffect(() => {
    if (install !== 'running') return
    setElapsed(0)
    const timer = setInterval(() => setElapsed(seconds => seconds + 1), 1000)
    return () => clearInterval(timer)
  }, [install])
  const [workElapsed, setWorkElapsed] = useState(0)
  useEffect(() => {
    if (!runtime.busy) return
    setWorkElapsed(0)
    const timer = setInterval(() => setWorkElapsed(seconds => seconds + 1), 1000)
    return () => clearInterval(timer)
  }, [runtime.busy])
  const openPwshPlan = async (): Promise<void> => {
    setInstall('planned'); setPwshPlan({})
    if (plugins?.inspect === undefined) return
    try {
      const answer = await plugins.inspect(PWSH7) as { status?: string; version?: string; reason?: string }
      setPwshPlan({ ...(typeof answer?.version === 'string' ? { version: answer.version } : {}),
        ...(answer?.status === 'accepted' || answer?.status === undefined ? {} : { reason: answer.reason ?? answer.status }) })
    } catch { setPwshPlan({ reason: t('pwsh7PlanUnknown') }) }
  }
  // The companion plugin's own state: the host's plugin list is the only source.
  const [companion, setCompanion] = useState<{ state: 'unknown' | 'absent' | 'present'; version?: string }>({ state: 'unknown' })
  useEffect(() => {
    if (plugins === undefined) return
    let current = true
    void plugins.listPlugins().then(result => {
      if (!current) return
      const list = Array.isArray(result) ? result
        : Array.isArray((result as { value?: unknown })?.value) ? (result as { value: unknown[] }).value : undefined
      // A plugin row carries entryId/moduleName/patchId, not a package `name`.
      const entry = list?.find(row => typeof row === 'object' && row !== null
        && ['entryId', 'moduleName', 'patchId'].some(key => typeof (row as Record<string, unknown>)[key] === 'string'
          && ((row as Record<string, string>)[key]).includes(PWSH7))) as { version?: string } | undefined
      setCompanion(list === undefined ? { state: 'unknown' } : entry === undefined ? { state: 'absent' } : { state: 'present', version: entry.version })
    }).catch(() => { if (current) setCompanion({ state: 'unknown' }) })
    return () => { current = false }
  }, [plugins])
  const installPwsh7 = async (): Promise<void> => {
    if (plugins === undefined) return
    setInstall('running')
    try {
      const result = await plugins.installBundle(PWSH7, {}) as { application?: string; reason?: string; message?: string; error?: { message?: string } } | undefined
      if (result?.application === 'failed' || result?.application === 'cancelled') {
        // Keep the host's own words: a generic refusal hides the only actionable detail.
        setInstallError(result.reason ?? result.error?.message ?? result.message ?? '')
        setInstall('failed'); return
      }
      setCompanion({ state: 'present' }); setInstall('done')
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error))
      setInstall('failed')
    }
  }
  const owned = runtime.snapshot?.managed.some(entry => entry.owned) === true
  const win32 = runtime.snapshot?.platform === 'win32'
  return <section className="ops-detail" aria-label={t('runtime')}>
    <div className="ops-status-card">
      <div className="ops-detail-head">
        <h3 className="ops-detail-title">{t('runtimeTitle')}</h3>
        {runtime.at !== undefined && <span className="ops-detail-metric">{t('refreshedAt')} {runtime.at}</span>}
        <button type="button" className="ops-small ops-detail-action" disabled={runtime.busy}
          onClick={() => void runtime.refresh()}>{runtime.busy ? t('redetecting') : t('redetect')}</button>
      </div>
      {runtime.snapshot === undefined
        ? <p className="ops-note" role="status">{runtime.message === '' ? t('noRuntime') : runtime.message}</p>
        : <>
          <div className="ops-status-body">
            <p className="ops-status-lead">{view.summary}</p>
            <dl className="ops-facts">
              {view.facts.filter(fact => fact.label !== t('statusManaged')).map(fact => <div key={fact.label}>
                <dt>{fact.label}</dt><dd>{fact.value}</dd>
              </div>)}
              <div><dt>{t('statusManaged')}</dt><dd>{runtime.snapshot.managed.length === 0
                ? <>{t('statusNone')}{win32 && <button type="button" className="ops-link ops-row-action" disabled={runtime.busy}
                  onClick={() => void runtime.preview('install-bash')}>{t('installAction')}</button>}</>
                : <>{runtime.snapshot.managed.map(entry => entry.version).join(', ')}{owned && <button type="button"
                  className="ops-link ops-row-action" disabled={runtime.busy}
                  onClick={() => void runtime.preview('remove-bash')}>{t('removeAction')}</button>}</>}</dd></div>
              <div><dt>{t('pwsh7Plugin')}</dt><dd>{companion.state === 'present'
                ? `${t('pwsh7Present')}${(companion.version ?? runtime.snapshot?.companion) === undefined ? '' : `（${companion.version ?? runtime.snapshot?.companion}）`}`
                : <>{t('statusNone')}{plugins !== undefined && <button type="button" className="ops-link ops-row-action"
                  aria-label={t('installPwsh7')} onClick={() => void openPwshPlan()}>{t('installAction')}</button>}</>}</dd></div></dl>
            <p className="ops-status-note">{view.note}</p>
          </div>
        </>}
      {install === 'planned' && <div className="ops-preview" role="region" aria-label={t('preview')}>
        <ul>
          <li>{pwshPlan.version === undefined ? t('pwsh7PlanSource') : t('pwsh7PlanVersion', { version: pwshPlan.version })}</li>
          <li>{t('pwsh7PlanRestart')}</li>
        </ul>
        {pwshPlan.reason !== undefined && <p className="ops-note" role="status">{pwshPlan.reason}</p>}
        <div className="ops-actions">
          <button type="button" className="ops-primary" disabled={runtime.busy}
            onClick={() => void installPwsh7()}>{t('execute')}</button>
          <button type="button" className="ops-text-button" onClick={() => setInstall('idle')}>{t('dismiss')}</button>
        </div>
      </div>}
      {install !== 'idle' && install !== 'planned' && <p className="ops-note" role="status">
        {install === 'running' ? t('pwsh7Installing', { seconds: elapsed }) : install === 'done' ? t('pwsh7Installed') : `${t('pwsh7Failed')}${installError === '' ? '' : ` ${installError}`}`}
      </p>}
      {runtime.plan !== undefined && <div className="ops-preview" role="region" aria-label={t('preview')}>
        {/* The host plans in English; the page states the action in its own language and
            keeps the host's exact lines behind a disclosure as technical detail. */}
        <p className="ops-status-lead">{t(PLAN_KEYS[runtime.plan.action] ?? PLAN_KEYS['install-bash'])}</p>
        <ul>{runtime.plan.details.map((line, index) => <li key={index}>{planLine(line, t)}</li>)}</ul>
        {runtime.plan.reason !== undefined && <p className="ops-note" role="status">{runtime.plan.reason}</p>}
        <div className="ops-actions">
          <button type="button" className="ops-primary" disabled={!runtime.plan.available || runtime.busy}
            onClick={() => void runtime.execute()}>{t('execute')}</button>
          <button type="button" className="ops-text-button" disabled={runtime.busy}
            onClick={() => runtime.dismiss()}>{t('dismiss')}</button>
        </div>
      </div>}
      {runtime.busy && <p className="ops-note" role="status">{t('busySeconds', { seconds: workElapsed })}</p>}
      {runtime.busy && <button type="button" className="ops-text-button" onClick={() => runtime.cancel()}>{t('cancel')}</button>}
      {runtime.result !== undefined && <div className="ops-result" role="status">
        {/* The host answers in English; show a localised summary and keep its sentence
            only when it explains a failure. */}
        <p>{runtime.result.status === 'completed' ? t('resultApplied') : `${t('resultFailed')}${runtime.result.message}`}</p>
        {runtime.result.exitCode !== undefined && <p>{t('exitCode')}: {runtime.result.exitCode ?? '—'}</p>}
        {runtime.result.effectState === 'unknown' && <p>{t('unknownEffect')}</p>}
      </div>}
      {runtime.message !== '' && runtime.snapshot !== undefined && <p className="ops-field-error" role="status">{runtime.message}</p>}
    </div>
  </section>
}
