/** File capability data; no host services or registration side effects. */
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { DOCUMENT_PARAMETERS, DOCUMENT_DESCRIPTIONS, documentOutput } from './documents.js'
import { STORAGE_REFERENCE } from './result.js'
import type { ParameterSchema } from './types.js'

const string: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer', description: 'Nonnegative integer (0-based).' }
const range = (min: number, max: number, description = ''): JsonSchemaNode => ({ type: 'integer', description: `${min}-${max} inclusive.${description ? ` ${description}` : ''}` })
const bounded = (properties: Record<string, JsonSchemaNode>, required: string[] = []): ParameterSchema => ({ type: 'object', properties, required, additionalProperties: false })

// The pinned host SDK supports a schema subset: express bounds in descriptions;
// the native worker remains authoritative for validation, including raw PTC calls.
const revision: JsonSchemaNode = { type: 'string', description: '64 lowercase hex SHA-256 revision returned by inspect/stat; absent is create-only, never an overwrite wildcard.' }
const existingRevision: JsonSchemaNode = { type: 'string', description: '64 lowercase hex SHA-256 revision returned by inspect/stat; absent is not accepted.' }
const filePath: JsonSchemaNode = { ...string, description: 'File path; relative to session cwd.' }
const searchPath: JsonSchemaNode = { ...string, description: 'Search root; relative to session cwd, default ".".' }
const globFilter: JsonSchemaNode = { type: 'array', description: 'Relative glob ARRAY, e.g. ["**/*.ts","!vendor/**"]; omitted means all eligible files.', items: string }
const dryRun: JsonSchemaNode = { type: 'boolean', description: 'Preview without writing; default false.' }

const edits = bounded({ path: filePath, expectedRevision: existingRevision, edits: { type: 'array', description: '1-100 nonoverlapping edits against the same original bytes.', items: bounded({ oldText: { ...string, description: 'Nonempty text that occurs exactly once in the original.' }, newText: { ...string, description: 'Literal replacement text; empty deletes the matched text.' } }, ['oldText', 'newText']) }, dryRun }, ['path', 'expectedRevision', 'edits'])

export const PARAMETERS = Object.freeze({
  ...DOCUMENT_PARAMETERS,
  read_files: bounded({ files: { type: 'array', description: '1-32 file ranges.', items: bounded({
    path: string, offset: { type: 'integer', description: 'Line >=1; default 1.' }, limit: range(1, 10000, 'Default 200.'),
  }, ['path']) } }, ['files']),
  inspect_local_file: bounded({
    path: filePath,
    offset: { type: 'integer', description: '1-based line or 16-byte hex row; default 1. Legacy 0 also reads the first unit.' },
    limit: range(1, 10000, 'Default 200.'),
    encoding: { type: 'string', enum: ['utf-8'], description: 'Text encoding; only utf-8 is supported.' },
    view: { type: 'string', enum: ['text', 'hex'], description: 'Text lines (default) or 16-byte hex rows.' },
  }),
  glob: bounded({
    path: searchPath,
    pattern: { type: 'array', description: 'Glob ARRAY, e.g. ["**/*.md","!vendor/**"]; at least one positive entry is required.', items: string },
    outputMode: { type: 'string', enum: ['paths', 'details'], description: 'Paths (default) or paths with byte sizes and modification times.' },
    sort: { type: 'string', enum: ['path', 'modified'], description: 'Path order (default) or newest modification first.' },
    offset: integer,
    limit: range(1, 10000, 'Default 100.'),
    continuation: { ...string, description: 'Opaque cursor from a complete scan. Keep query options unchanged; omit offset or use nextOffset. SEARCH_STALE requires a fresh query.' },
  }, ['pattern']),
  grep: bounded({
    path: searchPath,
    pattern: { ...string, description: 'One Rust regex STRING, e.g. "TODO|FIXME".' },
    glob: globFilter,
    outputMode: { type: 'string', enum: ['files_with_matches', 'content', 'count', 'summary'], description: 'Matching text (default), file paths, per-file counts or aggregate totals.' },
    caseInsensitive: { type: 'boolean', description: 'Ignore case; default false.' },
    lineNumbers: { type: 'boolean', description: 'Include 1-based line numbers; default true.' },
    beforeContext: range(0, 32, 'Lines before each match; default 0.'),
    afterContext: range(0, 32, 'Lines after each match; default 0.'),
    multiline: { type: 'boolean', description: 'Search whole-file text instead of individual lines; default false.' },
    offset: integer,
    limit: range(1, 10000, 'Default 100.'),
    exactTotal: { type: 'boolean', description: 'Default true. False stops at the row limit with lower bounds and no stable cursor; summary and continuation still scan fully.' },
    continuation: { ...string, description: 'Opaque cursor from a complete scan. Keep query options unchanged; omit offset or use nextOffset. SEARCH_STALE requires a fresh query.' },
  }, ['pattern']),
  stat: bounded({ path: filePath }, ['path']),
  diff: bounded({ path: filePath, content: { ...string, description: 'Complete proposed UTF-8 file content.' }, offset: integer, limit: range(1, 1000, 'Default 100.') }, ['path', 'content']),
  write_file: bounded({ path: filePath, content: { ...string, description: 'Complete UTF-8 file content; empty writes an empty file.' }, expectedRevision: revision, dryRun }, ['path', 'content', 'expectedRevision']),
  edit_file: edits,
  copy: bounded({ path: filePath, to: { ...string, description: 'Absent destination file; relative to session cwd. Parents must exist.' }, expectedRevision: existingRevision }, ['path', 'to', 'expectedRevision']),
  move: bounded({ path: filePath, to: { ...string, description: 'Absent destination file on the same filesystem; relative to session cwd.' }, expectedRevision: existingRevision }, ['path', 'to', 'expectedRevision']),
  remove: bounded({ path: filePath, expectedRevision: existingRevision }, ['path', 'expectedRevision']),
  replace: bounded({
    path: searchPath,
    pattern: { ...string, description: 'Nonempty literal STRING, not a regex.' },
    replacement: { ...string, description: 'Literal replacement text; empty deletes matches.' },
    glob: globFilter,
    maxReplacements: range(1, 100000, 'Default 100.'),
    dryRun,
  }, ['pattern', 'replacement']),
})

