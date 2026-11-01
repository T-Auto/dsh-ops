/**
 * The host-facing adapter: tool definitions plus the outcome normalization the host expects.
 *
 * Everything here exists to keep one promise — the model never sees an unstructured failure. A tool
 * either reports `completed` with data, `partial` with a continuation the caller can follow, or one of
 * `rejected` / `conflict` / `error` / `unknown` with a code, an effect state and a retry verdict.
 *
 * @module dsh-ops/ptc/adapter
 */

import path from 'node:path'

type JsonSchema = Record<string, unknown>
type Row = Record<string, unknown>

/** Effect states a caller is allowed to branch on. */
type EffectState = 'none' | 'applied' | 'partial' | 'unknown'
/** Retry verdicts a caller is allowed to branch on. */
type Retry = 'never' | 'after-input-change' | 'after-state-change' | 'bounded-transient'
/** Terminal statuses; `completed` and `partial` are handled separately. */
type FailureStatus = 'rejected' | 'conflict' | 'error' | 'unknown'
/** Truncation reasons the coverage block may name. */
type Truncation = 'scan-budget' | 'output-budget' | 'time-limit' | 'row-limit'

const object = (properties: JsonSchema, required: string[]): JsonSchema =>
  ({ type: 'object', properties, required, additionalProperties: false })

const dataSchema: JsonSchema = { type: 'object', properties: {}, additionalProperties: true }

const coverage = (complete: boolean): JsonSchema => object({
  scannedFiles: { type: 'integer' },
  matchedCount: { type: 'integer' },
  isComplete: { type: 'boolean', const: complete },
  truncatedBy: { type: 'string', enum: ['scan-budget', 'output-budget', 'time-limit', 'row-limit'] },
}, ['scannedFiles', 'matchedCount', 'isComplete'])

/**
 * The one schema every host-facing PTC tool declares.
 *
 * Three shapes, and the middle one is the point: an incomplete observation must carry a
 * `continuation` string, otherwise `partial` is just a failure with a friendlier name.
 */
export const HOST_OUTCOME_SCHEMA: JsonSchema = {
  oneOf: [
    object({ status: { const: 'completed', type: 'string' }, data: dataSchema, coverage: coverage(true) }, ['status', 'data']),
    object({
      status: { const: 'partial', type: 'string' },
      data: dataSchema,
      coverage: coverage(false),
      continuation: { type: 'string' },
    }, ['status', 'data', 'coverage', 'continuation']),
    object({
      status: { type: 'string', enum: ['rejected', 'conflict', 'error', 'unknown'] },
      data: dataSchema,
      error: object({
        code: { type: 'string' },
        message: { type: 'string' },
        effectState: { type: 'string', enum: ['none', 'applied', 'partial', 'unknown'] },
        retry: { type: 'string', enum: ['never', 'after-input-change', 'after-state-change', 'bounded-transient'] },
      }, ['code', 'message', 'effectState', 'retry']),
    }, ['status', 'error']),
  ],
}

const record = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value)

const EFFECT_STATES: readonly EffectState[] = ['none', 'applied', 'partial', 'unknown']
const RETRIES: readonly Retry[] = ['never', 'after-input-change', 'after-state-change', 'bounded-transient']
const FAILURE_STATUSES: readonly FailureStatus[] = ['rejected', 'conflict', 'error', 'unknown']
const TRUNCATIONS: readonly Truncation[] = ['scan-budget', 'output-budget', 'time-limit', 'row-limit']

/** Build the canonical refusal. `POLICY_DENIED` and `EXECUTOR_UNAVAILABLE` are rejections, not errors. */
const failure = (code: string, message: string, effectState: EffectState = 'none', retry: Retry = 'never'): Row => ({
  status: effectState === 'unknown' ? 'unknown' : code === 'POLICY_DENIED' || code === 'EXECUTOR_UNAVAILABLE' ? 'rejected' : 'error',
  error: { code, message, effectState, retry },
})

/**
 * Normalize whatever the engine returned into the host outcome.
 *
 * `mayWrite` matters when the receipt is unreadable: a mutating tool that cannot prove what it did must
 * report `effectState: 'unknown'`, never `'none'` — claiming no effect is a stronger claim than the
 * evidence supports.
 */
export function toHostOutcome(value: unknown, mayWrite = false): Row {
  if (!record(value)) return failure('RESULT_UNKNOWN', 'Execution returned no structured receipt.', 'unknown')

  const status = value.status
  if (typeof status === 'string' && (FAILURE_STATUSES as readonly string[]).includes(status)) {
    const error: Row = record(value.error) ? value.error : value
    const effect: EffectState = (EFFECT_STATES as readonly string[]).includes(error.effectState as string)
      ? error.effectState as EffectState
      : mayWrite ? 'unknown' : 'none'
    const retry: Retry = (RETRIES as readonly string[]).includes(error.retry as string) ? error.retry as Retry : 'never'
    return {
      status,
      error: {
        code: typeof error.code === 'string' ? error.code : 'RESULT_UNKNOWN',
        message: typeof error.message === 'string' ? error.message : 'Execution failed without a message.',
        effectState: effect,
        retry,
      },
      data: value,
    }
  }

  const data = status === 'completed' || status === 'partial' ? value.data : status === 'ok' ? value : undefined
  if (!record(data)) return failure('RESULT_UNKNOWN', 'Execution returned an unrecognized status or data shape.', 'unknown')

  const locate = record(data.locate) ? data.locate : undefined
  const incomplete = status === 'partial'
    || (record(value.coverage) && value.coverage.isComplete === false)
    || locate?.truncated === true || locate?.pruned === true
    || data.truncated === true || data.pruned === true || data.partial === true
    || data.complete === false || data.scanComplete === false || data.pageComplete === false
    || Number(data.failed) > 0

  if (incomplete) {
    const seen = value.coverage
    if (record(seen) && seen.isComplete === false
      && Number.isInteger(seen.scannedFiles) && Number.isInteger(seen.matchedCount)
      && typeof value.continuation === 'string' && value.continuation.length > 0) {
      return {
        status: 'partial',
        data,
        coverage: {
          scannedFiles: seen.scannedFiles,
          matchedCount: seen.matchedCount,
          isComplete: false,
          ...((TRUNCATIONS as readonly string[]).includes(seen.truncatedBy as string) ? { truncatedBy: seen.truncatedBy as Truncation } : {}),
        },
        continuation: value.continuation,
      }
    }
    return {
      ...failure('RESULT_PARTIAL', 'Observation was incomplete and has no safe continuation. Narrow the input before retrying.', mayWrite ? 'unknown' : 'none', 'after-input-change'),
      data,
    }
  }

  return { status: 'completed', data }
}

