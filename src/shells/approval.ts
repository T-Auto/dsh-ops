// Adapted from @deepseek-ai/dsh-tool-bash 0.2.0-rc.2 (MIT). See licenses/deepseek-harness/LICENSE.
/** Per-call widening follows the pinned host approval vocabulary; grants are never cached. */
import type { ShellContext, ShellCall, ShellPolicy } from './types.js'
import { BashArgumentError } from './argument-error.js'
import { BASH_TOOL_NAME } from './constants.js'
import { sameAuthority } from '../authority-paths.js'

const modes: ShellPolicy['mode'][] = ['read-only', 'workspace-write', 'danger-full-access']
type EscalationArgs = Record<string, unknown> & { sandbox_permissions?: 'workspace-write' | 'danger-full-access'; justification?: string }

export function validateBashEscalation(args: Record<string, unknown>, standing: ShellPolicy): asserts args is EscalationArgs {
  const target = args.sandbox_permissions
  const reason = args.justification
  if (target !== undefined && target !== 'workspace-write' && target !== 'danger-full-access') {
    throw new BashArgumentError('invalid sandbox_permissions: expected workspace-write or danger-full-access', 'sandbox_permissions')
  }
  if (reason !== undefined && typeof reason !== 'string') throw new BashArgumentError('invalid justification: expected a string', 'justification')
  if (target === undefined && reason?.trim()) throw new BashArgumentError('invalid justification: requires sandbox_permissions', 'justification')
  if (target !== undefined && target !== standing.mode && !reason?.trim()) {
    throw new BashArgumentError('invalid justification: a different sandbox_permissions mode requires a non-empty reason', 'justification')
  }
  if (target !== undefined && modes.indexOf(target) < modes.indexOf(standing.mode)) {
    throw new BashArgumentError('invalid sandbox_permissions: the requested mode is narrower than the current mode', 'sandbox_permissions')
  }
}

export async function approveBashPolicy(ctx: ShellContext, args: Record<string, unknown>, exec: ShellCall, standing: ShellPolicy): Promise<ShellPolicy> {
  validateBashEscalation(args, standing)
  if (args.sandbox_permissions === undefined || args.sandbox_permissions === standing.mode) return standing
  const approval = ctx.get('approval')
  if (!exec?.agent || !approval?.request) throw new Error('APPROVAL_UNAVAILABLE: no command executed; approval is unavailable. Do not bypass the session policy.')
  const outcome = await approval.request({ agent: exec.agent, callId: exec.callId, toolName: BASH_TOOL_NAME,
    reason: args.justification!, signal: exec.signal })
  if (outcome !== 'allowed-once') throw new Error(`APPROVAL_${String(outcome).toUpperCase().replaceAll('-', '_')}: no command executed; the requested wider mode was not granted. Do not retry or bypass this decision.`)
  exec.signal?.throwIfAborted()
  const current = ctx.get('sandboxPolicy')?.resolve({ session: exec.agent.session })
  if (!current || !sameAuthority(current, standing)) {
    throw new Error('AUTHORITY_CHANGED: session policy changed while approval was pending; no command executed.')
  }
  return { ...standing, mode: args.sandbox_permissions }
}
