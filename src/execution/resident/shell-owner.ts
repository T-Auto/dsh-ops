/** Service-scoped activation for the internal shell adapter, before any tool publication. */
import type { Context } from '../../adapter/dsh/types.js'
import { createShellAdmissionHost, type ShellAdmissionOptions } from './shell-admission.js'

declare module '@deepseek-ai/cordis' {
  interface Context { opsShellAdmission: ReturnType<typeof createShellAdmissionHost> }
}

/**
 * Withdrawal/replacement of any launch authority provider disposes this owner
 * and awaits every shell close before a replacement adapter can be exposed.
 * The transport itself belongs to the already-ready, activation-owned kernel.
 */
export function residentShellAdmission(options: ShellAdmissionOptions) {
  return {
    name: 'dsh-ops-shell-admission',
    inject: ['agents', 'sandboxPolicy', 'sandbox', 'shellEnv', 'workingDirectory'],
    apply(ctx: Context): void {
      if (ctx.get('opsShellAdmission', false)) throw new Error('A resident shell admission owner is already mounted in this scope.')
      ctx.provide('opsShellAdmission', createShellAdmissionHost(ctx, options))
    },
  }
}
