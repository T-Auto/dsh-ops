/** One context-owned task adapter. Exact Agent lifetime owns records; the kernel owns scheduling. */
import { randomUUID } from 'node:crypto'
import type { Agent, Context, Session } from '../../adapter/dsh/types.js'
import type { ShellCall } from '../../shells/types.js'
import { NativeTaskExecution, type TaskExecutionOptions } from './task-execution.js'
import type { TaskKernelMessage, TaskTransport } from './task-protocol.js'

interface Owner { agent: Agent; session: Session; key: string; closing?: Promise<void>; closed: boolean }
interface Pending { owner: Owner; execution: NativeTaskExecution }
interface Control { resolve(): void; reject(error: Error): void }
export function createTaskExecutionHost(ctx: Context, transport: TaskTransport) {
  if (!transport.available || !transport.capabilities.includes('task-v1')) throw new Error('Resident kernel does not support task-v1')
  const owners = new Map<Session, Owner>(), identities = new Map<string, Owner>()
  const pending = new Map<string, Pending>(), controls = new Map<string, Control>(), disposed = new WeakSet<Agent>()
  let stopped = false, disposal: Promise<void> | undefined
  let unavailable: Extract<TaskKernelMessage, { type: 'task.unavailable' }> | undefined
  function current(owner: Owner): void {
    if (stopped || owner.closed || disposed.has(owner.agent) || owner.agent.session !== owner.session
      || ctx.get('sessions')?.get(owner.session.id) !== owner.session
      || ctx.get('agents')?.get(owner.agent.id) !== owner.agent) throw new Error('OWNER_DISPOSED: exact Agent/Session is no longer active')
  }
  async function close(owner: Owner): Promise<void> {
    if (owner.closing) return owner.closing
    owner.closed = true; disposed.add(owner.agent)
    const executions = [...pending.values()].filter(item => item.owner === owner).map(item => item.execution)
    for (const execution of executions) execution.kill('Session owner disposed')
    const requestId = randomUUID()
    const cleanup = unavailable ? unavailable.cleanupConfirmed ? Promise.resolve() : Promise.reject(new Error(unavailable.error.message))
      : new Promise<void>((resolve, reject) => {
        controls.set(requestId, { resolve, reject })
        try { transport.send({ type: 'task.closeOwner', requestId, ownerKey: owner.key, reason: 'Session owner disposed' }) }
        catch (error) { transport.abort(error instanceof Error ? error : new Error(String(error))) }
      })
    owner.closing = Promise.allSettled([cleanup, ...executions.map(execution => execution.done)]).then(results => {
      const failed = results.find(value => value.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      owners.delete(owner.session); identities.delete(owner.agent.id)
    })
    return owner.closing
  }
  function ownerFor(agent: Agent | undefined): Owner {
    if (!agent?.session || disposed.has(agent)) throw new Error('OWNER_DISPOSED: an exact active Agent/Session is required')
    const existing = owners.get(agent.session)
    if (existing) {
      if (existing.agent !== agent) throw new Error('OWNER_CONFLICT: this Session belongs to another Agent')
      current(existing); return existing
    }
    if (identities.has(agent.id) || owners.size >= 32) throw new Error('EXECUTOR_BUSY: owner capacity full or prior identity is closing')
    const owner = { agent, session: agent.session, key: randomUUID(), closed: false }
    current(owner); owners.set(owner.session, owner); identities.set(agent.id, owner)
    agent.ctx.effect(() => () => close(owner))
    return owner
  }
  const unsubscribe = transport.subscribe(message => {
    if (message.type === 'task.output') return
    if (message.type === 'task.unavailable') {
      unavailable = message
      for (const { execution } of pending.values()) execution.receive(message)
      for (const control of controls.values()) message.cleanupConfirmed ? control.resolve() : control.reject(new Error(message.error.message))
      controls.clear(); return
    }
    if (message.type === 'task.ownerClosed') {
      const control = controls.get(message.requestId)
      if (control) { controls.delete(message.requestId); message.cleanupConfirmed ? control.resolve() : control.reject(new Error(message.error?.message ?? 'Task cleanup was not confirmed')) }
      return
    }
    pending.get(message.requestId)?.execution.receive(message)
  })
  const removeDisposed = ctx.on('session/disposed', session => {
    const owner = owners.get(session)
    if (owner) void close(owner).catch(() => {})
  })
  function dispose(): Promise<void> {
    if (disposal) return disposal
    stopped = true
    disposal = Promise.allSettled([...owners.values()].map(close)).then(results => {
      unsubscribe(); removeDisposed()
      const failed = results.find(value => value.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
    return disposal
  }
  ctx.effect(() => dispose)
  return {
    start(call: ShellCall, options: Omit<TaskExecutionOptions, 'requestId' | 'ownerKey' | 'signal'>): NativeTaskExecution {
      if (stopped || !transport.available) throw new Error('EXECUTOR_UNAVAILABLE: task provider is no longer available')
      const owner = ownerFor(call.agent)
      if (pending.size >= 32) throw new Error('EXECUTOR_BUSY: task capacity is full')
      const requestId = randomUUID(), admit = options.admit
      const execution = new NativeTaskExecution(transport, { ...options, requestId, ownerKey: owner.key, signal: call.signal,
        sessionId: owner.session.id,
        spec: { ...options.spec },
        admit: async signal => { current(owner); const launch = await admit(signal); signal.throwIfAborted(); current(owner); return launch } })
      pending.set(requestId, { owner, execution })
      void execution.done.then(() => pending.delete(requestId))
      execution.start()
      return execution
    },
    dispose,
  }
}
