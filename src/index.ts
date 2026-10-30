/** dsh-ops host half. Own registrations only; no @deepseek-ai value imports. */
import type { Context } from './adapter/dsh/types.js'
import type { Agent } from './adapter/dsh/types.js'
import type {} from './adapter/dsh/types.js'
import type {} from './adapter/dsh/types.js'
import { resolveConfig } from './config.js'
import { mountConfigUpdates, updatedConfig } from './config-updates.js'
import { SECTION_ORDERS, TOOLING_SECTION, BASH_TOOL, publicToolName, hostShellRefusal, renderToolingPolicy } from './policy.js'
import { NATIVE_FILE_TOOLS as FILE_TOOLS, NATIVE_RESIDENT_FILE_TOOLS } from './capabilities/registry.js'
import { resolveShells } from './shells.js'
import { mountSessionBash } from './session-shells.js'
import { NativeFileTools } from './file/runtime.js'
import { resolveWorker } from './ptc/runtime.js'
import { visibleNames } from './surface.js'
import { mountWorkspacePreparation } from './workspace-preparation.js'
import { safeDispose, safeDisposeAll } from './teardown.js'
import { mountResultLifecycle } from './kernel/result-lifecycle.js'
import { applyResolvedMode } from './modes/apply.js'
import { resolveMergedConfig, effectiveMode, dynamicForMode } from './settings/merged.js'
import { modeOf } from './modes/detect.js'
import { onModesChange } from './modes/registry.js'
import type { DiscoveryGate } from './discovery/index.js'
import { beginMergedRow, endMergedRow } from './settings/legacy.js'
import { mountRuntimeSettings } from './settings/runtime-host.js'
import { companionVersion } from './settings/companion.js'
import * as minimalModule from './components/mode-minimal/index.js'
import * as standardModule from './components/mode-standard/index.js'
import * as ptcModule from './components/mode-ptc/index.js'
import * as cordisModule from './components/mode-cordis/index.js'
import * as discoveryModule from './components/discovery/index.js'
import * as panelModule from './components/panel/index.js'
import * as tuiModule from './components/tui/index.js'

export { Config } from './settings/merged.js'
export const name = 'dsh-ops'
type ResolvedConfig = ReturnType<typeof resolveConfig>
type Component = 'shell' | 'file'
function errorText(error: unknown): string {
  return String(error !== null && typeof error === 'object' && 'message' in error ? error.message ?? error : error)
}
function report(ctx: Context, message: string, level = 'error'): void {
  const logger = ctx?.logger
  const sink: unknown = logger ? Reflect.get(logger, level) : undefined
  if (typeof sink === 'function') sink.call(logger, message)
  else if (level === 'warn') console.warn(message)
  else console.error(message)
}
function visibleTools(ctx: Context, agent?: Agent): string[] {
  try {
    const tools = ctx.get('tools')
    // Names only, through the view: `schemas()` projected every visible definition —
    // 34.2 ms for 258 tools at the published runtime's surface shape — to keep a
    // handful of owned names, and this section renders once per assembly.
    return tools ? visibleNames(tools, agent) : []
  } catch { return [] }
}

