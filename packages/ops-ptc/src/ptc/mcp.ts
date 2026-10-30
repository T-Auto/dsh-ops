/**
 * MCP stdio server：按行分帧（NDJSON）的 JSON-RPC 2.0 端点。
 *
 * 只做传输与协议校验，工具实现全在 `./tools`；每一帧独立 dispatch，靠 `inflight`
 * 限并发。输出侧有一道硬闸：积压超过 8 MB 就直接退出，避免宿主不读 stdout 时把进程撑死。
 */
import { opsPtcAddition, type PtcToolDef } from './tools';

const SERVER_INFO = { name: 'ops-ptc', version: opsPtcAddition.version };
const PROTOCOL_VERSION = '2024-11-05';
const MAX_FRAME_BYTES = 1 << 20;
const MAX_INFLIGHT = 32;
const MAX_PENDING_OUTPUT_BYTES = 8 << 20;

/** JSON-RPC 的 id：请求方可省略，响应里缺省写 null */
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: JsonRpcId;
    method: string;
    params?: unknown;
}

const write = (msg: Record<string, unknown>): void => {
    const frame = JSON.stringify(msg) + '\n';
    if (Buffer.byteLength(frame) > MAX_PENDING_OUTPUT_BYTES - process.stdout.writableLength) {
        process.stdin.destroy();
        process.stderr.write('[ops-ptc/mcp] Output buffer limit exceeded (8388608 bytes)\n');
        process.exit(1);
    }
    process.stdout.write(frame);
};

const reply = (id: JsonRpcId | undefined, result: unknown): void => write({ jsonrpc: '2.0', id: id ?? null, result });

const fail = (id: JsonRpcId | undefined, code: number, message: string, data?: unknown): void => write({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

const mcpTool = (t: PtcToolDef) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
});

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const hasId = (req: JsonRpcRequest): boolean => Object.hasOwn(req, 'id');

const isRequest = (value: unknown): value is JsonRpcRequest => {
    if (!isObject(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string')
        return false;
    if (Object.hasOwn(value, 'id') && value.id !== null && typeof value.id !== 'string' &&
        !(typeof value.id === 'number' && Number.isFinite(value.id)))
        return false;
    return !Object.hasOwn(value, 'params') || isObject(value.params) || Array.isArray(value.params);
};

async function callTool(name: string, args: unknown, ctx: { cwd: string }) {
    const handlers = opsPtcAddition.handlers;
    if (!Object.hasOwn(handlers, name) || typeof handlers[name] !== 'function') {
        throw Object.assign(new Error(`未知工具: ${name}`), { code: -32602 });
    }
    const out = await handlers[name](args, ctx);
    return {
        content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out,
        ...(isObject(out) && out.status === 'error' ? { isError: true } : {}),
    };
}

async function dispatch(req: JsonRpcRequest): Promise<void> {
    const { id, method, params = {} } = req;
    const respond = (result: unknown): void => { if (hasId(req))
        reply(id, result); };
    const reject = (code: number, message: string): void => { if (hasId(req))
        fail(id, code, message); };
    if (!isObject(params)) {
        reject(-32602, 'Invalid params: expected an object');
        return;
    }
    switch (method) {
        case 'initialize':
            respond({
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: SERVER_INFO,
                instructions: '默认不加载。仅在「大型代码重构 / 复杂代码库分析」时使用；返回值是一行极简 JSON，' +
                    '中间态（文件列表 / AST 切片 / 补丁载荷 / diff 全文）不会进入对话历史。',
            });
            return;
        case 'notifications/initialized':
        case 'notifications/cancelled':
            return;
        case 'ping':
            respond({});
            return;
        case 'tools/list':
            respond({
                tools: opsPtcAddition.tools.map(mcpTool),
                _meta: { load: opsPtcAddition.discover.load, cost: opsPtcAddition.discover.cost, id: opsPtcAddition.id },
            });
            return;
        case 'tools/call': {
            if (typeof params.name !== 'string' || !params.name ||
                (Object.hasOwn(params, 'arguments') && !isObject(params.arguments))) {
                reject(-32602, 'Invalid params: name must be a string and arguments an object');
                return;
            }
            try {
                respond(await callTool(params.name, (params.arguments ?? {}), { cwd: process.cwd() }));
            }
            catch (e) {
                const err = e as Error & { code?: number };
                if (err.code === -32602)
                    reject(-32602, err.message);
                else {
                    respond({
                        content: [{ type: 'text', text: JSON.stringify({ status: 'error', code: 'E_INTERNAL', message: err.message }) }],
                        isError: true,
                    });
                }
            }
            return;
        }
        default:
            reject(-32601, `未实现的方法: ${method}`);
    }
}

const inflight = new Set<Promise<void>>();
let parts: Buffer[] = [];
let frameBytes = 0;
let discarding = false;

function acceptFrame(): void {
    const line = Buffer.concat(parts, frameBytes).toString('utf8').trim();
    parts = [];
    frameBytes = 0;
    if (!line)
        return;
    let value: unknown;
    try {
        value = JSON.parse(line);
    }
    catch {
        fail(null, -32700, 'Parse error');
        return;
    }
    if (!isRequest(value)) {
        fail(null, -32600, 'Invalid Request');
        return;
    }
    const req = value;
    if (inflight.size >= MAX_INFLIGHT) {
        if (hasId(req))
            fail(req.id, -32000, 'Server busy');
        return;
    }
    const task = dispatch(req)
        .catch((e) => { if (hasId(req))
        fail(req.id, -32603, (e as Error).message); })
        .finally(() => inflight.delete(task));
    inflight.add(task);
}

process.stdin.on('data', (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length) {
        const nl = chunk.indexOf(10, start);
        const end = nl < 0 ? chunk.length : nl;
        if (!discarding) {
            const length = end - start;
            if (length > MAX_FRAME_BYTES - frameBytes) {
                parts = [];
                frameBytes = 0;
                discarding = true;
                fail(null, -32600, `Frame exceeds ${MAX_FRAME_BYTES} bytes`);
            }
            else if (length > 0) {
                parts.push(Buffer.from(chunk.subarray(start, end)));
                frameBytes += length;
            }
        }
        if (nl < 0)
            break;
        if (discarding)
            discarding = false;
        else
            acceptFrame();
        start = nl + 1;
    }
});

process.stdin.on('end', async () => {
    if (!discarding && frameBytes > 0)
        acceptFrame();
    while (inflight.size > 0)
        await Promise.allSettled([...inflight]);
    process.exitCode = 0;
});

process.on('uncaughtException', (e) => {
    process.stderr.write(`[ops-ptc/mcp] ${e.message}\n`);
    process.exit(1);
});
