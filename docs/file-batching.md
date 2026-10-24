# Batched file reads and atomic edits

中文版：[文件批量操作.md](文件批量操作.md)。

`ops_read_files` reads 1-32 UTF-8 ranges with one one-shot worker invocation. Every relative
path resolves against the current session cwd on that call. Each entry has `path`, optional
1-based `offset` (default 1), and `limit` from 1 to 10000 (default 200). Unlike the legacy
inspector, offset 0 is invalid. Unknown fields, invalid bounds and malformed descriptors reject
the request. A binary file requires a binary/document reader or `ops_inspect_local_file` with
`view: "hex"`; text is never decoded lossily.

```json
{"files":[{"path":"src/index.ts","offset":1,"limit":80},{"path":"README.md","offset":10,"limit":40}]}
```

Results contain per-file canonical inspection values in `items`, including revision, bytes,
physical line count, numbered lines and completion facts. Empty files have zero lines; CRLF
counts once and a trailing LF creates no phantom line. A missing, unreadable or invalid-encoding
file has an error entry without hiding successful neighbors. The host checks all credential
paths before spawning and refuses the whole request if any are protected; the worker also
checks every path and refuses links/junctions. Read-only calls create no audit or cache files.
Successful observations update the host read-before-edit table using versions captured before
reading; failed and pending entries do not produce observations.

The exact path component `.dsh-ops` is reserved case-insensitively on every platform, including
absolute paths, ancestors above the session cwd, and missing create targets. Public file reads
(including document readers, `stat`, `diff` and each `read_files` entry), writes, edits, copies,
moves and removals reject it with `PATH_RESTRICTED`; copy/move check both source and destination.
An explicitly requested search/replace path follows the same rule. Ordinary directory searches
continue to exclude hidden audit entries without treating that exclusion as a coverage gap.
Near names such as `.dsh-ops-backup` and `.dsh-ops.json` are not reserved, though normal hidden
search exclusions still apply. This public-path restriction does not block trusted batch
plan/run/resume, audit paging, or result/cache lifecycle APIs. It does not authenticate audit
records against writes made outside these public file tools.

`nextIndex` is the first unreturned input entry and `pending` counts remaining entries. Resume
those files by sending the remaining slice of the original `files` array. Separately, an included
file's `complete: false` and `nextOffset` describe unread lines in that file. Aggregate `complete`
is true only when every file is fully read and there are no errors or pending entries. A partial
result with `pending: 0` can still require per-file recovery. Check both levels.

The worker bounds the complete escaped response to 96 KiB, including paths and metadata. Native
content blocks have an additional 64 KiB escaped display cap. A huge line may return a prefix
with `truncatedInLine`, `bytesTotal` and `bytesOmitted`; its offset stays on that incomplete line.
Use hex inspection's 16-byte rows to recover the suffix. A display-cap notice requires repeating
a smaller original range, never advancing past unseen content. Native renders file headings,
physical line numbers, per-file errors and continuation notices; the programmatic value stays
structured.

`ops_edit_file` applies 1-100 edits to **one** UTF-8 file, atomically. Supply `path`, the exact
SHA-256 `expectedRevision` from a read/stat, and `edits: [{oldText,newText}]`. Each nonempty
`oldText` must occur exactly once in the same original bytes; overlaps, ambiguity or stale
revision reject all edits before publication. Empty `newText` deletes the match. Preserve
CRLF/BOM explicitly. `dryRun: true` previews the same receipt without writing; read-only policy
still rejects mutation tools. This is not a cross-file transaction.

The operation shares `ops_edit_file`'s no-follow, CAS and platform metadata protections, and
returns a short receipt containing revisions, changed count, byte/line facts and warnings,
without echoing replacement content. Inspect any `error.effectState` before deciding whether
a write may be retried. It is never declared concurrency-safe.
