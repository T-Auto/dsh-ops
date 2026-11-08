/** Stable Native discovery definitions with next-step conditional admission. */
import type { Agent, Context, Fiber, ToolDefinition } from '../adapter/dsh/types.js'
import { resolveDiscoveryConfig } from '../config.js'
import { NativeFileTools } from '../projections/native/runtime.js'
import { ownScopes } from '../publication/ownership.js'
import { activationIsPtc, isNativePresentation, isPresentationProbe } from '../publication/presentation.js'
import { visibleNames } from '../publication/surface.js'
import { mountResultLifecycle } from '../kernel/result-lifecycle.js'
import { failure, resolveWorker } from '../execution/files.js'
import { capability, DISCOVERY_TOOL_NAME } from '../capabilities/registry.js'
import { DISCOVERY_DESCRIPTION, DISCOVERY_PARAMETERS, DISCOVERY_OUTPUT } from '../capabilities/discovery.js'
import { publicToolName, renderToolingPolicy } from '../policy.js'
import type { DiscoverableName } from './config.js'
import { prepareProviders, providers, onProvidersChange, providerDiscoverable, type Provider } from './providers.js'
import { nativeCatalog } from './catalog.js'
import { renderNativeDirectory } from './prompt.js'
import { searchCapabilities } from './candidates.js'
import { parseRequest } from './search.js'
import { InvocationLifetime, InvocationNotStarted } from '../lifecycle/invocations.js'
import { nativeProviders } from '../publication/providers.js'
import { observeSelection } from './observations.js'
import { acquireSharedFile, isSharedFileApi } from '../publication/scope-owner.js'
import type { PublicationLease } from '../publication/registrar.js'
import { publicationReady, publicationRegistration } from '../publication/reentry.js'

export interface DiscoveryGate {
  allows(agent: Agent): boolean
  watch?(notify: () => void): () => void
  guidance?: boolean
  extraGuidance?: string
  extraGuidanceOwner?(agent: Agent): boolean
  residentTools?(agent: Agent): ReadonlySet<string> | readonly string[]
  external?: { allowed: readonly string[]; alwaysLoaded: readonly string[]; disabled: readonly string[] }
}
interface Registration { definition: ToolDefinition; dispose(): void; provider?: Provider }
interface Entry {
  ctx?: Context
  fiber?: Fiber
  ready: Promise<void>
  runtime: NativeFileTools
  calls: InvocationLifetime
  selected: Set<DiscoverableName>
  pending: Set<DiscoverableName>
  externalSelected: Set<string>
  externalPending: Set<string>
  registrations: Map<string, Registration>
  files: Map<DiscoverableName, { lease: PublicationLease; revoke?: () => void; entitled?: boolean }>
  releaseObservation?: () => void
}
const DISCOVER = publicToolName(DISCOVERY_TOOL_NAME)

