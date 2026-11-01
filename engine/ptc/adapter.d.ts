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
/** Same envelope as dsh-ops 0.4.1 modes/ptc/schema; engine data remains separate. */
export declare const HOST_OUTCOME_SCHEMA: JsonSchema;
export declare function toHostOutcome(value: unknown, mayWrite?: boolean): HostOutcome;
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
export declare function createHostTools(addition: PtcToolAddition, bridge: HostBridge): HostToolDefinition[];
/** Register on the caller's scoped ctx.tools service; dispose with its lifecycle. */
export declare function registerHostTools(ctx: {
    tools: {
        register(definition: HostToolDefinition): () => void;
    };
}, addition: PtcToolAddition, bridge: HostBridge): () => void;
export {};
