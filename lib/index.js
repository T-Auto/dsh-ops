/**
 * dsh-ops host half: hosts the vendored FastCtx MCP runtime as this profile's
 * repository tool surface, and steers the model to it instead of the host shell.
 *
 * Four contributions, each scoped to the service it needs so that any one of
 * them can be absent without taking the plugin down:
 *
 * 1. prompt sections that state the tooling policy as an explicit ladder over
 *    the rungs this deployment actually resolved (`lib/policy.js`);
 * 2. the tools that run on this plugin's own shells, published through one
 *    `ctx.effect` (`lib/shells.js`), so the bundled rungs appear wherever that
 *    module can resolve them;
 * 3. the opt-in host-shell enforcement: `tools.restrict()` visibility per
 *    agent, with the shipped `tools/pre-execute` fence as the guarantee;
 * 4. the FastCtx server itself, spawned by this plugin as a long-lived MCP
 *    stdio child whose tools are published under this plugin's own
 *    `ops_<rawName>` namespace (`lib/tools.js`). This plugin holds the MCP
 *    connection and registers its own tools through its own context; it never
 *    touches the shared tool registry. Rewriting a name at the registration
 *    boundary is the shape that failed once: patching `ToolRuntime.register`
 *    attributed every foreign registration to this plugin's plane and broke the
 *    host's second registration of a name such as `subagent`. See `AGENTS.md`,
 *    "上游兼容".
 *
 * The module imports no `@deepseek-ai/*` value at load time at all: everything
 * it needs from the host is reached through `ctx.inject([...])` / `ctx.get()`,
 * so a profile without the tool registry still gets the prompt policy, and a
 * missing service is a logged, bounded failure instead of a plugin that never
 * loads.
 *
 * @module dsh-ops
 */

import { PACKAGE_ROOT, probeBinary, resolveBinary } from './binary.js'
import { resolveConfig } from './config.js'
import {
  HOST_SHELL_SECTION,
  SECTION_ORDERS,
  TOOLING_SECTION,
  TOOL_PREFIX,
  hostShellEnforcement,
  hostShellRefusal,
  ladderLevels,
  renderHostShellPolicy,
  renderToolingPolicy,
} from './policy.js'
import { publishShellTools, resolveShells } from './shells.js'
import { FastCtxTools } from './tools.js'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'dsh-ops'

/**
 * Report one failure without letting a hostile logger hide it.
 * @param {object} ctx - a Cordis context.
 * @param {string} message - the report.
 * @param {'error'|'warn'|'info'} [level] - the logger level to use.
 * @returns {void}
 */
function report(ctx, message, level = 'error') {
  const logger = /** @type {Record<string, (text: string) => void>|undefined} */ (ctx?.logger)
  const write = logger?.[level]
  if (typeof write === 'function') {
    write.call(logger, message)
    return
  }
  if (level === 'warn') console.warn(message)
  else console.error(message)
}

/**
 * Every registered tool name that starts with `prefix`.
 *
 * Read at every prompt assembly rather than cached: the FastCtx server can be
 * replaced and its whole tool generation republished by a reconnect, so the
 * live registry is the only honest answer to "can the model call these tools
 * right now".
 * @param {object} ctx - the context carrying the tool registry.
 * @param {string} prefix - the namespace to filter on.
 * @returns {string[]} the visible names, empty when the registry cannot answer.
 */
function namesWithPrefix(ctx, prefix) {
  try {
    // `ctx.get` rather than `ctx.tools`: this runs from the prompt-injection
    // scope, which does not declare the tool registry as an injection, and the
    // property proxy only answers for declared or topologically visible
    // services.
    const schemas = ctx?.get?.('tools')?.schemas?.() ?? []
    return schemas
      .map((schema) => schema?.name)
      .filter((toolName) => typeof toolName === 'string' && toolName.startsWith(prefix))
  } catch {
    // A registry that cannot answer is not a reason to lose the section: the
    // policy text is still correct, and the next assembly re-asks.
    return []
  }
}

/**
 * The tools this plugin publishes under its own namespace.
 * @param {object} ctx - the context carrying the tool registry.
 * @returns {string[]} the visible `ops_` names.
 */
function visibleTools(ctx) {
  return namesWithPrefix(ctx, TOOL_PREFIX)
}

