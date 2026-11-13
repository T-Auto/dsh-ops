/** Explicit activation owner shared by every local file consumer in one host. */
import path from 'node:path'
import type { Context } from '../../adapter/dsh/types.js'
import { resolveWorker, type WorkerSelection } from '../runtime.js'
import { startResident, type ResidentClient } from './client.js'

declare module '@deepseek-ai/cordis' {
  interface Context { opsKernel: ResidentClient }
}

function identity(file: string): string {
  const absolute = path.resolve(file)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Reject conflicting explicit selections before any consumer or process starts. */
export function sharedWorkerSelection(selections: readonly WorkerSelection[]): WorkerSelection {
  const explicit = selections.flatMap(value => value.binaryPath === undefined ? [] : [value.binaryPath])
  if (explicit.some(file => !path.isAbsolute(file))) throw new Error('Native worker selection must be an absolute path.')
  if (new Set(explicit.map(identity)).size > 1) throw new Error('Conflicting OPS kernel binaryPath selections; one host activation uses one native worker.')
  return explicit.length ? { binaryPath: explicit[0] } : {}
}

/** Public setup for standalone integrations; mount once in their common owning activation. */
export function residentKernel(options: WorkerSelection = {}) {
  const selection = sharedWorkerSelection([options])
  return {
    name: 'dsh-ops-kernel',
    inject: ['subprocess'],
    async apply(ctx: Context): Promise<void> {
      if (ctx.get('opsKernel', false)) throw new Error('An OPS kernel provider already belongs to this host; share the existing provider instead of mounting another.')
      const file = resolveWorker(selection)
      // Reserve the service before awaiting startup; concurrent activations
      // cannot both launch a process while the first handshake is pending.
      ctx.provide('opsKernel', undefined)
      const client = await startResident(ctx, file, process.cwd())
      ctx.set('opsKernel', client)
    },
  }
}

/** No lazy startup or fallback: the common owning activation must already be ready. */
export function requireResident(ctx: Context, selection: WorkerSelection = {}): ResidentClient {
  const client = ctx.get('opsKernel')
  if (!client) throw new Error('OPS kernel provider is missing or not ready. Mount residentKernel() in the common owning activation before integration().')
  if (selection.binaryPath !== undefined && identity(selection.binaryPath) !== identity(client.file)) {
    throw new Error('Conflicting OPS kernel binaryPath selection; this consumer must use its owning provider worker.')
  }
  if (!client.available) throw new Error('OPS kernel is unavailable; explicitly reload its owning plugin before running more file requests.')
  return client
}
