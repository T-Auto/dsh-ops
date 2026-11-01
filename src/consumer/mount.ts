/** One assembly path: consumers supply policy, publishers own registration and execution. */
import type { Context } from '../adapter/dsh/types.js'
import { resolveShells } from '../shells.js'
import { mountSessionBash } from '../session-shells.js'
import { mountWorkspacePreparation } from '../workspace-preparation.js'
import { mountNative } from '../publication/native.js'
import { mountReplacements } from '../publication/replacements.js'
import { mountDiscovery } from '../discovery/controller.js'
import { mountPtc } from '../publication/ptc.js'
import { NATIVE_RESIDENT_RAW } from '../capabilities/profiles.js'
import { BASH_TOOL, publicToolName } from '../policy.js'
import { BASH_PROMPT_SECTION, renderBashGuidance } from '../shells/prompt.js'
import type { ConsumerPlan } from './types.js'

export function mountConsumer(ctx: Context, plan: ConsumerPlan): void {
  const { gate, core } = plan
  if (plan.shell) {
    if (process.platform === 'win32') mountWorkspacePreparation(ctx)
    const shells = resolveShells(core)
    ctx.inject(['tools'], inner => mountSessionBash(inner, core, shells, gate))
    if (core.promptPolicy) ctx.inject(['tools', 'systemPrompt'], inner => {
      inner.effect(() => inner.systemPrompt.section({ name: `${BASH_PROMPT_SECTION}:${plan.id}`, order: inner.systemPrompt.getSectionOrder('TOOL_BASH'), interpolate: false,
        text: context => {
          const agent = context.agent ?? context.scope as Parameters<typeof gate.allows>[0]
          if (!agent || !gate.allows(agent)) return ''
          const definition = inner.get('tools')?.get(BASH_TOOL, agent)
          if (!definition) return ''
          const background = Object.hasOwn(definition.parameters.properties ?? {}, 'run_in_background')
          return [renderBashGuidance(background), core.extraGuidance.trim()].filter(Boolean).join('\n\n')
        } }), 'dsh-ops: consumer Bash guidance')
    })
  }
  if (plan.presentation === 'native') {
    const residents = plan.files && plan.residentTools ? (plan.residentNames ?? NATIVE_RESIDENT_RAW) : []
    if (residents.length) mountNative(ctx, core, { id: plan.id, tools: residents, section: plan.section, gate })
    if (plan.discovery || plan.native.alwaysLoaded.length || plan.external.allowed.length) mountDiscovery(ctx,
      { ...plan.native, enabled: plan.discovery }, { ...gate, guidance: core.promptPolicy, extraGuidance: core.extraGuidance,
        residentTools: () => residents.map(publicToolName), external: plan.external })
  } else if (plan.files) mountPtc(ctx, plan.ptc, { ...gate, guidance: core.promptPolicy, resident: plan.residentTools, dynamic: plan.discovery })
  if (plan.replaceOfficial) mountReplacements(ctx, { id: plan.id, targets: plan.replacementTargets, gate, keepOfficial: () => false })
}