/** Mount the selected consumer's complete pool once; selection never changes registration identity. */
export function mountDiscovery(root: Context, raw: unknown, gate: DiscoveryGate): void {
  const config = resolveDiscoveryConfig(raw)
  const externalEnabled = Boolean(gate.external?.allowed.length)
  let worker: string | undefined
  try { if (config.allowedTools.length || config.alwaysLoaded.length) worker = resolveWorker(config) }
  catch (error) {
    if (config.required) throw error
    root.logger.warn('dsh-ops: discovery worker unavailable; built-in tools stay unpublished.')
    if (!externalEnabled) return
  }
  root.inject(externalEnabled ? ['tools', 'systemPrompt'] : ['tools', 'systemPrompt', 'sandboxPolicy', 'subprocess'], async ctx => {
    const tools = ctx.get('tools')!, prompt = ctx.get('systemPrompt')!
    mountResultLifecycle(ctx)
    await prepareProviders(ctx)
    const entries = new Map<Agent, Entry>(), retired = new WeakSet<Agent>()
    let stopped = false
    let ownership: Awaited<ReturnType<typeof ownScopes>> | undefined
    const owns = (agent: Agent): boolean => !stopped && gate.allows(agent) && Boolean(ownership?.owns(agent))
    const residentSet = (agent: Agent): ReadonlySet<string> => new Set(gate.residentTools?.(agent) ?? [])
    const permitted = (agent: Agent, api?: DiscoverableName): boolean => {
      if (!owns(agent) || !worker || !ctx.get('subprocess')) return false
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      return policy !== undefined && ['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)
        && (!api || api === 'result' || !capability(api)?.mutates || policy.mode !== 'read-only')
    }
    const selectable = (agent: Agent, api: DiscoverableName): boolean =>
      !residentSet(agent).has(publicToolName(api)) && permitted(agent, api)
    const externalPool = (agent: Agent): Provider[] => providers(ctx, agent).filter(provider =>
      gate.external?.allowed.includes(provider.capability.definition.name) && !gate.external.disabled.includes(provider.capability.definition.name))
    const externalAvailable = (provider: Provider, agent: Agent): boolean => {
      try { return provider.active && provider.capability.available?.(agent) !== false } catch { return false }
    }
    const externalDiscoverable = (agent: Agent): Provider[] => externalPool(agent)
      .filter(provider => externalAvailable(provider, agent) && providerDiscoverable(provider, agent))
    const apiByName = new Map([...config.allowedTools, ...config.alwaysLoaded].map(api => [publicToolName(api), api]))
    const selected = (agent: Agent, entry: Entry, name: string, provider?: Provider): boolean => {
      if (!owns(agent)) return false
      if (provider) return externalPool(agent).includes(provider) && externalAvailable(provider, agent)
        && (entry.externalSelected.has(provider.token) || gate.external?.alwaysLoaded.includes(name) || provider.capability.disclosure === 'resident') === true
      if (name === DISCOVER) return config.enabled && (externalEnabled || permitted(agent))
      const api = apiByName.get(name)
      return api !== undefined && selectable(agent, api) && (config.alwaysLoaded.includes(api) || entry.selected.has(api))
    }
    const rotateFiles = (agent: Agent, entry: Entry): void => {
      for (const [api, file] of entry.files) {
        const entitled = selected(agent, entry, publicToolName(api))
        if (file.entitled === entitled) continue
        file.revoke?.()
        file.entitled = undefined
        file.revoke = file.lease.grant({ consumer: entry, agent, token: {}, entitled,
          dispatch: async () => undefined,
          present: async activation => activation.agent === agent && entries.get(agent) === entry
            && permitted(agent, api) && !await activationIsPtc(prompt, activation),
        })
        file.entitled = entitled
      }
    }
    const publish = (agent: Agent, entry: Entry, source: ToolDefinition, provider?: Provider): void => {
      if (!entry.ctx || entry.registrations.has(source.name)) return
      const definition: ToolDefinition = { ...source, execute: async (args, exec) => {
        const current = () => !exec.signal.aborted && entries.get(agent) === entry && exec.agent === agent
          && selected(agent, entry, source.name, provider) && tools.executable(source.name, agent, exec.toolSet) === definition
        if (!current() || !await isNativePresentation(prompt, agent, exec.signal).catch(() => false) || !current()) {
          return failure('POLICY_DENIED', 'This Native capability must be admitted for the calling scope; no action executed.')
        }
        if (!provider) return source.execute(args, exec)
        if (!await Promise.resolve().then(() => provider.capability.authorize(exec)).catch(() => false) || !current()) {
          return failure('POLICY_DENIED', 'External provider is inactive, disabled or unauthorized; no action executed.')
        }
        try {
          return await entry.calls.run(exec.signal, signal => Promise.resolve(source.execute(args, { ...exec, signal })), provider.calls)
        } catch (error) {
          if (error instanceof InvocationNotStarted) return failure('ABORTED', error.message)
          return failure('RESULT_UNKNOWN', 'External invocation did not settle; effects may be unknown.', 'execute', 'unknown')
        }
      } }
      const dispose = publicationRegistration(entry.ctx, () => entry.ctx!.tools.register(definition, { when: async activation => activation.agent === agent
        && entries.get(agent) === entry && selected(agent, entry, source.name, provider) && !await activationIsPtc(prompt, activation) }))
      entry.registrations.set(source.name, { definition, dispose, provider })
    }
    const syncExternal = (agent: Agent, entry: Entry): void => {
      const pool = externalPool(agent)
      for (const [name, registration] of entry.registrations) if (registration.provider && !pool.includes(registration.provider)) {
        registration.dispose(); entry.registrations.delete(name)
        entry.externalSelected.delete(registration.provider.token); entry.externalPending.delete(registration.provider.token)
      }
      for (const provider of pool) {
        const name = provider.capability.definition.name
        // Provider opt-in cannot shadow an independently registered host capability.
        const visible = tools.get(name, agent)
        const ownedAncestor = nativeProviders(ctx, agent).some(source => source.definition === visible)
        if (!entry.registrations.has(name) && visible !== undefined && !ownedAncestor
          && !providers(ctx, agent).some(source => source.capability.definition.output === visible.output)) continue
        publish(agent, entry, provider.capability.definition, provider)
      }
    }
    const discover = (agent: Agent, entry: Entry): ToolDefinition => ({
      name: DISCOVER, description: DISCOVERY_DESCRIPTION, parameters: DISCOVERY_PARAMETERS,
      output: { schema: DISCOVERY_OUTPUT, render: (_args, value) => [{ type: 'text', text: typeof value === 'object' && value && 'message' in value ? String(value.message) : JSON.stringify(value) }] },
      execute: async args => {
        const request = parseRequest(args)
        if (typeof request === 'string') return failure('INVALID_ARGUMENT', request)
        const candidates = searchCapabilities(request.query, config.allowedTools.filter(api => selectable(agent, api)), externalDiscoverable(agent), Math.min(request.maxResults, config.maxResults))
        const activated = candidates.builtins.filter(api => !entry.selected.has(api) && !config.alwaysLoaded.includes(api))
        const externalActivated = candidates.providers.filter(provider => !entry.externalSelected.has(provider.token)
          && !gate.external?.alwaysLoaded.includes(provider.capability.definition.name) && provider.capability.disclosure !== 'resident')
        for (const api of activated) entry.pending.add(api)
        for (const provider of externalActivated) entry.externalPending.add(provider.token)
        const names = [...candidates.builtins.map(publicToolName), ...candidates.providers.map(provider => provider.capability.definition.name)]
        return { status: 'completed', activated: [...activated.map(publicToolName), ...externalActivated.map(provider => provider.capability.definition.name)],
          alreadyActive: [...candidates.builtins.filter(api => !activated.includes(api)).map(publicToolName), ...candidates.providers.filter(provider => !externalActivated.includes(provider)).map(provider => provider.capability.definition.name)],
          message: names.length ? `Selected ${names.join(', ')}. Newly selected tools become available on the next model step; no tool action was executed.` : 'No allowed, implemented capability matched. Refine the query; unavailable formats cannot be activated.' }
      },
    })
    const attach = (agent: Agent): Promise<void> => {
      if (stopped || retired.has(agent) || !agent.ctx || !owns(agent)) return Promise.resolve()
      const existing = entries.get(agent)
      if (existing) return existing.ready
      const entry: Entry = { runtime: new NativeFileTools({ ctx, config: { ...config, required: Boolean(worker) && config.required, workerPath: worker }, report: undefined }),
        calls: new InvocationLifetime(), selected: new Set(), pending: new Set(), externalSelected: new Set(), externalPending: new Set(), registrations: new Map(), files: new Map(), ready: Promise.resolve() }
      entries.set(agent, entry); ownership?.track(agent)
      entry.releaseObservation = observeSelection(ctx, agent, entry.externalPending)
      entry.ready = Promise.resolve().then(async () => {
        if (!owns(agent) || entries.get(agent) !== entry) return
        entry.fiber = agent.ctx!.plugin({ inject: ['tools'], apply(scoped) { entry.ctx = scoped } })
        await entry.fiber
        if (!owns(agent) || entries.get(agent) !== entry || !entry.ctx) return
        await entry.runtime.start([])
        if (!owns(agent) || entries.get(agent) !== entry || !entry.ctx) return
        if (config.enabled) publish(agent, entry, discover(agent, entry))
        if (worker) for (const api of new Set([...config.allowedTools, ...config.alwaysLoaded])) {
          if (residentSet(agent).has(publicToolName(api))) continue
          if (isSharedFileApi(api)) {
            const lease = await acquireSharedFile(agent, api, { workerPath: worker, required: config.required,
              denyCredentialReads: config.denyCredentialReads }, ctx)
            if (!owns(agent) || entries.get(agent) !== entry) { lease.dispose(); return }
            entry.files.set(api, { lease })
          } else publish(agent, entry, entry.runtime.definition(api))
        }
        if (!owns(agent) || entries.get(agent) !== entry) return
        rotateFiles(agent, entry)
        syncExternal(agent, entry)
        await Promise.all([
          ...[...entry.registrations.values()].map(registration => publicationReady(registration.dispose)),
          ...[...entry.files.values()].map(file => file.lease.ready()),
        ])
      }).catch(async error => {
        // This is ready's own rejection path: cleanup must never await ready,
        // replace the original error, or remove a newer attachment.
        try { if (entries.get(agent) === entry) await detach(agent) }
        catch { ctx.logger.warn('dsh-ops: discovery attachment cleanup failed') }
        throw error
      })
      return entry.ready
    }
    const detach = async (agent: Agent): Promise<void> => {
      const entry = entries.get(agent)
      if (!entry) return
      const errors: unknown[] = []
      const attempt = (action: () => unknown) => { try { action() } catch (error) { errors.push(error) } }
      const settle = async (action: () => unknown) => { try { await action() } catch (error) { errors.push(error) } }
      entries.delete(agent); ownership?.forget(agent)
      attempt(() => entry.releaseObservation?.())
      entry.pending.clear(); entry.externalPending.clear()
      attempt(() => entry.runtime.cancel('Consumer withdrawn'))
      attempt(() => entry.calls.cancel('Consumer withdrawn'))
      for (const registration of entry.registrations.values()) attempt(() => registration.dispose())
      entry.registrations.clear()
      for (const file of entry.files.values()) attempt(() => file.lease.dispose())
      entry.files.clear()
      await settle(() => entry.runtime.stop())
      await settle(async () => {
        if (await entry.calls.stop('Discovery consumer disposed', false)) ctx.logger.warn('dsh-ops: external calls were cancelled but may still be running; effects are unknown. No operation was replayed.')
      })
      await settle(() => entry.fiber?.dispose())
      if (errors.length) throw new AggregateError(errors, 'Discovery detach failed')
    }
    const refresh = (): void => {
      for (const [agent, entry] of entries) {
        if (!owns(agent)) void detach(agent).catch(() => ctx.logger.warn('dsh-ops: background discovery detach failed'))
        else { rotateFiles(agent, entry); syncExternal(agent, entry) }
      }
      for (const agent of ctx.get('agents')?.list() ?? []) if (owns(agent)) void attach(agent).catch(() => {
        ctx.logger.warn('dsh-ops: background discovery attachment failed')
      })
    }
    ownership = await ownScopes(ctx, 'discovery', refresh, gate.allows)
    ctx.on('agent/created', async ({ agent }) => { await attach(agent) })
    ctx.on('agent/disposed', async ({ agent }) => { retired.add(agent); await detach(agent) })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (!isPresentationProbe(context) && result.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))) {
        const entry = entries.get(context.scope as Agent)
        if (entry) {
          entry.pending.clear(); entry.externalPending.clear()
          entry.runtime.cancel('Native presentation withdrawn'); entry.calls.cancel('Native presentation withdrawn')
        }
      }
      return result
    })
    ctx.on('session/event', (session, event) => {
      if ((event as { type: string }).type === 'agent-preset/selected') { refresh(); return }
      for (const [agent, entry] of entries) if (agent.session === session) {
        if (event.type === 'step/end') {
          for (const api of entry.pending) if (selectable(agent, api)) entry.selected.add(api)
          for (const provider of externalDiscoverable(agent)) if (owns(agent) && entry.externalPending.has(provider.token)) entry.externalSelected.add(provider.token)
          entry.pending.clear(); entry.externalPending.clear()
          rotateFiles(agent, entry)
        } else if (event.type === 'sandbox/mode') {
          entry.pending.clear(); entry.externalPending.clear(); entry.runtime.cancel('Sandbox authority changed'); entry.calls.cancel('Sandbox authority changed')
          rotateFiles(agent, entry)
        }
      }
    })
    ctx.effect(() => onProvidersChange(ctx, refresh), 'dsh-ops: external discovery providers')
    if (gate.watch) ctx.effect(() => gate.watch!(refresh), 'dsh-ops: discovery consumer observer')
    ctx.effect(() => prompt.section({ name: ownership!.sectionName('dsh-ops:discovery-tools'), order: 3253, interpolate: false, text: context => {
      const agent = context.scope as Agent, entry = entries.get(agent)
      if (gate.guidance === false || !entry || !owns(agent)) return ''
      const callable = new Set(visibleNames(tools, agent, context.toolSet))
      const published = [...entry.registrations.keys(), ...[...entry.files.keys()].map(publicToolName)].filter(name => callable.has(name))
      if (!published.length) return ''
      const directory = callable.has(DISCOVER) ? renderNativeDirectory(nativeCatalog(config.allowedTools.filter(api => selectable(agent, api)), externalDiscoverable(agent), callable)) : ''
      const policy = renderToolingPolicy({ published, shellComponent: false, extraGuidance: gate.extraGuidanceOwner?.(agent) ? '' : gate.extraGuidance })
      return [policy, directory].filter(Boolean).join('\n\n')
    } }), 'dsh-ops: discovered capability guidance')
    ctx.effect(() => async () => { stopped = true; await Promise.allSettled([...entries.keys()].map(detach)); ownership?.dispose() }, 'dsh-ops: discovery lifecycle')
    ownership.refresh()
    await Promise.all((ctx.get('agents')?.list() ?? []).map(attach))
  })
}
