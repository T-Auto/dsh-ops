/** Typed OPS shell boundary; host classes are borrowed through services, never imported as values. */
import type { OpsErrorPayload } from '../kernel/outcome.js'
import type { ToolDefinition, ToolRunContext } from '../adapter/dsh/types.js'
import type { JsonSchemaNode } from '../adapter/dsh/types.js'
import type { SandboxExecutionPolicy, SandboxProvider } from '../adapter/dsh/types.js'
import type { SandboxPolicyService } from '../adapter/dsh/types.js'
import type { SubprocessRuntime, SubprocessOutputReader } from '../adapter/dsh/types.js'

export type ShellCall = Partial<Pick<ToolRunContext, 'agent' | 'callId' | 'signal' | 'token' | 'parent' | 'deferContext'>>
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-ops:shell-reset': { readonly kind: 'dsh-ops:shell-reset'; readonly callId?: string
      readonly shellState: 'reset'; readonly cleanupConfirmed: true; readonly effectState: 'none' | 'unknown' }
  }
}
export type ShellPolicy = SandboxExecutionPolicy
export interface ShellStream { text: string; truncated: boolean; spillPath?: string; bytes?: number; bytesTotal?: number; lines?: number }
export interface ShellResult {
  resolvedFrom?: string
  cwdSource?: string
  exitCode?: number | null
  signal?: string | null
  error?: string
  failure?: OpsErrorPayload
  timedOut: boolean
  timeoutMs: number
  stdout: ShellStream
  stderr: ShellStream
  cancelled?: boolean
  stopped?: string
  diagnostics?: { durationMs: number; executor: { kind: string; source: string } }
  permission?: { code: string; message: string; nextAction: string }
  restriction?: { code: string; message: string; nextAction: string }
  sandbox?: { mode: ShellPolicy['mode']; denied: boolean; enforcement?: 'full' | 'partial'; runnerFailed?: boolean
    denialObservation?: 'detected' | 'not-observed' | 'incomplete' }
}
export type SettledShellResult = ShellResult & { status: 'completed' | 'failed' }
export type HostForeground = SettledShellResult & { kind: 'foreground'; exitCode: number | null; signal: string | null; aborted: boolean }
export type HostSessionResult = HostForeground & {
  execution: 'session'; shellState: 'preserved' | 'reset' | 'unchanged' | 'unknown'; cleanupConfirmed: boolean
  retention: 'prefix'; stateLost?: 'authority-changed' | 'runtime-changed' | 'environment-changed' | 'shell-reset'
  denialObservation?: 'detected' | 'not-observed' | 'incomplete'
}
export type HostBashResult = (HostForeground | HostSessionResult | { kind: 'background'; jobId: string; label: string }
  | { kind: 'promoted'; jobId: string; label: string; timeoutMs: number; output: string }) & Pick<ShellResult, 'resolvedFrom' | 'cwdSource'>
export interface ShellExecution {
  status: 'running' | 'completed' | 'killed'
  readonly started: boolean
  readonly effectState?: 'none' | 'unknown'
  observed: { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader }
  kill(reason?: string): void
  result(): Promise<ShellResult>
  done: Promise<void>
  exitCode?: number | null
  signal?: string | null
  sandbox?: ShellResult['sandbox']
}
export interface ExecutionOptions { onExpiry?: 'none' }
export interface PreparedBashCall {
  args: Record<string, unknown>; spec: ShellExecutionSpec; call: ShellCall
  standing: ShellPolicy; policy: ShellPolicy; env: NodeJS.ProcessEnv; background: boolean
  observe(execution: ShellExecution): void
}
export type BashExecutionStrategy = (prepared: PreparedBashCall) => Promise<HostBashResult>
export interface ShellExecutionSpec extends ExecutionOptions {
  command?: string
  scriptPath?: string
  workdir?: string
  timeoutMs: number
  graceMs: number
  includeDiagnostics: boolean
}
export interface ShellExecutorOptions {
  file: string
  source: string
  subprocess?: Pick<SubprocessRuntime, 'spawn'>
  env?: NodeJS.ProcessEnv
  prepareArgv?: (argv: string[], signal: AbortSignal) => Promise<string[]>
  projectResult?: (value: ShellResult) => ShellResult | Promise<ShellResult>
}
export type StartShell = (exec: ShellCall, options: ExecutionOptions) => ShellExecution | Promise<ShellExecution>
export type CreateShellExecution = (args: Record<string, unknown>, exec: ShellCall, standing: ShellPolicy,
  policy: ShellPolicy, env: NodeJS.ProcessEnv, options: ExecutionOptions) => ShellExecution | Promise<ShellExecution>
export interface ShellBase {
  name: string
  description: string
  parameters: JsonSchemaNode & Record<string, unknown> & { properties: Record<string, JsonSchemaNode> }
  resolve(args: Record<string, unknown>): unknown
}
export interface LegacyShellDefinition extends ShellBase {
  resolve(args: unknown): ShellExecutionSpec
  output: ToolDefinition['output']
  start(args: Record<string, unknown>, exec?: ShellCall, options?: ExecutionOptions): ShellExecution
  execute(args: Record<string, unknown>, exec?: ShellCall): Promise<ShellResult>
}
export type HostShellDefinition = Omit<ToolDefinition, 'execute'> & {
  execute(args: unknown, exec?: ShellCall): Promise<HostBashResult>
}

/** Minimal structural projections of the pinned optional host services, which are not npm dependencies. */
export interface ShellJobView { status: string; detail?: string }
export interface ShellJobs {
  start(spec: { kind: string; label: string; owner?: string;
    output: { channel: string; read: SubprocessOutputReader['readFrom'] }[];
    run(): { done: Promise<{ status: 'completed' | 'failed' | 'killed'; detail: string }>; cancel(reason: string): void } }): string
  wait(id: string, timeoutMs: number, owner?: string, signal?: AbortSignal): Promise<ShellJobView>
  kill(id: string, owner: string | undefined, reason: string): unknown
  remove(id: string, owner?: string): unknown
  read(id: string, owner?: string): { chunks: { channel: string; text: string }[]; lossy: boolean; job: { output: { spillPaths?: string[] } } }
}
interface ShellServices {
  jobs: ShellJobs
  approval: { request(input: { agent: NonNullable<ShellCall['agent']>; callId?: ShellCall['callId']; toolName: string; reason: string; signal?: AbortSignal }): Promise<string> }
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  sandbox: Pick<SandboxProvider, 'confine'>
  sandboxPolicy: Pick<SandboxPolicyService, 'resolve'>
  shellEnv: { collect(exec: ShellCall): NodeJS.ProcessEnv }
}
export interface ShellContext {
  get<K extends keyof ShellServices>(name: K): ShellServices[K] | undefined
  logger?: { warn?(message: string): void }
}
export function errorMessage(error: unknown): string {
  return String(typeof error === 'object' && error !== null && 'message' in error ? error.message ?? error : error)
}
