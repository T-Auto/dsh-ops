import * as path from 'node:path';
import type { PtcToolAddition } from './tools';

export interface HostExec {
    agent?: {
        session?: {
            id?: string | number;
        };
    };
    signal?: AbortSignal;
}
export interface HostPolicy {
    mode: 'read-only' | 'workspace-write' | 'danger-full-access';
    workspaceRoot: string;
}
export interface HostBridge {
    sandboxPolicy: {
        resolve(input: {
            session: NonNullable<NonNullable<HostExec['agent']>['session']>;
        }): HostPolicy;
    };
    /** Trusted implementation must enforce paths, credential fences, confinement,
     * cancellation and authority revalidation before side effects. Do not bind
     * directly to addition.handlers: those are unrestricted engine entrypoints. */
    invoke?: (name: string, args: Record<string, unknown>, exec: HostExec, policy: HostPolicy) => Promise<unknown>;
}
type Effect = 'none' | 'applied' | 'partial' | 'unknown';
type Retry = 'never' | 'after-input-change' | 'after-state-change' | 'bounded-transient';
export type HostOutcome = {
    status: 'completed';
    data: Record<string, unknown>;
} | {
    status: 'partial';
    data: Record<string, unknown>;
    coverage: Record<string, unknown>;
    continuation: string;
} | {
    status: 'rejected' | 'conflict' | 'error' | 'unknown';
    error: {
        code: string;
        message: string;
        effectState: Effect;
        retry: Retry;
    };
    data?: Record<string, unknown>;
};
interface JsonSchema {
    type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
    properties?: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties?: boolean;
    oneOf?: JsonSchema[];
    enum?: Array<string | number | boolean | null>;
    const?: string | number | boolean | null;
}
const object = (properties: Record<string, JsonSchema>, required?: string[]): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const dataSchema: JsonSchema = { type: 'object', properties: {}, additionalProperties: true };
const coverage = (complete: boolean): JsonSchema => object({ scannedFiles: { type: 'integer' }, matchedCount: { type: 'integer' },
    isComplete: { type: 'boolean', const: complete }, truncatedBy: { type: 'string', enum: ['scan-budget', 'output-budget', 'time-limit', 'row-limit'] } }, ['scannedFiles', 'matchedCount', 'isComplete']);
/** Same envelope as dsh-ops 0.4.1 modes/ptc/schema; engine data remains separate. */
export const HOST_OUTCOME_SCHEMA: JsonSchema = { oneOf: [
        object({ status: { const: 'completed', type: 'string' }, data: dataSchema, coverage: coverage(true) }, ['status', 'data']),
        object({ status: { const: 'partial', type: 'string' }, data: dataSchema, coverage: coverage(false), continuation: { type: 'string' } }, ['status', 'data', 'coverage', 'continuation']),
        object({ status: { type: 'string', enum: ['rejected', 'conflict', 'error', 'unknown'] }, data: dataSchema, error: object({
                code: { type: 'string' }, message: { type: 'string' }, effectState: { type: 'string', enum: ['none', 'applied', 'partial', 'unknown'] },
                retry: { type: 'string', enum: ['never', 'after-input-change', 'after-state-change', 'bounded-transient'] },
            }, ['code', 'message', 'effectState', 'retry']) }, ['status', 'error']),
    ] };
