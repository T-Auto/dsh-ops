/** Executable next-step recommendations; they describe calls, never replay authority. */
import type { RetryPolicy } from '../../kernel/outcome.js'
import { publicToolName } from '../../policy.js'
import { decodeContinuation } from './continuation.js'
import type { CanonicalData } from './outcome.js'

/** What the calling step can execute now, resolved by the dispatching runtime. */
export interface NextStepSurface {
  /** Public tool names the calling step admits. */
  readonly callable: ReadonlySet<string>
  /** True when the calling scope's sandbox policy forbids every mutation. */
  readonly readOnly: boolean
}

const record = (value: unknown): CanonicalData | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as CanonicalData : undefined
const call = (rawName: string, args: CanonicalData): string => publicToolName(rawName) + ' ' + JSON.stringify(args)
const admitted = (surface: NextStepSurface | undefined, rawName: string): boolean =>
  surface !== undefined && surface.callable.has(publicToolName(rawName))

/** Render the safe continuation token as an explicit, parameter-legal call. */
export function continueReading(continuation: string): string | undefined {
  const decoded = decodeContinuation(continuation)
  return decoded !== undefined
    ? `Continue this read with ${call(decoded.tool, decoded.args)}; a page that reports complete=true is the last one.`
    : undefined
}

function directoryStep(path: string, surface: NextStepSurface | undefined): string {
  if (admitted(surface, 'glob')) {
    return `The path is a directory, not a file. List its immediate entries with ${call('glob', { path, pattern: ['*'] })}, then read one concrete file path.`
  }
  return 'The path is a directory, not a file, and no directory-listing API is callable in this step; supply one concrete file path.'
}

function encodingStep(tool: string, path: string, surface: NextStepSurface | undefined): string {
  // The calling tool just executed, so the same tool stays callable; a cross-tool
  // recommendation additionally requires an admitted surface entry.
  if (tool === 'inspect_local_file' || admitted(surface, 'inspect_local_file')) {
    return `The bytes are not valid UTF-8. Read a hex window with ${call('inspect_local_file', { path, view: 'hex' })}.`
  }
  return `File ${JSON.stringify(path)} is not valid UTF-8; no hex-capable reader is callable in this step.`
}

function revisionStep(path: string, surface: NextStepSurface | undefined): string {
  const reader = admitted(surface, 'stat') ? 'stat' : admitted(surface, 'inspect_local_file') ? 'inspect_local_file' : undefined
  const resubmit = surface?.readOnly === true ? '' : ', then re-submit with that expectedRevision'
  return reader !== undefined
    ? `The file changed since the revision you observed; nothing was applied. Read the current revision with ${call(reader, { path })}${resubmit}.`
    : `The file changed since the revision you observed; nothing was applied. Read the current revision of ${JSON.stringify(path)} with a callable read API${resubmit}.`
}

/** The generic guard for argument-rejected calls that name no specific recovery. */
export const CHANGE_FIRST = 'Change the request arguments as the error message describes; an identical request fails identically.'

/** Recommend the concrete call a recoverable failure admits; other guidance stays with the worker. */
export function nextStepFor(tool: string, rawArgs: unknown, error: { code: string, message: string, retry: RetryPolicy },
  data: CanonicalData, surface: NextStepSurface | undefined): string | undefined {
  const args = record(rawArgs) ?? {}
  const path = typeof args.path === 'string' ? args.path : undefined
  if ((error.code === 'INVALID_ARGUMENT' || error.code === 'IS_DIRECTORY') && error.message.includes('is a directory')) {
    return path !== undefined ? directoryStep(path, surface) : undefined
  }
  if (error.code === 'ERR_INVALID_ENCODING' && path !== undefined) return encodingStep(tool, path, surface)
  if (error.code === 'RESULT_PARTIAL' && Array.isArray(data.items)) {
    const failed = data.items.map(record).find(item => record(item?.error)?.code === 'ERR_INVALID_ENCODING')
    const failedPath = failed !== undefined && typeof failed.path === 'string' ? failed.path : undefined
    if (failedPath !== undefined) return encodingStep(tool, failedPath, surface)
  }
  if (error.code === 'REVISION_CONFLICT' && path !== undefined) return revisionStep(path, surface)
  return undefined
}
