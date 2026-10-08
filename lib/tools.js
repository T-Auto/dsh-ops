/**
 * The FastCtx tool surface: this plugin's own long-lived MCP stdio connection
 * to the vendored FastCtx server, and the `ops_<rawName>` tool definitions it
 * publishes into the harness tool registry.
 *
 * The boundary held here is deliberate, because breaking it already shipped
 * once: **the plugin registers its own tools through its own context and never
 * rewrites the shared tool registry.** Replacing `ToolRuntime.register` made
 * every *foreign* registration look like this plugin's own — a Cordis service
 * property read returns a wrapper bound to the reading context, so the
 * patched call attributed the caller's write to this plugin — and the host's
 * second registration of a name such as `subagent` then threw "already
 * registered", failing every new session. See the plugin's `AGENTS.md`,
 * "上游兼容 (upstream compatibility)".
 *
 * Load-time semantics are the caller's: an unavailable server is fatal only
 * when the deployment says `required: true`.
 *
 * @module dsh-ops/tools
 */

import { McpStdioClient } from './handshake.js'
import { publicToolName } from './policy.js'

/** Deadline for one connection attempt: spawn, initialize, and `tools/list`. */
const CONNECT_TIMEOUT_MS = 60_000

/** Upper bound for the server's own instructions, in UTF-8 bytes. */
const MAX_INSTRUCTION_BYTES = 32_768

/**
 * Reconnect policy. One outage shares one attempt budget: `maxAttempts`
 * consecutive failed attempts, delays doubling from `initialDelayMs` up to
 * `maxDelayMs`. A connection that stayed up at least `maxDelayMs` closes the
 * outage, so the next disconnect starts a fresh budget while a crash-looping
 * server — even one whose connects briefly succeed — still exhausts the cap
 * instead of restarting forever.
 */
export const RECONNECT = Object.freeze({
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

/** Credential-shaped environment names the harness never forwards to a child. */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** The harness's own fact prefix, never forwarded to a child implicitly. */
const DSH_ENV_PREFIX = 'DSH_'

/**
 * The canonical value schema of one published tool: the MCP content array,
 * plus the server's structured result when it sends one. `structuredContent`
 * is declared but not required, so a result without one is still canonical.
 */
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    content: { type: 'array', items: {} },
    structuredContent: {},
  },
  required: ['content'],
  additionalProperties: false,
})

/** Raised internally when `stop()` wins the race against an in-flight connect. */
class StoppedError extends Error {
  constructor() {
    super('the FastCtx tool surface was stopped')
    this.name = 'StoppedError'
  }
}

/**
 * Describe one thrown value for a report line.
 * @param {unknown} error - the thrown value.
 * @returns {string} the message.
 */
function messageOf(error) {
  return String(/** @type {{message?: unknown}} */ (error)?.message ?? error)
}

/**
 * The environment one FastCtx child starts from.
 *
 * The harness never forwards credential-shaped names or its own `DSH_*` facts
 * to a child, and the MCP bridge this plugin used to mount applied that same
 * scrub. The plugin spawns the server itself now, so it keeps the guarantee:
 * `PATH`, `HOME`, locale, and proxy variables survive so child tooling runs
 * normally, while credentials are never inherited implicitly (`gh` and `git`
 * keep reading their own configuration files).
 * @param {NodeJS.ProcessEnv} [parent] - the environment to scrub.
 * @returns {NodeJS.ProcessEnv} a fresh environment object safe to hand to a spawn.
 */
export function childEnv(parent = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    if (key.toUpperCase().startsWith(DSH_ENV_PREFIX)) continue
    env[key] = value
  }
  return env
}

/**
 * The FastCtx command line this deployment wants: the shell tools are opt-in.
 * @param {boolean} enableShellTools - whether to publish FastCtx's run/job tools.
 * @returns {string[]} the server arguments.
 */
export function serverArgs(enableShellTools) {
  return enableShellTools ? ['serve', '--enable-shell'] : ['serve']
}

/**
 * Project one MCP content array into the text the model reads.
 *
 * Text blocks are joined verbatim. Blocks this plugin cannot present as model
 * context (images, audio, embedded resources) become one explicit placeholder
 * rather than silence, and the raw MCP content stays in the canonical value for
 * programmatic callers.
 * @param {unknown[]} content - the MCP content array.
 * @param {string} rawName - the server's own tool name, for the empty case.
 * @returns {string} the rendered text.
 */
