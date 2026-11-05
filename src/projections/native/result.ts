/** Native page/release adapter over the same result kernel bridge used by PTC. */
import path from 'node:path'
import type { ToolDefinition } from '../../adapter/dsh/types.js'
import { capability } from '../../capabilities/registry.js'
import { publicToolName } from '../../policy.js'
import { PARAMETERS, OUTPUT } from '../../capabilities/ptc.js'
import { invoke, failure } from '../../execution/jobs.js'
import { renderNative } from './render.js'
import { presentationMeta } from '../../kernel/presentation-outcome.js'
import { resolveSessionDirectory } from '../../adapter/dsh/working-directory.js'
export function resultDefinition(execute: ToolDefinition['execute']): ToolDefinition {
  const entry = capability('result')
  if (!entry || !('nativeProjection' in entry) || !entry.nativeProjection) throw new Error('Native result projection is missing')
  return { name: publicToolName(entry.rawName), description: entry.nativeProjection.description,
    parameters: PARAMETERS.result, execute,
    output: { schema: OUTPUT, render: (args, value) => [{ type: 'text', text: renderNative('result', args, value) }], presentationMeta } }
}
type Execution = Parameters<ToolDefinition['execute']>[1]
export async function invokeResult(ctx: Parameters<typeof invoke>[0], file: string, args: unknown,
  exec: Execution, signal: AbortSignal, config: Parameters<typeof invoke>[6], allowPut: () => Promise<boolean> = async () => false): Promise<unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return failure('INVALID_ARGUMENT', 'Expected page/release arguments.')
  const input: Record<string, unknown> = { ...args }
  for (const [key, value] of Object.entries(input)) {
    if (input.action !== 'put' && key !== 'id' && key !== 'action' && (value === null || value === undefined
      || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0))) delete input[key]
  }
  const putting = input.action === 'put'
  if (putting && !await allowPut()) return failure('PUBLICATION_DENIED', 'Result put requires a live run_code parent and current PTC admission; no cache was written.')
  const allowed = new Set(['action', 'root', 'id', 'offset', 'limit', 'maxBytes', 'fields', 'equals', ...(putting ? ['items', 'ttlMs'] : [])])
  const unknown = Object.keys(input).find(key => !allowed.has(key))
  if (unknown) return failure('INVALID_ARGUMENT', 'Unknown result argument: ' + unknown)
  if (!putting && (!['page', 'release'].includes(String(input.action)) || typeof input.id !== 'string' || !input.id.startsWith('ref://'))) {
    return failure('INVALID_ARGUMENT', 'Result accepts owned ref:// page/release, or PTC put only.')
  }
  let root = input.root
  if (root === undefined) {
    try { root = (await resolveSessionDirectory(ctx, exec.agent, signal)).cwd }
    catch { return failure('EXECUTOR_UNAVAILABLE', 'The authoritative session cwd is unavailable; no reference action was executed.') }
  }
  if (typeof root !== 'string' || !path.isAbsolute(root)) return failure('INVALID_ARGUMENT', 'An absolute reference root or authoritative session cwd is required.')
  return invoke(ctx, file, 'result', { ...input, root }, exec, signal, config)
}