/** Explicit host-shell denial is independent of whether ops commands exist. */
function installHostShellDenial(ctx: Context, config: ResolvedConfig): void {
  const denied = new Set(config.deniedHostTools)
  const lifts = new Map<Agent, () => void>()
  let warned = false
  const hide = (agent: Agent) => {
    if (lifts.has(agent) || !agent?.ctx) return
    try {
      const names = visibleNames(ctx.tools, agent).filter(name => denied.has(name))
      if (names.length) lifts.set(agent, agent.ctx.tools.restrict({ deny: names }))
    } catch (error) {
      if (!warned) {
        warned = true
        report(ctx, `dsh-ops: host shell visibility restriction unavailable: ${errorText(error)}; calls remain denied.`, 'warn')
      }
    }
  }
  ctx.on('agent/created', ({ agent }) => { hide(agent) })
  // Same isolation as the bulk teardown below: a throwing lift must not stop `lifts.delete`, nor
  // leave this agent's shell visibility permanently restricted.
  ctx.on('agent/disposed', ({ agent }) => {
    safeDispose(lifts.get(agent), (error) => report(ctx, `dsh-ops: host shell restriction lift failed: ${errorText(error)}`, 'warn'), 'host shell lift (agent disposed)')
    lifts.delete(agent)
  })
  for (const agent of ctx.get('agents')?.list?.() ?? []) hide(agent)
  ctx.effect(() => () => {
    // Isolate each lift: these restore the host's shell visibility, so one throwing callback
    // must not leave the remaining agents' tools hidden (nor skip the map cleanup).
    safeDisposeAll(lifts.values(), (error) => report(ctx, `dsh-ops: host shell restriction lift failed: ${errorText(error)}`, 'warn'), 'host shell lift')
    lifts.clear()
  }, 'dsh-ops: host shell restrictions')
  ctx.on('tools/pre-execute', async (exec, next) => {
    const refusal = hostShellRefusal({ toolName: String(exec?.name ?? ''), denied })
    return refusal ? { kind: 'deny', reason: refusal.reason } : next()
  })
  if (typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard(exec => hostShellRefusal({ toolName: String(exec?.name ?? ''), denied })?.reason), 'dsh-ops: host shell guard')
  }
}

async function mountNativeFile(ctx: Context, config: ResolvedConfig, file: string | undefined): Promise<void> {
  mountResultLifecycle(ctx)
  const surface = new NativeFileTools({ ctx, config: { ...config, workerPath: file },
    report: (message, level) => report(ctx, message, level) })
  // `safeDispose` isolates synchronous teardown callbacks; a *rejecting promise* needs its own
  // catch, or the rejection is dropped and the worker's shutdown failure stays invisible (#30).
  ctx.effect(() => () => {
    return surface.stop().catch(error => report(ctx, `dsh-ops: native file worker shutdown failed: ${errorText(error)}`, 'warn'))
  }, 'dsh-ops: native file worker')
  const tools = await surface.start(NATIVE_RESIDENT_FILE_TOOLS)
  if (tools.length) report(ctx, `dsh-ops: native Rust file worker ready; ${tools.length} tools.`, 'info')
}

/** The components this host half mounts; `dsh-ops/background` is a separate no-op stub. */
const COMPONENTS = Object.freeze(['shell', 'file'])

export function applyComponent(root: Context, rawConfig: unknown, component: Component): void {
  if (!COMPONENTS.includes(component)) throw new Error(`dsh-ops: unknown component ${JSON.stringify(component)}`)
  // Validate before migrating: malformed/unknown keys still fail loud.
  resolveConfig(rawConfig)
  const config = resolveConfig(updatedConfig(rawConfig ?? {}))
  mountConfigUpdates(root, rawConfig)
  const nativeWorker = component === 'file' ? (() => {
    try { return resolveWorker(config) }
    catch (error) {
      report(root, `dsh-ops: native file worker unavailable: ${errorText(error)}`)
      if (config.required) throw new Error(`Native file worker unavailable for binaryPath ${config.binaryPath ?? '(automatic resolution)'}: ${errorText(error)}`)
      return undefined
    }
  })() : undefined
  const shells = component === 'shell' ? resolveShells(config) : undefined
  const owned = component === 'shell' ? [BASH_TOOL, 'pwsh'] : [...FILE_TOOLS.map(publicToolName), 'read_image']
  if (config.promptPolicy) root.inject(['systemPrompt'], ctx => {
    ctx.effect(() => ctx.systemPrompt.section({
      name: `${TOOLING_SECTION}:${component}`,
      order: SECTION_ORDERS[TOOLING_SECTION] + (component === 'shell' ? 1 : 0),
      interpolate: false,
      text: context => renderToolingPolicy({
        published: visibleTools(ctx, context.agent).filter(name => owned.includes(name)),
        shellComponent: component === 'shell',
        extraGuidance: config.extraGuidance,
      }),
    }), `dsh-ops: ${component} tooling`)
  })
  if (component === 'shell') {
    // Workspace preparation is Windows-specific; the host owns its PowerShell executor.
    if (process.platform === 'win32') mountWorkspacePreparation(root)
    root.inject(['tools'], ctx => {
      if (shells) mountSessionBash(ctx, config, shells)
      if (config.shellPolicy === 'deny-host-shell') installHostShellDenial(ctx, config)
    })
  } else {
    root.inject(['tools', 'sandboxPolicy', 'subprocess'], ctx => mountNativeFile(ctx, config, nativeWorker))
  }
}

