/**
 * The MCP stdio server: newline-delimited JSON in, newline-delimited JSON out.
 *
 * Two limits exist because a client can write faster than the tools answer: at most 32 requests in
 * flight, and at most 8 MiB of unflushed output. Both refusals are explicit — a caller that gets
 * "Server busy" or a dropped stdin knows what happened, whereas silently queueing would grow memory
 * until the process died.
 *
 * A frame over 1 MiB is dropped whole rather than streamed: half a JSON object is not recoverable, and
 * trying to resynchronise inside it would misparse the next request too.
 *
 * @module dsh-ops/ptc/mcp
 */

import { opsPtcAddition } from './tools.cjs'

/** A JSON-RPC id: absent for notifications, null only in error replies. */
type RpcId = string | number | null

interface RpcRequest {
  jsonrpc: '2.0'
  id?: RpcId
  method: string
  params?: Record<string, unknown> | unknown[]
}

/** What a tool handler receives; the MCP surface only ever sets `cwd`. */
interface ToolContext { cwd?: string }

/** The MCP result envelope for `tools/call`. */
interface ToolResult {
  content: Array<{ type: 'text', text: string }>
  structuredContent: Record<string, unknown>
  isError?: true
}

const SERVER_INFO = { name: 'ops-ptc', version: opsPtcAddition.version }
const PROTOCOL_VERSION = '2024-11-05'
const MAX_FRAME_BYTES = 1 << 20
const MAX_INFLIGHT = 32
const MAX_PENDING_OUTPUT_BYTES = 8 << 20

const write = (msg: Record<string, unknown>): void => {
  const frame = `${JSON.stringify(msg)}\n`
  if (Buffer.byteLength(frame) > MAX_PENDING_OUTPUT_BYTES - process.stdout.writableLength) {
    // The client is not reading. Dropping stdin and exiting is the only honest answer; buffering would
    // trade a visible failure for an invisible one.
    process.stdin.destroy()
    process.stderr.write('[ops-ptc/mcp] Output buffer limit exceeded (8388608 bytes)\n')
    process.exit(1)
  }
  process.stdout.write(frame)
}

const reply = (id: RpcId | undefined, result: unknown): void => write({ jsonrpc: '2.0', id: id ?? null, result })

const fail = (id: RpcId | undefined, code: number, message: string, data?: unknown): void =>
  write({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } })

const mcpTool = (tool: { name: string, title: string, description: string, inputSchema: unknown }): Record<string, unknown> => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
})

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const hasId = (req: RpcRequest): boolean => Object.hasOwn(req, 'id')

/** Validate the envelope before it reaches dispatch; a bad envelope must not become a bad tool call. */
const isRequest = (value: unknown): value is RpcRequest => {
  if (!isObject(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') return false
  if (Object.hasOwn(value, 'id') && value.id !== null && typeof value.id !== 'string'
    && !(typeof value.id === 'number' && Number.isFinite(value.id))) return false
  return !Object.hasOwn(value, 'params') || isObject(value.params) || Array.isArray(value.params)
}

async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const handlers = opsPtcAddition.handlers as unknown as Record<string, (a: Record<string, unknown>, c: ToolContext) => Promise<Record<string, unknown>>>
  if (!Object.hasOwn(handlers, name) || typeof handlers[name] !== 'function') {
    throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 })
  }
  const out = await handlers[name](args, ctx)
  return {
    content: [{ type: 'text', text: JSON.stringify(out) }],
    structuredContent: out,
    // `isError` is what an MCP client branches on; the payload also carries `status: 'error'`.
    ...(isObject(out) && out.status === 'error' ? { isError: true as const } : {}),
  }
}

async function dispatch(req: RpcRequest): Promise<void> {
  const { id, method, params = {} } = req
  const respond = (result: unknown): void => {
    if (hasId(req)) reply(id, result)
  }
  const reject = (code: number, message: string): void => {
    if (hasId(req)) fail(id, code, message)
  }
  if (!isObject(params)) {
    reject(-32602, 'Invalid params: expected an object')
    return
  }

  switch (method) {
    case 'initialize':
      respond({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: '默认不加载。仅在「大型代码重构 / 复杂代码库分析」时使用；返回值是一行极简 JSON，'
          + '中间态（文件列表 / AST 切片 / 补丁载荷 / diff 全文）不会进入对话历史。',
      })
      return
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      respond({})
      return
    case 'tools/list':
      respond({
        tools: opsPtcAddition.tools.map(mcpTool),
        _meta: { load: opsPtcAddition.discover.load, cost: opsPtcAddition.discover.cost, id: opsPtcAddition.id },
      })
      return
    case 'tools/call': {
      if (typeof params.name !== 'string' || !params.name
        || (Object.hasOwn(params, 'arguments') && !isObject(params.arguments))) {
        reject(-32602, 'Invalid params: name must be a string and arguments an object')
        return
      }
      try {
        respond(await callTool(params.name, (params.arguments as Record<string, unknown> | undefined) ?? {}, { cwd: process.cwd() }))
      } catch (error) {
        const problem = error as Error & { code?: number }
        if (problem.code === -32602) reject(-32602, problem.message)
        else {
          respond({
            content: [{ type: 'text', text: JSON.stringify({ status: 'error', code: 'E_INTERNAL', message: problem.message }) }],
            isError: true,
          })
        }
      }
      return
    }
    default:
      reject(-32601, `未实现的方法: ${method}`)
  }
}

const inflight = new Set<Promise<void>>()
let parts: Buffer[] = []
let frameBytes = 0
let discarding = false

/** Assemble one newline-delimited frame and dispatch it. */
function acceptFrame(): void {
  const line = Buffer.concat(parts, frameBytes).toString('utf8').trim()
  parts = []
  frameBytes = 0
  if (!line) return
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    fail(null, -32700, 'Parse error')
    return
  }
  if (!isRequest(value)) {
    fail(null, -32600, 'Invalid Request')
    return
  }
  const req = value
  if (inflight.size >= MAX_INFLIGHT) {
    if (hasId(req)) fail(req.id, -32000, 'Server busy')
    return
  }
  const task = dispatch(req)
    .catch((error: Error) => {
      if (hasId(req)) fail(req.id, -32603, error.message)
    })
    .finally(() => inflight.delete(task))
  inflight.add(task)
}

process.stdin.on('data', (chunk: Buffer) => {
  let start = 0
  while (start < chunk.length) {
    const newline = chunk.indexOf(10, start)
    const end = newline < 0 ? chunk.length : newline
    if (!discarding) {
      const length = end - start
      if (length > MAX_FRAME_BYTES - frameBytes) {
        parts = []
        frameBytes = 0
        discarding = true
        fail(null, -32600, `Frame exceeds ${MAX_FRAME_BYTES} bytes`)
      } else if (length > 0) {
        parts.push(Buffer.from(chunk.subarray(start, end)))
        frameBytes += length
      }
    }
    if (newline < 0) break
    if (discarding) discarding = false
    else acceptFrame()
    start = newline + 1
  }
})

process.stdin.on('end', async () => {
  if (!discarding && frameBytes > 0) acceptFrame()
  // Drain before exiting: a reply written after the process exits is a reply the client never sees.
  while (inflight.size > 0) await Promise.allSettled([...inflight])
  process.exitCode = 0
})

process.on('uncaughtException', (error: Error) => {
  process.stderr.write(`[ops-ptc/mcp] ${error.message}\n`)
  process.exit(1)
})
