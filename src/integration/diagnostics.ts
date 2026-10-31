/** Read-only operator diagnostics for the current scope; no execution or selection side effects. */
import type { Context, Agent } from '../adapter/dsh/types.js'
import { inspectPresentation } from '../publication/presentation.js'
import { visibleNames } from '../publication/surface.js'
import { resolveWorker } from '../execution/files.js'
import { resolveShells } from '../shells.js'
import { pendingSelection } from '../discovery/observations.js'
import { providers } from '../discovery/providers.js'
import { integrationFor } from '../consumer/registry.js'
import { nativeProviders } from '../publication/providers.js'
import { publicToolName } from '../policy.js'
import { ownScopes } from '../publication/ownership.js'
import type { PublicationGate } from '../publication/types.js'
import { presetOf } from '../consumer/identity.js'
import { modeOf } from '../presets/detect.js'
import { enabledModes } from '../presets/registry.js'
export interface Diagnostic {
  preset?: string
  state: 'not-selected' | 'disabled' | 'ready' | 'degraded'
  tools: string[]
  issues: { code: string; message: string }[]
  external: { name: string; state: 'disabled' | 'unavailable' | 'active' | 'pending' | 'available' }[]
}
export { observeSelection } from '../discovery/observations.js'
export async function diagnose(ctx: Context, agent: Agent): Promise<Diagnostic> {
  const config = integrationFor(ctx, agent), mode = modeOf(ctx, agent)
  const selected = Boolean(config || mode && enabledModes(ctx).has(mode))
  const issues: Diagnostic['issues'] = []
  let names: string[] = []
  try { names = visibleNames(ctx.get('tools')!, agent) } catch { /* reported below */ }
  const issue = (code: string, message: string) => { if (!issues.some(row => row.code === code)) issues.push({ code, message }) }
  if (selected && config?.enabled !== false) {
    for (const service of ['tools', 'systemPrompt']) if (!ctx.get(service as 'tools')) issue('HOST_SERVICE_UNAVAILABLE', `Required host service ${service} is unavailable; enable it and reload the component.`)
    const builtins = Boolean(config ? config.files || config.presentation === 'native' && (config.native.allowedTools.length || config.native.alwaysLoaded.length)
      : mode && enabledModes(ctx).has(mode) && mode !== 'minimal')
    if (builtins) {
      try { resolveWorker(config?.core ?? enabledModes(ctx).get(mode!)!) }
      catch { issue('RUNTIME_UNAVAILABLE', 'Native worker resolution failed. Check binaryPath and the packaged runtime; official alternatives remain available.') }
    }
    if (builtins || config?.shell) for (const service of ['sandboxPolicy', 'subprocess']) if (!ctx.get(service as 'tools')) issue('HOST_SERVICE_UNAVAILABLE', `Execution service ${service} is unavailable; enable it and reload.`)
    if (config?.shell) {
      const shell = resolveShells(config.core)
      if (!shell.bash.available) issue('SHELL_UNAVAILABLE', 'Bash is unavailable. Check bashPath or provision the managed Bash payload.')
    }
    if (config) try {
      const assembly = await inspectPresentation(ctx.get('systemPrompt')!, agent)
      const ptc = assembly.tools.length === 1 && assembly.tools[0]?.name === 'run_code'
        && assembly.sections.some(section => section.name === 'tools:ptc-only' && section.text.trim())
      if (config.presentation === 'ptc' && (!ptc || !ctx.get('ptcRuntime'))) issue('PRESENTATION_MISMATCH', 'PTC requires an available runtime and authoritative run_code-only presentation; a preset name or recommendation is insufficient.')
      if (config.presentation === 'native' && ptc) issue('PRESENTATION_MISMATCH', 'Native tools are withdrawn in PTC-only presentation. Choose the typed PTC integration or restore Native presentation.')
    } catch { issue('PRESENTATION_UNAVAILABLE', 'The host could not assemble this scope. Check the host presentation/runtime configuration.') }
    if (config) {
      const expected = [
        ...(config.files && config.residentTools ? (config.presentation === 'ptc' ? ['inspect_local_file', 'result', ...config.ptc.alwaysLoaded] : config.residentNames) : []),
        ...(config.presentation === 'ptc' && config.discovery ? ['load_sdk'] : []),
        ...(config.shell ? ['bash'] : []),
        ...(config.presentation === 'native' && config.native.enabled ? ['discover_tools'] : []),
        ...(config.presentation === 'native' ? config.native.alwaysLoaded : []),
      ].map(publicToolName)
      const missing = expected.filter(name => !names.includes(name))
      if (missing.length) issue('PUBLICATION_UNAVAILABLE', `Configured tools are not visible in this scope: ${missing.join(', ')}. Check component lifecycle and host registration errors; this is not proof of permission denial.`)
    }
  }
  // Readiness is evaluated from the current visible surface, never binary presence alone.
  const pending = pendingSelection(ctx, agent)
  const pool = providers(ctx, agent)
  const published = nativeProviders(ctx, agent)
  const external: Diagnostic['external'] = (config?.externalTools ?? []).map(name => {
    const provider = pool.find(row => row.capability.definition.name === name)
    let available = false
    try { available = Boolean(provider?.active && provider.capability.available?.(agent) !== false) } catch { /* unavailable */ }
    return { name, state: config!.externalDisabled.includes(name) ? 'disabled' : !provider || !available ? 'unavailable'
      : published.some(source => source.scope === agent && source.definition.name === name && source.definition.output === provider.capability.definition.output) ? 'active' : pending?.has(provider.token) ? 'pending' : 'available' }
  })
  return { preset: presetOf(ctx, agent), state: !selected ? 'not-selected' : config?.enabled === false ? 'disabled' : issues.length ? 'degraded' : 'ready',
    tools: [...names].sort(), issues, external }
}

