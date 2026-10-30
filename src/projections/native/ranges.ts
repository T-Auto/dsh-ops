import path from 'node:path'
import { encodeSourceLine } from './line-encoding.js'
type Row = Record<string, unknown>
const record = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const quoted = (value: string): string => JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
interface Range { path: string; revision: string; total: number; next: number; complete: boolean; lines: { line: number; text: string }[] }
/** Compact only a fully evidenced requested range. Physical gaps keep the general diagnostic renderer. */
function range(input: unknown, value: unknown): Range | undefined {
  if (!record(input) || !record(value) || value.status !== 'completed' || value.error || value.reference || value.storageError
    || value.truncated !== false || value.truncatedBy !== undefined || value.nextAction !== undefined
    || value.metadataWarnings !== undefined || value.failed !== 0 || !integer(value.lineCount)
    || !integer(value.nextOffset) || typeof value.path !== 'string' || !path.isAbsolute(value.path)
    || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision) || !Array.isArray(value.items)) return
  const offset = input.offset ?? 1, limit = input.limit ?? 200
  if (!integer(offset) || offset < 1 || !integer(limit) || limit < 1) return
  const expected = Math.max(0, Math.min(limit, value.lineCount - offset + 1))
  if (value.items.length !== expected || value.nextOffset !== offset + expected
    || value.complete !== (offset - 1 + expected >= value.lineCount)) return
  const lines: Range['lines'] = []
  for (const [index, item] of value.items.entries()) {
    if (!record(item) || item.line !== offset + index || item.path !== value.path || typeof item.text !== 'string'
      || item.view === 'hex' || item.truncatedInLine === true || item.metadataWarnings !== undefined) return
    lines.push({ line: offset + index, text: item.text })
  }
  return { path: value.path, revision: value.revision, total: value.lineCount, next: value.nextOffset, complete: value.complete, lines }
}
/** Canonical metadata remains unchanged; Native needs one revision and one clear continuation per file. */
export function compactRanges(input: Row, value: Row): string[] | undefined {
  if (!Array.isArray(input.files) || !Array.isArray(value.items) || !input.files.length || input.files.length !== value.items.length
    || value.reference || value.storageError || value.truncated !== false || value.failed !== 0 || value.pending !== 0
    || value.total !== input.files.length || value.nextIndex !== input.files.length) return
  const observed: Range[] = []
  for (const [index, item] of value.items.entries()) {
    const current = range(input.files[index], item)
    if (!current) return
    observed.push(current)
  }
  const parent = path.dirname(observed[0]!.path)
  const base = observed.length > 1 && observed.every(item => path.dirname(item.path) === parent) ? parent : undefined
  const output = base ? [`[Base: ${quoted(base)}]`] : []
  for (const item of observed) {
    const span = item.lines.length ? `${item.lines[0]!.line}-${item.lines.at(-1)!.line}` : 'none'
    output.push(`=== FILE: ${quoted(base ? path.basename(item.path) : item.path)} (Lines ${span} of ${item.total}) ===`)
    for (const line of item.lines) output.push(`${line.line}|${encodeSourceLine(line.text)}`)
    if (!item.lines.length) output.push(item.total === 0 ? '(empty file)' : '(no lines in this range)')
    output.push(`[revision=${item.revision}; ${item.complete ? 'end of file; complete=true' : `more lines; nextOffset=${item.next}`}]`)
  }
  output.push(`[Notice: ${observed.length}/${input.files.length} requested ranges returned.]`)
  return output
}
