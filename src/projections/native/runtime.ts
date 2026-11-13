import type { Context } from '../../adapter/dsh/types.js'
import type { ToolDefinition } from '../../adapter/dsh/types.js'
import type { FileToolName } from '../../capabilities/registry.js'
import { WORKER_TIMEOUT_MS } from '../../execution/protocol.js'
import { publicToolName } from '../../policy.js'
import { definition } from './contract.js'
import { NATIVE_FILE_TOOLS } from '../../capabilities/registry.js'
import { resultDefinition, invokeResult } from './result.js'
import { registerNativeProvider } from '../../publication/providers.js'
import { publicationRegistration } from '../../publication/reentry.js'
import { safeDisposeAll } from '../../teardown.js'
import { invoke, failure } from '../../execution/files.js'
import { InvocationLifetime, InvocationNotStarted } from '../../lifecycle/invocations.js'
import { canonicalOutput } from '../canonical-output.js'
import { canonicalOutput as canonicalSchema } from '../ptc/canonical-schema.js'
import { acquireResultAdmission } from '../../publication/result-admission.js'
import { createNativeReadDedup } from './read-dedup.js'
import { requireResident } from '../../execution/resident/provider.js'

type Execution = Parameters<ToolDefinition['execute']>[1]
type NativeToolName = FileToolName | 'result'
export interface NativeRuntimeConfig { workerPath?: string; required?: boolean; denyCredentialReads?: boolean; toolCallTimeoutMs?: number }
type Reporter = (message: string, level?: string) => void
export class NativeFileTools {
  readonly ctx: Context
  readonly config: NativeRuntimeConfig
  readonly report: Reporter
  file: string | undefined
  readonly calls = new InvocationLifetime()
  readonly active = this.calls.active
  readonly disposers: (() => void)[]
  private stopped: boolean
  private readonly readDedup: ReturnType<typeof createNativeReadDedup>
  private readonly resultAdmission: ReturnType<typeof acquireResultAdmission>
  private unregisterProvider: (() => void) | undefined
  constructor({ ctx, config, report }: { ctx: Context; config: NativeRuntimeConfig; report?: Reporter }) {
    this.ctx = ctx
    this.config = config
    this.report = report ?? (() => {})
    this.file = undefined
    this.disposers = []
    this.stopped = false
    // Provider and execution events originate at root, not the agent source scope;
    // the observer therefore asks for `global` dispatch. It subscribes on this
    // caller's context rather than the root, because dsh-tui's root-capability
    // guard refuses `root.events.on` from a plugin activation. The runtime still
    // owns (and disposes) its independent evidence observer.
    this.readDedup = createNativeReadDedup(ctx)
    this.resultAdmission = acquireResultAdmission(ctx)
  }

  async start(names: readonly NativeToolName[] = NATIVE_FILE_TOOLS as readonly NativeToolName[]): Promise<string[]> {
    try { this.file = requireResident(this.ctx, { binaryPath: this.config.workerPath }).file }
    catch (error) {
      if (this.config.required) throw error
      return []
    }
    const definitions = names.map(rawName => this.definition(rawName))
    // Discovery starts a worker without a resident surface. Do not emit a
    // registry change for an empty provider on every newly attached agent.
    if (definitions.length) this.unregisterProvider = await registerNativeProvider(this.ctx, definitions, tool => publicationRegistration(this.ctx, () => this.ctx.tools.register(tool)))
    return names.map(publicToolName)
  }

  definition(rawName: NativeToolName): ToolDefinition {
    const execute: ToolDefinition['execute'] = (args, exec) => this.call(rawName, args, exec)
    const source = this.readDedup.wrap(rawName === 'result' ? resultDefinition(execute) : definition(rawName, execute))
    const typed = rawName === 'glob' || rawName === 'grep' || rawName === 'read_files'
    return canonicalOutput(rawName, typed ? { ...source, output: { ...source.output, schema: canonicalSchema(rawName) } } : source)
  }

  async call(tool: NativeToolName, args: unknown, exec: Execution): Promise<unknown> {
    if (this.stopped) return failure('POLICY_DENIED', 'Native file component is disposed.')
    if (!this.file) return failure('EXECUTOR_UNAVAILABLE', 'Native file worker path is unavailable.')
    try {
      return await this.calls.run(exec?.signal, signal => tool === 'result'
        ? invokeResult(this.ctx, this.file!, args, exec, signal, this.config, () => this.resultAdmission.authorize({ ...exec, signal }).catch(() => undefined))
        : invoke(this.ctx, this.file!, tool, args, exec, signal, this.config), undefined,
      Math.min(this.config.toolCallTimeoutMs ?? WORKER_TIMEOUT_MS, WORKER_TIMEOUT_MS))
    } catch (error) {
      if (error instanceof InvocationNotStarted) return failure('ABORTED', error.message)
      return failure('RESULT_UNKNOWN', 'Invocation did not settle; inspect postconditions before retrying.', 'execute', 'unknown')
    }
  }

  cancel(reason: string): void {
    this.calls.cancel(reason)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.readDedup.dispose()
    this.resultAdmission.dispose()
    safeDisposeAll([this.unregisterProvider].filter((dispose): dispose is () => void => typeof dispose === 'function'), error => this.report('dsh-ops: Native pager teardown failed: ' + error, 'warn'), 'result provider')
    await this.calls.stop('Native file component unloaded')
    // Isolate each teardown: one throwing worker registration must not strand the rest.
    safeDisposeAll(this.disposers.splice(0), (error, where) => {
      this.report(`dsh-ops: ${where} teardown failed: ${error instanceof Error ? error.message : String(error)}`, 'warn')
    }, 'file runtime stop')
  }
}
