/** Prepare one exact public-confined launch; never replace its wrapper in native code. */
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ConfinedArgv } from '../../adapter/dsh/types.js'
import { loadScrubbedParentEnv } from '../../adapter/dsh/host.js'
import type { ShellCall, ShellContext, ShellPolicy } from '../../shells/types.js'
import { shellEnvOverrides } from '../../shells/constants.js'
import { confinedBash } from '../../bash-ipc.js'
import { isNiubashExecutable, prepareNiubash, type NativeShellRuntime } from '../../niubash/runtime.js'
import { prepareWorkspace } from '../../workspace-preparation.js'
import type { ShellBootstrap, ShellLaunch } from './shell-protocol.js'
import { residentShellBootstrap } from './shell-bootstrap.js'

export interface ShellLaunchOptions {
  bash: { file: string; source: string }
  /** Owned fixed driver arguments only; command text never enters this callback. */
  bootstrap?(endpoints: ShellBootstrap): string[]
  runtime?: typeof prepareShellRuntime
}
/** Full explicit environment, including Windows case-insensitive tombstones. */
export function mergeShellEnvironment(...layers: NodeJS.ProcessEnv[]): Record<string, string> {
  const output: Record<string, string> = {}
  for (const layer of layers) for (const [name, value] of Object.entries(layer)) {
    if (process.platform === 'win32') for (const key of Object.keys(output)) if (key.toUpperCase() === name.toUpperCase()) delete output[key]
    if (value === undefined) delete output[name]
    else output[name] = value
  }
  // This native child must never inherit the outer host's private control descriptor.
  for (const key of Object.keys(output)) if (key.toUpperCase() === 'DSH_SUBPROCESS_CONTROL') delete output[key]
  return output
}
export async function shellEnvironment(ctx: ShellContext, call: ShellCall): Promise<Record<string, string>> {
  const parent = await loadScrubbedParentEnv()
  const env = mergeShellEnvironment(parent, shellEnvOverrides(parent, ctx.get('shellEnv')?.collect(call) ?? {}))
  assertBootstrapEnvironment(env)
  return env
}
/** Startup scripts can replace the reserved driver before its first receipt. */
export function assertBootstrapEnvironment(env: Record<string, string>): void {
  const configured = Object.keys(env).filter(name => ['NIU_ENV', 'BASH_ENV', 'ENV'].includes(name.toUpperCase()) && env[name] !== '')
  if (configured.length) throw new Error(`UNSUPPORTED_STARTUP_ENV: session execution cannot run ${configured.join(', ')} startup scripts. Remove those environment entries or use fresh execution.`)
}
/** Hash is kept private and never logged; changing host facts resets instead of overwriting exports. */
export function environmentIdentity(env: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
}
export async function prepareShellRuntime(bash: ShellLaunchOptions['bash'], env: NodeJS.ProcessEnv,
  policy: ShellPolicy, signal: AbortSignal): Promise<NativeShellRuntime> {
  if (!path.isAbsolute(bash.file)) throw new Error('EXECUTOR_UNAVAILABLE: Bash requires an absolute executable.')
  if (process.platform === 'win32' && isNiubashExecutable(bash.file)) {
    return prepareNiubash(bash.file, env.PATH ?? env.Path, signal, { workspaceRoot: policy.workspaceRoot })
  }
  const runtime = policy.mode === 'danger-full-access' ? { file: bash.file } : confinedBash(bash.file, { source: bash.source })
  return { file: runtime.file, env: runtime.env ?? {} }
}
export async function prepareShellLaunch(ctx: ShellContext, options: ShellLaunchOptions, endpoints: ShellBootstrap,
  cwd: string, env: Record<string, string>, policy: ShellPolicy, signal: AbortSignal, assertCurrent: () => void,
): Promise<{ launch: ShellLaunch; confinement?: ConfinedArgv }> {
  assertCurrent()
  const runtime = await (options.runtime ?? prepareShellRuntime)(options.bash, env, policy, signal)
  assertCurrent()
  const completeEnv = mergeShellEnvironment(env, runtime.env)
  assertBootstrapEnvironment(completeEnv)
  await prepareWorkspace(policy)
  assertCurrent()
  const argv = [runtime.file, ...(options.bootstrap ?? residentShellBootstrap)(endpoints)]
  if (!path.isAbsolute(argv[0]) || argv.some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('EXECUTOR_UNAVAILABLE: invalid trusted shell bootstrap argv.')
  }
  let confinement: ConfinedArgv | undefined
  if (policy.mode !== 'danger-full-access') {
    const sandbox = ctx.get('sandbox')
    if (!sandbox?.confine) throw new Error('SANDBOX_UNAVAILABLE: no confinement provider; no command executed.')
    confinement = await sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)
    assertCurrent()
    if (!confinement?.argv?.length || !['full', 'partial'].includes(confinement.enforcement)
      || !path.isAbsolute(confinement.argv[0]) || confinement.argv.some(value => typeof value !== 'string' || value.includes('\0'))) {
      throw new Error('SANDBOX_UNAVAILABLE: invalid confinement result; no command executed.')
    }
  }
  return { launch: { argv: confinement?.argv ?? argv, cwd, env: completeEnv }, confinement }
}
