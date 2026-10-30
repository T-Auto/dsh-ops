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
import { BASH_TOOL, publicToolName, renderToolingPolicy, TOOLING_SECTION } from '../policy.js'
import type { ConsumerPlan } from './types.js'

export function mountConsumer(ctx: Context, plan: ConsumerPlan): void {
  const { gate, core } = plan
  if (plan.shell) {
    if (process.platform === 'win32') mountWorkspacePreparation(ctx)
    const shells = resolveShells(core)
    ctx.inject(['tools'], inner => mountSessionBash(inner, core, shells, gate))
    if (core.promptPolicy && (!plan.files || !plan.residentTools)) ctx.inject(['tools', 'systemPrompt'], inner => {
      inner.effect(() => inner.systemPrompt.section({ name: `${TOOLING_SECTION}:consumer-shell-${plan.id}`, order: 3254, interpolate: false,
        text: context => {
          const agent = context.agent ?? context.scope as Parameters<typeof gate.allows>[0]
          return agent && gate.allows(agent) ? renderToolingPolicy({ published: inner.get('tools')?.get(BASH_TOOL, agent) ? [BASH_TOOL] : [], extraGuidance: core.extraGuidance }) : ''
        } }), 'dsh-ops: consumer shell guidance')
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
