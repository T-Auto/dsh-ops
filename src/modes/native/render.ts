import { Buffer } from 'node:buffer'
import { FILE_MUTATIONS } from '../../capabilities/registry.js'
import { compactRanges } from './ranges.js'
import { encodeSourceLine } from './line-encoding.js'
import { renderDocument } from './documents.js'
import { isDocumentTool } from '../../capabilities/documents.js'
import { renderResult } from './result.js'
import { errorPolicy } from '../../kernel/errors.js'
import type { EffectState } from '../../kernel/outcome.js'

export const NATIVE_OUTPUT_BYTES = 64 * 1024

type Row = Record<string, unknown>
const record = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(record) : []
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const label = (value: unknown): string => String(value ?? '').replace(/[\r\n\t\x00-\x1f\x7f]/g, char => JSON.stringify(char).slice(1, -1))
// Keep physical line labels intact without confusing literal backslashes with escapes.
const contentLine = (value: unknown): string => encodeSourceLine(String(value ?? ''))
const field = (value: unknown): string => typeof value === 'string' ? label(value) : JSON.stringify(value)
const encodedBytes = (text: string): number => Buffer.byteLength(JSON.stringify([{ type: 'text', text }]), 'utf8')

/** Bound the final escaped content blocks, not the unescaped source text. */
export function capNativeText(text: string, maxBytes = NATIVE_OUTPUT_BYTES, recovery = 'Re-read the original range with a smaller limit; do not advance past undisplayed content.'): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > NATIVE_OUTPUT_BYTES) {
    throw new RangeError('Native output budget must be 512-65536 bytes')
  }
  if (encodedBytes(text) <= maxBytes) return text
  const notice = `\n[Notice: Display incomplete. TruncatedBy: output-budget. ${recovery}]`
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encodedBytes(text.slice(0, middle) + notice) <= maxBytes) low = middle
    else high = middle - 1
  }
  // Do not emit half of an astral Unicode character when the budget lands inside a pair.
  if (low > 0 && /[\uD800-\uDBFF]/u.test(text[low - 1]!)) low--
  return text.slice(0, low) + notice
}

function facts(value: Row, keys: string[]): string {
  return keys.filter(key => value[key] !== undefined).map(key => `${key}=${field(value[key])}`).join('; ')
}
function notices(value: Row, displayed: number): string[] {
  const incomplete = value.complete === false || value.truncated === true || value.status === 'partial'
  const details = [
    `${displayed} item${displayed === 1 ? '' : 's'} displayed`,
    `complete=${value.complete === undefined ? (incomplete ? 'false' : 'unspecified') : value.complete}`,
    `TruncatedBy: ${value.truncatedBy ?? (incomplete ? 'worker-limit' : 'none')}`,
    facts(value, ['nextOffset', 'nextIndex', 'pending', 'omitted', 'total', 'matched', 'files', 'matches', 'skippedFiles', 'skippedPaths', 'failed', 'continuation']),
  ].filter(Boolean)
  const output = [`[Notice: ${details.join('; ')}.]`]
  for (const item of rows(value.items)) {
    if (item.truncatedInLine === true) {
      output.push(`[Notice: Line ${label(item.line)} in ${label(item.path)} is incomplete; ${facts(item, ['bytesTotal', 'bytesOmitted'])}. Use a smaller or binary range; the next line offset does not recover its missing suffix.]`)
    }
    if (item.metadataWarnings !== undefined) output.push(`[Notice: ${label(item.path)} metadataWarnings=${field(item.metadataWarnings)}.]`)
  }
  return output
}

