/** Explicit session dispatch before the unchanged fresh authority/jobs path. */
import type { JsonSchemaNode } from '../adapter/dsh/types.js'
import type { ShellAdmissionResult } from '../execution/resident/shell-admission.js'
import type { HostBashResult, HostSessionResult, HostShellDefinition, ShellCall } from './types.js'
import { errorMessage } from './types.js'
import { HOST_BASH_OUTPUT_SCHEMA, hostFailure, hostForeground, renderHostBash } from './host-contract.js'
import { HOST_MAX_BASH_TIMEOUT_MS } from './host-tool.js'
import { DEFAULT_GRACE_MS } from './constants.js'

interface Admission {
  execute(input: Record<string, unknown>, call: ShellCall, active?: () => boolean): Promise<ShellAdmissionResult>
}
const foreground = HOST_BASH_OUTPUT_SCHEMA.oneOf![2]
export const SESSION_BASH_OUTPUT_SCHEMA: JsonSchemaNode = {
  oneOf: [...HOST_BASH_OUTPUT_SCHEMA.oneOf!, {
    ...foreground, required: [...foreground.required!, 'execution', 'shellState', 'cleanupConfirmed', 'retention'],
    properties: { ...foreground.properties,
      execution: { type: 'string', const: 'session' },
      shellState: { type: 'string', enum: ['preserved', 'reset', 'unchanged', 'unknown'] },
      cleanupConfirmed: { type: 'boolean' }, retention: { type: 'string', const: 'prefix' },
      stateLost: { type: 'string', enum: ['authority-changed', 'runtime-changed', 'environment-changed', 'shell-reset'] },
      denialObservation: { type: 'string', enum: ['detected', 'not-observed', 'incomplete'] },
    },
  }],
}
function sessionResult(value: ShellAdmissionResult, timeoutMs: number): HostSessionResult {
  const stream = (output: ShellAdmissionResult['stdout']) => ({ text: output.text, truncated: output.lossy, bytesTotal: output.bytesTotal,
    ...(output.spillPath ? { spillPath: output.spillPath } : {}) })
  const result = hostForeground({ exitCode: value.exitCode, timeoutMs, timedOut: value.error?.code === 'TIMEOUT',
    cancelled: value.status === 'cancelled', stdout: stream(value.stdout), stderr: stream(value.stderr),
    ...(value.sandbox ? { sandbox: value.sandbox } : {}), ...(value.restriction ? { restriction: value.restriction } : {}),
    ...(value.error ? { error: value.error.message } : {}) }, value.effectState)
  if (value.status !== 'completed') result.status = 'failed'
  if (value.error) result.failure = { code: value.error.code, message: value.error.message,
    effectState: value.effectState, retry: value.effectState === 'none' && value.error.code === 'INVALID_ARGUMENT' ? 'after-input-change' : 'never',
    nextAction: value.effectState === 'unknown' ? 'Inspect prior effects before another command; do not repeat automatically.' : 'Resolve the reported condition before another call.' }
  return { ...result, execution: 'session', shellState: value.shellState, cleanupConfirmed: value.cleanupConfirmed,
    retention: 'prefix', ...(value.stateLost ? { stateLost: value.stateLost } : {}),
    ...(value.denialObservation ? { denialObservation: value.denialObservation } : {}) }
}
const invalid = (detail: string): never => { throw new Error(`INVALID_BASH_ARGUMENT: ${detail}`) }

