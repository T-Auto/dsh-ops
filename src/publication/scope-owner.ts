/** The agent's scoped context outlives all publication consumer leases. */
import type { Agent, Context, ToolDefinition } from '../adapter/dsh/types.js'
import type { FileToolName } from '../capabilities/registry.js'
import { definition } from '../projections/ptc/contract.js'
import { publicToolName } from '../policy.js'
import { acquire } from './registrar.js'
import { loadScopes } from '../adapter/dsh/host.js'

// PTC metadata is cached from the static API contract, not runtime closures.
// Legacy acquisition is retained for isolated contract tests; production uses the shared source.
const contracts = new Map<FileToolName, Omit<ToolDefinition, 'name' | 'execute'>>()
export function acquirePtcFile(agent: Agent, api: FileToolName) {
  if (!agent.ctx) throw new Error('Publication requires an agent scope')
  let canonical = contracts.get(api)
  if (!canonical) {
    const { name: _name, execute: _execute, ...metadata } = definition(api, async () => undefined)
    canonical = metadata
    contracts.set(api, canonical)
  }
  return acquire(agent.ctx, agent, publicToolName(api), canonical)
}

/** File parameters and execution/files.invoke are identical for Native and PTC.
 * monitoredInvoke routes FILE_TOOLS before jobs. One runtime preserves authoritative
 * cwd, credentials, CAS, permissions, timeouts and result-session lifecycle. Result
 * uses the shared jobs bridge with its explicit PTC put admission fence.
 */
import { NativeFileTools } from '../projections/native/runtime.js'
import type { NativeRuntimeConfig } from '../projections/native/runtime.js'
import type { PublicationLease } from './registrar.js'
import { WORKER_TIMEOUT_MS } from '../execution/protocol.js'
export const SHARED_FILE_APIS = ['inspect_local_file', 'replace', 'write_file', 'edit_file', 'copy', 'move', 'remove', 'stat', 'grep', 'glob', 'read_files', 'diff', 'read_table', 'read_docx', 'read_pdf', 'result'] as const
export function isSharedFileApi(api: string): api is typeof SHARED_FILE_APIS[number] {
  return (SHARED_FILE_APIS as readonly string[]).includes(api)
}
type SharedApi = typeof SHARED_FILE_APIS[number]
type Canonical = Omit<ToolDefinition, 'name' | 'execute'>
interface Source {
  runtime: NativeFileTools
  /** Owns the source's event subscriptions; its lifetime is the source's, not a row's. */
  feed: { dispose(): Promise<void> }
  ready: Promise<unknown>
  refs: number
  closed: boolean
  identity: string
  definitions: Map<SharedApi, { canonical: Canonical; dispatch: ToolDefinition['execute'] }>
}
const runtimes = new WeakMap<Agent, Source>()
type Scopes = Awaited<ReturnType<typeof loadScopes>>
/**
 * Mint the event feed the shared source subscribes on.
 *
 * The feed has to hold two properties that no single host context offers by
 * itself. It must outlive every consumer row, because one source serves the
 * native publication row, the PTC row and the discovery row of an agent, and the
 * row that created it may unload first. And it must carry no scope tag:
 * `session/event` and `session/disposed` are dispatched with an undefined
 * routing key, so a tagged listener is never admitted and read-dedup would
 * silently stop invalidating. The agent scope matches the lifetime; its own view
 * is tagged. A child scope minted with an undefined key has both: Cordis gives
 * the fiber the agent scope's lifetime, and its own `undefined` tag shadows the
 * inherited one. The tag is re-read here rather than assumed, so a host whose
 * scope primitive changed fails closed instead of going deaf.
 * Synchronous on purpose: the caller replaces "no source" with a source in the
 * same turn, and an await here let two concurrent consumers (the PTC row and the
 * discovery row attach in parallel) both build one, which then registered the same
 * publication name with two different canonical objects.
 * @param owner - the agent scope the source is keyed by.
 * @param scopes - the already-loaded host scope helpers.
 * @returns the unscoped feed context and its disposal boundary.
 */
