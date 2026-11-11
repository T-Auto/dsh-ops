import type { OpsSdk, Outcome, StorageReference } from 'dsh-ops/ptc-sdk'

declare const tools: OpsSdk
async function read() {
  const result = await tools.ops_read_files({ files: [{ path: 'a.ts', offset: 1, limit: 20 }] })
  // @ts-expect-error A result must be narrowed before accessing failure details.
  void result.error
  if (result.status === 'completed') {
    const text: string | undefined = result.data.items?.[0]?.items?.[0]?.text
    // @ts-expect-error Canonical text is not a number.
    const count: number = result.data.items?.[0]?.items?.[0]?.text
    return text
  }
  if (result.status === 'partial') {
    const complete: false = result.coverage.isComplete
    const next: string = result.continuation
    // @ts-expect-error Partial is an explicit continuation state, not a failure.
    void result.error
    return { complete, next }
  }
  const retry: 'never' | 'after-input-change' | 'after-state-change' | 'bounded-transient' = result.error.retry
  return { code: result.error.code, retry }
}
async function metadata() {
  const result = await tools.ops_stat({ path: 'a.ts' })
  if (result.status === 'completed') {
    const modified: number | null | undefined = result.data.modifiedMs
    return modified
  }
}
void tools.ops_inspect_local_file({ path: 'a.ts', view: 'hex' })
// @ts-expect-error Tool arguments preserve the original enum contract.
void tools.ops_inspect_local_file({ path: 'a.ts', view: 'pdf' })
// @ts-expect-error Multi-read requires a list of file ranges.
void tools.ops_read_files({ path: 'a.ts' })
// @ts-expect-error Editing requires the observed revision.
void tools.ops_edit_file({ path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] })
// @ts-expect-error Tool names are a finite catalogue, not an open arbitrary dictionary.
void tools.ops_unknown_tool({})
const completed: Outcome<StorageReference | undefined> = { status: 'completed', data: undefined }
void [read, metadata, completed]

async function loader() {
  const selected = await tools.ops_load_sdk({ tools: ['read_files', 'grep'] })
  if (selected.status !== 'completed') return 'error' in selected ? selected.error.code : 'partial'
  const names: string[] = selected.data.tools
  const next: true = selected.data.nextTurn
  // @ts-expect-error The loader returns its selection receipt, not a file-operation body.
  void selected.data.items
  // @ts-expect-error The loader returns no storage reference.
  void selected.data.reference
  return { names, next }
}
void loader

async function tables() {
  const result = await tools.ops_read_table({ path: 'rows.csv', header: false, encoding: 'utf-16le' })
  if (result.status === 'completed' || result.status === 'partial') {
    const cells: string[] | undefined = result.data.items?.[0]?.cells
    const rows: number | undefined = result.data.source?.rowsObserved
    // @ts-expect-error Cells preserve lexical text instead of guessing numbers.
    const numeric: number[] | undefined = result.data.items?.[0]?.cells
    return { cells, rows }
  }
  return result.data?.items?.[0]?.cells
}
// @ts-expect-error Encoding is a finite strict-decoding contract.
void tools.ops_read_table({ path: 'rows.csv', encoding: 'latin1' })
void tables

async function paragraphs() {
  const value = await tools.ops_read_docx({ path: 'body.docx', offset: 1, limit: 10 })
  if (value.status === 'completed' || value.status === 'partial') {
    const text: string | undefined = value.data.items?.[0]?.text
    const kind: 'paragraph' | undefined = value.data.items?.[0]?.type
    const scope: string | undefined = value.data.scope
    // @ts-expect-error Document paragraphs are not table cell arrays.
    void value.data.items?.[0]?.cells
    return { text, kind, scope }
  }
  return value.data?.items?.[0]?.text
}
// @ts-expect-error DOCX decoding comes from the package, not a caller-supplied encoding.
void tools.ops_read_docx({ path: 'body.docx', encoding: 'utf-8' })
void paragraphs

async function pdfPages() {
  const value = await tools.ops_read_pdf({ path: 'text.pdf', offset: 1, limit: 10 })
  if (value.status === 'completed' || value.status === 'partial') {
    const runs: string[] | undefined = value.data.items?.[0]?.runs
    const page: number | undefined = value.data.items?.[0]?.page
    const processed: number | undefined = value.data.source?.processedBytes
    // @ts-expect-error PDF pages have no DOCX paragraph block index.
    void value.data.items?.[0]?.block
    return { runs, page, processed }
  }
  return value.data?.items?.[0]?.text
}
// @ts-expect-error PDF encoding derives from supported fonts, not caller selection.
void tools.ops_read_pdf({ path: 'text.pdf', encoding: 'utf-8' })
void pdfPages

async function readThenEdit() {
  const read = await tools.ops_inspect_local_file({ path: 'a.ts' })
  if (read.status !== 'completed' || !read.data.revision) return read
  const row = read.data.items?.[0]
  if (!row?.text || row.truncatedInLine) return read
  return tools.ops_edit_file({ path: 'a.ts', expectedRevision: read.data.revision,
    edits: [{ oldText: row.text, newText: row.text.replace('old', 'new') }] })
}
void tools.ops_write_file({ path: 'new.ts', content: '', expectedRevision: 'absent' })
// @ts-expect-error Creation still requires the explicit absent literal or a revision.
void tools.ops_write_file({ path: 'new.ts', content: '' })
// @ts-expect-error Null is not create-only permission.
void tools.ops_write_file({ path: 'new.ts', content: '', expectedRevision: null })
async function replacementReceipts() {
  const value = await tools.ops_replace({ pattern: 'old', replacement: 'new' })
  const row = value.data?.items?.[0]
  const before: string | undefined = row?.revision
  const after: string | undefined = row?.revisionAfter
  const state: 'pending' | 'completed' | 'error' | undefined = row?.status
  // @ts-expect-error Replace uses revision for the before-image; edit_file uses revisionBefore.
  const editBefore: string | undefined = row?.revisionBefore
  // @ts-expect-error Per-file receipt state is not an automatic retry instruction.
  const retry: 'retry' = row?.status
  return { before, after, state }
}
void [readThenEdit, replacementReceipts]

async function searchRows() {
  const glob = await tools.ops_glob({ pattern: ['*'], kind: 'all', outputMode: 'paths' })
  const entry = glob.data?.items?.[0]
  if (typeof entry === 'string') {
    // @ts-expect-error paths mode yields strings, not objects with a path property.
    void entry.path
  } else if (entry) {
    const path: string = entry.path
    const modified: number | null = entry.modified
    void [path, modified]
  }
  const grep = await tools.ops_grep({ pattern: 'needle', outputMode: 'count' })
  const row = grep.data?.items?.[0]
  if (row && 'count' in row) {
    const count: number = row.count
    // @ts-expect-error Count rows contain no line text.
    void row.text
    return count
  }
  if (row && 'text' in row) {
    const line: number = row.line
    return { line, text: row.text }
  }
}
void searchRows
