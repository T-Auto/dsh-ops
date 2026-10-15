/** dsh-ops host half. Own registrations and reversible host-tool masks only. */
import Schema from '@deepseek-ai/schemastery'
import { mountBuiltinTools, mountHostToolPolicy } from './host-tools.js'

// Only this field is schema-owned; other keys retain explicit validation below.
export const Config = Schema.object({ hideBuiltinTools: Schema.boolean().default(false).volatile() })
import { PACKAGE_ROOT, probeBinary, resolveBinary } from './binary.js'
import { resolveConfig } from './config.js'
import { mountConfigUpdates, updatedConfig } from './config-updates.js'
import { SECTION_ORDERS, TOOLING_SECTION, BACKGROUND_TOOLS, BASH_TOOL, publicToolName, hostShellRefusal, renderToolingPolicy } from './policy.js'
import { FILE_TOOLS } from './file/contract.js'
import { resolveShells } from './shells.js'
import { mountSessionBash } from './session-shells.js'
import { mountBundledPwsh } from './session-pwsh.js'
import { NativeFileTools } from './file/runtime.js'
import { resolveWorker } from './ptc/runtime.js'
import { mountWorkspacePreparation } from './workspace-preparation.js'

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
      .filter(tool => typeof tool === 'string')
  } catch { return [] }
}
function prepareRuntime(ctx, config) {
  try {
    const resolved = resolveBinary({ binaryPath: config.binaryPath, packageRoot: PACKAGE_ROOT })
    // Resolution can land on a binary nobody vouched for — `PATH` above all, which is exactly
    // the case the probe below exists to distrust. Say so on the **success** path too: the
    // probe executes the candidate to prove it runs, and "it ran" is not evidence that it was
    // trustworthy. `config.binaryPath` / `DSH_OPS_FASTCTX` are deliberate operator choices and
    // stay quiet; an inherited PATH hit is not.
    if (resolved.source === 'PATH') {
      report(ctx, `dsh-ops: FastCtx was resolved from PATH and carries no provenance: ${resolved.file}. `
        + 'Install the matching @dsh-ops/fastctx platform package, or set config.binaryPath to pin a known build.', 'warn')
    }
    const probe = probeBinary(resolved.file)
    if (!probe.ok) throw new Error(`Unusable FastCtx at ${resolved.file}: ${probe.detail}`)
    return { file: resolved.file, source: resolved.source, version: probe.version }
  } catch (error) {
    report(ctx, `dsh-ops: ${error.message}`)
    if (config.required) throw error
  }
}

async function mountNativeFile(ctx, config, file) {
  const surface = new NativeFileTools({ ctx, config: { ...config, workerPath: file },
    report: (message, level) => report(ctx, message, level) })
  ctx.effect(() => () => { void surface.stop() }, 'dsh-ops: native file worker')
  const tools = await surface.start()
  if (tools.length) report(ctx, `dsh-ops: native Rust file worker ready; ${tools.length} tools.`, 'info')
}

async function mountServer(ctx, config, runtime, component) {
  if (!runtime) return
  const { FastCtxTools } = await import('./tools.js')
  const background = component === 'background'
  const surface = new FastCtxTools({ ctx, config, runtime,
    fileTools: !background, commandTools: background ? BACKGROUND_TOOLS : [], shared: true,
    report: (message, level) => report(ctx, message, level) })
  ctx.effect(() => () => surface.stop(), 'dsh-ops: fastctx server')
  if (background) {
    ctx.on('agent/created', ({ agent }) => surface.attachAgent(agent))
    ctx.on('agent/disposed', ({ agent }) => surface.detachAgent(agent))
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'sandbox/mode') surface.refreshAgents()
    })
    // Background command layers follow authoritative per-session permission.
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
  }
  try {
    const tools = await surface.start()
    report(ctx, `dsh-ops: FastCtx ${runtime.version} ready; ${component} component, ${tools.length} global tools.`, 'info')
  } catch (error) {
    report(ctx, `dsh-ops: FastCtx unavailable: ${error.message}`)
    if (config.required) throw error
    surface.retryLater()
  }
}

export function applyComponent(root, rawConfig, component) {
  const hideBuiltinTools = rawConfig?.hideBuiltinTools
  if (typeof hideBuiltinTools?.get === 'function') {
    rawConfig = { ...rawConfig, hideBuiltinTools: hideBuiltinTools.get() }
  }
  // Validate before migrating: malformed/unknown keys still fail loud.
  resolveConfig(rawConfig)
  const config = resolveConfig(updatedConfig(rawConfig ?? {}))
  mountConfigUpdates(root, rawConfig)
  const runtime = component === 'shell' || component === 'file' ? undefined : prepareRuntime(root, config)
  const nativeWorker = component === 'file' ? (() => {
    try { return resolveWorker(config) }
    catch (error) {
      report(root, `dsh-ops: native file worker unavailable: ${error.message}`)
      if (config.required) throw new Error(`Native file worker unavailable for binaryPath ${config.binaryPath ?? '(automatic resolution)'}: ${error.message}`)
      return undefined
    }
  })() : undefined
  const shells = component === 'shell' ? resolveShells(config) : undefined
  const owned = component === 'shell' ? [BASH_TOOL, 'pwsh']
    : component === 'file' ? FILE_TOOLS.map(publicToolName) : BACKGROUND_TOOLS.map(publicToolName)
  if (component === 'file') owned.push('read_image')
  if (config.promptPolicy) root.inject(['systemPrompt'], ctx => {
    ctx.effect(() => ctx.systemPrompt.section({
      name: `${TOOLING_SECTION}:${component}`,
      order: SECTION_ORDERS[TOOLING_SECTION] + (component === 'shell' ? 1 : component === 'background' ? 2 : 0),
      interpolate: false,
      text: context => renderToolingPolicy({
        published: visibleTools(ctx, context.agent).filter(name => owned.includes(name)),
        shellComponent: component === 'shell', pwsh7: shells?.pwsh.available ?? false,
        extraGuidance: config.extraGuidance,
      }),
    }), `dsh-ops: ${component} tooling`)
  })
  if (component === 'shell') {
    mountWorkspacePreparation(root)
    mountBundledPwsh(root, shells)
    root.inject(['tools'], ctx => {
      mountSessionBash(ctx, config, shells)
      if (config.shellPolicy === 'deny-host-shell') {
        const denied = new Set(config.deniedHostTools)
        mountHostToolPolicy(ctx, { denied, reason: toolName => hostShellRefusal({ toolName, denied }).reason })
      }
    })
  } else if (component === 'file') {
    root.inject(['tools'], ctx => mountBuiltinTools(ctx, hideBuiltinTools, root))
    root.inject(['tools', 'sandboxPolicy', 'subprocess'], ctx => mountNativeFile(ctx, config, nativeWorker))
  } else root.inject(['tools'], ctx => mountServer(ctx, config, runtime, component))
}

// Backward-compatible module entry. The bundle uses independently toggled rows.
export function apply(root, rawConfig) { return applyComponent(root, rawConfig, 'file') }
