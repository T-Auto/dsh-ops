/** Optional read-only panel. Missing tuiPanels leaves only this component pending. */
import type { Context } from '../../adapter/dsh/types.js'
import type {} from '../../adapter/dsh/types.js'
import type { AttentionLevel } from '../../tui/attention.js'
import { createActivityStore, resolveActivityConfig } from '../../tui/activity.js'
import { createOpsPanel } from '../../tui/panel.js'
import { createAttentionStore } from '../../tui/attention.js'
import { retired as retiredLegacyRow } from '../../settings/legacy.js'

export { Config } from '../../settings/tui-config.js'
export const name = 'dsh-ops-tui'
export const inject = ['tuiPanels']
export { resolveActivityConfig as resolveTuiConfig }

/** Narrow injected API-v1 surface, independent of a host TUI/React installation. */
export interface TuiPanels {
  register(descriptor: { apiVersion: 1; id: string; title: string; minColumns: number; component: ReturnType<typeof createOpsPanel> }): unknown
  list(): readonly { id: string }[]
  badge(id: string, value: { level: AttentionLevel | undefined; unread: number } | null): void
}
export function apply(ctx: Context, rawConfig?: unknown): void {
  if (retiredLegacyRow(ctx, 'tui')) return
  const config = resolveActivityConfig(rawConfig)
  const panels = ctx.get('tuiPanels') as TuiPanels
  const store = createActivityStore(config)
  const attention = createAttentionStore()
  const dispose = panels.register({ apiVersion: 1, id: 'overview', title: 'OPS', minColumns: 28,
    component: createOpsPanel(store, attention) })
  if (typeof dispose !== 'function') {
    attention.dispose(); store.dispose()
    ctx.logger?.warn?.('dsh-ops: TUI panel API v1 registration was declined; OPS tools are unchanged.')
    return
  }
  // list() returns this activation's host-prefixed IDs, unlike register()'s disposer.
  const panelId = panels.list().find(panel => panel.id.endsWith(':overview'))?.id
  const unsubscribe = attention.subscribe(() => {
    const alert = attention.snapshot()
    try { if (panelId) panels.badge(panelId, alert.unread ? { level: alert.level, unread: alert.unread } : null) }
    catch { /* A presentation failure cannot escape into the committed event observer. */ }
  })
  ctx.on('session/event', (session, event) => {
    if (store.observe(session.id, event) && (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch')) {
      attention.observe(store.snapshot(session.id).recent[0])
    }
  })
  ctx.effect(() => () => { unsubscribe(); dispose(); attention.dispose(); store.dispose() })
}