export const OUTPUT: JsonSchemaNode = {
  type: 'object',
  properties: {
    reference: STORAGE_REFERENCE, referenceRoot: string, root: string, source: { type: 'object' }, storageError: { type: 'object' }, nextAction: string,
    revision: string, bytes: { type: 'integer' }, lineCount: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    status: { type: 'string' }, phase: { type: 'string' }, changed: { type: 'integer' },
    matched: { type: 'integer' }, skipped: { type: 'integer' }, failed: { type: 'integer' },
    complete: { type: 'boolean' }, omitted: { type: 'integer' }, total: { type: 'integer' },
    nextOffset: { type: 'integer' }, truncated: { type: 'boolean' }, items: { type: 'array', items: {} },
    dryRun: { type: 'boolean' }, files: { type: 'integer' }, matches: { type: 'integer' },
    skippedFiles: { type: 'integer' },
    error: { type: 'object' },
  },
}

export const READ_FILES_OUTPUT: JsonSchemaNode = {
  type: 'object', properties: {
    reference: STORAGE_REFERENCE, referenceRoot: string, root: string, source: { type: 'object' }, storageError: { type: 'object' }, nextAction: string,
    status: string, complete: { type: 'boolean' }, nextIndex: { type: 'integer' }, pending: { type: 'integer' },
    total: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' }, effectState: string,
    items: { type: 'array', items: { ...OUTPUT, properties: { ...OUTPUT.properties, path: string } } }, error: { type: 'object' },
  },
}

export const SEARCH_OUTPUT: JsonSchemaNode = {
  ...OUTPUT, properties: {
    ...OUTPUT.properties,
    scanComplete: { type: 'boolean' }, pageComplete: { type: 'boolean' },
    scannedFiles: { type: 'integer' }, skippedFiles: { type: 'integer' },
    skipReasons: { type: 'object' }, matchedObserved: { type: 'integer' },
    matchedTotal: { type: 'integer', description: 'Present only after a complete scan.' },
    truncatedBy: { type: 'string', enum: ['scan-budget', 'output-budget', 'time', 'row-limit', 'none'] },
    continuation: string, nextAction: string,
  },
}

/** Every projection declares the same canonical execution shape. */
export function fileOutput(rawName: keyof typeof PARAMETERS): JsonSchemaNode {
  const document = documentOutput(rawName)
  if (document) return document
  if (rawName === 'read_files') return READ_FILES_OUTPUT
  if (rawName === 'glob' || rawName === 'grep') return SEARCH_OUTPUT
  return OUTPUT
}

