/** Batch and PTC result schemas; the same result capability also owns a Native projection. */
import type { JsonSchemaNode } from '../adapter/dsh/types.js'
import { STORAGE_REFERENCE, RESULT_PAGE_PARAMETERS } from './result.js'
import type { ParameterSchema } from './types.js'
import engineSchema from '../ast/schema.json' with { type: 'json' }

const string: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer' }
const object = (properties: Record<string, JsonSchemaNode>, required: string[] = []): ParameterSchema => ({ type: 'object', properties, required, additionalProperties: false })
/**
 * The five `ops_ast_*` schemas are the engine's own `schema.json`, spread in rather than retyped:
 * `required` drives the adapter's early INVALID_ARGUMENT, so a hand-copied schema would eventually
 * accept an argument the engine then rejects after policy resolution.
 */
const engine = (name: keyof typeof engineSchema.tools): ParameterSchema => engineSchema.tools[name] as unknown as ParameterSchema
export const PARAMETERS = {
  batch: object({
    root: string,
    action: { type: 'string', enum: ['plan', 'run', 'resume'] },
    operations: { type: 'array', description: '1-512 operations; enforced by the native worker.', items: object({ op: { type: 'string', enum: ['copy', 'move', 'remove'] }, path: string, to: string }, ['op', 'path']) },
    operationsRef: string,
    protect: { type: 'array', description: 'At most 128 protected relative paths.', items: string },
    id: string,
  }, ['action']),
  result: object({
    action: { type: 'string', enum: ['put', 'page', 'release'] }, ...RESULT_PAGE_PARAMETERS,
    items: { type: 'array', description: 'At most 10000 object rows; 2 MiB whole request, 10 MiB physical reference cap.', items: { type: 'object' } },
    ttlMs: { ...integer, description: 'put only: 0 (default, session lifetime), or 1-604800000 milliseconds.' },
  }, ['action']),
  ast_locate: engine('ops_ast_locate'),
  ast_find: engine('ops_ast_find'),
  ast_refactor: engine('ops_ast_refactor'),
  ast_inproc: engine('ops_ast_inproc'),
  ast_audit: engine('ops_ast_audit'),
}
// Open JSON values exist only in the data plane (caller-owned rows), not in operation inputs.
export const OUTPUT: JsonSchemaNode = {
  type: 'object', properties: {
    id: string, root: string, status: string, phase: string, done: integer, total: integer,
    failed: integer, unknown: integer, logicalBytes: integer, byteSemantics: string,
    detailsRef: string, complete: { type: 'boolean' }, omitted: integer, nextAction: string,
    sourceTotal: integer, contentHash: string, reference: STORAGE_REFERENCE,
    source: { type: 'object', description: 'Original execution facts, itemEncoding, capturedItems and captureComplete; independent of page completeness.' },
    expires: { oneOf: [integer, { type: 'null' }] }, items: { type: 'array', items: { type: 'object' } }, nextOffset: integer,
    sandbox: object({ mode: string, enforcement: string }, ['mode']),
    error: object({ code: string, phase: string, retryable: { type: 'boolean' }, effectState: string, nextAction: string, message: string,
      permission: object({ current: string, required: string, operation: string, workspaceRoot: string }),
    }, ['code', 'phase', 'retryable', 'effectState', 'nextAction', 'message']),
  },
}
export const DESCRIPTIONS = {
  batch: 'Preflight and verify copy/move/remove. action=plan requires operations and creates a no-effect audit plan; execute that exact plan with action=resume plus id (do not change it to run). action=run requires operations and executes immediately. root, when supplied, must be an absolute path: a relative root is rejected at preflight with INVALID_ARGUMENT. Omit root to use the session workspace root; an absolute root follows DSH permissions (unrestricted in full access). Operations use relative / paths, no overwrite or link traversal. Page detailsRef with ops_result, passing the same root whenever the plan root differs from the session workspace root. Parameter errors return structured error objects.',
  result: 'Session-owned object rows: put items (up to 10000; 2 MiB whole request and 10 MiB physical reference cap), page, release. Pages default to offset=0, limit=64, maxBytes=16384; follow nextOffset until complete. equals filters top-level exact values before fields projection; offset/total/omitted count filtered rows. sourceTotal/contentHash identify all ordered rows before filtering/projection (SHA-256 of worker compact JSON with sorted object keys); compare hashes across pages to detect changed audits, never as authority. An oversized row returns OUTPUT_LIMIT: project fewer fields or raise maxBytes (max 65536). New ref:// snapshots default to session lifetime (ttlMs=0); put may set ttlMs up to 604800000. reference.createdAt is Unix milliseconds. Legacy r- snapshots expire after 24h; audit pages have expires=null and cannot be released. Page complete describes stored rows only; source execution and capture completeness remain independent. Tagged-json-v1 item-json-chunk text must be joined by index and byteOffset before JSON.parse, only after complete=true. operationsRef in ops_batch accepts only owned unexpired result rows. Pass the same root as the batch when paging detailsRef, or expect NOT_FOUND. Failures are structured values, not thrown errors. In run_code, process pages locally and return only needed summaries.',
  ast_locate: 'Locate one symbol in-process with Tree-sitter: enumeration, substring pre-filter, then a single-file parse. Returns line range, signature and byte size per hit, never the whole file, so a locate in a 600-file repository costs roughly 250 bytes of context. Pass file to skip enumeration, or roots (default session cwd) and ext (default ts/tsx) to narrow the walk. strategy=auto picks walk or the Everything index by directory size. body controls hit text: true/default attaches it only while the total stays under 8 KiB, false gives line numbers alone, a number sets the budget. Follow nextOffset when hitsOmitted is present. Read-only; answered in-process, with no subprocess and no write.',
  ast_find: 'Fast address lookup by file query (Everything plus SANE), read-only. Without symbol it returns the matching file list only; with symbol it returns the files, the symbol byte range and the signature of the first candidate that contains it. Use it to find where a symbol lives before reading or rewriting; use ops_ast_locate when the symbol name is already known and the repository is large. Falls back to a bounded walk when the Everything index has not caught up with a freshly written file. Read-only; no file is modified.',
  ast_refactor: 'Five-stage structural refactor: Everything address search, SANE symbol slice, ast-grep AST rewrite, AgentBox stdin write, difftastic syntax-level audit. mode=apply writes and returns hunk counts plus audit facts; mode=preview returns the same shape without touching the target. Requires symbol, pattern and rewrite, plus query or file. This is the writing tool: it requires workspace-write, and every named file and root is anchored to the workspace or session cwd. External binaries it cannot find are reported as E_BIN_MISSING rather than replaced by a guess.',
  ast_inproc: 'In-process AST match, structural rewrite and syntax audit with Tree-sitter. The normal path starts no subprocess; strict=true additionally cross-checks the hit count with the ast-grep CLI before writing. Pattern and rewrite are the ast-grep pair (for example `return $A` rewritten to `return ($A);`), optionally scoped by symbol, file, roots and ext. mode=apply writes and mode=preview does not; single files up to 2 MB across TS/TSX/JS/JSX/HTML/CSS. Writing requires workspace-write. Use it for a single file or a small tree; use ops_ast_refactor when addressing a large repository.',
  ast_audit: 'Syntax-level diff audit between two versions of one file (difftastic): returns hunk count, added and removed line counts, and the detected language while ignoring formatting-only changes. file is the current version and beforeFile the pre-change image. It never modifies the target: the only write is a temporary directory it removes again, so it stays available under read-only. Use it after a refactor to confirm the edit stayed syntax-equivalent, and report its facts rather than re-reading the file.',
}
