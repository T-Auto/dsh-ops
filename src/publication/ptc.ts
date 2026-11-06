/** Stable, scoped PTC definitions; DSH resolves selection once per model step. */
import type { Agent, Context, Fiber, ToolDefinition, ToolRunContext } from '../adapter/dsh/types.js'
import { resolvePtcConfig } from '../config.js'
import { acquirePtcFile, acquireSharedFile, isSharedFileApi } from './scope-owner.js'
import type { PublicationLease } from './registrar.js'
import type { FileToolName } from '../capabilities/registry.js'
import { capability } from '../capabilities/registry.js'
import { publicToolName } from '../policy.js'
import { definition, PTC_SECTION } from '../projections/ptc/contract.js'
import { requestedApis, sdkDefinition } from '../projections/ptc/loader.js'
import { renderSdkDirectory } from '../projections/ptc/directory.js'
import { PTC_RESIDENT_TOOLS } from '../ptc/config.js'
import type { ApiName } from '../ptc/config.js'
import { ownPtcScopes } from '../ptc/ownership.js'
import { InvocationLifetime, InvocationNotStarted } from '../lifecycle/invocations.js'
import { monitoredInvoke } from '../execution/monitored.js'
import { failure, resolveWorker } from '../execution/jobs.js'
import { WORKER_TIMEOUT_MS } from '../execution/protocol.js'
import { mountWorkspacePreparation } from '../workspace-preparation.js'
import { mountResultLifecycle } from '../kernel/result-lifecycle.js'
import { activationIsPtc, inspectPresentation, isPresentationProbe } from './presentation.js'
import { visibleNames } from './surface.js'
import { publicationRegistration, publicationReady } from './reentry.js'
import { retired as retiredLegacyRow } from '../settings/legacy.js'
export { resolvePtcConfig } from '../config.js'
export const name = 'dsh-ops-ptc'