type FailureStatus = Exclude<HostOutcome['status'], 'completed' | 'partial'>;
const FAILURE_STATUSES: readonly FailureStatus[] = ['rejected', 'conflict', 'error', 'unknown'];
const EFFECTS: readonly Effect[] = ['none', 'applied', 'partial', 'unknown'];
const RETRIES: readonly Retry[] = ['never', 'after-input-change', 'after-state-change', 'bounded-transient'];
const TRUNCATED_BY = ['scan-budget', 'output-budget', 'time-limit', 'row-limit'] as const;
type TruncatedBy = (typeof TRUNCATED_BY)[number];
const isFailureStatus = (v: unknown): v is FailureStatus => (FAILURE_STATUSES as readonly unknown[]).includes(v);
const isEffect = (v: unknown): v is Effect => (EFFECTS as readonly unknown[]).includes(v);
const isRetry = (v: unknown): v is Retry => (RETRIES as readonly unknown[]).includes(v);
const isTruncatedBy = (v: unknown): v is TruncatedBy => (TRUNCATED_BY as readonly unknown[]).includes(v);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const failure = (code: string, message: string, effectState: Effect = 'none', retry: Retry = 'never'): HostOutcome => ({
    status: effectState === 'unknown' ? 'unknown' : code === 'POLICY_DENIED' || code === 'EXECUTOR_UNAVAILABLE' ? 'rejected' : 'error',
    error: { code, message, effectState, retry },
});
export function toHostOutcome(value: unknown, mayWrite = false): HostOutcome {
    if (!record(value))
        return failure('RESULT_UNKNOWN', 'Execution returned no structured receipt.', 'unknown');
    if (isFailureStatus(value.status)) {
        const error = record(value.error) ? value.error : value;
        const effect: Effect = isEffect(error.effectState) ? error.effectState : mayWrite ? 'unknown' : 'none';
        const retry: Retry = isRetry(error.retry) ? error.retry : 'never';
        return { status: value.status, error: {
                code: typeof error.code === 'string' ? error.code : 'RESULT_UNKNOWN',
                message: typeof error.message === 'string' ? error.message : 'Execution failed without a message.', effectState: effect, retry,
            }, data: value };
    }
    const data = value.status === 'completed' || value.status === 'partial' ? value.data : value.status === 'ok' ? value : undefined;
    if (!record(data))
        return failure('RESULT_UNKNOWN', 'Execution returned an unrecognized status or data shape.', 'unknown');
    const reported = record(value.coverage) ? value.coverage : undefined;
    const locate = record(data.locate) ? data.locate : undefined;
    const incomplete = value.status === 'partial' || reported?.isComplete === false || locate?.truncated || locate?.pruned
        || data.truncated || data.pruned || data.partial === true || data.complete === false || data.scanComplete === false || data.pageComplete === false || Number(data.failed) > 0;
    if (incomplete) {
        const c = reported;
        if (c && c.isComplete === false && Number.isInteger(c.scannedFiles) && Number.isInteger(c.matchedCount)
            && typeof value.continuation === 'string' && value.continuation.length > 0) {
            return { status: 'partial', data, coverage: { scannedFiles: c.scannedFiles, matchedCount: c.matchedCount, isComplete: false,
                    ...(isTruncatedBy(c.truncatedBy) ? { truncatedBy: c.truncatedBy } : {}) }, continuation: value.continuation };
        }
        return { ...failure('RESULT_PARTIAL', 'Observation was incomplete and has no safe continuation. Narrow the input before retrying.', mayWrite ? 'unknown' : 'none', 'after-input-change'), data };
    }
    return { status: 'completed', data };
}
const mutates = (name: string, args: Record<string, unknown>) => name === 'ops_ptc_audit'
    || ((name === 'ops_ptc_inproc' || name === 'ops_ptc_refactor') && args.mode !== 'preview');
export interface HostToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    timeoutMs: number;
    output: {
        schema: typeof HOST_OUTCOME_SCHEMA;
        render: (args: unknown, value: unknown) => Array<{
            type: 'text';
            text: string;
        }>;
    };
    execute(args: unknown, exec: HostExec): Promise<HostOutcome>;
}
/** Explicit host integration only. No automatic original OPS discovery mounting. */
export function createHostTools(addition: PtcToolAddition, bridge: HostBridge): HostToolDefinition[] {
    return addition.tools.map(tool => ({
        name: tool.name,
        description: tool.description + ' Returns Outcome: completed.data; partial.data/coverage/continuation; failures use error.code/effectState/retry.',
        parameters: tool.inputSchema,
        timeoutMs: 120000,
        output: { schema: HOST_OUTCOME_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
            let started = false;
            let mayWrite = false;
            try {
                if (!record(args))
                    return failure('INVALID_ARGUMENT', 'Arguments must be an object.', 'none', 'after-input-change');
                const input = JSON.parse(JSON.stringify(args));
                mayWrite = mutates(tool.name, input);
                const session = exec?.agent?.session;
                if (!session?.id || !bridge?.sandboxPolicy?.resolve || !bridge.invoke)
                    return failure('EXECUTOR_UNAVAILABLE', 'A session, authoritative sandboxPolicy and trusted invoke bridge are required.');
                const policy = bridge.sandboxPolicy.resolve({ session });
                if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode) || !path.isAbsolute(policy.workspaceRoot ?? ''))
                    return failure('EXECUTOR_UNAVAILABLE', 'The host returned an invalid authoritative policy.');
                if (policy.mode === 'read-only' && mayWrite)
                    return failure('POLICY_DENIED', 'This operation requires workspace-write.');
                if (exec.signal?.aborted)
                    return failure('ABORTED', 'Execution was cancelled before dispatch.');
                started = true;
                return toHostOutcome(await bridge.invoke(tool.name, input, exec, { ...policy }), mayWrite);
            }
            catch {
                return failure('RESULT_UNKNOWN', started ? 'Trusted execution did not return a settled receipt. Inspect postconditions.' : 'Host authority or request preparation failed.', started && mayWrite ? 'unknown' : 'none');
            }
        },
    }));
}
/** Register on the caller's scoped ctx.tools service; dispose with its lifecycle. */
export function registerHostTools(ctx: {
    tools: {
        register(definition: HostToolDefinition): () => void;
    };
}, addition: PtcToolAddition, bridge: HostBridge): () => void {
    const disposers: Array<() => void> = [];
    const dispose = () => { for (const release of disposers.splice(0).reverse())
        release(); };
    try {
        for (const definition of createHostTools(addition, bridge))
            disposers.push(ctx.tools.register(definition));
        return dispose;
    }
    catch (error) {
        dispose();
        throw error;
    }
}