/** A real Desktop-accessible tool, not an offline binary-presence probe. */
export function mountDiagnostics(root: Context, gate: PublicationGate): void {
  root.inject(['tools'], async ctx => {
    const entries = new Map<Agent, { fiber: { dispose(): Promise<void> }; dispose?: () => void }>()
    let stopped = false
    const ownership = await ownScopes(ctx, 'diagnostics', () => { void reconcile() }, gate.allows)
    const reconcile = async () => {
      if (stopped) return
      for (const [agent, entry] of entries) if (!gate.allows(agent) || !ownership.owns(agent)) {
        entries.delete(agent); entry.dispose?.(); await entry.fiber.dispose()
      }
      for (const agent of ctx.get('agents')?.list?.() ?? []) await attach(agent)
    }
    const attach = async (agent: Agent) => {
      if (stopped || entries.has(agent) || !gate.allows(agent) || !ownership.owns(agent)) return
      const fiber = agent.ctx.plugin({ inject: ['tools'], apply(scoped) {
        const dispose = scoped.tools.register({ name: publicToolName('status'), description: 'Read current OPS scope publication diagnostics; performs no tool action or activation.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async (_args, exec) => {
            if (stopped || exec.agent !== agent || !entries.has(agent) || !gate.allows(agent) || !ownership.owns(agent)) return { status: 'rejected', error: { code: 'POLICY_DENIED' } }
            return diagnose(ctx, agent)
          } })
        const entry = entries.get(agent); if (entry) entry.dispose = dispose
      } })
      entries.set(agent, { fiber }); await fiber
    }
    ctx.on('agent/created', async ({ agent }) => { await attach(agent); return undefined })
    ctx.on('agent/disposed', async ({ agent }) => { const entry = entries.get(agent); entries.delete(agent); entry?.dispose?.(); await entry?.fiber.dispose() })
    ctx.on('session/event', (_session, event) => { if ((event as { type: string }).type === 'agent-preset/selected') void reconcile() })
    if (gate.watch) ctx.effect(() => gate.watch!(() => { void reconcile() }), 'dsh-ops: diagnostics observer')
    ctx.effect(() => async () => { stopped = true; for (const entry of entries.values()) { entry.dispose?.(); await entry.fiber.dispose() }; entries.clear(); ownership.dispose() }, 'dsh-ops: diagnostics lifecycle')
    await reconcile()
  })
}
