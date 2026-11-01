/** Bounded worker transport shared by fixed-file and confined execution policies. */
import type { SubprocessRuntime } from '../adapter/dsh/types.js'
import { record } from './boundary.js'
export interface WorkerExchange {
  exitCode: number | null
  interrupted: boolean
  readers: boolean
  lossy: boolean
  stderr: string
  value?: Record<string, unknown>
  invalid?: 'json' | 'shape'
}
export async function exchange(subprocess: SubprocessRuntime, spec: Parameters<SubprocessRuntime['spawn']>[0], started?: () => void): Promise<WorkerExchange> {
  const handle = subprocess.spawn(spec)
  started?.()
  const outcome = await handle.done
  const base = { exitCode: outcome.exitCode, interrupted: Boolean(spec.signal?.aborted || outcome.signal) }
  if (!handle.collected.stdout || !handle.collected.stderr) return { ...base, readers: false, lossy: false, stderr: '' }
  const stdout = handle.collected.stdout.readFrom(0), stderr = handle.collected.stderr.readFrom(0)
  const result = { ...base, readers: true, lossy: Boolean(stdout.lossy), stderr: stderr.text }
  if (base.interrupted || stdout.lossy || outcome.exitCode !== 0) return result
  let value: unknown
  try { value = JSON.parse(stdout.text) } catch { return { ...result, invalid: 'json' } }
  return record(value) ? { ...result, value } : { ...result, invalid: 'shape' }
}