// Failures are returned values, never thrown: a try/catch alone misses them (#44).
const RESULT = ' Failures resolve as {status:"error"|"rejected", error.code}; they are not thrown.'
const EDIT_DESCRIPTION = 'Precisely patch one UTF-8 file using 1-100 oldText/newText edits against the SAME original bytes. Every nonempty oldText must occur exactly once; overlapping edits reject all. Required expectedRevision from inspect/stat. Atomic CAS; dryRun previews. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Preserve CRLF/BOM explicitly in text. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT
export const DESCRIPTIONS = Object.freeze({
  ...DOCUMENT_DESCRIPTIONS,
  read_files: 'Read UTF-8 ranges relative to session cwd. Check each file complete/error; nextOffset continues lines, nextIndex resumes pending files. Binary needs a binary reader. Failures return status:error|rejected and error.code; never throw.',
  inspect_local_file: 'Read bounded UTF-8 text lines or a hex view from path relative to the DSH session cwd. Directories are rejected; use ops_glob or ops_grep.' + RESULT,
  glob: 'Find regular files below path relative to the current session cwd. pattern is an ARRAY of globs matched against paths relative to path: ["**/*.md","!vendor/**"]; "*.md" matches the top level only, "!" excludes, at least one positive entry. Symlinks, reparse points, hidden files and dependency/build directories are excluded. limit defaults to 100; paging uses 0-based offset/nextOffset. Check scanComplete and pageComplete; matchedTotal exists only after a complete scan. Prefer continuation with unchanged options; SEARCH_STALE means restart. Incomplete scans require a narrower query.' + RESULT,
  grep: 'Search UTF-8 files below path relative to the current session cwd. pattern is ONE Rust regex string; filter files with glob, an ARRAY of relative globs ("!" excludes). There is no include field. Use summary for aggregate file/match totals, count for per-file counts, files_with_matches for paths, content for text (default); limit defaults to 100 items. Optional line context. Paging uses 0-based offset/nextOffset; prefer continuation with unchanged options. Each page rescans; SEARCH_STALE means restart. Check scanComplete and pageComplete; matchedTotal exists only after a complete scan, matchedObserved is a lower bound otherwise. skipReasons explains gaps. Narrow incomplete scans instead of blindly paging.' + RESULT,
  stat: 'Inspect one regular file: SHA-256 revision, bytes, UTF-8 lineCount (null for binary), timestamps and permissions; no content. Missing paths return exists:false, revision:absent.' + RESULT,
  diff: 'Read-only comparison of one UTF-8 file with content. Returns one prefix/suffix-trimmed replacement hunk (not a minimal diff), paged 0-based offset/limit (default 100). Includes old/new hashes and line counts; no publication.' + RESULT,
  write_file: 'Create or fully overwrite one UTF-8 file; parents must exist. Required expectedRevision is the observed SHA-256, or absent for create-only. Atomic CAS, short receipt with new revision/bytes/lineCount; dryRun only previews. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Read-only denies even dryRun. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT,
  edit_file: EDIT_DESCRIPTION,
  copy: 'Copy ONE regular file to absent to (relative to session cwd); parents must exist. Required expectedRevision checks source. Atomic no-clobber destination; preserves metadata or fails closed. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved. Darwin requires APFS cloning and currently refuses nonempty extended ACLs with METADATA_UNSUPPORTED before staging; use a dedicated metadata-aware tool for ACL-bearing files. No directories/links; recursive work uses ops_batch when available.' + RESULT,
  move: 'Move ONE regular file to absent to, same filesystem only. Required source expectedRevision. Atomic no-clobber destination then source unlink; failures after publication carry effectState:applied. No copy-delete fallback, directories or links.' + RESULT,
  remove: 'Unlink ONE regular file with required expectedRevision from inspect/stat. No recursion/directories/links. Atomic unlink; no trash. Read-only denies all mutations.' + RESULT,
  replace: 'Replace LITERAL text (pattern is not a regex) in UTF-8 files under path; glob filters files as in ops_grep. dryRun observes only; writes use revision checks and atomic replacement. Read-only sessions are rejected. Darwin nonempty extended ACLs fail closed with METADATA_UNSUPPORTED. Windows preserves owner/group/ordered DACL and supported basic attributes/timestamps; readonly overwrite is refused and unsupported streams/EA/special storage fail with METADATA_UNSUPPORTED. SACL/audit labels are not preserved.' + RESULT,
})