export function renderContent(content, rawName) {
  const parts = []
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported MCP content block: expected an object]')
      continue
    }
    const block = /** @type {Record<string, any>} */ (value)
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'resource_link':
        parts.push(typeof block.name === 'string' && typeof block.uri === 'string'
          ? `Resource link: ${block.name} (${block.uri})`
          : '[resource link unavailable: the MCP block is missing its name or URI]')
        break
      case 'image':
      case 'audio':
      case 'resource':
        parts.push(`[${block.type} content is not shown to the model; the raw MCP result remains `
          + 'available to programmatic callers]')
        break
      default:
        parts.push(`[unsupported MCP content type: ${String(block.type)}]`)
    }
  }
  const text = parts.join('\n')
  return text === '' ? `(${publicToolName(rawName)} returned no model-visible content)` : text
}

/**
 * Map one MCP `tools/call` result onto the harness tool-result contract.
 *
 * An MCP error result becomes a rejected call, exactly as the bridge did
 * before: the model must read the error and correct its arguments instead of
 * treating an empty success as an answer.
 * @param {unknown} result - the raw MCP result.
 * @param {string} rawName - the server's own tool name.
 * @returns {{content: unknown[], structuredContent?: unknown}} the canonical value.
 * @throws {Error} when the result is malformed, or when it is an error result.
 */
export function toToolValue(result, rawName) {
  const value = /** @type {{content?: unknown, isError?: unknown, structuredContent?: unknown}} */ (result)
  if (typeof value !== 'object' || value === null || !Array.isArray(value.content)) {
    throw new Error(`${publicToolName(rawName)} returned an invalid MCP result without a content array`)
  }
  if (value.isError === true) throw new Error(renderContent(value.content, rawName))
  return {
    content: value.content,
    ...(value.structuredContent !== undefined ? { structuredContent: value.structuredContent } : {}),
  }
}

/**
 * One registered tool definition for one FastCtx tool.
 * @param {object} options - the definition inputs.
 * @param {{name: string, description?: string, inputSchema?: Record<string, unknown>}} options.tool - the server's own tool.
 * @param {(args: Record<string, unknown>, exec: unknown) => Promise<{content: unknown[], structuredContent?: unknown}>} options.call - the call body.
 * @returns {object} the definition `ctx.tools.register()` accepts.
 */
export function toolDefinition({ tool, call }) {
  return {
    name: publicToolName(tool.name),
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderContent(value.content ?? [], tool.name) }],
    },
    execute: (args, exec) => call(args, exec),
  }
}

/**
 * One owned FastCtx connection and the tool generation it publishes.
 *
 * The surface needs exactly one thing from its context — the tool registry this
 * plugin registers into — so that a caller can drive it without a host, and so
 * that there is no seam through which it could reach anything it does not own.
 */
export class FastCtxTools {
  /**
   * @param {object} options - the surface inputs.
   * @param {{tools: {register: (definition: object) => () => void}}} options.ctx - this plugin's own registration context.
   * @param {import('./config.js').ResolvedConfig} options.config - the resolved plugin configuration.
   * @param {{file: string, source: string, version: string}} options.runtime - the resolved FastCtx executable.
   * @param {(message: string, level?: string) => void} [options.report] - where asynchronous events are reported.
   */
  constructor({ ctx, config, runtime, report }) {
    this.ctx = ctx
    this.config = config
    this.runtime = runtime
    this.report = report ?? (() => {})
    /** The live connection, or undefined while the surface is down. */
    this.client = undefined
    /** When the current connection was established; drives the stability rule. */
    this.connectedAt = undefined
    /** Consecutive failed attempts inside the current outage. */
    this.attempts = 0
    /** The pending reconnect timer, if any. */
    this.timer = undefined
    /** Set once the owner disposed the surface; every later event is ignored. */
    this.stopped = false
    /** Live registrations of the current generation, keyed by public name. */
    this.disposers = new Map()
    /** The server's own identity, once a handshake succeeded. */
    this.serverInfo = undefined
    /** The server's own instructions, as the model-facing section text. */
    this.serverInstructions = ''
  }

  /** The public names currently published, in registration order. */
  names() {
    return [...this.disposers.keys()]
  }

  /**
   * The hosted server's own instructions, already attributed to it.
   *
   * The MCP bridge used to publish these as a prompt section of its own; the
   * plugin keeps the same section name and text shape so the model still reads
   * the server's instructions. Empty while the server is down or sends none.
   * @returns {string} the section text.
   */
  instructions() {
    return this.serverInstructions
  }

