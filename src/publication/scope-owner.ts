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
  ready: Promise<unknown>
  refs: number
  closed: boolean
  identity: string
  definitions: Map<SharedApi, { canonical: Canonical; dispatch: ToolDefinition['execute'] }>
}
const runtimes = new WeakMap<Agent, Source>()
/**
 * Acquire one shared file source for an agent.
 *
 * @param agent - the reading agent; its ctx serves services, credentials and cwd.
 * @param api - the shared file capability.
 * @param config - the worker and policy configuration, part of the source identity.
 * @param events - the context that receives provider and execution events. This is
 *   the only construction point that reads through `agent.ctx`, so every caller
 *   must pass its row-level ctx here: an agent ctx carries a scope tag and misses
 *   `session/event` and `session/disposed`, which is exactly the evidence
 *   read-dedup invalidates on. Handing the reading ctx back as `events` is
 *   therefore refused below instead of quietly degrading.
 * @returns the publication lease.
 */
export async function acquireSharedFile(agent: Agent, api: SharedApi, config: NativeRuntimeConfig, events?: Context): Promise<PublicationLease> {
  if (!agent.ctx) throw new Error('Shared file source requires an agent scope')
  const { scopeChainOf } = await loadScopes()
  agent.ctx.fiber.assertActive()
  // Fail closed on the documented regression rather than degrade silently: passing
  // the reading ctx back as the subscription ctx is exactly how the agent scope
  // takes over and drops `session/event` / `session/disposed` (DESIGN §5 R1).
  // The test is identity, not scope tags, and deliberately so: a publisher row
  // mounted under a scoped ctx receives an injected ctx that inherits that tag
  // while still being a row context that other rows are meant to use, so a
  // tag-based refusal would reject supported compositions. Visibility probing is
  // ruled out too (DESIGN D6): it subscribes to answer, and a wrong verdict is silent.
  if (events === agent.ctx) throw new Error('Shared file subscription context must not be the reading ctx: the agent scope loses session events')
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
    void owned.runtime.stop().catch(error => agent.ctx!.logger.warn(`dsh-ops: shared file stop failed: ${String(error)}`))
  }
  if (!source) {
    const runtime = new NativeFileTools({ ctx: agent.ctx, events, config: normalized })
    source = { runtime, refs: 0, closed: false, identity, definitions: new Map(), ready: runtime.start([]) }
    runtimes.set(agent, source)
    const created = source
    agent.ctx.effect(() => () => stop(created))
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
