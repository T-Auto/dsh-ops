/** Single-row composition root. All presets consume the same assembly pipeline. */
import type { Context } from './adapter/dsh/types.js'
import { applyResolvedMode } from './presets/builtin.js'
import { resolveModeConfig } from './presets/config.js'
import { resolveMergedConfig, effectiveMode, dynamicForMode } from './settings/merged.js'
import { beginMergedRow, endMergedRow } from './settings/legacy.js'
import { mountIntegration } from './integration/index.js'
import { gateConsumer } from './consumer/gates.js'
import { resolveIntegrationConfig } from './consumer/options.js'
import { mountRuntimeSettings } from './settings/runtime-host.js'
import { companionVersion } from './settings/companion.js'
import * as panelModule from './components/panel/index.js'
import * as tuiModule from './components/tui/index.js'
import * as downloadGuardModule from './components/download-guard/index.js'
export { Config } from './settings/merged.js'
export { applyComponent } from './legacy/host.js'
export const name = 'dsh-ops'

/**
 * Package-root entry: the single row the bundle inserts.
 *
 * Every feature the row enables is mounted from this one fiber with its own
 * validated slice. Disabling a feature and saving the row remounts the fiber, so
 * its effects are torn down exactly like the old per-row switches did. The TUI
 * link keeps its optional host service: an absent `tuiPanels` leaves that
 * desktop feature pending instead of blocking the tools.
 */

export async function apply(root: Context, rawConfig: unknown): Promise<void> {
  const config = resolveMergedConfig(rawConfig)
  const host = root
  const mount = async (module: { apply(...args: unknown[]): unknown }, state: { enabled: boolean; raw?: Record<string, unknown>; config: unknown }, slice?: Record<string, unknown>): Promise<void> => {
    if (!state.enabled) return
    const payload = slice ?? state.raw ?? state.config
    if (state.raw === undefined && slice === undefined) {
      await host.plugin({ name: `dsh-ops/${moduleName(module)}`, apply: (ctx: Context) => { (module.apply as (ctx: Context, config: unknown) => void)(ctx, state.config) } })
      return
    }
    await host.plugin(module, payload)
  }
  beginMergedRow()
  try {
    // The browser half mounts its `opsSettings` remote; the legacy shell row used
    // to provide that seam, so the merged row owns it now.
    await host.plugin({ name: 'dsh-ops/runtime-settings', apply: (ctx: Context) => mountRuntimeSettings(ctx) })
    for (const mode of ['minimal', 'standard', 'ptc', 'cordis'] as const) {
      const state = config[mode]
      const effective = resolveModeConfig(effectiveMode(state, config.global, typeof config.other.raw?.pwsh7Link === 'boolean' ? config.other.raw.pwsh7Link : companionVersion({ sweep: false }) !== undefined), mode)
      await host.plugin({ name: `dsh-ops/consumer-${mode}`, apply(ctx: Context) {
        applyResolvedMode(ctx, effective, mode, { enabled: state.enabled,
          discovery: { ...config.discovery.config, enabled: config.discovery.enabled },
          dynamic: dynamicForMode(state, config.global) })
      } })
    }
    for (const row of Object.values(config.presets)) {
      const options = row.options
      const resolved = resolveIntegrationConfig(options)
      const linked = typeof config.other.raw?.pwsh7Link === 'boolean' ? config.other.raw.pwsh7Link : companionVersion({ sweep: false }) !== undefined
      const effective = gateConsumer(resolved, config.global, linked)
      await host.plugin({ name: `dsh-ops/custom-${resolved.preset}`, apply(ctx: Context) { return mountIntegration(ctx, effective) } })
    }
    await mount(downloadGuardModule, config['download-guard'])
    await mount(panelModule, config.panel)
    await mount(tuiModule, config.tui)
  } finally { endMergedRow() }
}

/** The module's declared name, for the child plugin label. */
function moduleName(module: unknown): string {
  const value = (module as { name?: unknown }).name
  return typeof value === 'string' ? value : 'feature'
}