function inspect(args: Row, value: Row): string[] {
  const items = rows(value.items)
  const output: string[] = []
  const groups = new Map<string, Row[]>()
  for (const item of items) {
    const path = typeof item.path === 'string' ? item.path : String(args.path ?? value.path ?? '(path unavailable)')
    const group = groups.get(path) ?? []
    group.push(item)
    groups.set(path, group)
  }
  if (groups.size === 0) groups.set(String(args.path ?? value.path ?? '(path unavailable)'), [])
  for (const [path, group] of groups) {
    const hex = group.some(item => item.view === 'hex') || args.view === 'hex'
    const numbers = group.map(item => item.line).filter(count)
    const span = numbers.length ? `${numbers[0]}-${numbers.at(-1)}` : 'none'
    const total = count(value.lineCount) ? value.lineCount : count(value.total) ? value.total : '?'
    output.push(`=== FILE: ${label(path)} (${hex ? 'Hex' : `Lines ${span} of ${total}`}) ===`)
    const observed = facts(value, ['revision', 'bytes', 'lineCount'])
    if (observed) output.push(`[Notice: ${observed}.]`)
    for (const item of group) {
      if (hex) output.push(`${label(item.offset ?? '?')} | ${contentLine(item.text)}`)
      else output.push(`${count(item.line) ? item.line : '?'} | ${contentLine(item.text)}`)
    }
    if (!group.length) output.push(value.lineCount === 0 ? '(empty file)' : '(no lines in this range)')
  }
  output.push(...notices(value, items.length))
  return output
}

function failure(value: Row): string[] {
  const error = record(value.error) ? value.error : {}
  const code = typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR'
  const effect = ['none', 'applied', 'partial', 'unknown'].includes(String(error.effectState))
    ? error.effectState as EffectState : 'unknown'
  const advice = errorPolicy(code, effect)
  const status = value.status === 'rejected' && effect === 'none' ? 'rejected' : advice.status
  const output = [`${status}: ${label(code)}`,
    `[Notice: effectState=${effect}; retry=${advice.retry}; ${facts(error, ['phase', 'reason'])}.]`]
  if (typeof error.nextAction === 'string') output.push(`Next: ${label(error.nextAction)}`)
  if (error.message) output.push(label(error.message))
  if (rows(value.items).length) output.push('Partial receipts:', ...receiptItems(value))
  return output
}

const mutations = new Set<string>(FILE_MUTATIONS)
function receiptItems(value: Row): string[] {
  return rows(value.items).map(item => `${label(item.path ?? '(path unavailable)')}: ${facts(item, [
    'removed', 'changed', 'revision', 'revisionBefore', 'revisionAfter', 'bytes', 'bytesBefore', 'bytesAfter',
    'lineCountBefore', 'lineCount', 'replacements', 'metadata', 'metadataWarnings',
  ])}`)
}
function receipts(tool: string, value: Row): string[] {
  const output = [`${label(tool)}: ${value.dryRun === true ? 'preview' : label(value.status ?? 'unknown')}; ${facts(value, ['changed', 'matched', 'skipped', 'failed', 'revisionBefore'])}`,
    ...receiptItems(value)]
  output.push(...notices(value, rows(value.items).length))
  return output
}
function stat(args: Row, value: Row): string[] {
  return [`${label(value.path ?? args.path ?? '(path unavailable)')}: ${facts(value, [
    'exists', 'revision', 'bytes', 'lineCount', 'readonly', 'modifiedMs', 'mode',
  ])}`, ...notices(value, rows(value.items).length)]
}
function diff(args: Row, value: Row): string[] {
  const output = [`=== DIFF: ${label(args.path ?? value.path ?? '(path unavailable)')} ===`]
  for (const key of ['before', 'after', 'hunk']) {
    if (record(value[key])) output.push(`[Notice: ${key}: ${facts(value[key], Object.keys(value[key]))}.]`)
  }
  for (const item of rows(value.items)) {
    const sign = item.kind === 'remove' ? '-' : item.kind === 'add' ? '+' : '?'
    output.push(`${sign} ${label(item.line ?? '?')} | ${contentLine(String(item.text ?? '').replace(/\r?\n$/, ''))}`)
  }
  output.push(...notices(value, rows(value.items).length))
  return output
}