  /**
   * Connect and publish the first generation of tools.
   * @returns {Promise<string[]>} the published public names; empty when the server listed none.
   * @throws {Error} on any connection failure — the caller decides whether that is fatal.
   */
  async start() {
    await this.#connect()
    return this.names()
  }

  /**
   * Keep trying in the background after a failed `start()`, with bounded
   * exponential backoff, and republish the whole generation on success.
   * The caller picks this only for a deployment that tolerates a missing
   * server; a fatal one must let `start()` reject instead.
   * @returns {void}
   */
  retryLater() {
    if (this.stopped || this.client !== undefined) return
    this.#scheduleReconnect()
  }

  /**
   * Unregister every tool this surface published and stop the child process.
   *
   * Idempotent, and silent about work that was in flight when it was called.
   * @returns {Promise<void>} resolves once the child is gone.
   */
  async stop() {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const client = this.client
    this.client = undefined
    this.connectedAt = undefined
    this.serverInstructions = ''
    this.#unpublish()
    if (client !== undefined) await client.close()
  }

  /**
   * Spawn one server, handshake, list its tools, and swap in the new generation.
   * @returns {Promise<void>} resolves once the generation is live.
   */
  async #connect() {
    const client = McpStdioClient.start({
      file: this.runtime.file,
      args: serverArgs(this.config.enableShellTools),
      env: childEnv(),
      timeoutMs: CONNECT_TIMEOUT_MS,
    })
    this.client = client
    // Installed before the handshake: a crash is an event, not a failed
    // request, and it must be noticed between calls rather than on the next
    // timeout. The identity guard drops the exit of a connection this surface
    // already replaced or abandoned.
    void client.exited.then(({ code, signal, error }) => this.#onExit(client, code, signal, error))
    try {
      const handshake = await client.initialize('dsh-ops')
      const tools = await client.listTools()
      if (this.stopped || client !== this.client) throw new StoppedError()
      this.#publish(tools)
      this.serverInfo = handshake?.serverInfo
      this.#acceptInstructions(handshake?.instructions)
      this.connectedAt = Date.now()
    } catch (error) {
      await client.close()
      if (this.client === client) this.client = undefined
      throw error
    }
  }

