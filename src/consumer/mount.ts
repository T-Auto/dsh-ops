/** One assembly path: consumers supply policy, publishers own registration and execution. */
import type { Agent, Context } from '../adapter/dsh/types.js'
import { resolveShells } from '../shells.js'
import { mountSessionBash } from '../session-shells.js'
import { mountWorkspacePreparation } from '../workspace-preparation.js'
import { mountNative } from '../publication/native.js'
import { mountReplacements } from '../publication/replacements.js'
import { mountDiscovery } from '../discovery/controller.js'
import { mountPtc } from '../publication/ptc.js'
import { NATIVE_RESIDENT_RAW } from '../capabilities/profiles.js'
import { BASH_TOOL, publicToolName } from '../policy.js'
import { BASH_PROMPT_SECTION, renderBashGuidance, renderBashUnavailable } from '../shells/prompt.js'
import { mountJobWaitGuidance } from '../shells/job-wait-guidance.js'
import { mountSpillRetention } from '../shells/spill-retention-runtime.js'
import { spillRetentionConfig } from '../shells/spill-retention.js'
import type { ConsumerPlan } from './types.js'

export function mountConsumer(ctx: Context, plan: ConsumerPlan): void {
  const { gate, core } = plan
  let renderShellGuidance: (agent: Agent) => string = () => ''
  const shellOwnsGuidance = (agent: Agent): boolean => Boolean(core.extraGuidance.trim()) && Boolean(renderShellGuidance(agent))
  if (plan.shell) {
    // Host subprocess spills outlive the call that produced them upstream, so the
    // row that publishes the shell also owns one bounded retention runtime.
    const releaseSpillRetention = mountSpillRetention(spillRetentionConfig(core), {
      report: message => ctx.logger?.warn?.(message),
    })
    ctx.effect(() => () => releaseSpillRetention(), 'dsh-ops: spill retention')
    if (process.platform === 'win32') mountWorkspacePreparation(ctx)
    const shells = resolveShells(core)
    // Resolved once at mount: a slot whose executor never resolved publishes no tool at all, so the
    // section below has to report that instead of rendering nothing for the whole session.
    const bashResolution = shells.bash
    ctx.inject(['tools'], inner => mountSessionBash(inner, core, shells, gate))
    if (core.promptPolicy) ctx.inject(['tools', 'systemPrompt'], inner => {
      mountJobWaitGuidance(inner, plan.id, gate)
      let active = true
      inner.effect(() => () => { active = false }, 'dsh-ops: Bash guidance lifetime')
      // Every consumer of this slot shares one extra-guidance block, so the notice and the normal
      // guidance must deliver it the same way: exactly once, whichever branch wins.
      const withExtra = (text: string): string => [text, core.extraGuidance.trim()].filter(Boolean).join('\n\n')
      renderShellGuidance = agent => {
        if (!active || !agent || !gate.allows(agent)) return ''
        const definition = inner.get('tools')?.get(BASH_TOOL, agent)
        if (!definition) return bashResolution.available ? '' : withExtra(renderBashUnavailable(bashResolution.source, bashResolution.detail))
        const background = Object.hasOwn(definition.parameters.properties ?? {}, 'run_in_background')
        return withExtra(renderBashGuidance(background))
      }
      inner.effect(() => inner.systemPrompt.section({ name: `${BASH_PROMPT_SECTION}:${plan.id}`, order: inner.systemPrompt.getSectionOrder('TOOL_BASH'), interpolate: false,
        text: context => renderShellGuidance(context.agent ?? context.scope as Agent),
      }), 'dsh-ops: consumer Bash guidance')
    })
  }
  if (plan.presentation === 'native') {
    const residents = plan.files && plan.residentTools ? (plan.residentNames ?? NATIVE_RESIDENT_RAW) : []
    const nativeOwnsGuidance = residents.length
      ? mountNative(ctx, core, { id: plan.id, tools: residents, section: plan.section, gate, extraGuidanceOwner: shellOwnsGuidance })
      : () => false
    if (plan.discovery || plan.native.alwaysLoaded.length || plan.external.allowed.length) mountDiscovery(ctx,
      { ...plan.native, enabled: plan.discovery }, { ...gate, guidance: core.promptPolicy, extraGuidance: core.extraGuidance,
        extraGuidanceOwner: agent => shellOwnsGuidance(agent) || nativeOwnsGuidance(agent),
        residentTools: () => residents.map(publicToolName), external: plan.external })
  } else if (plan.files) mountPtc(ctx, plan.ptc, { ...gate, guidance: core.promptPolicy, resident: plan.residentTools, dynamic: plan.discovery })
  if (plan.replaceOfficial) mountReplacements(ctx, { id: plan.id, targets: plan.replacementTargets, gate, keepOfficial: () => false })
}