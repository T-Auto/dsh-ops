/** Built-in defaults are plans for the same assembler used by external presets. */
import type { Context, Agent } from '../adapter/dsh/types.js'
import { mountConsumer } from '../consumer/mount.js'
import type { ConsumerGate } from '../consumer/types.js'
import { replacementTargets as consumerTargets } from '../consumer/replacements.js'
import { resolveDiscoveryConfig, type DiscoveryConfig } from '../discovery/config.js'
import { resolveModeConfig, type ModeConfig } from './config.js'
import { modeOf } from './detect.js'
import { MODE_PLANS } from './defaults.js'
import { integrationFor } from '../consumer/registry.js'
import { joinMode, onModesChange } from './registry.js'
import type { ModeId } from './types.js'

export function replacementTargets(mode: ModeId, platform: string = process.platform, hidePwsh = false): ReadonlyMap<string, string> {
  return consumerTargets(MODE_PLANS[mode].nativeFiles, MODE_PLANS[mode].shell && hidePwsh, platform as NodeJS.Platform)
}
export function applyMode(root: Context, rawConfig: unknown, mode: ModeId): void {
  applyResolvedMode(root, resolveModeConfig(rawConfig, mode), mode)
}
/**
 * The gate one built-in mode hands its consumer.
 *
 * The consumer forwards its gate keys to the PTC publication, so the batching
 * switch rides here instead of changing the PTC configuration contract.
 * @param root - the row context the gate observes mode changes on.
 * @param mode - the mode the gate admits.
 * @param batching - whether the PTC publication delivers batching guidance.
 * @returns a consumer gate that also carries the batching switch.
 */
export function modeGate(root: Context, mode: ModeId, batching: boolean): ConsumerGate & { batching: boolean } {
  return {
    allows: (agent: Agent) => integrationFor(root, agent) === undefined && modeOf(root, agent) === mode,
    watch: (notify: () => void) => onModesChange(root, notify),
    batching,
  }
}
export interface BuiltinConsumerOptions { discovery?: DiscoveryConfig; enabled?: boolean; dynamic?: boolean }
export function applyResolvedMode(root: Context, config: ModeConfig, mode: ModeId, options: BuiltinConsumerOptions = {}): void {
  const plan = MODE_PLANS[mode]
  const enabled = options.enabled !== false
  if (enabled) {
    const leave = joinMode(root, mode, config)
    root.effect(() => leave, `dsh-ops: ${mode} consumer`)
  }
  const gate = modeGate(root, mode, config.batchingGuidance)
  // Standalone legacy mode rows leave discovery to their explicit discovery row.
  const discovery = options.discovery ?? resolveDiscoveryConfig({ enabled: false, allowedTools: [] })
  mountConsumer(root, {
    id: mode, gate, core: config, files: enabled && (plan.nativeFiles || plan.ptc),
    shell: enabled && plan.shell && config.bash && process.platform === 'win32',
    presentation: plan.ptc ? 'ptc' : 'native', residentTools: enabled && config.residentTools,
    discovery: plan.ptc ? config.dynamicTools : options.discovery !== undefined && options.dynamic !== false && discovery.enabled,
    native: discovery, ptc: { binaryPath: config.binaryPath, required: config.required, allowedTools: config.allowedTools, alwaysLoaded: config.alwaysLoaded },
    replaceOfficial: enabled && (config.hideOfficialTools || config.hidePwsh),
    replacementTargets: consumerTargets(config.hideOfficialTools && plan.nativeFiles, config.hidePwsh && config.bash && plan.shell),
    section: plan.section === null ? null : `mode-${plan.section}`,
    external: { allowed: [], alwaysLoaded: [], disabled: [] },
  })
}