/**
 * Resolve and probe the runtime, synchronously.
 *
 * Resolution and probing are both synchronous, so they belong in `apply`
 * rather than behind a service injection: a deployment that configured a path
 * this plugin cannot honour must fail at load — that is the earliest point at
 * which the operator can still see which row is at fault.
 * @param {object} ctx - a context to report through.
 * @param {import('./config.js').ResolvedConfig} config - the plugin configuration.
 * @returns {{file: string, source: string, version: string}|undefined} the ready runtime, or undefined after reporting.
 * @throws {Error} when `config.required` is set and no usable runtime exists.
 */
function prepareRuntime(ctx, config) {
  let resolved
  try {
    resolved = resolveBinary({ binaryPath: config.binaryPath, packageRoot: PACKAGE_ROOT })
  } catch (error) {
    const detail = typeof error?.report === 'function' ? `\n${error.report()}` : ''
    report(ctx, `dsh-ops: ${error.message}${detail}`)
    if (config.required) throw error
    return undefined
  }

  const probe = probeBinary(resolved.file)
  if (!probe.ok) {
    report(ctx, `dsh-ops: ${resolved.file} (${resolved.source}) is not a working FastCtx build: ${probe.detail}`)
    if (config.required) throw new Error(`dsh-ops: unusable FastCtx executable at ${resolved.file}`)
    return undefined
  }
  return { file: resolved.file, source: resolved.source, version: probe.version }
}

/**
 * Publish the hosted server's own instructions as its own prompt section.
 *
 * This plugin holds the MCP connection to the server it spawns, so the server's
 * instructions are published under the section name the host reserves for a
 * mounted server, `mcp:<serverName>`, at its `MCP_SERVERS` placement. The text
 * goes empty whenever the server is down or sends none. This is the server's
 * text, not this plugin's policy, so `promptPolicy` does not gate it.
 * @param {object} ctx - this plugin's injected context.
 * @param {import('./config.js').ResolvedConfig} config - the plugin configuration.
 * @param {FastCtxTools} surface - the live tool surface.
 * @returns {void}
 */
function mountServerInstructions(ctx, config, surface) {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const order = promptCtx.systemPrompt.getSectionOrder('MCP_SERVERS')
    if (!Number.isFinite(order)) {
      report(ctx, 'dsh-ops: this host declares no MCP_SERVERS prompt placement; '
        + 'the FastCtx server instructions are left out of the prompt.')
      return
    }
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: `mcp:${config.serverName}`,
      order,
      interpolate: false,
      text: () => surface.instructions(),
    }), 'dsh-ops: fastctx server instructions')
  })
}

/**
 * Start the FastCtx server and publish this plugin's own tool namespace.
 *
 * The surface owns the connection, the reconnect policy, and the tool
 * registrations, and disposing it closes the child and unregisters every tool
 * it published.
 * @param {object} ctx - this plugin's injected context, carrying the tool registry.
 * @param {import('./config.js').ResolvedConfig} config - the plugin configuration.
 * @param {{file: string, source: string, version: string}|undefined} runtime - the prepared runtime.
 * @returns {Promise<void>} resolves once the tools are published or the failure is reported.
 * @throws {Error} when `config.required` is set and the server cannot start.
 */
async function mountServer(ctx, config, runtime) {
  if (runtime === undefined) return

  const surface = new FastCtxTools({
    ctx,
    config,
    runtime,
    report: (message, level) => report(ctx, message, level),
  })
  // Owned by this plugin's fiber: unloading the plugin unregisters every tool
  // it published and stops the server it spawned.
  ctx.effect(() => () => surface.stop(), 'dsh-ops: fastctx server')
  mountServerInstructions(ctx, config, surface)

  let tools
  try {
    tools = await surface.start()
  } catch (error) {
    report(
      ctx,
      `dsh-ops: ${runtime.file} (${runtime.source}, ${runtime.version || 'unknown version'}) could not be `
      + `started (${error?.message ?? error}); the FastCtx tools are unavailable in this deployment.`,
    )
    if (config.required) throw error
    // A deployment that tolerates a missing server still expects it to come
    // back: keep retrying in the background with bounded backoff.
    surface.retryLater()
    return
  }

  if (tools.length === 0) {
    report(
      ctx,
      `dsh-ops: ${runtime.file} (${runtime.source}, ${runtime.version || 'unknown version'}) started `
      + 'but published no FastCtx tools; repository work has no FastCtx tool surface.',
    )
    return
  }
  report(
    ctx,
    `dsh-ops: FastCtx ${runtime.version || 'unknown version'} ready from ${runtime.source} `
    + `with ${tools.length} tool(s): ${tools.join(', ')}`,
  )
}

