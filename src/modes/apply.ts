/**
 * Apply one enhanced-preset mode row.
 *
 * Each row is self-contained: it registers its mode in the shared registry, then
 * publishes only for Agents composed from its preset. The native file surface is
 * registered per Agent, the Windows shell layer and the PTC SDK are gated by the
 * same preset test, and the replacement controller hides only official tools
 * whose OPS counterpart is visible. Compatibility mode is a runtime switch that
 * lifts those hides without unloading any row.
 */
import type { Context } from '../adapter/dsh/types.js'
import type { Agent } from '../adapter/dsh/types.js'
import { apply as mountPtc } from '../ptc/index.js'
import { mountSessionBash, type BashGate } from '../session-shells.js'
import { resolveShells } from '../shells.js'
import { mountWorkspacePreparation } from '../workspace-preparation.js'
import { resolveModeConfig, type ModeConfig } from './config.js'
import { modeOf } from './detect.js'
import { mountNative } from '../publication/native.js'
import { MODE_PLANS, NATIVE_RESIDENT_RAW, SHELL_OFFICIAL_NAMES } from './plan.js'
import { OFFICIAL_REPLACEMENTS } from '../official-tool-catalog.js'
import { BASH_TOOL } from '../policy.js'
import { integrationFor } from '../integration/registry.js'
import { joinMode, onModesChange, compatibilityOn } from './registry.js'
import { mountReplacements } from '../publication/replacements.js'
import type { ModeId } from './types.js'

/** Built-in product replacement policy; generic publication does not know preset ids. */
export function replacementTargets(mode: ModeId, platform: string = process.platform, hidePwsh = true): ReadonlyMap<string, string> {
  const targets = new Map<string, string>()
  for (const official of MODE_PLANS[mode].replacements) targets.set(official, OFFICIAL_REPLACEMENTS[official])
  // With `hidePwsh: false` the official shell stays visible: the session gets both
  // the host shell and ops_bash, and the model chooses.
  if (MODE_PLANS[mode].shell && platform === 'win32' && hidePwsh) for (const official of SHELL_OFFICIAL_NAMES) targets.set(official, BASH_TOOL)
  return targets
}

export function applyMode(root: Context, rawConfig: unknown, mode: ModeId): void {
  applyResolvedMode(root, resolveModeConfig(rawConfig, mode), mode)
}

/**
 * Apply a mode from a config that was already resolved and validated.
 * @param root - the fiber mounting the feature.
 * @param config - the resolved mode configuration.
 * @param mode - the preset this feature publishes for.
 */
export function applyResolvedMode(root: Context, config: ModeConfig, mode: ModeId): void {
  const plan = MODE_PLANS[mode]
  const leave = joinMode(root, mode, config)
  root.effect(() => () => leave(), `dsh-ops: ${mode} mode switch`)
  const matches = (agent: Agent): boolean => integrationFor(root, agent) === undefined && modeOf(root, agent) === mode
  const watch = (notify: () => void): (() => void) => onModesChange(root, notify)
  // The Windows shell replacement is the only shell work a mode row performs:
  // POSIX sessions already run the host's bash, so OPS publishes nothing there.
  if (plan.shell && process.platform === 'win32' && config.bash) {
    mountWorkspacePreparation(root)
    const gate: BashGate = { allows: matches, watch }
    const shells = resolveShells(config)
    root.inject(['tools'], ctx => { mountSessionBash(ctx, config, shells, gate) })
  }
  // `hideOfficialTools: false` keeps the official file tools published: the OPS
  // resident tools coexist with them and nothing is hidden.
  if (config.hideOfficialTools) {
    mountReplacements(root, { id: mode, targets: replacementTargets(mode, process.platform, config.hidePwsh), gate: { allows: matches, watch }, keepOfficial: () => compatibilityOn(root) })
  }
  if (plan.nativeFiles && config.residentTools) mountNative(root, config, { id: mode, tools: NATIVE_RESIDENT_RAW,
    section: plan.section === null ? null : `mode-${plan.section}`, gate: { allows: matches, watch } })
  if (plan.ptc) {
    mountPtc(root, {
      binaryPath: config.binaryPath, required: config.required,
      allowedTools: config.allowedTools, alwaysLoaded: config.alwaysLoaded,
    }, { allows: matches, watch, resident: config.residentTools, dynamic: config.dynamicTools })
  }
}
