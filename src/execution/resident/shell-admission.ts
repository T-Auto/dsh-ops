/** Host authority at the native queue head. This module neither schedules commands nor publishes tools. */
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Agent, Context, Session } from '../../adapter/dsh/types.js'
import type { ShellCall, ShellPolicy } from '../../shells/types.js'
import { errorMessage } from '../../shells/types.js'
import { approveBashPolicy } from '../../shells/approval.js'
import { DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS } from '../../shells/constants.js'
import { sameAuthority } from '../../authority-paths.js'
import { resolveSessionDirectory } from '../../adapter/dsh/working-directory.js'
import { sessionWorkdir } from '../../session-shells.js'
import { prepareShellLaunch, shellEnvironment, environmentIdentity, type ShellLaunchOptions } from './shell-launch.js'
import type { ShellAdmission, ShellCompleted, ShellFailure, ShellKernelMessage, ShellTransport } from './shell-protocol.js'
import { collectShellOutput, type ShellOutputPair } from './shell-output.js'

type Args = { command: string; workdir?: string; timeoutMs: number; sandbox_permissions?: string; justification?: string }
interface Facts { standing: ShellPolicy; effective: ShellPolicy; environment: string }
interface Owner {
  agent: Agent; session: Session; key: string; facts?: Facts; closed: boolean
  closing?: Promise<void>; retiring?: Promise<void>
}
interface Pending {
  owner: Owner; args: Args; call: ShellCall; signal: AbortSignal; abort: AbortController
  sent: boolean; started: boolean; admitting: boolean; atHead?: boolean; terminal?: boolean; removeAbort(): void
  grant?: { standing: ShellPolicy; effective: ShellPolicy }
  resolve(value: ShellAdmissionResult): void
}
interface Control { owner: Owner; resolve(): void; reject(error: Error): void }
export interface ShellAdmissionOptions extends ShellLaunchOptions {
  transport: ShellTransport
  /** The owning publication may revoke access synchronously before its async reconciliation. */
  active?(agent: Agent): boolean
}
export type ShellAdmissionResult = ShellCompleted & ShellOutputPair
const MAX_PENDING = 32
const MAX_COMMAND_BYTES = 1024 * 1024
const OUTPUT_BYTES = 128 * 1024
const snapshot = (policy: ShellPolicy): ShellPolicy => ({ ...policy, additionalWritableRoots: [...policy.additionalWritableRoots ?? []] })
const same = (left: ShellPolicy, right: ShellPolicy) => sameAuthority(left, right) && left.sessionId === right.sessionId
function failure(error: unknown): ShellFailure {
  const message = errorMessage(error)
  const code = error instanceof Error && error.name === 'AbortError' ? 'CANCELLED'
    : error instanceof Error && error.name === 'BashArgumentError' ? 'INVALID_ARGUMENT'
    : /^([A-Z][A-Z_]+):/.exec(message)?.[1] ?? 'EXECUTOR_UNAVAILABLE'
  return { code, message }
}
function emptyOutput(lossy = false): ShellOutputPair {
  return { stdout: { text: '', bytesTotal: 0, lossy }, stderr: { text: '', bytesTotal: 0, lossy } }
}
function refused(requestId: string, error: ShellFailure, sent = false, cleanupConfirmed = true): ShellAdmissionResult {
  return { type: 'shell.completed', requestId, status: sent ? 'failed' : 'rejected', exitCode: null,
    effectState: sent ? 'unknown' : 'none', shellState: 'reset', cleanupConfirmed, stdoutTotal: 0, stderrTotal: 0, error, ...emptyOutput(sent) }
}
function argumentsFor(input: Record<string, unknown>): Args {
  if (typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0')
    || Buffer.byteLength(input.command) > MAX_COMMAND_BYTES) throw new Error('INVALID_ARGUMENT: command must be nonempty and at most 1 MiB, without NUL.')
  if (input.script_path !== undefined || input.run_in_background !== undefined) throw new Error('INVALID_ARGUMENT: this internal foreground protocol accepts command only.')
  if (input.workdir !== undefined && (typeof input.workdir !== 'string' || input.workdir.includes('\0'))) throw new Error('INVALID_ARGUMENT: workdir must be a string without NUL.')
  const timeoutMs = input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_BASH_TIMEOUT_MS) throw new Error(`INVALID_ARGUMENT: timeoutMs must be an integer from 1 to ${MAX_BASH_TIMEOUT_MS}.`)
  // Escalation validation belongs at admission, against the then-current standing policy.
  return { ...input, command: input.command, workdir: typeof input.workdir === 'string' && input.workdir.trim() ? input.workdir : undefined, timeoutMs } as Args
}

