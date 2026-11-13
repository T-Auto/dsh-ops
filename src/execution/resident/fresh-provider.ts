/** Fresh task selection requires the kernel's complete recoverable-output contract. */
import type { Context } from '../../adapter/dsh/types.js'
import { createFreshTaskHost, type FreshTaskHost } from './fresh-host.js'

declare module '@deepseek-ai/cordis' {
  interface Context { opsFreshTasks: FreshTaskHost }
}

export function supportsFreshTasks(capabilities: readonly string[]): boolean {
  return capabilities.includes('task-v1') && capabilities.includes('task-spill-v1')
}

/** Mount once beside residentKernel(), before consumers; there is no configuration bypass. */
export function residentFreshTasks() {
  return { name: 'dsh-ops-fresh-tasks', inject: ['opsKernel'], apply(ctx: Context): void {
    const kernel = ctx.get('opsKernel')!
    if (!supportsFreshTasks(kernel.task.capabilities)) return
    if (ctx.get('opsFreshTasks', false)) throw new Error('Fresh task authority already belongs to this host; share its existing provider.')
    ctx.inject(['agents', 'sessions', 'sandboxPolicy', 'shellEnv'], owner => {
      owner.provide('opsFreshTasks', undefined)
      const host = createFreshTaskHost(owner, { transport: kernel.task })
      owner.set('opsFreshTasks', host)
    })
  } }
}