/**
 * Does this call change bytes?
 *
 * Only two rows can: `ops_ptc_audit` always can (it applies a rewrite), and the two in-place tools can
 * unless the caller asked for a preview. Getting this wrong in the safe direction costs a policy
 * refusal; getting it wrong the other way skips one.
 */
const mutates = (name: string, args: Row): boolean => name === 'ops_ptc_audit'
  || ((name === 'ops_ptc_inproc' || name === 'ops_ptc_refactor') && args.mode !== 'preview')

/** The bridge the host hands over; every field is required before a tool may run. */
export interface HostBridge {
  sandboxPolicy?: { resolve(input: { session: unknown }): { mode?: string, workspaceRoot?: string } | undefined }
  invoke?(name: string, input: Row, exec: unknown, policy: Row): Promise<unknown>
}

/** One tool definition as this plugin publishes it. */
export interface HostToolDefinition {
  name: string
  description: string
  parameters: unknown
  timeoutMs: number
  output: { schema: JsonSchema, render(args: unknown, value: unknown): Array<{ type: 'text', text: string }> }
  execute(args: unknown, exec: { signal?: AbortSignal, agent?: { session?: { id?: string } } }): Promise<Row>
}

interface Addition { tools: Array<{ name: string, description: string, inputSchema: unknown }> }

/**
 * Turn an engine addition into host tool definitions.
 *
 * The four gates before dispatch are the whole security story: a session identity, an authoritative
 * policy the host resolved (never one we invented), a read-only policy that refuses writes, and an
 * already-aborted signal.
 */
export function createHostTools(addition: Addition, bridge: HostBridge): HostToolDefinition[] {
  return addition.tools.map(tool => ({
    name: tool.name,
    description: `${tool.description} Returns Outcome: completed.data; partial.data/coverage/continuation; failures use error.code/effectState/retry.`,
    parameters: tool.inputSchema,
    timeoutMs: 120000,
    output: {
      schema: HOST_OUTCOME_SCHEMA,
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec: { signal?: AbortSignal, agent?: { session?: { id?: string } } }): Promise<Row> {
      let started = false
      let mayWrite = false
      try {
        if (!record(args)) return failure('INVALID_ARGUMENT', 'Arguments must be an object.', 'none', 'after-input-change')
        // Clone through JSON so a caller cannot mutate its argument object after dispatch.
        const input = JSON.parse(JSON.stringify(args)) as Row
        mayWrite = mutates(tool.name, input)
        const session = exec?.agent?.session
        if (!session?.id || !bridge?.sandboxPolicy?.resolve || !bridge.invoke) {
          return failure('EXECUTOR_UNAVAILABLE', 'A session, authoritative sandboxPolicy and trusted invoke bridge are required.')
        }
        const policy = bridge.sandboxPolicy.resolve({ session })
        if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode ?? '')
          || !path.isAbsolute(policy.workspaceRoot ?? '')) {
          return failure('EXECUTOR_UNAVAILABLE', 'The host returned an invalid authoritative policy.')
        }
        if (policy.mode === 'read-only' && mayWrite) return failure('POLICY_DENIED', 'This operation requires workspace-write.')
        if (exec.signal?.aborted) return failure('ABORTED', 'Execution was cancelled before dispatch.')
        started = true
        return toHostOutcome(await bridge.invoke(tool.name, input, exec, { ...policy }), mayWrite)
      } catch {
        return failure(
          'RESULT_UNKNOWN',
          started ? 'Trusted execution did not return a settled receipt. Inspect postconditions.' : 'Host authority or request preparation failed.',
          started && mayWrite ? 'unknown' : 'none',
        )
      }
    },
  }))
}

/**
 * Register every tool and return one disposer.
 *
 * A partial registration is rolled back before the error escapes: a half-published surface is worse
 * than none, because the host has already advertised tools that cannot run.
 */
export function registerHostTools(ctx: { tools: { register(definition: HostToolDefinition): () => void } }, addition: Addition, bridge: HostBridge): () => void {
  const disposers: Array<() => void> = []
  const dispose = (): void => {
    for (const release of disposers.splice(0).reverse()) release()
  }
  try {
    for (const definition of createHostTools(addition, bridge)) disposers.push(ctx.tools.register(definition))
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