export function createShellAdmissionHost(ctx: Context, options: ShellAdmissionOptions) {
  const { transport } = options
  // Config replacement must dispose this owning context. Mutable caller config cannot relabel a live shell.
  options = { ...options, bash: { ...options.bash } }
  if (!transport.available || !transport.capabilities.includes('shell-v1')) throw new Error('EXECUTOR_UNAVAILABLE: the resident kernel does not support shell-v1.')
  const owners = new Map<Session, Owner>(), identities = new Map<string, Owner>()
  const disposed = new WeakSet<Agent>(), pending = new Map<string, Pending>(), controls = new Map<string, Control>()
  let stopped = false, disposal: Promise<void> | undefined
  let unavailable: Extract<ShellKernelMessage, { type: 'shell.unavailable' }> | undefined

  function current(owner: Owner): ShellPolicy {
    if (stopped || owner.closed || disposed.has(owner.agent) || owner.agent.session !== owner.session
      || ctx.get('agents')?.get(owner.agent.id) !== owner.agent || options.active?.(owner.agent) === false) {
      throw new Error('OWNER_DISPOSED: the exact calling Agent/Session is no longer active.')
    }
    const policy = ctx.get('sandboxPolicy')?.resolve({ session: owner.session })
    if (!policy) throw new Error('SANDBOX_UNAVAILABLE: no current session policy; no command executed.')
    return snapshot(policy)
  }
  function assertCurrent(item: Pending, standing: ShellPolicy) {
    item.signal.throwIfAborted()
    if (!same(current(item.owner), standing)) throw new Error('AUTHORITY_CHANGED: session policy changed before admission; no command executed.')
  }
  function finish(requestId: string, value: ShellAdmissionResult) {
    const item = pending.get(requestId)
    if (!item) return
    pending.delete(requestId)
    item.removeAbort()
    item.abort.abort()
    item.resolve(value)
  }
  function control(owner: Owner, type: 'shell.retire' | 'shell.close', reason: string): Promise<void> {
    const requestId = randomUUID()
    return new Promise<void>((resolve, reject) => {
      controls.set(requestId, { owner, resolve, reject })
      try { transport.send({ type, requestId, sessionKey: owner.key, reason }) }
      catch (error) { transport.abort(new Error(errorMessage(error))) }
    })
  }
  function retire(owner: Owner): Promise<void> {
    if (owner.closed) return owner.closing ?? Promise.resolve()
    if (!owner.retiring) {
      owner.facts = undefined
      // Retire affects the current head only. Queued requests keep their own
      // admission opportunity under the next policy; late head callbacks stop.
      for (const item of pending.values()) if (item.owner === owner && item.atHead && !item.terminal) {
        item.removeAbort()
        item.abort.abort(new Error('AUTHORITY_CHANGED: the active shell is being retired.'))
      }
      owner.retiring = control(owner, 'shell.retire', 'Session authority changed')
        .catch(error => { void close(owner).catch(() => {}); throw error })
        .finally(() => { owner.retiring = undefined })
    }
    return owner.retiring
  }
  function close(owner: Owner): Promise<void> {
    if (owner.closing) return owner.closing
    owner.closed = true
    disposed.add(owner.agent)
    for (const item of pending.values()) if (item.owner === owner) item.abort.abort(new Error('OWNER_DISPOSED: session owner is closing.'))
    const closed = unavailable ? unavailable.cleanupConfirmed ? Promise.resolve() : Promise.reject(new Error(unavailable.error.message))
      : control(owner, 'shell.close', 'Session owner disposed')
    owner.closing = closed.then(() => {
      owners.delete(owner.session)
      if (identities.get(owner.agent.id) === owner) identities.delete(owner.agent.id)
    })
    return owner.closing
  }
  function ownerFor(agent: Agent | undefined): Owner {
    if (!agent?.session || disposed.has(agent)) throw new Error('OWNER_DISPOSED: an active authoritative Agent/Session is required.')
    const existing = owners.get(agent.session)
    if (existing && existing.agent !== agent) throw new Error('OWNER_CONFLICT: this Session belongs to another Agent.')
    if (existing) { current(existing); return existing }
    if (identities.has(agent.id)) throw new Error('OWNER_CLOSING: the previous owner with this session id has not finished cleanup.')
    if (owners.size >= 32) throw new Error('EXECUTOR_BUSY: resident shell owner capacity is full; dispose an owner before opening another.')
    const owner: Owner = { agent, session: agent.session, key: randomUUID(), closed: false }
    current(owner)
    owners.set(owner.session, owner); identities.set(agent.id, owner)
    agent.ctx.effect(() => () => close(owner))
    return owner
  }
  async function directory(item: Pending, standing: ShellPolicy): Promise<string> {
    const basis = await resolveSessionDirectory(ctx, item.owner.agent, item.signal)
    assertCurrent(item, standing)
    const cwd = sessionWorkdir(item.args, { header: { cwd: basis.cwd } })
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw new Error('INVALID_ARGUMENT: workdir must resolve to an absolute path.')
    const info = await fs.stat(cwd)
    assertCurrent(item, standing)
    if (!info.isDirectory()) throw new Error('INVALID_ARGUMENT: workdir must be an existing directory.')
    return cwd
  }
  async function admit(event: Extract<ShellKernelMessage, { type: 'shell.admit' }>) {
    const item = pending.get(event.requestId)
    if (!item) return
    if (item.admitting || item.started || item.terminal) { void close(item.owner).catch(() => {}); return }
    item.admitting = true
    item.atHead = true
    let reply: ShellAdmission
    try {
      const standing = current(item.owner)
      assertCurrent(item, standing)
      const env = await shellEnvironment(ctx, { ...item.call, signal: item.signal })
      assertCurrent(item, standing)
      if (item.owner.retiring) { item.admitting = false; return }
      const environment = environmentIdentity(env)
      const facts = item.owner.facts
      if (event.hasShell && (!facts || !same(facts.standing, standing) || facts.environment !== environment)) {
        reply = { type: 'shell.admission', requestId: event.requestId, decision: 'retire' }
      } else {
        if (!item.grant) item.grant = { standing, effective: snapshot(await approveBashPolicy(ctx, item.args, { ...item.call, signal: item.signal }, standing)) }
        assertCurrent(item, item.grant.standing)
        const effective = item.grant.effective
        if (event.hasShell && !same(facts!.effective, effective)) {
          reply = { type: 'shell.admission', requestId: event.requestId, decision: 'retire' }
        } else {
          const cwd = !event.hasShell || item.args.workdir !== undefined ? await directory(item, standing) : undefined
          assertCurrent(item, standing)
          if (event.hasShell) reply = { type: 'shell.admission', requestId: event.requestId, decision: 'reuse', ...(cwd ? { commandCwd: cwd } : {}) }
          else {
            const endpoints = event.bootstrap
            if (!endpoints || Object.values(endpoints).some(value => typeof value !== 'string' || !value || value.includes('\0') || value.length > 512)) throw new Error('PROTOCOL_ERROR: missing trusted bootstrap endpoints.')
            const prepared = await prepareShellLaunch(ctx, options, endpoints, cwd!, env, effective, item.signal, () => assertCurrent(item, standing))
            assertCurrent(item, standing)
            item.owner.facts = { standing, effective, environment }
            reply = { type: 'shell.admission', requestId: event.requestId, decision: 'launch', launch: prepared.launch,
              closeAfter: !same(standing, effective), ...(item.args.workdir ? { commandCwd: cwd } : {}) }
          }
        }
      }
    } catch (error) { reply = { type: 'shell.admission', requestId: event.requestId, decision: 'reject', error: failure(error) } }
    item.admitting = false
    if (pending.get(event.requestId) !== item || item.terminal || item.signal.aborted || item.owner.closed || item.owner.retiring || stopped) return
    // Every async boundary above rechecks authority; there is no await between the last check and enqueue.
    try { transport.send(reply) }
    catch (error) { transport.abort(new Error(errorMessage(error))) }
  }
  function receive(event: ShellKernelMessage) {
    if (event.type === 'shell.output') return // read() owns offset-correlated output receipts.
    if (event.type === 'shell.admit') { void admit(event); return }
    if (event.type === 'shell.started') { const item = pending.get(event.requestId); if (item) item.started = true; return }
    if (event.type === 'shell.completed') {
      const item = pending.get(event.requestId)
      if (!item || item.terminal) return
      item.terminal = true
      // Native may admit the next queued request while these terminal streams
      // are still being copied. Apply this receipt's state change now, never
      // after awaits that could overwrite the next shell's launch facts.
      if (event.shellState === 'reset') item.owner.facts = undefined
      item.removeAbort()
      item.abort.abort(new Error('The kernel has settled this request.'))
      if (!transport.available) { finish(event.requestId, { ...event, ...emptyOutput(event.effectState !== 'none') }); return }
      void collectShellOutput(transport, event).then(output => {
        if (!pending.has(event.requestId)) return
        transport.send({ type: 'shell.release', requestId: event.requestId })
        finish(event.requestId, { ...event, ...output, status: output.error ? 'failed' : event.status,
          ...(event.error ?? output.error ? { error: event.error ?? output.error } : {}) })
      }).catch(error => { transport.abort(new Error(errorMessage(error))) })
      return
    }
    if (event.type === 'shell.closed') {
      const value = controls.get(event.requestId)
      if (!value) return
      controls.delete(event.requestId)
      value.owner.facts = undefined
      if (event.cleanupConfirmed) value.resolve()
      else value.reject(new Error(event.error?.message ?? 'Shell cleanup was not confirmed.'))
      return
    }
    stopped = true
    unavailable = event
    for (const owner of owners.values()) owner.facts = undefined
    for (const [id, item] of pending) finish(id, refused(id, event.error, item.sent, event.cleanupConfirmed))
    for (const value of controls.values()) {
      if (event.cleanupConfirmed) value.resolve()
      else value.reject(new Error(event.error.message))
    }
    controls.clear()
  }
  const unsubscribe = transport.subscribe(receive)
  const removeEvent = ctx.on('session/event', (session) => {
    const owner = owners.get(session)
    if (!owner || owner.closed || !owner.facts) return
    try { if (!same(current(owner), owner.facts.standing)) void retire(owner).catch(() => {}) }
    catch { void close(owner).catch(() => {}) }
  })
  const removeDisposed = ctx.on('session/disposed', session => { const owner = owners.get(session); if (owner) void close(owner).catch(() => {}) })

  function execute(input: Record<string, unknown>, call: ShellCall): Promise<ShellAdmissionResult> {
    const requestId = randomUUID()
    let args: Args, owner: Owner
    try {
      call.signal?.throwIfAborted()
      if (stopped || !transport.available) throw new Error('EXECUTOR_UNAVAILABLE: resident shell transport is unavailable.')
      if (pending.size >= MAX_PENDING) throw new Error('EXECUTOR_BUSY: resident shell correlation capacity is full.')
      args = argumentsFor(input); owner = ownerFor(call.agent)
    } catch (error) { return Promise.resolve(refused(requestId, failure(error))) }
    return new Promise(resolve => {
      const abort = new AbortController()
      const signal = call.signal ? AbortSignal.any([call.signal, abort.signal]) : abort.signal
      let cancelled = false
      const cancel = () => {
        if (!item.sent || cancelled || !pending.has(requestId)) return
        cancelled = true
        try { transport.send({ type: 'cancel', requestId }) } catch (error) { transport.abort(new Error(errorMessage(error))) }
      }
      const item: Pending = { owner, args, call: { ...call, agent: owner.agent }, signal, abort, sent: false, started: false, admitting: false,
        removeAbort: () => signal.removeEventListener('abort', cancel), resolve }
      pending.set(requestId, item)
      signal.addEventListener('abort', cancel, { once: true })
      try {
        signal.throwIfAborted()
        item.sent = true
        transport.send({ type: 'shell.execute', requestId, sessionKey: owner.key, command: args.command,
          timeoutMs: args.timeoutMs, stdoutBytes: OUTPUT_BYTES, stderrBytes: OUTPUT_BYTES })
      } catch (error) { finish(requestId, refused(requestId, failure(error))) }
    })
  }
  function dispose(): Promise<void> {
    if (!disposal) {
      stopped = true
      removeEvent(); removeDisposed()
      disposal = Promise.allSettled([...owners.values()].map(close)).then(results => {
        unsubscribe()
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      })
    }
    return disposal
  }
  ctx.effect(() => dispose)
  return { execute, dispose }
}
