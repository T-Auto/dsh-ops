# Search coverage and continuation

中文版：[搜索覆盖范围.md](搜索覆盖范围.md).

Developer timing and equal-work comparisons: [search performance diagnostics](search-performance.md).

`glob` and `grep` return an additive `SearchExecutionReport` alongside their existing items.
A settled legacy `status: completed` means the worker returned a result; callers must still
inspect `scanComplete`, `pageComplete` and `complete` before treating it as exhaustive.

| Field | Meaning |
| --- | --- |
| `scanComplete` | Every eligible candidate was observed without a read/encoding/size gap or execution stop. |
| `pageComplete` | The requested page of observed items was fully rendered; independent of whether later pages exist. |
| `scannedFiles` | Allowed, non-hidden regular file candidates considered, including declared glob-filter exclusions. |
| `skippedFiles` | Known regular files excluded or unreadable; never an estimate of files below a skipped directory. |
| `skipReasons` | Counts of excluded files/directory entries, or observed gaps. A skipped directory counts once. |
| `matchedObserved` | Matches observed so far: matching files for glob, matching lines/spans for grep. |
| `matchedTotal` | Present only when `scanComplete` is true; the exact full-scan match count. |
| `truncatedBy` | `scan-budget`, `time`, `output-budget`, `row-limit`, or `none`. A non-budget read/encoding gap can use `none`. |
| `continuation` | Opaque cursor for another page of a fully observed, unchanged query. |

`grep` count/files modes page matching files while `matchedTotal` counts matches; the legacy
`total` counts page items. `total` and `omitted` are absent when the scan is incomplete. Existing
`matched`, `matches` and `files` are observed counts, never a replacement for the coverage flags.
The Native renderer puts coverage and recovery guidance before matching text. The published
argument schemas include `continuation`; the typed output declares the report fields.
An explicit `limit` can produce `scanComplete: true`, `pageComplete: true`,
`truncatedBy: row-limit` and a continuation. Legacy `complete` becomes true only on the final
fully displayed page of a complete scan.

Declared pattern exclusions, hidden paths, excluded dependency/build directories, credential
locations and no-follow links stay outside the query scope. Their skip counts do not make an
otherwise complete query incomplete. Unreadable entries/directories/files, invalid path encoding,
files over 32 MiB, and non-UTF-8 content are coverage gaps. These do make `scanComplete` false,
remove full totals/cursors, and return `nextAction` advising a narrower query or repair of the gap.
Credential paths and content are never exposed through the report.

Search considers at most 10,000 regular files, 100,000 directory entries, depth 128, and 256 MiB
of read bytes per call. Its cooperative deadline is 30 seconds, checked between directory entries,
64 KiB read chunks and matches; existing host cancellation and the worker process deadline remain
in force. Directory sorting and glob candidates are bounded; grep streams one bounded file and
materializes only its output page. Later shared-budget work will centralize these limits.

Pass a returned `continuation` with the same query options and omit `offset` (or pass the cursor's
`nextOffset`). The token binds the tool, normalized host-resolved path arguments, session, current
authority fields, workspace identity and observed search state. Candidate order is deterministic;
modified-time sorting retains that order for ties. Grep fingerprints include file contents, so
restoring a file's size and timestamp does not conceal changed bytes. Glob fingerprints bind its
observed paths and metadata. A changed query, authority, token checksum or observation returns
`SEARCH_STALE` with no effects. Discard that token and start a fresh query. Every call rechecks
host authority and no-follow boundaries; a cursor or its checksum grants no permission.

This implementation rescans the bounded query and validates its fingerprint before returning a
later page. It does not freeze a filesystem snapshot or resume beyond a scan/time/gap stop.
Incomplete traversals return explicit narrow-query guidance without a cursor. Stored snapshots
and reference-backed resumption belong to the later result-reference slice.

An oversized matching line may return a bounded prefix marked `truncatedInLine`, `bytesTotal`
and `bytesOmitted`. That makes `pageComplete` false. No continuation skips the missing suffix;
`nextOffset` stays at the incomplete item, with guidance to inspect that file using text/hex
ranges. Whole omitted rows can continue normally after a complete scan. Output is bounded by
serialized JSON bytes, not source-character counts, and search creates no audit/reference store.
