/** dsh-ops host half. Own registrations only; no @deepseek-ai value imports. */
import { PACKAGE_ROOT, probeBinary, resolveBinary } from './binary.js'
import { resolveConfig } from './config.js'
import { SECTION_ORDERS, TOOLING_SECTION, TOOL_PREFIX, hostShellRefusal, renderToolingPolicy } from './policy.js'
import { FastCtxTools } from './tools.js'

export const name = 'dsh-ops'
function report(ctx, message, level = 'error') {
  const logger = ctx?.logger
  if (typeof logger?.[level] === 'function') logger[level](message)
  else if (level === 'warn') console.warn(message)
  else console.error(message)
}
function visibleTools(ctx, agent) {
  try {
    return (ctx.get('tools')?.schemas(agent) ?? []).map(schema => schema.name)
      .filter(tool => typeof tool === 'string' && tool.startsWith(TOOL_PREFIX))
  } catch { return [] }
}
function prepareRuntime(ctx, config) {
  try {
    const resolved = resolveBinary({ binaryPath: config.binaryPath, packageRoot: PACKAGE_ROOT })
    const probe = probeBinary(resolved.file)
    if (!probe.ok) throw new Error(`Unusable FastCtx at ${resolved.file}: ${probe.detail}`)
    return { file: resolved.file, source: resolved.source, version: probe.version }
  } catch (error) {
    report(ctx, `dsh-ops: ${error.message}`)
    if (config.required) throw error
  }
}

/** Explicit host-shell denial is independent of whether ops commands exist. */
function installHostShellDenial(ctx, config) {
  const denied = new Set(config.deniedHostTools)
  const lifts = new Map()
  const hide = agent => {
    if (lifts.has(agent) || !agent?.ctx) return
    try {
      const names = (ctx.get('tools').schemas(agent) ?? []).map(tool => tool.name).filter(name => denied.has(name))
      if (names.length) lifts.set(agent, agent.ctx.tools.restrict({ deny: names }))
    } catch (error) {
      report(ctx, `dsh-ops: host shell visibility restriction unavailable: ${error.message}; calls remain denied.`, 'warn')
    }
  }
  ctx.on('agent/created', ({ agent }) => hide(agent))
  ctx.on('agent/disposed', ({ agent }) => { lifts.get(agent)?.(); lifts.delete(agent) })
  for (const agent of ctx.get('agents')?.list?.() ?? []) hide(agent)
  ctx.effect(() => () => { for (const lift of lifts.values()) lift(); lifts.clear() }, 'dsh-ops: host shell restrictions')
  ctx.on('tools/pre-execute', (exec, next) => hostShellRefusal({ toolName: String(exec?.name ?? ''), denied }) ?? next())
  if (typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard(exec => hostShellRefusal({ toolName: String(exec?.name ?? ''), denied })?.reason), 'dsh-ops: host shell guard')
  }
}

async function mountServer(ctx, config, runtime) {
  if (!runtime) return
  const surface = new FastCtxTools({ ctx, config, runtime, report: (message, level) => report(ctx, message, level) })
  ctx.effect(() => () => surface.stop(), 'dsh-ops: fastctx server')
  ctx.on('agent/created', ({ agent }) => surface.attachAgent(agent))
  ctx.on('agent/disposed', ({ agent }) => surface.detachAgent(agent))
  ctx.on('session/event', (session, event) => {
    if (event.type === 'sandbox/mode') surface.refreshAgents(session)
  })
  // Authority may mount after the tools service or be hot-reloaded. Losing it
  // immediately retires every command layer; it never falls back to env state.
  surface.authorityAvailable = false
  ctx.inject(['sandboxPolicy'], authorityCtx => {
    surface.authorityAvailable = true
    surface.refreshAgents()
    authorityCtx.effect(() => () => {
      surface.authorityAvailable = false
      surface.refreshAgents()
    }, 'dsh-ops: permission authority')
  })
  for (const agent of ctx.get('agents')?.list?.() ?? []) surface.attachAgent(agent)
  try {
    const tools = await surface.start()
    report(ctx, `dsh-ops: FastCtx ${runtime.version} ready; ${tools.length} file tools, session-authorized command layers.`, 'info')
  } catch (error) {
    report(ctx, `dsh-ops: FastCtx unavailable: ${error.message}`)
    if (config.required) throw error
    surface.retryLater()
  }
}

export function apply(root, rawConfig) {
  const config = resolveConfig(rawConfig)
  const runtime = prepareRuntime(root, config)
  // The host already provides shell tools. Do not publish duplicate ops_bash.
  if (config.publishBashTool) report(root, 'dsh-ops: publishBashTool is retired; use the host shell or authorized command tools.', 'warn')
  if (config.promptPolicy) root.inject(['systemPrompt'], ctx => {
    ctx.effect(() => ctx.systemPrompt.section({
      name: TOOLING_SECTION,
      order: SECTION_ORDERS[TOOLING_SECTION],
      interpolate: false,
      text: context => renderToolingPolicy({
        published: visibleTools(ctx, context.agent), extraGuidance: config.extraGuidance,
      }),
    }), 'dsh-ops: repository tooling')
  })
  root.inject(['tools'], ctx => {
    if (config.shellPolicy === 'deny-host-shell') installHostShellDenial(ctx, config)
    return mountServer(ctx, config, runtime)
  })
}
