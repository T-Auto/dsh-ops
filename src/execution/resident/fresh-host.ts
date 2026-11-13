/** Fresh policy bridge at native heads; initial approval and public projection stay in host-tool. */
import path from 'node:path'
import type { Agent, Context, ConfinedArgv, JobRegistry } from '../../adapter/dsh/types.js'
import type { PreparedBashCall, ShellCall, ShellPolicy } from '../../shells/types.js'
import { sameAuthority } from '../../authority-paths.js'
import { loadScrubbedParentEnv } from '../../adapter/dsh/host.js'
import { shellEnvOverrides } from '../../shells/constants.js'
import { adaptElectronRunner } from '../../shells/environment.js'
import { confinementResult } from '../../shells/confinement-result.js'
import { hostForeground } from '../../shells/host-contract.js'
import { BashJobAdmissionError } from '../../shells/jobs.js'
import { prepareWorkspace } from '../../workspace-preparation.js'
import { executorUnavailableMessage } from '../../bash-runtime-failure.js'
import { isNiubashExecutable } from '../../niubash/runtime.js'
import { mergeShellEnvironment, prepareShellRuntime } from './shell-launch.js'
import { createTaskExecutionHost } from './task-owner.js'
import { runTaskJob } from './task-jobs.js'
import type { TaskExecution } from './task-execution.js'
import type { TaskTransport } from './task-protocol.js'

type Bash = { file: string; source: string }
interface Facts { agent: Agent; standing: ShellPolicy; effective: ShellPolicy; confinement?: ConfinedArgv }
export interface FreshTaskOptions {
  transport: TaskTransport
  /** Internal deterministic fixtures may prepare a verified runtime; no user configuration bypass. */
  runtime?: typeof prepareShellRuntime
}
export interface FreshTaskCall extends PreparedBashCall { bash: Bash; active(): boolean }
const snapshot = (policy: ShellPolicy): ShellPolicy => ({ ...policy, additionalWritableRoots: [...policy.additionalWritableRoots ?? []] })
const same = (a: ShellPolicy, b: ShellPolicy) => sameAuthority(a, b) && a.sessionId === b.sessionId

function project(execution: TaskExecution, facts: () => Facts | undefined): TaskExecution {
  const value = execution.result().then(result => {
    const observed = facts()
    if (!observed) return result
    const classified = confinementResult(result, observed.effective, observed.confinement)
    // Signatures classify observed diagnostics, never overwrite native effect or error facts.
    return { ...result, ...(classified.restriction ? { restriction: classified.restriction } : {}),
      ...(!result.error && classified.sandbox?.runnerFailed ? { error: 'EXECUTOR_UNAVAILABLE: the sandbox runtime reported a failure; inspect prior effects before another call.' } : {}),
      sandbox: { ...classified.sandbox!, denialObservation: classified.sandbox?.denied ? 'detected' as const
        : result.stderr.truncated ? 'incomplete' as const : 'not-observed' as const } }
  })
  return {
    get status() { return execution.status }, set status(value) { execution.status = value },
    get started() { return execution.started }, get effectState() { return execution.effectState },
    get cleanupConfirmed() { return execution.cleanupConfirmed }, get exitCode() { return execution.exitCode }, get signal() { return execution.signal },
    observed: execution.observed, kill: reason => execution.kill(reason), promote: () => execution.promote(),
    result: () => value, done: value.then(() => undefined),
  }
}