export function withSessionExecution(fresh: HostShellDefinition, admission: Admission, active: (call: ShellCall) => boolean): HostShellDefinition {
  const properties = { ...(fresh.parameters as JsonSchemaNode).properties,
    execution: { type: 'string', enum: ['fresh', 'session'], description: 'fresh (default): independent shell. session: preserve cwd, exports, functions and options in this Agent; command only, foreground only. Inspect shellState and stateLost.' } satisfies JsonSchemaNode,
    timeoutMs: { type: 'number', description: 'Defaults to 120000 ms, capped at 600000 ms. Session requires an integer and includes queue/admission time; expiry stops its owned shell without promotion. Fresh keeps host-job promotion when available.' } satisfies JsonSchemaNode,
    workdir: { type: 'string', description: 'Relative paths use the current host session directory. Fresh resolves cwd on every call. Session omission preserves persistent cwd; an explicit path changes it before this command.' } satisfies JsonSchemaNode,
    ...(Object.hasOwn((fresh.parameters as JsonSchemaNode).properties ?? {}, 'run_in_background') ? {
      run_in_background: { type: 'boolean', description: 'Fresh only: return an independent host job id; collect with job_output and stop with job_kill. Session state is not cloned or detached.' } satisfies JsonSchemaNode,
    } : {}),
  }
  return {
    ...fresh,
    description: fresh.description.replace('in a fresh non-login shell.', 'in a fresh non-login shell by default.')
      .replace('shell state does not persist between calls.', 'fresh calls do not retain shell state.')
      .replace('Output is bounded with spill paths.', 'Fresh output is bounded with spill paths.')
      + ' Optional execution=session uses the Agent’s persistent shell. Omitted workdir preserves its cwd; explicit workdir changes it before this command. Session calls queue in order and recheck authority at the head. Session timeout stops the owned shell and loses state; it never promotes to a job. Session output retains the first 128 KiB per stream; an available spillPath recovers the complete stream up to 64 MiB. Check shellState, stateLost and cleanupConfirmed.',
    parameters: { ...fresh.parameters, properties },
    output: { ...fresh.output!, schema: SESSION_BASH_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderHostBash(value as unknown as HostBashResult) }] },
    async execute(input, call = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fresh.execute(input, call)
      const args = input as Record<string, unknown>
      if (args.execution === undefined || args.execution === 'fresh') {
        const { execution: _execution, ...local } = args
        return fresh.execute(local, call)
      }
      let timeoutMs = 120_000
      let submitted = false
      try {
        if (args.execution !== 'session') invalid('execution must be fresh or session.')
        if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') invalid('run_in_background must be a boolean.')
        if (args.run_in_background) invalid('session cannot detach or clone its state; use execution=fresh with an available host job registry for an independent background job.')
        const unknown = Object.keys(args).find(key => !Object.hasOwn(properties, key))
        if (unknown) invalid(`unknown key ${JSON.stringify(unknown)}.`)
        if (typeof args.description !== 'string' || !args.description.trim()) invalid('description must be a nonempty string.')
        if (typeof args.command !== 'string' || !args.command.trim() || args.command.includes('\0') || Buffer.byteLength(args.command) > 1024 * 1024) invalid('session command must be nonempty, at most 1 MiB, without NUL.')
        if (args.workdir !== undefined && (typeof args.workdir !== 'string' || args.workdir.includes('\0'))) invalid('workdir must be a string without NUL.')
        if (args.script_path !== undefined) invalid('script_path requires execution=fresh; session accepts command only.')
        if (args.graceMs !== undefined && args.graceMs !== DEFAULT_GRACE_MS) invalid('custom graceMs requires execution=fresh.')
        if (args.includeDiagnostics !== undefined && args.includeDiagnostics !== false) invalid('includeDiagnostics requires execution=fresh.')
        if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0)) invalid('session timeoutMs must be a positive integer.')
        timeoutMs = Math.min(args.timeoutMs as number ?? timeoutMs, HOST_MAX_BASH_TIMEOUT_MS)
        const isActive = () => active(call)
        if (!isActive()) throw new Error('EXECUTOR_UNAVAILABLE: the calling Bash publication or exact Agent is no longer active.')
        const { execution: _execution, script_path: _script, run_in_background: _background, graceMs: _grace, includeDiagnostics: _diagnostics, ...local } = args
        submitted = true
        return sessionResult(await admission.execute({ ...local, timeoutMs }, call, isActive), timeoutMs)
      } catch (error) {
        return { ...hostFailure(errorMessage(error), timeoutMs, submitted ? 'unknown' : 'none'), execution: 'session', shellState: submitted ? 'unknown' : 'unchanged',
          cleanupConfirmed: !submitted, retention: 'prefix' }
      }
    },
  }
}
