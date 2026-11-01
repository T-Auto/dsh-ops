/** Conditional guidance after an observed delay; never changes execution or results. */
import type { Agent, Context } from '../adapter/dsh/types.js'
import type { ConsumerGate } from '../consumer/types.js'
import { BASH_TOOL } from '../policy.js'
import { registerSystemSection } from '../prompt-injection/index.js'

const SHELLS = new Set([BASH_TOOL, 'bash', 'pwsh', 'pwsh_persistent', 'shell'])
export const JOB_WAIT_GUIDANCE = 'If you are waiting for an existing host job, use job_output({ wait: true }) with its jobId instead of a separate sleep and later poll. A delay for an external service can still be appropriate when there is no host job to wait for. This hint does not mean a job is running.'

/** Only complete standalone bounded commands qualify; loops and compounds remain opaque. */
export function isLongStandaloneSleep(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const text = command.trim()
  const posix = /^(?:sudo(?:\s+-n)?\s+)?(?:\/(?:usr\/)?bin\/)?sleep(?:\.exe)?\s+(\d+(?:\.\d+)?)([smhd]?)$/.exec(text)
  if (posix) {
    const factor = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[posix[2]]!
    const seconds = Number(posix[1]) * factor
    return Number.isFinite(seconds) && seconds >= 20
  }
  const powershell = /^Start-Sleep\s+-(Seconds|Milliseconds)\s+(\d+(?:\.\d+)?)$/i.exec(text)
  if (!powershell) return false
  const seconds = Number(powershell[2]) / (powershell[1].toLowerCase() === 'milliseconds' ? 1000 : 1)
  return Number.isFinite(seconds) && seconds >= 20
}

export function mountJobWaitGuidance(ctx: Context, id: string, gate: ConsumerGate): void {
  const seen = new WeakSet<Agent>()
  let active = true
  ctx.effect(() => () => { active = false })
  const eligible = (agent: Agent): boolean => active && gate.allows(agent) && Boolean(ctx.get('tools')?.get('job_output', agent))
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const agent = exec.agent
    if (decision.kind !== 'accept' || result.isError || exec.signal?.aborted || !agent || seen.has(agent) || !SHELLS.has(exec.name)) return decision
    const args = exec.arguments as Record<string, unknown> | undefined
    if (!args || args.script_path || args.run_in_background || !isLongStandaloneSleep(args.command)) return decision
    const value = result.value as Record<string, unknown> | undefined
    if (value && typeof value === 'object' && (value.status === 'failed' || value.error || value.timedOut || value.cancelled || value.signal
      || value.kind === 'background' || value.kind === 'promoted' || typeof value.exitCode === 'number' && value.exitCode !== 0)) return decision
    try {
      if (!eligible(agent)) return decision
      seen.add(agent)
      registerSystemSection(ctx, agent, { id: `${id}:job-wait-guidance`, revision: '1', priority: 3300,
        text: () => eligible(agent) ? JOB_WAIT_GUIDANCE : '' })
    } catch (error) {
      // Optional guidance cannot turn a successful command into a failed tool result.
      ctx.logger?.warn?.('dsh-ops: job wait guidance unavailable:', error)
    }
    return decision
  })
}
