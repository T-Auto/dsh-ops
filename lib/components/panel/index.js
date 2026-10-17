/**
 * `dsh-ops/panel`: opt-in, static-file capture of new conversations into the
 * session's own working directory (issue #205 §五).
 *
 * The row is inserted enabled so its config is addressable in the settings
 * editor, and the switch inside it (`capture`, the settings item 「启动数据检测」)
 * is **off by default**. Off means exactly nothing: no listener, no effect, no
 * directory, no file, no timer — `apply` returns after validating its own config,
 * which is what makes "default off ⇒ zero overhead" checkable rather than a
 * claim. The component registers no UI panel, opens no port, and reads and writes
 * nothing outside `<cwd>/.dsh-ops/panel/`.
 *
 * @module dsh-ops/components/panel
 */

import { readFileSync } from 'node:fs'
import { createPanelCollector, resolvePanelConfig } from '../../panel/collect.js'

export const name = 'dsh-ops-panel'

/** Validator the bundle gate and this component share. */
export { resolvePanelConfig }

/** Report the way the rest of the plugin does, without inventing a second logger. */
function report(ctx, message, level = 'error') {
  const logger = ctx?.logger
  if (typeof logger?.[level] === 'function') logger[level](message)
  else if (level === 'warn') console.warn(message)
  else console.error(message)
}

/** The shipped package version, for the provenance block; absent is acceptable. */
function pluginVersion() {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version } catch { return undefined }
}

/**
 * Mount the capture sink when the row asks for it.
 * @param {object} ctx - the host plugin context.
 * @param {unknown} rawConfig - the row config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  // Malformed config fails the row loud, exactly like the other components.
  const config = resolvePanelConfig(rawConfig)
  if (!config.capture) return
  const collector = createPanelCollector({
    config,
    report: (message, level) => report(ctx, message, level),
    meta: { pluginVersion: pluginVersion(), argv: process.argv.slice(2), platform: process.platform, node: process.version },
  })
  ctx.on('session/event', (session, event) => { collector.observe(session, event) })
  ctx.on('session/disposed', (session) => { void collector.close(session?.id) })
  // Sealing is asynchronous and best effort; `dispose` never rejects, and the
  // teardown must not wait on it (a slow disk cannot hold a shutdown open).
  ctx.effect(() => () => { void collector.dispose() }, 'dsh-ops: panel capture')
}
