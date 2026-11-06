# AST engine: `ops_ast_locate`, `ops_ast_refactor`, `ops_ast_audit`

Three tools that read and rewrite source by syntax tree instead of text. They answer **in-process**:
a Tree-sitter parse over bytes already in memory costs less than spawning the native worker, so no
subprocess is started and no confinement step is applied.

中文版：[ast-engine.zh.md](ast-engine.zh.md)

## Why in-process

`ops_grep` and `ops_replace` already cover text search and literal replacement. A structural
tool earns its place only by knowing node kinds — telling a definition from a reference, or telling a
whitespace change from a semantic one. That work is a parse of a small file, measured at ~0.5 ms; the
native worker path would add a process spawn (~30–50 ms) on top.

The engine confines nothing itself. Every fence the native worker path runs, these tools run too, in
the same order:

1. an authoritative session identity and an absolute cwd;
2. one `sandboxPolicy.resolve()` call, then a whitelist of its mode;
3. a credential fence and an anchor check for every caller-named path — `file`, `beforeFile`, and
   each entry of `roots` — with the lexical name judged before the resolved real path;
4. **enumeration prunes the credential roots as well.** A per-argument fence cannot see a directory
   walk, so the walk itself skips those trees and the candidate list is filtered again before any
   file is read;
5. write intent (`ast_refactor` with `mode: "apply"`) requires `workspace-write`, and only the
   workspace may receive a write: the session cwd is a read scope, not a write grant, so a cwd
   outside the workspace cannot authorise a commit.

`@ast-grep/napi` is loaded on the first `ast_*` call, never at boot. If it cannot load, the tools
return `EXECUTOR_UNAVAILABLE` and nothing else in the plugin is affected.

## `ops_ast_locate`

Find a symbol definition by exact identifier over the tree below the session cwd. A definition is a
function, class, method, constructor, or a declaration whose value is a function; a plain
`const NAME = 1` is not one and returns no hit — that is what `ops_grep` is for.

| Argument | Meaning |
| --- | --- |
| `symbol` | Required. Exact identifier, e.g. `locateSymbol`. Definitions rank above references. |
| `file` | Search one file instead of the tree. |
| `roots` | Search roots relative to the session cwd, each inside it. Default: the cwd. |
| `ext` | Extensions, e.g. `["ts","py"]`. Default: every registered language. |
| `limit` | 1–500 hits, default 5. |
| `body` | `false` for the signature alone, `true` for the whole node, or a line count. |
| `continuation` | Opaque cursor from a truncated scan. Keep every other argument unchanged. |
| `skipDirs` | Directory names never descended into, e.g. `["dist","vendor"]`. |

Returns `hits[]` (`file`, `lang`, `lines`, `signature`, optional `body`) plus `scanned`, `truncated`,
`pruned` and `continuation`. A walk stopped by `limit` reports `truncated: true`: the list is then
not the complete set of matches. Only the first 48 candidates are parsed once a prefilter leaves more than
that; `pruned: true` says so instead of silently reporting a short list.

## `ops_ast_refactor`

Rewrite source structurally with an ast-grep pattern and a rewrite template.

| Argument | Meaning |
| --- | --- |
| `pattern` | Required. ast-grep pattern with metavariables, e.g. `console.log($A)`. |
| `rewrite` | Required. Replacement text; `$A` expands to the matched metavariable. |
| `mode` | `preview` (default) reports the plan and writes nothing; `apply` writes it. |
| `detail` | Include the structural delta per file. |

A receipt carries `matched`, `planned` and `remaining`, so a `limit`-stopped run says how much work
it left behind instead of looking complete. `apply` opens each target once with `O_NOFOLLOW`, reads the bytes through that descriptor, and
refuses a target whose inode changed before the rename (`E_STALE`, nothing overwritten). A target
that became a link is refused rather than followed. The engine plans; the bridge publishes. `apply` returns the same receipt as `preview` plus, per file,
the replacement `after` text and the `revision` the plan was built against, and each one is then
written **through its own descriptor**: opened once with `O_NOFOLLOW`, read for the revision check,
written and truncated and fsynced on that same descriptor.

Writing through the descriptor binds the write to one inode, so a leaf swapped between the open and
the write cannot redirect it. A **parent** directory swapped for a junction is different: the open
resolves the whole path afresh, so the write lands where the junction points. Node exposes no
`openat`, so this cannot be prevented here — it is detected instead: the directory is resolved and
checked against the workspace before the descriptor is opened, which narrows the window to the
instant between that check and the open rather than closing it. The trade is atomicity: a rename leaves a file
all-old or all-new at every instant, while an in-place write can be interrupted halfway. The original
text is kept in memory, restored if the write fails, and the result is read back and compared before
the call reports success. **Ownership, ACLs, xattrs and hard links are preserved**, because the inode
is the same one the file always had; the BOM and line endings are read from it and written back. A
failure after the first write reports `effectState: "partial"` together with the files it already
committed in `filesApplied`, so a retry cannot silently duplicate an edit.

## `ops_ast_audit`

Compare two versions of one file. `file` and `beforeFile` are both required and both relative to the
session cwd. Returns `formatOnly`, `nodesBefore`, `nodesAfter`, `nodesChanged`.

`formatOnly: true` means the change is **whitespace only**. A comment is a node, so adding or removing
one counts as structural — the tool reports that instead of guessing at intent. It never writes.

## Errors

Failures are returned values with `error.code`, `error.effectState` and `error.retryable`; they are
never thrown.

| Code | Meaning | Retryable |
| --- | --- | --- |
| `INVALID_ARGUMENT` | A required argument is missing or the name is not an AST tool. | no |
| `POLICY_DENIED` | `apply` under read-only, or a named path outside the workspace and session cwd. | no |
| `PATH_RESTRICTED` | A named path resolves (through a junction or symlink) outside the workspace. | no |
| `CREDENTIAL_DENIED` | A named path matched the credential fence. | no |
| `EXECUTOR_UNAVAILABLE` | No session identity, no policy service, or `@ast-grep/napi` did not load. | no |
| `E_STALE` | A file changed between plan and commit; nothing was written. | no |
| `E_NO_MATCH` | No definition found; `continuation` resumes a truncated scan. | yes, with a different query |
| `E_BINARY` / `E_ENCODING` | The file is not UTF-8 text. | no |
| `E_ROOT_OUTSIDE` | A `roots` entry left the session cwd. | no |
| `RESULT_UNKNOWN` | The engine failed without a settled receipt. Inspect postconditions first. | check first |

## Presentation

These three names publish on the **Native** presentation only. PTC output is read by sandboxed code
against a strict typed schema, and no PTC projection is declared for them: a caller that reaches
`ops_ast_*` from PTC code sees no such tool rather than a mistyped one.
