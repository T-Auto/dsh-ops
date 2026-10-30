/** Native document rendering keeps safe parsed prefixes beside non-exhaustive coverage facts. */
type Row = Record<string, unknown>
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const show = (value: unknown): string => (JSON.stringify(value) ?? 'null').replace(/[\u0085\u2028\u2029]/gu, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
const facts = (value: Row, keys: string[]): string => keys.filter(key => value[key] !== undefined).map(key => key + '=' + show(value[key])).join('; ')
export function renderDocument(tool: string, args: Row, value: Row): string[] {
  const items = Array.isArray(value.items) ? value.items.filter(object) : []
  const lines = ['=== DOCUMENT: ' + show(value.path ?? args.path ?? '(path unavailable)') + ' ===',
    '[Observation: ' + facts(value, ['status', 'format', 'encoding', 'header', 'bytes', 'bytesRead', 'decodedBytes', 'processedBytes', 'revision', 'columnCount']) + '.]',
    '[Coverage: ' + facts(value, ['scanComplete', 'pageComplete', 'complete', 'rowsObserved', 'blocksObserved', 'pagesObserved', 'skipped', 'total', 'omitted', 'nextOffset', 'truncatedBy']) + '.]']
  if (typeof value.scope === 'string') lines.push('[Scope: ' + show(value.scope) + '; excludedContent=' + show(value.excludedContent) + '. Completeness applies only to this scope.]')
  if (Array.isArray(value.columns)) lines.push('Columns: ' + show(value.columns))
  if (object(value.error)) lines.push('Error: ' + facts(value.error, ['code', 'message', 'effectState', 'nextAction']))
  if (value.scanComplete === false || object(value.error)) lines.push('[Notice: This observation is not exhaustive. Only preceding complete records are shown; page offsets do not recover a physical scan gap.]')
  for (const item of items) lines.push(tool === 'read_table'
    ? 'Row ' + show(item.row) + ' (LF lines ' + show(item.lineStart) + '-' + show(item.lineEnd) + ') | ' + show(item.cells)
    : tool === 'read_pdf' ? 'Page ' + show(item.page) + ' [runs=' + (Array.isArray(item.runs) ? item.runs.length : 'unknown') + '] | ' + show(item.text)
    : 'Paragraph ' + show(item.block) + ' [' + facts(item, ['table', 'row', 'cell']) + '] | ' + show(item.text))
  if (!items.length) lines.push('(no records in this displayed range)')
  lines.push('[Notice: displayedRecords=' + items.length + '. Scan, requested range, and displayed content have separate completeness.]')
  if (typeof value.nextAction === 'string') lines.push('Next: ' + show(value.nextAction))
  return lines
}