/**
 * Package-root entry: the single row the bundle inserts.
 *
 * Every feature the row enables is mounted from this one fiber with its own
 * validated slice. Disabling a feature and saving the row remounts the fiber, so
 * its effects are torn down exactly like the old per-row switches did. The TUI
 * link keeps its optional host service: an absent `tuiPanels` leaves that
 * desktop feature pending instead of blocking the tools.
 */
const modes = { minimal: minimalModule, standard: standardModule, ptc: ptcModule, cordis: cordisModule } as const

export async function apply(root: Context, rawConfig: unknown): Promise<void> {
  const config = resolveMergedConfig(rawConfig)
  const host = root
  const mount = async (module: { apply(...args: unknown[]): unknown }, state: { enabled: boolean; raw?: Record<string, unknown>; config: unknown }, slice?: Record<string, unknown>): Promise<void> => {
    if (!state.enabled) return
    const payload = slice ?? state.raw ?? state.config
    if (state.raw === undefined && slice === undefined) {
      await host.plugin({ name: `dsh-ops/${moduleName(module)}`, apply: (ctx: Context) => { (module.apply as (ctx: Context, config: unknown) => void)(ctx, state.config) } })
      return
    }
    await host.plugin(module, payload)
  }
  // The discovery entry is one publication gated per preset: a mode receives it
  // only while the bundle switch and that mode's own switch are both on.
  const dynamic = Object.fromEntries((['minimal', 'standard', 'ptc', 'cordis'] as const)
    .map(mode => [mode, dynamicForMode(config[mode], config.global)]))
  const gate: DiscoveryGate = {
    allows: agent => {
      const mode = modeOf(root, agent)
      return mode !== undefined && dynamic[mode] === true
    },
    watch: notify => onModesChange(root, notify),
  }
  beginMergedRow()
  try {
    // The browser half mounts its `opsSettings` remote; the legacy shell row used
    // to provide that seam, so the merged row owns it now.
    await host.plugin({ name: 'dsh-ops/runtime-settings', apply: (ctx: Context) => mountRuntimeSettings(ctx) })
    for (const mode of ['minimal', 'standard', 'ptc', 'cordis'] as const) {
      await mount(modes[mode], config[mode], effectiveMode(config[mode], config.global, typeof config.other.raw?.pwsh7Link === 'boolean' ? config.other.raw.pwsh7Link : companionVersion({ sweep: false }) !== undefined))
    }
    if (config.discovery.enabled) {
      await host.plugin({ name: 'dsh-ops/discovery',
        apply: (ctx: Context) => { (discoveryModule.apply as (ctx: Context, raw: unknown, gate: DiscoveryGate) => void)(ctx, config.discovery.raw ?? {}, gate) } })
    }
    await mount(panelModule, config.panel)
    await mount(tuiModule, config.tui)
  } finally { endMergedRow() }
}

/** The module's declared name, for the child plugin label. */
function moduleName(module: unknown): string {
  const value = (module as { name?: unknown }).name
  return typeof value === 'string' ? value : 'feature'
}
