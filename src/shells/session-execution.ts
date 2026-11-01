/** Resolve and confine every invocation using the current session authority. */
import path from 'node:path'
import type { ConfinedArgv } from '../adapter/dsh/types.js'
import type { ShellContext, ShellCall, ShellPolicy, ExecutionOptions, ShellExecution, ShellResult } from './types.js'
import { bashToolDefinition, withBashStatus } from './tool.js'
import { confinedBash } from '../bash-ipc.js'
import { prepareWorkspace } from '../workspace-preparation.js'
import { executionRestriction } from '../permissions.js'
import { shellEnvOverrides } from './constants.js'
import { hostRunnerRefusal } from './host-runner.js'

export function startSessionBash({ ctx, bash, active }: { ctx: ShellContext; bash: { file: string; source: string }; active(): boolean },
  args: Record<string, unknown>, exec: ShellCall, standing: ShellPolicy, policy: ShellPolicy, dshEnv: NodeJS.ProcessEnv, options: ExecutionOptions): ShellExecution {
  if (!exec.agent?.session) throw new Error('EXECUTOR_UNAVAILABLE: an authoritative session is required.')
  const session = exec.agent.session
  const assertAuthority = () => {
    const current = ctx.get('sandboxPolicy')?.resolve({ session })
    if (!active() || current?.mode !== standing.mode || current?.workspaceRoot !== standing.workspaceRoot) {
      throw new Error('AUTHORITY_CHANGED: session authority changed before execution; no command executed. Read the current policy before another call.')
    }
  }
  assertAuthority()
  if (!path.isAbsolute(bash.file)) throw new Error('EXECUTOR_UNAVAILABLE: Bash requires a resolved absolute executable path; configure an absolute bashPath. No command executed.')
  let runtime: { file: string; env?: NodeJS.ProcessEnv }
  try { runtime = policy.mode === 'danger-full-access' ? { file: bash.file } : confinedBash(bash.file, { source: bash.source }) }
  catch { throw new Error('EXECUTOR_UNAVAILABLE: the restricted Bash runtime is unavailable or incompatible; this is not a user authorization denial. Restore the verified pinned Bash payload and IPC runtime; changing the DSH selector is not a repair. Do not retry or bypass confinement.') }
  let confinement: ConfinedArgv | undefined
  // The child environment is `ENV_OVERRIDES` over these overrides and nothing else,
  // so this is also the environment the host-runner guard has to read.
  const childEnv = { ...runtime.env, ...dshEnv }
  const definition = bashToolDefinition({ file: runtime.file, source: bash.source,
    env: childEnv, subprocess: ctx.get('subprocess'),
    prepareArgv: async (argv: string[], signal: AbortSignal) => {
      signal.throwIfAborted()
      assertAuthority()
      await prepareWorkspace(policy)
      signal.throwIfAborted()
      if (policy.mode !== 'danger-full-access') {
        const sandbox = ctx.get('sandbox')
        if (!sandbox?.confine) throw new Error('SANDBOX_UNAVAILABLE: confinement is unavailable; no command executed.')
        confinement = await sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)
        if (!['full', 'partial'].includes(confinement?.enforcement) || !confinement.argv?.length) throw new Error('SANDBOX_UNAVAILABLE: invalid confinement result; no command executed.')
      }
      signal.throwIfAborted()
      assertAuthority()
      const prepared = confinement?.argv ?? argv
      // A confinement provider that hands back the host binary itself — or a bashPath
      // pointed at it — would start a second GUI instance under Electron and exit 0
      // without running the command. Refuse instead of reporting that as success.
      const refusal = hostRunnerRefusal(prepared, shellEnvOverrides(globalThis.process.env, childEnv))
      if (refusal) throw new Error(refusal)
      return prepared
    },
    projectResult: (value: ShellResult) => {
      const stderr = `${value.stderr?.text ?? ''}\n${value.error ?? ''}`
      const runnerFailed = value.exitCode !== 0 && confinement?.runnerFailureRules?.some(rule =>
        (!rule.allowedExitCodes || (value.exitCode != null && rule.allowedExitCodes.includes(value.exitCode))) &&
        stderr.split(/\r?\n/).filter(line => !rule.informationalLines?.some(info => info.toLowerCase() === line.toLowerCase()))
          .some(line => rule.fatalSignatures?.some(signature => line.toLowerCase().includes(signature.toLowerCase()))))
      const unavailable = runnerFailed || /couldn't create signal pipe|fatal error.*win32 error|sandbox_unavailable/i.test(stderr)
      const denied = !unavailable && value.exitCode !== 0 && confinement?.denialSignatures?.some(signature => stderr.toLowerCase().includes(signature.toLowerCase()))
      return withBashStatus({ ...value,
        ...(unavailable ? { error: 'EXECUTOR_UNAVAILABLE: the sandbox runtime failed before the command ran; this is not a user authorization denial. Restore the runtime or confinement provider; changing the DSH selector is not a repair. Do not bypass confinement.' } : {}),
        ...(denied ? { restriction: executionRestriction('command file effects') } : {}),
        sandbox: { mode: policy.mode, denied: denied === true,
          ...(confinement ? { enforcement: confinement.enforcement } : {}), ...(unavailable ? { runnerFailed: true } : {}) },
      })
    },
  })
  return definition.start(args, exec, options)
}