  /**
   * Take the server's instructions for the model, bounded and attributed.
   * @param {unknown} instructions - the handshake's `instructions`.
   * @returns {void}
   */
  #acceptInstructions(instructions) {
    const text = typeof instructions === 'string' ? instructions.trimEnd() : ''
    const attributed = text === '' ? '' : `### MCP server: ${this.config.serverName}\n\n${text}`
    if (Buffer.byteLength(attributed) > MAX_INSTRUCTION_BYTES) {
      this.serverInstructions = ''
      this.report(
        `dsh-ops: ${this.#describe()} sent more than ${MAX_INSTRUCTION_BYTES} bytes of instructions; `
        + 'they are left out of the prompt.',
        'warn',
      )
      return
    }
    this.serverInstructions = attributed
  }

  /**
   * React to one connection ending: report it, then reconnect with backoff.
   * @param {McpStdioClient} client - the connection that ended.
   * @param {number|null} code - the exit code.
   * @param {string|null} signal - the terminating signal.
   * @param {Error} [error] - the spawn error, when the server never started.
   * @returns {void}
   */
  #onExit(client, code, signal, error) {
    if (this.stopped || client !== this.client) return
    this.client = undefined
    this.connectedAt = undefined
    this.report(
      `dsh-ops: ${this.#describe()} ${error !== undefined
        ? `could not be started (${error.message})`
        : `exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`}; `
      + 'the published ops_ tools fail until it is back.',
    )
    this.#scheduleReconnect()
  }

  /**
   * Wait, then try once more, then either recover or spend another attempt.
   * @returns {void}
   */
  #scheduleReconnect() {
    // One pending timer at a time: a crash and a failed first connect can both
    // land here, and two loops would double every later attempt.
    if (this.stopped || this.timer !== undefined) return
    // A connection that stayed up long enough closed the previous outage.
    if (this.connectedAt !== undefined && Date.now() - this.connectedAt >= RECONNECT.maxDelayMs) {
      this.attempts = 0
    }
    this.connectedAt = undefined
    this.attempts += 1
    if (this.attempts > RECONNECT.maxAttempts) {
      // Giving up must not leave phantom tools behind: the model would keep
      // calling a surface nothing answers.
      this.#unpublish()
      this.serverInstructions = ''
      this.report(
        `dsh-ops: giving up on FastCtx after ${RECONNECT.maxAttempts} consecutive failed reconnect `
        + 'attempts; the ops_ tools are unavailable until the plugin is reloaded.',
      )
      return
    }
    const delayMs = Math.min(RECONNECT.maxDelayMs, RECONNECT.initialDelayMs * 2 ** (this.attempts - 1))
    this.report(
      `dsh-ops: FastCtx is down; reconnecting in ${delayMs}ms `
      + `(attempt ${this.attempts}/${RECONNECT.maxAttempts}).`,
      'warn',
    )
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.#reconnect()
    }, delayMs)
    this.timer.unref?.()
  }

  /**
   * One scheduled reconnect attempt: publish a fresh generation, or spend the
   * next attempt. Never rejects and never takes the plugin down.
   * @returns {Promise<void>} resolves once this attempt settled.
   */
  async #reconnect() {
    if (this.stopped) return
    try {
      await this.#connect()
      this.report(`dsh-ops: ${this.#describe()} reconnected with ${this.names().length} tool(s).`)
    } catch (error) {
      if (this.stopped) return
      this.report(
        `dsh-ops: FastCtx reconnect attempt ${this.attempts}/${RECONNECT.maxAttempts} `
        + `failed (${messageOf(error)}).`,
        'warn',
      )
      this.#scheduleReconnect()
    }
  }

  /**
   * Publish one whole generation, or leave the previous one untouched.
   *
   * The next generation is built completely before the live one is disposed, so
   * a failed `tools/list` or a malformed definition costs nothing. A failure
   * while registering rolls the partial generation back and surfaces as a
   * connection failure: a registry conflict can only mean a foreign
   * registration squats on this plugin's own `ops_` names.
   * @param {{name: string, description?: string, inputSchema?: Record<string, unknown>}[]} tools - the server's tool list.
   * @returns {void}
   */
  #publish(tools) {
    const definitions = []
    const seen = new Set()
    for (const tool of tools) {
      const name = publicToolName(String(tool?.name ?? ''))
      if (seen.has(name)) {
        throw new Error(`${this.#describe()} listed the tool "${String(tool?.name)}" more than once`)
      }
      seen.add(name)
      definitions.push(toolDefinition({
        tool,
        call: (args, exec) => this.#call(tool.name, args, exec),
      }))
    }

    this.#unpublish()
    const disposers = new Map()
    try {
      for (const definition of definitions) {
        disposers.set(definition.name, this.ctx.tools.register(definition))
      }
    } catch (error) {
      for (const dispose of disposers.values()) dispose()
      throw error
    }
    this.disposers = disposers
  }

  /** Release every registration of the current generation. @returns {void} */
  #unpublish() {
    for (const dispose of this.disposers.values()) dispose()
    this.disposers = new Map()
  }

  /**
   * Call one FastCtx tool and map its result onto the host contract.
   * @param {string} rawName - the server's own tool name.
   * @param {Record<string, unknown>} args - the arguments.
   * @param {{signal?: AbortSignal}} [exec] - the host execution context.
   * @returns {Promise<{content: unknown[], structuredContent?: unknown}>} the canonical value.
   */
  async #call(rawName, args, exec) {
    const label = publicToolName(rawName)
    const client = this.client
    if (client === undefined) {
      // A dead server must be an immediate, explicit failure rather than a
      // request that waits out the whole call deadline.
      throw new Error(
        `${label} is unavailable: the FastCtx server is not connected `
        + `(reconnect attempt ${this.attempts}/${RECONNECT.maxAttempts} in progress; retry shortly)`,
      )
    }
    let result
    try {
      result = await client.callTool(rawName, args ?? {}, {
        timeoutMs: this.config.toolCallTimeoutMs,
        signal: exec?.signal,
      })
    } catch (error) {
      throw new Error(`${label} failed: ${messageOf(error)}`, { cause: error })
    }
    return toToolValue(result, rawName)
  }

  /**
   * The runtime identity used in reports.
   * @returns {string} a human-readable description.
   */
  #describe() {
    return `FastCtx ${this.runtime.version || 'unknown version'} (${this.runtime.source})`
  }
}