/**
 * The configured host shell names that one agent can actually see.
 *
 * Read from the live registry as the agent appears, never from the config
 * alone: a name the registry does not carry — or one this agent does not
 * inherit — is left out, so `tools.restrict()` is never handed a name it would
 * reject as an unknown global tool.
 * @param {object} registry - the tool registry.
 * @param {object} agent - the agent whose view is asked.
 * @param {ReadonlySet<string>} denied - the configured host shell names.
 * @returns {string[]} the names visible to that agent, possibly empty.
 */
function visibleDeniedNames(registry, agent, denied) {
  let schemas = []
  try {
    schemas = registry.schemas(agent) ?? []
  } catch {
    // A registry that cannot answer for this agent hides nothing: the fence
    // below still refuses the calls.
    schemas = []
  }
  const present = new Set()
  for (const schema of schemas) {
    if (typeof schema?.name === 'string') present.add(schema.name)
  }
  return [...denied].filter((toolName) => present.has(toolName))
}

/**
 * Hide the host shell tools from one agent, or say why that is not possible.
 *
 * `tools.restrict()` is the weakest mechanism that suffices: it keeps schema
 * presentation, lookup, and execution consistent, and it lifts when disposed.
 * It must run on the agent's own scoped context. The disposer is handed to this
 * plugin's effect as well, because unloading the plugin does not dispose
 * `agent.ctx` registrations by itself.
 * @param {object} ctx - this plugin's context, carrying the tool registry.
 * @param {object} agent - the agent to hide them from.
 * @param {ReadonlySet<string>} denied - the configured host shell names.
 * @returns {{kind: 'hidden'|'absent'|'unsupported', reason?: string}} the outcome.
 */
function hideHostShellTools(ctx, agent, denied) {
  const scope = agent?.ctx
  if (scope === undefined) {
    return { kind: 'unsupported', reason: 'the agent exposes no scoped context' }
  }
  const registry = ctx?.get?.('tools')
  if (typeof registry?.restrict !== 'function' || typeof scope?.tools?.restrict !== 'function') {
    return { kind: 'unsupported', reason: 'this host\'s tool registry has no tools.restrict()' }
  }
  const names = visibleDeniedNames(registry, agent, denied)
  if (names.length === 0) return { kind: 'absent' }
  try {
    const lift = scope.tools.restrict({ deny: names })
    ctx.effect(() => lift, 'dsh-ops: restrict host shell tools')
    return { kind: 'hidden' }
  } catch (error) {
    return { kind: 'unsupported', reason: `tools.restrict() refused ${names.join(', ')}: ${error?.message ?? error}` }
  }
}

/**
 * Install the visibility half of `deny-host-shell`: every agent created while
 * this plugin is mounted has the host shell tools it can see masked out of its
 * own view — but only while this deployment still offers a rung of its own.
 *
 * Both questions are asked here, as the agent appears: whether a rung is live is
 * a registry fact ({@link ladderLevels}), never a resolved executable, and the
 * mask belongs to one agent. Failure is bounded and reported once per mount,
 * because the point of the visibility step is to be the weak mechanism in front
 * of the fence, not to be the only one: a deployment with no rung of its own, or
 * a host that cannot scope the mask, still refuses the calls at
 * `tools/pre-execute`.
 * @param {object} ctx - a context carrying the tool registry, owned by this plugin.
 * @param {import('./config.js').ResolvedConfig} config - the plugin configuration.
 * @param {(ctx: object) => import('./policy.js').LadderLevels} liveLevels - the rungs, read from the registry now.
 * @returns {void}
 */
