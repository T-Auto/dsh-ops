/** Stored rows remain distinct from source-operation completeness and item JSON chunks. */
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string => JSON.stringify(value) ?? 'null'
const bytes = (value: string): number => Buffer.byteLength(JSON.stringify([{ type: 'text', text: value }]))
export function renderResult(args: Record<string, unknown>, value: Record<string, unknown>): string {
  const id = value.id ?? (object(value.reference) ? value.reference.refId : undefined) ?? args.id
  if (value.status === 'released') return 'Released cached reference ' + text(id) + '. No business files were changed.'
  const reference = object(value.reference) ? value.reference : {}
  const source = object(value.source) ? value.source : {}
  const header = ['=== RESULT: ' + text(id) + ' ===',
    '[Notice: root=' + text(source.root ?? value.root ?? args.root ?? '(current session cwd)') + '; sourceTotal=' + text(value.sourceTotal)
      + '; filteredTotal=' + text(value.total) + '; contentHash=' + text(value.contentHash) + '.]',
    '[Notice: producer=' + text(reference.producerTool) + '; createdAt=' + text(reference.createdAt)
      + '; ttlMs=' + text(reference.ttlMs) + '; totalBytes=' + text(reference.totalBytes) + '.]']
  if (object(value.source)) header.push('[Source execution: ' + text(value.source) + ']')
  if (source.itemEncoding === 'tagged-json-v1') header.push('[Notice: Stored rows encode items or item JSON chunks. Join chunks for the same index in byteOffset order before parsing; a final chunk alone is not a complete item.]')
  const items: unknown[] = Array.isArray(value.items) ? value.items : []
  let body = header.join('\n'), displayed = 0
  for (const item of items) {
    const next = body + '\n' + text(item)
    // Reserve the final paging notice and keep every displayed stored row intact.
    if (bytes(next) > 60 * 1024) break
    body = next; displayed++
  }
  const displayComplete = displayed === items.length
  const notice = '[Notice: displayedRows=' + displayed + '; displayComplete=' + displayComplete
    + '; pageComplete=' + text(value.complete) + '; omitted=' + text(value.omitted)
    + (displayComplete ? '; nextOffset=' + text(value.nextOffset) : '; repeatOffset=' + text(args.offset ?? 0))
    + '. Page completeness covers stored rows only; source execution and capture completeness are independent.]'
  return body + '\n' + notice + (!displayComplete
    ? '\nNext: Repeat the same offset with a smaller limit/maxBytes or fewer fields. Do not advance past undisplayed rows.'
    : typeof value.nextAction === 'string' ? '\nNext: ' + value.nextAction : '')
}
