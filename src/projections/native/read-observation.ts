import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '../../adapter/dsh/types.js'
import { publicToolName } from '../../policy.js'

export interface ReadObservation {
  readonly body: string
  readonly key: string
}
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export function exactJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(exactJson).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${exactJson(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
/** Each file needs its own fresh identity and revision; one successful sibling proves nothing. */
function fileEvidence(value: Record<string, unknown>): unknown[] | undefined {
  if (value.status !== 'completed' || value.error || value.reference || value.storageError
    || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0
    || !Array.isArray(value.items) || !value.items.length) return
  const items = value.items
  if (!items.every(item => record(item) && typeof item.path === 'string' && isAbsolute(item.path)
    && Number.isSafeInteger(item.line) && Number(item.line) > 0 && typeof item.text === 'string'
    && item.truncatedInLine !== true && item.view !== 'hex')) return
  const first = items[0]
  if (!record(first) || typeof first.path !== 'string' || !items.every(item => record(item) && item.path === first.path)) return
  const stat = lstatSync(first.path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.ino === 0n || stat.size !== BigInt(Number(value.bytes))) return
  return [first.path, value.revision, items.map(item => record(item) ? item.line : 0),
    stat.dev.toString(), stat.ino.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()]
}
/** A fresh successful worker read is required before any metadata is observed. */
export function observeRead(tool: ToolDefinition, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ReadObservation | undefined {
  if (exec.parent || !exec.agent || result.isError || exec.signal.aborted || !record(result.value)) return
  const value = result.value
  if (value.error || value.reference || value.storageError || result.content.length !== 1) return
  const block = result.content[0]
  if (block?.type !== 'text' || block.text.includes('TruncatedBy: output-budget')) return
  // Only the unmodified trusted Native renderer is eligible. Post-policy content wins.
  if (exactJson(tool.output.render(exec.arguments, result.value)) !== exactJson(result.content)) return
  let observations: unknown[]
  if (exec.name === publicToolName('read_files')) {
    if (!['completed', 'partial'].includes(String(value.status)) || value.pending !== 0 || value.failed !== 0
      || !Array.isArray(value.items) || !value.items.length || value.nextIndex !== value.items.length
      || !record(exec.arguments) || !Array.isArray(exec.arguments.files) || exec.arguments.files.length !== value.items.length) return
    const files = value.items.map(item => record(item) ? fileEvidence(item) : undefined)
    if (files.some(item => item === undefined)) return
    observations = files
  } else {
    const file = fileEvidence(value)
    if (!file) return
    observations = [file]
  }
  return {
    body: block.text,
    key: exactJson([exec.name, exec.arguments, observations]),
  }
}
export function unchangedContent(body: string, callId: string, messageId: string): string | undefined {
  const kept = body.split('\n').filter(line => !/^\d+(?: \| |\|)/.test(line))
    .map(line => line.replace(/^(\[Notice: \d+ items?) displayed;/, '$1 revalidated;')
      .replace(/requested ranges returned\./, 'requested ranges revalidated.'))
  const notice = `[Notice: Unchanged file range; body already present in the current model context in tool call ${JSON.stringify(callId)} / message ${JSON.stringify(messageId)}. Fresh read revalidated the revision above.]`
  const compact = [...kept, notice].join('\n')
  return Buffer.byteLength(compact, 'utf8') < Buffer.byteLength(body, 'utf8') ? compact : undefined
}