function installHostShellVisibility(ctx, config, liveLevels) {
  const denied = new Set(config.deniedHostTools)
  let reported = false
  /** Report the first reason this mount could not hide, and nothing after it. */
  const reportOnce = (message) => {
    if (reported) return
    reported = true
    report(ctx, message, 'warn')
  }
  ctx.on('agent/created', ({ agent }) => {
    const enforcement = hostShellEnforcement({
      shellPolicy: config.shellPolicy,
      levels: liveLevels(ctx),
    })
    if (!enforcement.hide) {
      reportOnce(`dsh-ops: ${enforcement.reason}`)
      return
    }
    const outcome = hideHostShellTools(ctx, agent, denied)
    if (outcome.kind !== 'unsupported') return
    reportOnce(
      `dsh-ops: the host shell tools could not be hidden from the model (${outcome.reason}); `
      + 'the tools/pre-execute fence still refuses them by name.',
    )
  })
}

/**
 * Mount the plugin.
 * @param {object} root - the plugin's Cordis context.
 * @param {unknown} [rawConfig] - the `config` value from the loader row.
 * @returns {void}
 */
export function apply(root, rawConfig) {
  const config = resolveConfig(rawConfig)

  // Resolution and probing run here, not behind an injection: a runtime this
  // deployment cannot use is a load-time misconfiguration, and `required` makes
  // it reject activation before the plugin claims to be active.
  const runtime = prepareRuntime(root, config)

  // The shells are resolved once per mount: which executable, by which route,
  // and why not. That is detail and reporting. A rung exists for the model when
  // its tool is published, so `liveLevels` asks the registry, at the moment the
  // question is asked. The PowerShell rung is the one exception: what makes it
  // live is the bundled executable being there, which is the same fact the
  // bundle patch's L3 override acts on. "Prefer" is wording plus those facts:
  // nothing here falls back from one rung to another at run time.
  const shells = resolveShells(config)
  const pwshRung = shells.pwsh.available === true
  /** The rungs as they stand right now. */
  const liveLevels = (ctx) => ladderLevels({ published: visibleTools(ctx), pwsh: pwshRung })

  // One effect owns every tool the bundled shells publish, so unloading the
  // plugin removes them exactly as it removes the FastCtx tools.
  root.inject(['tools'], (ctx) => {
    ctx.effect(() => publishShellTools(ctx, config, shells), 'dsh-ops: shell tools')
  })

  // The policy is registered first and independently of the server: the
  // prohibition on shell-based repository work must hold even when FastCtx is
  // missing, which is exactly when a model is most likely to reach for it.
  if (config.promptPolicy) {
    root.inject(['systemPrompt'], (ctx) => {
      ctx.effect(() => ctx.systemPrompt.section({
        name: HOST_SHELL_SECTION,
        order: SECTION_ORDERS[HOST_SHELL_SECTION],
        interpolate: false,
        text: renderHostShellPolicy(),
      }), 'dsh-ops: host shell policy')
      ctx.effect(() => ctx.systemPrompt.section({
        name: TOOLING_SECTION,
        order: SECTION_ORDERS[TOOLING_SECTION],
        interpolate: false,
        // Every rung is asked of the live registry: a reconnect republishes the
        // FastCtx generation, and the bash rung's tool is published beside it —
        // or not published at all, when the host carries no `subprocess`
        // service for it to run on. Naming a rung the model cannot reach is
        // worse than leaving it out.
        text: () => renderToolingPolicy({
          enableShellTools: config.enableShellTools,
          extraGuidance: config.extraGuidance,
          levels: liveLevels(ctx),
        }),
      }), 'dsh-ops: repository tooling policy')
    })
  }

  // `deny-host-shell` is the shipped opt-in fence: it refuses the configured
  // names whenever the mode is on, whatever resolved. Hiding them is the weaker
  // mechanism in front of it, and whether it may be used is decided per agent,
  // against the rungs that are live then.
  if (config.shellPolicy === 'deny-host-shell') {
    root.inject(['tools'], (ctx) => {
      const denied = new Set(config.deniedHostTools)
      ctx.on('tools/pre-execute', async (exec, next) => {
        const refusal = hostShellRefusal({
          toolName: String(exec?.name ?? ''),
          denied,
        })
        // A refusal short-circuits the waterfall by design; every other call
        // must delegate so later listeners still decide.
        return refusal ?? next()
      })
      // Visibility first, the fence as the guarantee: a name the mask could not
      // hide — or an agent the mask could not be installed for — is still
      // refused when it is called.
      installHostShellVisibility(ctx, config, liveLevels)
    })
  }

  root.inject(['tools'], (ctx) => mountServer(ctx, config, runtime))
}
