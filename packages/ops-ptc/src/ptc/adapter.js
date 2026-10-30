"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_OUTCOME_SCHEMA = void 0;
exports.toHostOutcome = toHostOutcome;
exports.createHostTools = createHostTools;
exports.registerHostTools = registerHostTools;
const node_path_1 = __importDefault(require("node:path"));
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const dataSchema = { type: 'object', properties: {}, additionalProperties: true };
const coverage = (complete) => object({ scannedFiles: { type: 'integer' }, matchedCount: { type: 'integer' },
    isComplete: { type: 'boolean', const: complete }, truncatedBy: { type: 'string', enum: ['scan-budget', 'output-budget', 'time-limit', 'row-limit'] } }, ['scannedFiles', 'matchedCount', 'isComplete']);
exports.HOST_OUTCOME_SCHEMA = { oneOf: [
        object({ status: { const: 'completed', type: 'string' }, data: dataSchema, coverage: coverage(true) }, ['status', 'data']),
        object({ status: { const: 'partial', type: 'string' }, data: dataSchema, coverage: coverage(false), continuation: { type: 'string' } }, ['status', 'data', 'coverage', 'continuation']),
        object({ status: { type: 'string', enum: ['rejected', 'conflict', 'error', 'unknown'] }, data: dataSchema, error: object({
                code: { type: 'string' }, message: { type: 'string' }, effectState: { type: 'string', enum: ['none', 'applied', 'partial', 'unknown'] },
                retry: { type: 'string', enum: ['never', 'after-input-change', 'after-state-change', 'bounded-transient'] },
            }, ['code', 'message', 'effectState', 'retry']) }, ['status', 'error']),
    ] };
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const failure = (code, message, effectState = 'none', retry = 'never') => ({
    status: effectState === 'unknown' ? 'unknown' : code === 'POLICY_DENIED' || code === 'EXECUTOR_UNAVAILABLE' ? 'rejected' : 'error',
    error: { code, message, effectState, retry },
});
function toHostOutcome(value, mayWrite = false) {
    if (!record(value))
        return failure('RESULT_UNKNOWN', 'Execution returned no structured receipt.', 'unknown');
    if (['rejected', 'conflict', 'error', 'unknown'].includes(value.status)) {
        const error = record(value.error) ? value.error : value;
        const effect = ['none', 'applied', 'partial', 'unknown'].includes(error.effectState) ? error.effectState : mayWrite ? 'unknown' : 'none';
        const retry = ['never', 'after-input-change', 'after-state-change', 'bounded-transient'].includes(error.retry) ? error.retry : 'never';
        return { status: value.status, error: {
                code: typeof error.code === 'string' ? error.code : 'RESULT_UNKNOWN',
                message: typeof error.message === 'string' ? error.message : 'Execution failed without a message.', effectState: effect, retry,
            }, data: value };
    }
    const data = value.status === 'completed' || value.status === 'partial' ? value.data : value.status === 'ok' ? value : undefined;
    if (!record(data))
        return failure('RESULT_UNKNOWN', 'Execution returned an unrecognized status or data shape.', 'unknown');
    const incomplete = value.status === 'partial' || value.coverage?.isComplete === false || data.locate?.truncated || data.locate?.pruned
        || data.truncated || data.pruned || data.partial === true || data.complete === false || data.scanComplete === false || data.pageComplete === false || Number(data.failed) > 0;
    if (incomplete) {
        const c = value.coverage;
        if (record(c) && c.isComplete === false && Number.isInteger(c.scannedFiles) && Number.isInteger(c.matchedCount)
            && typeof value.continuation === 'string' && value.continuation.length > 0) {
            return { status: 'partial', data, coverage: { scannedFiles: c.scannedFiles, matchedCount: c.matchedCount, isComplete: false,
                    ...(['scan-budget', 'output-budget', 'time-limit', 'row-limit'].includes(c.truncatedBy) ? { truncatedBy: c.truncatedBy } : {}) }, continuation: value.continuation };
        }
        return { ...failure('RESULT_PARTIAL', 'Observation was incomplete and has no safe continuation. Narrow the input before retrying.', mayWrite ? 'unknown' : 'none', 'after-input-change'), data };
    }
    return { status: 'completed', data };
}
const mutates = (name, args) => name === 'ops_ptc_audit'
    || ((name === 'ops_ptc_inproc' || name === 'ops_ptc_refactor') && args.mode !== 'preview');
function createHostTools(addition, bridge) {
    return addition.tools.map(tool => ({
        name: tool.name,
        description: tool.description + ' Returns Outcome: completed.data; partial.data/coverage/continuation; failures use error.code/effectState/retry.',
        parameters: tool.inputSchema,
        timeoutMs: 120000,
        output: { schema: exports.HOST_OUTCOME_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
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
                if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode) || !node_path_1.default.isAbsolute(policy.workspaceRoot ?? ''))
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
function registerHostTools(ctx, addition, bridge) {
    const disposers = [];
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
