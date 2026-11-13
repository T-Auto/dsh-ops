/** Resolve and confine every invocation using the current session authority. */
import path from 'node:path'
import { sameAuthority } from '../authority-paths.js'
import type { ConfinedArgv } from '../adapter/dsh/types.js'
import type { ShellContext, ShellCall, ShellPolicy, ExecutionOptions, ShellExecution, ShellResult } from './types.js'
import { bashToolDefinition } from './tool.js'
import { confinedBash } from '../bash-ipc.js'
import { executorUnavailableMessage } from '../bash-runtime-failure.js'
import { prepareWorkspace } from '../workspace-preparation.js'
import { confinementResult } from './confinement-result.js'
import { isNiubashExecutable, prepareNiubash } from '../niubash/runtime.js'

export function startSessionBash({ ctx, bash, active }: { ctx: ShellContext; bash: { file: string; source: string }; active(): boolean },
  args: Record<string, unknown>, exec: ShellCall, standing: ShellPolicy, policy: ShellPolicy, dshEnv: NodeJS.ProcessEnv, options: ExecutionOptions): ShellExecution {
  if (!exec.agent?.session) throw new Error('EXECUTOR_UNAVAILABLE: an authoritative session is required.')
  const session = exec.agent.session
  const assertAuthority = () => {
    const current = ctx.get('sandboxPolicy')?.resolve({ session })
    if (!active() || !current || !sameAuthority(current, standing)) {
      throw new Error('AUTHORITY_CHANGED: session authority changed before execution; no command executed. Read the current policy before another call.')
    }
  }
  assertAuthority()
  if (!path.isAbsolute(bash.file)) throw new Error('EXECUTOR_UNAVAILABLE: Bash requires a resolved absolute executable path; configure an absolute bashPath. No command executed.')
  const native = process.platform === 'win32' && isNiubashExecutable(bash.file)
  const env = { ...dshEnv }
  let confinement: ConfinedArgv | undefined
  const definition = bashToolDefinition({ file: bash.file, source: bash.source,
    env, subprocess: ctx.get('subprocess'),
    prepareArgv: async (argv: string[], signal: AbortSignal) => {
      signal.throwIfAborted()
      assertAuthority()
      try {
        const runtime = native ? await prepareNiubash(bash.file, dshEnv.PATH ?? dshEnv.Path ?? process.env.PATH, signal,
          { workspaceRoot: typeof policy.workspaceRoot === 'string' ? policy.workspaceRoot : undefined })
          : policy.mode === 'danger-full-access' ? { file: bash.file } : confinedBash(bash.file, { source: bash.source })
        if (native) for (const key of Object.keys(env)) if (['PATH', 'NIU_ROOT', 'WINUXCMD_PATH', 'NIU_SKIP_WINUXCMD_ACTIVATION'].includes(key.toUpperCase())) delete env[key]
        Object.assign(env, native ? runtime.env : { ...runtime.env, ...dshEnv })
        argv[0] = runtime.file
      } catch (error) { throw new Error(executorUnavailableMessage(error)) }
      signal.throwIfAborted()
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
      return confinement?.argv ?? argv
    },
    projectResult: (value: ShellResult) => confinementResult(value, policy, confinement),
  })
  return definition.start(args, exec, options)
}
