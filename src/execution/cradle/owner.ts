/** Kernel-scoped ownership, shared by its component leases; never keyed by home, workspace or PID. */
import type { Context, SubprocessHandle, SubprocessRuntime } from '../../adapter/dsh/types.js'
import { cradleEnvironment } from '../../adapter/dsh/cradle.js'
import { resolveWorker } from '../runtime.js'
import { CradleConnection } from './connection.js'

type Spec = Parameters<SubprocessRuntime['spawn']>[0]
class KernelCradle {
  private connection?: CradleConnection
  private environment?: Promise<(extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>
  private binary?: string
  private stopped = false
  constructor(private readonly ctx: Context, private readonly binaryPath?: string) {}
  async prepare(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.stopped) throw new Error('EXECUTOR_UNAVAILABLE: cradle owner disposed')
    if (process.platform !== 'win32') throw new Error('EXECUTOR_UNAVAILABLE: cradle backend requires Windows Job containment; select host backend on this platform')
    this.environment ??= cradleEnvironment(this.ctx)
    await this.environment
    signal.throwIfAborted()
    if (!this.connection?.available) {
      this.binary ??= resolveWorker({ binaryPath: this.binaryPath })
      this.connection = new CradleConnection(this.binary)
    }
    const connection = this.connection
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })
    try { await Promise.race([connection.connect(), cancelled]) }
    finally { signal.removeEventListener('abort', abort) }
    signal.throwIfAborted()
    if (this.stopped) throw new Error('EXECUTOR_UNAVAILABLE: cradle owner disposed')
  }
  async executor(signal: AbortSignal, authorize: () => void): Promise<Pick<SubprocessRuntime, 'spawn'>> {
    await this.prepare(signal)
    const connection = this.connection!
    const environment = await this.environment!
    return { spawn: (spec: Spec) => connection.spawn(spec, environment(spec.env), authorize) }
  }
  async dispose(): Promise<void> { this.stopped = true; await this.connection?.dispose() }
}
interface Owner { cradle: KernelCradle; references: number; binaryPath?: string }
const owners = new WeakMap<object, Owner>()
export interface CradleLease {
  executor(signal: AbortSignal, authorize: () => void): Promise<Pick<SubprocessRuntime, 'spawn'>>
  cancelOwner(owner: object): void
  bind(owner: object, executor: Pick<SubprocessRuntime, 'spawn'>): Pick<SubprocessRuntime, 'spawn'>
  dispose(): Promise<void>
}
export function acquireCradle(ctx: Context, binaryPath?: string): CradleLease {
  // Cordis root identifies the actual kernel. Different roots in one process are independent too.
  const root = (ctx as unknown as { root?: object }).root
  if (!root) throw new Error('EXECUTOR_UNAVAILABLE: cradle requires a kernel root identity')
  let owner = owners.get(root)
  if (owner && owner.binaryPath !== binaryPath) throw new Error('EXECUTOR_UNAVAILABLE: kernel cradle runtime selections disagree')
  if (!owner) { owner = { cradle: new KernelCradle(ctx, binaryPath), references: 0, binaryPath }; owners.set(root, owner) }
  owner.references++
  const shared = owner
  const tasks = new Map<object, Set<SubprocessHandle>>()
  let disposed = false
  const cancelOwner = (key: object) => { for (const task of tasks.get(key) ?? []) task.terminate(); tasks.delete(key) }
  return {
    executor: (signal, authorize) => {
      if (disposed) return Promise.reject(new Error('EXECUTOR_UNAVAILABLE: cradle lease disposed'))
      return shared.cradle.executor(signal, () => { if (disposed) throw new Error('Cradle lease disposed'); authorize() })
    },
    cancelOwner,
    bind: (key, executor) => ({ spawn(spec) {
      if (disposed) throw new Error('EXECUTOR_UNAVAILABLE: cradle lease disposed')
      const task = executor.spawn(spec)
      let set = tasks.get(key)
      if (!set) { set = new Set(); tasks.set(key, set) }
      set.add(task)
      void task.done.finally(() => { set!.delete(task); if (!set!.size) tasks.delete(key) }).catch(() => {})
      return task
    } }),
    async dispose() {
      if (disposed) return
      disposed = true
      for (const key of tasks.keys()) cancelOwner(key)
      if (--shared.references === 0) {
        owners.delete(root)
        await shared.cradle.dispose()
      }
    },
  }
}
