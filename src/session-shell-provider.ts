/** Product composition selects the runtime; the generic execution owner receives that selection. */
import type { Agent, Context } from './adapter/dsh/types.js'
import type { ResolvedConfig } from './config.js'
import { resolveShells } from './shells/resolve.js'
import { integrationFor } from './consumer/registry.js'
import { enabledModes } from './presets/registry.js'
import { modeOf } from './presets/detect.js'
import { residentShellAdmission } from './execution/resident/shell-owner.js'
import type { ShellLaunchOptions } from './execution/resident/shell-launch.js'
import { NIUBASH_MANIFEST_SHA256 } from './cli/niubash-payload.js'
import { isNiubashExecutable } from './niubash/runtime.js'
import { isQualifiedSessionRuntime } from './niubash/session-runtime.js'

/** Mount once beside residentKernel(), before integrations in their common owning scope. */
export function residentSessionShells() {
  return {
    name: 'dsh-ops-session-shells',
    inject: ['opsKernel'],
    async apply(ctx: Context): Promise<void> {
      if (!isQualifiedSessionRuntime(NIUBASH_MANIFEST_SHA256)) return
      const transport = ctx.opsKernel.shell
      if (!transport.available || !transport.capabilities.includes('shell-v1')
        || !transport.capabilities.includes('shell-spill-v1')) return
      const selections = new WeakMap<ResolvedConfig, ShellLaunchOptions['bash'] | null>()
      function selectBash(agent: Agent) {
        const integration = integrationFor(ctx, agent)
        const mode = modeOf(ctx, agent)
        const builtin = mode === undefined ? undefined : enabledModes(ctx).get(mode)
        const config = integration ? integration.enabled && integration.shell ? integration.core : undefined
          : builtin?.bash ? builtin : undefined
        if (!config?.publishBashTool) return undefined
        if (!selections.has(config)) {
          const bash = resolveShells(config).bash
          selections.set(config, bash.available && isNiubashExecutable(bash.file) ? { file: bash.file, source: bash.source } : null)
        }
        return selections.get(config) ?? undefined
      }
      await ctx.plugin(residentShellAdmission({ transport, selectBash }))
      ctx.on('dsh-ops/modes', () => ctx.get('opsShellAdmission')?.reconcile())
    },
  }
}