function subscriptionScope(owner: Agent, scopes: Scopes): { ctx: Context; dispose(): Promise<void> } {
  if (!owner.ctx) throw new Error('Shared file source requires an agent scope')
  // The undefined key is the point, not an accident: any defined key would tag the
  // feed and lose the session events. The cast is the price of an API typed for
  // identities only.
  const scope = scopes.createScope(owner.ctx, undefined as unknown as Parameters<typeof scopes.createScope>[1])
  if (scopes.scopeOf(scope.ctx) !== undefined) {
    void scope.dispose()
    throw new Error('Shared file subscription context must not carry a scope tag: the agent scope loses session events')
  }
  return scope
}

/**
 * Acquire one shared file source for an agent.
 *
 * One source serves every consumer row of an agent, so its event feed belongs to
 * the source rather than to whichever row acquired first (see
 * {@link subscriptionScope}).
 * @param agent - the reading agent; its ctx serves services, credentials and cwd.
 * @param api - the shared file capability.
 * @param config - the worker and policy configuration, part of the source identity.
 * @returns the publication lease.
 */
export async function acquireSharedFile(agent: Agent, api: SharedApi, config: NativeRuntimeConfig): Promise<PublicationLease> {
  if (!agent.ctx) throw new Error('Shared file source requires an agent scope')
  const scopes = await loadScopes()
  const { scopeChainOf } = scopes
  agent.ctx.fiber.assertActive()
  const owner = scopeChainOf(agent).find(scope => runtimes.has(scope as Agent)) as Agent | undefined
  const runtimeOwner = owner ?? agent
  // Startup policy is not execution identity once a worker has been selected.
  const normalized = { workerPath: config.workerPath, required: config.required ?? true,
    denyCredentialReads: config.denyCredentialReads ?? true,
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? WORKER_TIMEOUT_MS }
  const { required: _required, ...executionConfig } = normalized
  const identity = JSON.stringify(executionConfig)
  let source = runtimes.get(runtimeOwner)
  if (source && source.identity !== identity) throw new Error('Conflicting shared file runtime configuration')
  const stop = (owned: Source): void => {
    if (owned.closed) return
    owned.closed = true
    if (runtimes.get(runtimeOwner) === owned) runtimes.delete(runtimeOwner)
    owned.runtime.cancel('Shared file source disposed')
    // dispose() is synchronous; explicitly handle asynchronous teardown rejection.
    // The feed is disposed only after the listeners it owns are gone, and a failed
    // stop still releases it so a dead source cannot keep a subscription alive.
    void owned.runtime.stop()
      .then(() => owned.feed.dispose())
      .catch(error => (runtimeOwner.ctx ?? agent.ctx!).logger.warn(`dsh-ops: shared file stop failed: ${String(error)}`))
  }
  if (!source) {
    const feed = subscriptionScope(runtimeOwner, scopes)
    const runtime = new NativeFileTools({ ctx: agent.ctx, events: feed.ctx, config: normalized })
    const created: Source = { runtime, feed, refs: 0, closed: false, identity, definitions: new Map(), ready: runtime.start([]) }
    // The source belongs to the agent scope it is keyed by, not to the consumer
    // that happened to arrive first: removing one consumer has to leave the others
    // working, and a source shared with a descendant must not die with the
    // descendant that created it. Registered before the map insert so a refused
    // effect cannot leave a source nobody is left to stop.
    const ownerCtx = runtimeOwner.ctx!
    try { ownerCtx.effect(() => () => stop(created)) } catch (error) { stop(created); throw error }
    runtimes.set(runtimeOwner, created)
    source = created
  }
  const owned = source
  ++owned.refs
  const release = () => { if (--owned.refs === 0) stop(owned) }
  let lease: PublicationLease
  let shared: { canonical: Canonical; dispatch: ToolDefinition['execute'] }
  try {
    await owned.ready
    if (owned.closed) throw new Error('Shared file source is disposed')
    let cached = owned.definitions.get(api)
    if (!cached) {
      // runtime.definition retains Native render, metadata and dedup hooks and wraps raw call once.
      const { name: _name, execute, ...canonical } = owned.runtime.definition(api)
      cached = { canonical, dispatch: execute }
      owned.definitions.set(api, cached)
    }
    shared = cached
    lease = await acquire(agent.ctx, agent, publicToolName(api), shared.canonical)
  } catch (error) { release(); throw error }
  let disposed = false
  return {
    grant: grant => lease.grant({ ...grant, dispatch: shared.dispatch }),
    ready: () => lease.ready(),
    dispose() {
      if (disposed) return
      disposed = true
      try { lease.dispose() } finally { release() }
    },
  }
}
