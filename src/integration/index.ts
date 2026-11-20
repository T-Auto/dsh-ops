/** Stable opt-in preset entry. Consumers share the same assembler as built-in presets. */
import type { Agent, Context } from '../adapter/dsh/types.js'
import { mountConsumer } from '../consumer/mount.js'
import { replacementTargets } from '../consumer/replacements.js'
import { resolveIntegrationConfig, type IntegrationOptions, type IntegrationConfig } from '../consumer/options.js'
import { mountDiagnostics } from './diagnostics.js'
import { joinIntegration, integrationFor } from '../consumer/registry.js'
import { modeOf } from '../presets/detect.js'
import { onModesChange } from '../presets/registry.js'
import type { ModeId } from '../presets/types.js'
export { diagnose } from './diagnostics.js'
export type { Diagnostic } from './diagnostics.js'
export { registerNativeCapability } from '../discovery/providers.js'
export type { NativeCapability } from '../discovery/providers.js'
export { resolveIntegrationConfig } from '../consumer/options.js'
export type { IntegrationOptions, IntegrationProfile } from '../consumer/options.js'
export const name = 'dsh-ops-integration'
export async function apply(ctx: Context, raw: unknown): Promise<void> {
  return mountIntegration(ctx, resolveIntegrationConfig(raw))
}
/** Internal resolved-plan entry: global gates suppress capabilities without revalidating saved intent. */
export async function mountIntegration(ctx: Context, config: IntegrationConfig): Promise<void> {
  const binding = await joinIntegration(ctx, config)
  ctx.effect(() => binding.dispose, 'dsh-ops: preset integration binding')
  let active = true
  ctx.effect(() => () => { active = false }, 'dsh-ops: consumer lifetime')
  const gate = { allows: (agent: Parameters<typeof binding.allows>[0]) => active && binding.allows(agent), watch: binding.watch }
  mountDiagnostics(ctx, gate)
  if (config.enabled) mountConsumer(ctx, {
    id: config.preset, gate, core: config.core, files: config.files, shell: config.shell,
    presentation: config.presentation, residentTools: config.residentTools, residentNames: config.residentNames,
    discovery: config.discovery, native: config.native, ptc: config.ptc,
    replaceOfficial: config.replaceOfficial || config.hidePwsh,
    replacementTargets: replacementTargets(config.replaceOfficial && config.files && config.presentation === 'native', config.hidePwsh && config.shell),
    section: `preset-${config.preset}`,
    external: { allowed: config.externalTools, alwaysLoaded: config.externalAlwaysLoaded, disabled: config.externalDisabled },
  })
}
/**
 * One built-in mode publishes the same read-only diagnosis (#753): the status
 * tool used to exist only behind an external preset row, so a built-in preset
 * session could not see its own scope at all. The gate admits exactly the
 * sessions of this mode without an external preset - the same row the mode's
 * consumer is admitted by - so the two publications never overlap.
 *
 * The mount settles asynchronously on purpose: the listener this registers
 * inside the tools injection has to be on a fiber that resolves after the
 * synchronous apply returns, or the later `agent/created` dispatch never
 * reaches it - the external preset row reaches the same point by awaiting its
 * binding join, which is why only the built-in loop needed this one step.
 */
export async function mountModeDiagnostics(ctx: Context, mode: ModeId): Promise<void> {
  await Promise.resolve()
  mountDiagnostics(ctx, {
    allows: (agent: Agent) => integrationFor(ctx, agent) === undefined && modeOf(ctx, agent) === mode,
    watch: (notify: () => void) => onModesChange(ctx, notify),
  })
}

/** Mount inside a preset composition or with an explicit preset id at the host root. */
export function integration(options: IntegrationOptions) {
  const captured = structuredClone(options)
  resolveIntegrationConfig(captured)
  return { name, apply(ctx: Context) { return apply(ctx, structuredClone(captured)) } }
}
