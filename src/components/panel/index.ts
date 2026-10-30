/** Opt-in capture. A disabled row registers nothing and starts no filesystem work. */
import type { Context } from '../../adapter/dsh/types.js'
import type {} from '../../adapter/dsh/types.js'
import { readFileSync } from 'node:fs'
import { createPanelCollector, resolvePanelConfig } from '../../panel/collect.js'
import { configObject, editable, settingsConfig } from '../../settings/schema.js'
import { retired as retiredLegacyRow } from '../../settings/legacy.js'

export const name = 'dsh-ops-panel'
export { resolvePanelConfig }
export const Config = settingsConfig(value => resolvePanelConfig(configObject(value)), {
  capture: editable('boolean', 'Capture when this row is enabled. Legacy false remains off until explicitly changed to true.'),
  textLimit: editable('number', 'Maximum characters retained per text field (64–100000).'),
  maxSessionBytes: editable('number', 'Maximum bytes per session document (65536–268435456).'),
})
function pluginVersion(): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    return value && typeof value === 'object' && 'version' in value && typeof value.version === 'string' ? value.version : undefined
  } catch { return undefined }
}
export function apply(ctx: Context, rawConfig: unknown): void {
  if (retiredLegacyRow(ctx, 'panel')) return
  const config = resolvePanelConfig(configObject(rawConfig))
  if (!config.capture) {
    ctx.logger.info('dsh-ops: legacy panel capture:false remains off. Set capture:true only when collection is wanted; the row switch stops collection.')
    return
  }
  const collector = createPanelCollector({
    config,
    report: (message: string) => ctx.logger.warn(message),
    meta: { pluginVersion: pluginVersion(), argv: process.argv.slice(2), platform: process.platform, node: process.version },
  })
  ctx.on('session/event', (session, event) => { collector.observe(session, event) })
  ctx.on('session/disposed', session => { void collector.close(session?.id) })
  ctx.effect(() => () => collector.stop(), 'dsh-ops: panel capture')
}