interface Entry {
  agent: Agent
  ctx?: Context
  fiber?: Fiber
  ready: Promise<void>
  calls: InvocationLifetime
  selected: Set<ApiName>
  pending: Set<ApiName>
  definitions: Map<string, ToolDefinition>
  disposers: (() => void)[]
  files: Map<FileToolName | 'result', { lease: PublicationLease; revoke?: () => void; dispatch: ToolDefinition['execute']; granted?: { entitled: boolean; selected: boolean; config: object } }>
}
/** Consumer routing controls; invocation authority always remains host-owned. */
export interface PtcGate {
  guidance?: boolean
  resident?: boolean
  dynamic?: boolean
  allows(agent: Agent): boolean
  watch?(notify: () => void): () => void
}
export function apply(root: Context, rawConfig: unknown, gate: PtcGate = { allows: () => true }): void {
  if (!retiredLegacyRow(root, 'ptc')) mountPtc(root, rawConfig, gate)
}
export function mountPtc(root: Context, rawConfig: unknown, gate: PtcGate = { allows: () => true }): void {
  const config = resolvePtcConfig(rawConfig)
  let file: string
  try { file = resolveWorker(config) } catch (error) {
    if (config.required) throw error
    root.logger.warn(`dsh-ops: ${String(error)}`); return
  }
  mountWorkspacePreparation(root)
  root.inject(['tools', 'systemPrompt', 'sandboxPolicy', 'subprocess'], async ctx => {
    const tools = ctx.get('tools')!, prompt = ctx.get('systemPrompt')!
    mountResultLifecycle(ctx)
    const entries = new Map<Agent, Entry>(), retired = new WeakSet<Agent>()
    let stopped = false
    let presentationRevision = 0
    ctx.on('system-prompt/change', () => { ++presentationRevision })
    let ownership: Awaited<ReturnType<typeof ownPtcScopes>> | undefined
    const resident = new Set<ApiName>(gate.resident === false ? [] : [...PTC_RESIDENT_TOOLS, ...config.alwaysLoaded])
    const pool = new Set<ApiName>([...resident, ...config.allowedTools, 'result'])
    const owns = (agent: Agent): boolean => !stopped && gate.allows(agent) && Boolean(ownership?.owns(agent))
    const permitted = (agent: Agent, api: ApiName | 'load_sdk'): boolean => {
      if (!owns(agent) || !ctx.get('ptcRuntime') || !ctx.get('subprocess')) return false
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      return policy !== undefined && ['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)
        && (api === 'load_sdk' || api === 'result' || !capability(api)?.mutates || policy.mode !== 'read-only')
    }
    const loadable = gate.resident === false ? [...new Set<ApiName>([...config.allowedTools, 'result'])] : config.allowedTools
    const allowedApis = (agent: Agent): ApiName[] => gate.dynamic === false ? [] : loadable.filter(api => permitted(agent, api))
    const selected = (entry: Entry, api: ApiName | 'load_sdk'): boolean => api === 'load_sdk'
      ? gate.dynamic !== false : resident.has(api) || entry.selected.has(api)
    const isPtc = async (agent: Agent, signal?: AbortSignal): Promise<boolean> => {
      const assembly = await inspectPresentation(prompt, agent, signal)
      return assembly.tools.length === 1 && assembly.tools[0]?.name === 'run_code'
        && assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
    }
    const execute = (entry: Entry, api: ApiName | 'load_sdk'): ToolDefinition['execute'] => async (args, exec) => {
      // The public assembly may finish after its executor sections changed.
      // Refuse that stale verdict rather than dispatching under the old text.
      const revision = presentationRevision
      const current = () => entries.get(entry.agent) === entry && exec.agent === entry.agent && !exec.signal.aborted
        && revision === presentationRevision && permitted(entry.agent, api) && selected(entry, api)
        && (capability(api)?.component === 'file' || tools.executable(publicToolName(api), entry.agent, exec.toolSet) === entry.definitions.get(publicToolName(api)))
      if (!current() || !await isPtc(entry.agent, exec.signal).catch(() => false) || !current()) {
        return failure('POLICY_DENIED', 'This API must be admitted for the calling PTC scope; no action executed.')
      }
      if (api === 'load_sdk') {
        const requested = requestedApis(args, allowedApis(entry.agent))
        if (typeof requested === 'string') return failure('INVALID_ARGUMENT', requested)
        for (const name of requested) entry.pending.add(name)
        return { status: 'completed', tools: requested, nextTurn: true }
      }
      try {
        return await entry.calls.run(exec.signal, (_signal, controller) => monitoredInvoke(ctx, file, api, args, exec as ToolRunContext, controller, config), undefined, WORKER_TIMEOUT_MS)
      } catch (error) {
        if (error instanceof InvocationNotStarted) return failure('ABORTED', error.message)
        return failure('RESULT_UNKNOWN', 'Invocation did not settle; inspect postconditions before retrying.', 'unknown')
      }
    }
    const rotateFiles = (entry: Entry): void => {
      for (const [api, file] of entry.files) {
        const selection = selected(entry, api), entitled = permitted(entry.agent, api) && selection
        if (file.granted?.entitled === entitled && file.granted.selected === selection && file.granted.config === config) continue
        const revoke = file.revoke
        file.revoke = undefined; file.granted = undefined
        revoke?.()
        file.revoke = file.lease.grant({ consumer: entry, agent: entry.agent, token: {},
          entitled,
          present: activation => activation.agent === entry.agent && permitted(entry.agent, api)
            && selected(entry, api) && activationIsPtc(prompt, activation),
          dispatch: file.dispatch,
        })
        file.granted = { entitled, selected: selection, config }
      }
    }
    const clear = (entry: Entry): void => {
      const errors: unknown[] = []
      const attempt = (action: () => void) => { try { action() } catch (error) { errors.push(error) } }
      entry.pending.clear(); entry.selected.clear()
      attempt(() => entry.calls.cancel('PTC ownership withdrawn'))
      for (const dispose of entry.disposers.splice(0)) attempt(dispose)
      for (const file of entry.files.values()) attempt(() => file.lease.dispose())
      entry.files.clear()
      entry.definitions.clear()
      if (errors.length) throw new AggregateError(errors, 'PTC entry cleanup failed')
    }
    const attach = (agent: Agent): Promise<void> => {
      if (stopped || retired.has(agent) || !agent.ctx || !owns(agent)) return Promise.resolve()
      const existing = entries.get(agent)
      if (existing) return existing.ready
      const entry: Entry = { agent, ready: Promise.resolve(), calls: new InvocationLifetime(), selected: new Set(), pending: new Set(), definitions: new Map(), disposers: [], files: new Map() }
      entries.set(agent, entry); ownership?.track(agent)
      entry.ready = Promise.resolve().then(async () => {
        if (!owns(agent) || entries.get(agent) !== entry) return
        entry.fiber = agent.ctx!.plugin({ inject: ['tools'], apply(scoped) { entry.ctx = scoped } })
        await entry.fiber
        if (!owns(agent) || entries.get(agent) !== entry || !entry.ctx) return
        const publish = (api: ApiName | 'load_sdk', def: ToolDefinition): void => {
          entry.definitions.set(def.name, def)
          entry.disposers.push(publicationRegistration(entry.ctx!, () => entry.ctx!.tools.register(def, { when: async activation =>
            activation.agent === agent && permitted(agent, api) && selected(entry, api)
              && await activationIsPtc(prompt, activation) })))
        }
        for (const api of pool) {
          const def = definition(api, execute(entry, api))
          if (isSharedFileApi(api) || capability(api)?.component === 'file') {
            const lease = isSharedFileApi(api) ? await acquireSharedFile(agent, api, { workerPath: file, required: true }) : await acquirePtcFile(agent, api as FileToolName)
            // Ownership may change while the source starts. Never continue into
            // non-file publication using a superseded entry's disposed context.
            if (!owns(agent) || entries.get(agent) !== entry) { lease.dispose(); return }
            entry.definitions.set(def.name, def)
            entry.files.set(api as FileToolName | 'result', { lease, dispatch: def.execute })
          } else {
            if (!owns(agent) || entries.get(agent) !== entry) return
            publish(api, def)
          }
        }
        if (!owns(agent) || entries.get(agent) !== entry) return
        rotateFiles(entry)
        if (gate.dynamic !== false) publish('load_sdk', sdkDefinition(loadable, execute(entry, 'load_sdk')))
        await Promise.all([...entry.disposers.map(publicationReady), ...[...entry.files.values()].map(file => file.lease.ready())])
      }).catch(async error => {
        // Do not await ready here: this is its own rejection path. Preserve the
        // original failure for agent/created while observing teardown failures.
        try { if (entries.get(agent) === entry) await detach(agent) }
        catch { ctx.logger.warn('dsh-ops: PTC attachment cleanup failed') }
        throw error
      })
      return entry.ready
    }
    const detach = async (agent: Agent): Promise<void> => {
      const entry = entries.get(agent)
      if (!entry) return
      const errors: unknown[] = []
      const attempt = async (action: () => unknown) => { try { await action() } catch (error) { errors.push(error) } }
      entries.delete(agent)
      ownership?.forget(agent)
      await attempt(() => clear(entry))
      await attempt(() => entry.calls.stop())
      await attempt(() => entry.fiber?.dispose())
      if (errors.length) throw new AggregateError(errors, 'PTC detach failed')
    }
    const refresh = (): void => {
      for (const [agent] of entries) if (!owns(agent)) void detach(agent).catch(error => ctx.logger.warn(`dsh-ops: ${String(error)}`))
      for (const agent of ctx.get('agents')?.list() ?? []) if (owns(agent)) void attach(agent).catch(error => {
        const category = error instanceof Error && error.message === 'Conflicting shared file runtime configuration'
          ? 'shared file configuration conflict' : 'publication initialization failed'
        ctx.logger.warn(`dsh-ops: background PTC attachment failed: ${category}`)
      })
    }
    ownership = await ownPtcScopes(ctx, refresh, gate.allows)
    ctx.on('agent/created', async ({ agent }) => { await attach(agent) })
    ctx.on('agent/disposed', async ({ agent }) => { retired.add(agent); await detach(agent) })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      // Sections are evaluated before the public presentation waterfall. Shared
      // file names are callable in both executors, so they cannot select PTC text.
      const ptc = result.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
      if (!isPresentationProbe(context)) {
        const entry = entries.get(context.scope as Agent)
        if (entry && !ptc) {
          entry.pending.clear(); entry.calls.cancel('PTC presentation withdrawn')
        }
      }
      const name = ownership!.sectionName(PTC_SECTION)
      if (!result.sections.some(section => section.name === name)) return result
      if (!ptc) return { ...result, sections: result.sections.filter(section => section.name !== name) }
      // A text-only inspection cannot reconstruct a provider's captured SDK.
      // Preserve its presentation and identity until an admitted step supplies the set.
      if (!context.toolSet) return result
      const text = renderGuidance(context.scope as Agent, context.toolSet)
      if (result.sections.every(section => section.name !== name || section.text === text)) return result
      return { ...result, sections: result.sections.map(section => section.name === name ? { ...section, text } : section) }
    })
    ctx.on('session/event', (session, event) => {
      if ((event as { type: string }).type === 'agent-preset/selected') { refresh(); return }
      for (const [agent, entry] of entries) if (agent.session === session) {
        if (event.type === 'step/end') {
          for (const api of entry.pending) if (permitted(agent, api)) entry.selected.add(api)
          entry.pending.clear()
          rotateFiles(entry)
        } else if (event.type === 'sandbox/mode') {
          entry.pending.clear(); entry.calls.cancel('Sandbox authority changed')
          rotateFiles(entry)
        }
      }
    })
    if (gate.watch) ctx.effect(() => gate.watch!(refresh), 'dsh-ops: PTC consumer observer')
    const renderGuidance = (agent: Agent, toolSet?: import('../adapter/dsh/types.js').ResolvedToolSet): string => {
      const entry = entries.get(agent)
      if (gate.guidance === false || !entry || !owns(agent)) return ''
      const callable = new Set(visibleNames(tools, agent, toolSet))
      const active = [...entry.definitions.keys()].some(name => callable.has(name))
      if (!active) return ''
      const guidance = 'OPS APIs return typed Outcome values. Inspect status before data; preserve partial coverage and continuation. Process results locally in run_code and return only needed summaries. References do not grant authority.'
      const directory = callable.has(publicToolName('load_sdk')) ? renderSdkDirectory(allowedApis(agent), callable) : ''
      return guidance + (directory ? '\n\n' + directory : '')
    }
    ctx.effect(() => prompt.section({ name: ownership!.sectionName(PTC_SECTION), order: 3252, interpolate: false, text: '' }), 'dsh-ops: progressive PTC guidance')
    ctx.effect(() => async () => {
      stopped = true
      const results = await Promise.allSettled([...entries.keys()].map(detach))
      const errors: unknown[] = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      try { ownership?.dispose() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'PTC lifecycle cleanup failed')
    }, 'dsh-ops: PTC lifecycle')
    ownership.refresh()
    await Promise.all((ctx.get('agents')?.list() ?? []).map(attach))
  })
}
