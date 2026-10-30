// Adapted from @deepseek-ai/dsh-tool-bash 0.2.0-rc.2 (MIT). See licenses/deepseek-harness/LICENSE.
/** DSH 0.2.0-rc.2 shell DTO and rendering, with explicit OPS compatibility fields. */
import type { JsonSchemaNode, JsonSchemaType } from '../adapter/dsh/types.js'
import type { ShellResult, HostForeground, HostBashResult } from './types.js'
import { bashFailure } from './failure.js'
import { BASH_OUTPUT_SCHEMA, renderBashResult, withBashStatus } from './tool.js'

const nullable = (type: JsonSchemaType): JsonSchemaNode => ({ oneOf: [{ type }, { type: 'null' }] })
const directoryProperties = { resolvedFrom: { type: 'string' }, cwdSource: { type: 'string' } } as const
export const HOST_BASH_OUTPUT_SCHEMA: JsonSchemaNode = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'jobId', 'label'], properties: {
      ...directoryProperties, kind: { type: 'string', const: 'background' }, jobId: { type: 'string' }, label: { type: 'string' },
    } },
    { type: 'object', additionalProperties: false, required: ['kind', 'jobId', 'label', 'timeoutMs', 'output'], properties: {
      ...directoryProperties, kind: { type: 'string', const: 'promoted' }, jobId: { type: 'string' }, label: { type: 'string' }, timeoutMs: { type: 'number' }, output: { type: 'string' },
    } },
    { ...BASH_OUTPUT_SCHEMA, required: [...(BASH_OUTPUT_SCHEMA.required ?? []), 'kind', 'exitCode', 'signal', 'aborted'], properties: {
      ...BASH_OUTPUT_SCHEMA.properties, ...directoryProperties,
      failure: { type: 'object', additionalProperties: false, required: ['code', 'message', 'effectState', 'retry'], properties: {
        code: { type: 'string' }, message: { type: 'string' }, effectState: { type: 'string', enum: ['none', 'unknown'] },
        retry: { type: 'string', enum: ['never', 'after-input-change'] }, nextAction: { type: 'string' },
      } },
      kind: { type: 'string', const: 'foreground' }, exitCode: nullable('integer'), signal: nullable('string'),
      aborted: { type: 'boolean' }, stopped: { type: 'string' },
    } },
  ],
}

export function hostForeground(value: ShellResult, effects: 'none' | 'unknown' = 'unknown'): HostForeground {
  const settled = withBashStatus(value)
  return { ...settled, ...(settled.status === 'failed' ? { failure: bashFailure(value, effects) } : {}), kind: 'foreground', exitCode: value.exitCode ?? null,
    signal: value.signal ?? null, aborted: value.cancelled === true }
}

export function hostFailure(message: string, timeoutMs = 120_000, effects: 'none' | 'unknown' = 'none', cancelled = false) {
  return hostForeground({ error: message, timedOut: false, timeoutMs, ...(cancelled ? { cancelled: true } : {}),
    stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }, effects)
}

export function renderHostBash(value: HostBashResult): string {
  const directory = value.resolvedFrom === undefined ? '' : `[cwd: resolvedFrom=${JSON.stringify(value.resolvedFrom)}; cwdSource=${JSON.stringify(value.cwdSource)}]\n`
  if (value.kind === 'background') return directory + `started background job ${value.jobId} (${JSON.stringify(value.label)})`
  if (value.kind === 'promoted') return directory + `${value.output || '(no output)'}\n[still running after ${value.timeoutMs}ms; moved to background job ${value.jobId} (${JSON.stringify(value.label)})]\nUse job_output to collect output and job_kill to stop the command.`
  const { exitCode, signal, ...rest } = value
  const body = renderBashResult(rest)
  const markers = []
  if (value.failure) markers.push(`[${value.failure.code}; effects: ${value.failure.effectState}; retry: ${value.failure.retry}] ${value.failure.nextAction ?? ''}`)
  if (value.sandbox?.denied) markers.push(`[sandbox: file access denied under ${value.sandbox.mode} mode]`)
  if (value.stopped) markers.push(`[stopped: ${value.stopped}]`)
  if (signal !== null) markers.push(`[killed by signal: ${signal}]`)
  if (exitCode !== null) markers.push(`[exit code: ${exitCode}]`)
  return directory + [body, ...markers].join('\n')
}