function listing(tool: string, args: Row, value: Row): string[] {
  const output: string[] = []
  if (value.scanComplete !== undefined) output.push(`[Notice: ${facts(value, ['scanComplete', 'pageComplete', 'scannedFiles', 'skippedFiles', 'skipReasons', 'matchedObserved', 'matchedTotal'])}.]`)
  if (typeof value.nextAction === 'string') output.push(`Next: ${label(value.nextAction)}`)
  const items = Array.isArray(value.items) ? value.items : []
  for (const item of items) {
    if (typeof item === 'string') { output.push(label(item)); continue }
    if (!record(item)) continue
    const path = label(item.path ?? '(path unavailable)')
    if (tool === 'grep' && typeof item.text === 'string') {
      const numbered = count(item.line) && item.line > 0
      const start = numbered ? Math.max(1, Number(item.line) - (count(args.beforeContext) ? args.beforeContext : 0)) : 0
      if (numbered && start !== item.line) output.push(`[Notice: Match starts at ${path}:${item.line}; context follows.]`)
      for (const [index, line] of item.text.split('\n').entries()) output.push(`${path}${numbered ? `:${start + index}` : ''} | ${contentLine(line)}`)
    } else {
      const rest = { ...item }
      delete rest.path
      output.push(`${path}${Object.keys(rest).length ? `: ${facts(rest, Object.keys(rest))}` : ''}`)
    }
  }
  const summary = facts(value, ['exists', 'revision', 'bytes', 'lineCount', 'metadata', 'revisionBefore', 'revisionAfter', 'changed', 'dryRun'])
  if (summary) output.unshift(summary)
  output.push(...notices(value, items.length))
  return output
}

/** Native presentation is independent of the canonical execution value returned to PTC. */
export function renderNative(tool: string, args: unknown, result: unknown): string {
  if (!record(result)) return capNativeText('[Notice: No structured result was returned.]')
  const input = record(args) ? args : {}
  let lines: string[]
  if (isDocumentTool(tool)) lines = renderDocument(tool, input, result)
  else if (record(result.error) || ['error', 'rejected', 'conflict', 'unknown', 'failed'].includes(String(result.status))) lines = failure(result)
  else if (tool === 'result') return capNativeText(renderResult(input, result), NATIVE_OUTPUT_BYTES, 'Repeat the same offset with smaller limit/maxBytes; do not advance past undisplayed rows.')
  else if (tool === 'read_files') lines = compactRanges(input, result) ?? readMany(result)
  else if (tool === 'inspect_local_file') lines = inspect(input, result)
  else if (mutations.has(tool)) lines = receipts(tool, result)
  else if (tool === 'stat') lines = stat(input, result)
  else if (tool === 'diff') lines = diff(input, result)
  else lines = listing(tool, input, result)
  // Keep the locator ahead of potentially clipped model text so its omitted suffix stays recoverable.
  if (record(result.reference)) lines.unshift('[Stored reference: ' + facts(result.reference, ['refId', 'producerTool', 'totalItems', 'totalBytes'])
    + '; referenceRoot=' + field(result.referenceRoot) + '. Page with ops_result; inspect source capture/coverage facts before claiming completeness.]')
  if (record(result.storageError)) lines.unshift('[Storage: ' + facts(result.storageError, ['code', 'message', 'effectState']) + '. Cache effects are separate from business effects.]')
  return capNativeText(lines.join('\n'), NATIVE_OUTPUT_BYTES, mutations.has(tool)
    ? 'Inspect current state before another mutation; do not repeat the write to recover undisplayed receipts.'
    : isDocumentTool(tool) ? 'Use the stored reference when available; otherwise repeat this range with a smaller limit or use a dedicated reader for a large record. Do not advance past undisplayed content.' : undefined)
}

function readMany(value: Row): string[] {
  const output: string[] = []
  for (const item of rows(value.items)) {
    if (record(item.error)) output.push(`=== FILE: ${label(item.path)} ===`, ...failure(item))
    else output.push(...inspect(item, item))
  }
  output.push(...notices(value, rows(value.items).length))
  return output
}