export function createFreshTaskHost(ctx: Context, options: FreshTaskOptions) {
  const tasks = createTaskExecutionHost(ctx, options.transport), admitted = new Map<TaskExecution, Facts>()
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  const current = (call: FreshTaskCall): ShellPolicy => {
    const agent = call.call.agent
    if (stopped || !call.active() || !agent || ctx.get('agents')?.get(agent.id) !== agent
      || ctx.get('sessions')?.get(agent.session.id) !== agent.session) throw new Error('OWNER_DISPOSED: fresh execution publication or exact owner is no longer active.')
    const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
    if (!policy) throw new Error('SANDBOX_UNAVAILABLE: current session authority is unavailable.')
    return snapshot(policy)
  }
  ctx.on('session/event', session => {
    for (const [execution, facts] of admitted) if (facts.agent.session === session && execution.status === 'running') {
      const policy = ctx.get('sandboxPolicy')?.resolve({ session })
      if (!policy || !same(policy, facts.standing)) execution.kill('AUTHORITY_CHANGED: session authority changed after native admission')
    }
  })
  function start(call: FreshTaskCall, exec: ShellCall, lifetime: 'foreground' | 'job', noDeadline: boolean): TaskExecution {
    let facts: Facts | undefined, execution!: TaskExecution
    const task = tasks.start(exec, { lifetime, source: call.bash.source, spec: { ...call.spec, ...(noDeadline ? { onExpiry: 'none' as const } : {}) },
      async admit(signal) {
        // A test transport may deliver admit synchronously from send(). Ownership is installed first.
        await Promise.resolve()
        const standing = current(call), widened = !same(call.standing, call.policy)
        if (widened && !same(standing, call.standing)) throw new Error('AUTHORITY_CHANGED: the initial one-call grant no longer matches current authority; no command executed.')
        const effective = widened ? snapshot(call.policy) : standing
        facts = { agent: exec.agent!, standing, effective }; admitted.set(execution, facts)
        const assertCurrent = () => { signal.throwIfAborted(); if (!same(current(call), standing)) throw new Error('AUTHORITY_CHANGED: authority changed during fresh preparation; no command executed.') }
        assertCurrent()
        if (!path.isAbsolute(call.bash.file)) throw new Error('EXECUTOR_UNAVAILABLE: fresh Bash requires an absolute selected runtime.')
        const parent = await loadScrubbedParentEnv(); assertCurrent()
        const configured = ctx.get('shellEnv')?.collect(call.call) ?? {}
        const base = mergeShellEnvironment(parent, shellEnvOverrides(parent, configured))
        let runtime
        try { runtime = await (options.runtime ?? prepareShellRuntime)(call.bash, base, effective, signal) }
        catch (error) { throw new Error(executorUnavailableMessage(error)) }
        assertCurrent()
        // Native runtime PATH/support facts win; legacy runtimes keep the existing configured precedence.
        const explicit = process.platform === 'win32' && isNiubashExecutable(call.bash.file) ? runtime.env : { ...runtime.env, ...configured }
        const env = mergeShellEnvironment(base, shellEnvOverrides(base, explicit))
        await prepareWorkspace(effective); assertCurrent()
        const argv = call.spec.command === undefined ? [runtime.file, call.spec.scriptPath!] : [runtime.file, '-c', call.spec.command]
        let confinement: ConfinedArgv | undefined
        if (effective.mode !== 'danger-full-access') {
          const sandbox = ctx.get('sandbox')
          if (!sandbox?.confine) throw new Error('SANDBOX_UNAVAILABLE: no current confinement provider; no command executed.')
          confinement = await sandbox.confine(argv, { ...effective, mode: effective.mode }, signal); assertCurrent()
          if (!confinement?.argv?.length || !['full', 'partial'].includes(confinement.enforcement)) throw new Error('SANDBOX_UNAVAILABLE: invalid confinement result; no command executed.')
        }
        const confined = confinement?.argv ?? argv
        if (!path.isAbsolute(confined[0]!) || confined.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('SANDBOX_UNAVAILABLE: invalid confined argv.')
        facts.confinement = confinement ? structuredClone(confinement) : undefined
        assertCurrent()
        return { argv: [...confined], cwd: call.spec.workdir!, env: mergeShellEnvironment(adaptElectronRunner(confined, env)) }
      } })
    execution = project(task, () => facts)
    call.observe(execution)
    void execution.done.then(() => admitted.delete(execution))
    return execution
  }
  return {
    get available() { return !stopped && options.transport.available },
    async run(input: FreshTaskCall, jobs?: JobRegistry) {
      const call: FreshTaskCall = { ...input, args: { ...input.args }, spec: { ...input.spec }, call: { ...input.call },
        standing: snapshot(input.standing), policy: snapshot(input.policy), bash: { ...input.bash } }
      current(call)
      if (call.background && !jobs) throw new Error('EXECUTOR_UNAVAILABLE: the public Jobs registry is unavailable.')
      if (jobs) {
        try { return await runTaskJob(jobs, { label: String(call.args.description), background: call.background, timeoutMs: call.spec.timeoutMs }, call.call,
          (exec, lifetime) => start(call, exec, lifetime, true)) }
        catch (error) {
          if (call.background || !(error instanceof BashJobAdmissionError) || error.runInvoked) throw error
          // Public preflight invoked no producer; this is the same one native direct execution, not replay.
        }
      }
      const execution = start(call, call.call, 'foreground', false)
      return hostForeground(await execution.result(), execution.effectState)
    },
    dispose: () => { stopped = true; return tasks.dispose() },
  }
}
export type FreshTaskHost = ReturnType<typeof createFreshTaskHost>
