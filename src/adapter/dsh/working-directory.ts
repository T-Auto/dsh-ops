/** Resolve execution directories through the DSH 0.2.2 live directory service. */
import path from 'node:path'
import type { Agent } from './types.js'

type Host = { get(name: never): unknown }
interface WorkingDirectory {
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
  get(session: Agent['session']): string
}
export interface DirectoryBasis { cwd: string; source: 'workingDirectory' }

function service(ctx: Host): WorkingDirectory {
  const value = ctx.get('workingDirectory' as never)
  if (value === undefined || value === null) {
    throw new Error('EXECUTOR_UNAVAILABLE: the DSH workingDirectory service is required.')
  }
  return value as WorkingDirectory
}
function absolute(cwd: unknown): string {
  if (typeof cwd !== 'string' || cwd.includes('\0') || !path.isAbsolute(cwd)) {
    throw new Error('EXECUTOR_UNAVAILABLE: an authoritative absolute session cwd is required.')
  }
  return cwd
}
/** Snapshot once per call. An installed but failing service never falls back to stale state. */
export async function resolveSessionDirectory(ctx: Host, agent: Agent | undefined, signal?: AbortSignal): Promise<DirectoryBasis> {
  signal?.throwIfAborted()
  if (!agent) throw new Error('EXECUTOR_UNAVAILABLE: an authoritative agent is required.')
  const live = service(ctx)
  const cwd = absolute(await live.ensure(agent, signal))
  signal?.throwIfAborted()
  return { cwd, source: 'workingDirectory' }
}
/** Discovery cache identity is synchronous; execution still validates with ensure(). */
export function currentSessionDirectory(ctx: Host, agent: Agent): string {
  const live = service(ctx)
  return absolute(live.get(agent.session))
}
