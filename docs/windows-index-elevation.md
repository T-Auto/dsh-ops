# Windows index elevation and failure matrix

Status: W1 cold MFT enumeration and W4 hard-link reconciliation of `ops-win-index`
(#584, #602, #605). Reviewed 2026-11-04.

`ops-win-index` is an optional accelerator. When it cannot answer safely it reports
`Unsupported`/`Unavailable`, and the caller produces exactly the output its own
traversal produces. Nothing here may turn a permission problem into a partial or
empty answer.

## Why the index path needs Administrator

Opening a volume for the USN/MFT ioctls is an administrative operation on Windows:

- `FSCTL_ENUM_USN_DATA` (W1 cold enumeration) and `FSCTL_READ_USN_JOURNAL` (W2 replay)
  need a volume handle opened as `\\.\X:`;
- `OpenFileById` on that volume handle is the safe way to resolve a file id that may
  have no current path.

W1 detects the token with `usn-journal-rs::privilege::is_elevated` (fail closed: an
unreadable token counts as not elevated). A non-elevated worker answers
`SourceState::Unsupported`, so every request falls back to the existing walk and the
output stays byte-identical.

## Hard links (W4) and privileges

`FindFirstFileNameW`/`FindNextFileNameW` take a normal file path, not a volume
handle. They need the caller's normal traverse/read-attributes rights on that path;
they do **not** need Administrator, and this crate never tries to raise its
privileges. Consequences worth knowing:

- the caller must pass one of the file's current absolute names as the anchor; the
  index normally takes it from its own verified candidate;
- NTFS hard links cannot cross volumes, so the enumerated names belong to the same
  volume as the anchor;
- NTFS allows at most 1024 links per file; [`MAX_LINKS`] is 4096 as a pathology guard;
- names come back as raw UTF-16 exactly as Win32 reports them, so unpaired surrogates
  survive to the index's WTF-8 layer instead of being lossily flattened.

## Failure matrix

| Condition | Where it shows up | Observed | Source answer / caller action |
| --- | --- | --- | --- |
| Worker is not elevated | volume open / journal ioctl | `ERROR_ACCESS_DENIED` (5) | `Unsupported`; caller uses its walk |
| Volume is not NTFS / has no journal | `FSCTL_*` | `ERROR_INVALID_FUNCTION` (1), `ERROR_JOURNAL_NOT_ACTIVE` (1179) | `Unsupported`/`Unavailable`; fall back to walk |
| Journal deletion is in progress | journal ioctl | `ERROR_JOURNAL_DELETE_IN_PROGRESS` (1178) | `Unavailable`; retry, then rescan |
| BitLocker-locked volume | volume open | `ERROR_ACCESS_DENIED`, `ERROR_NOT_READY` | `Unavailable`; fall back to walk |
| File deleted between journal and reconcile | `FindFirstFileNameW` | `ERROR_FILE_NOT_FOUND` (2) / `ERROR_PATH_NOT_FOUND` (3) | `LinkOutcome::Incomplete(FileGone)`; skip, count, keep previous links |
| No read-attributes right on the file | `FindFirstFileNameW` | `ERROR_ACCESS_DENIED` (5) | `Incomplete(AccessDenied)`; skip, count, keep previous links |
| Walk fails part-way (lock race, short read) | `FindNextFileNameW` | any other error | `Incomplete(WalkAborted)`; partial names discarded, skip, count |
| More names than the guard allows | our `MAX_LINKS` check | — | `Incomplete(TooManyLinks)`; skip, count |
| ReFS 128-bit file id | W1/W2 id conversion | — | whole source `Unsupported`; walk |
| Anchor is relative or empty | our validation | — | `Incomplete(InvalidAnchor)`; caller bug, no syscall made |

An incomplete hard-link walk is **never** applied as an empty set: applying it would
delete a file that still has links. The reconcile loop counts it in
`LinkWalkStats::skipped` and leaves the last known set alone; the next
`HARD_LINK_CHANGE` retries.

## What this crate does not do

- It does not elevate, prompt for UAC, or use `SeBackupPrivilege`.
- It does not authorize paths: every candidate the integration receives must still be
  re-verified through the existing cap-std handles before it enters a result.
- It never reads file contents.
- It does not persist a journal cursor next to an index without the matching snapshot
  (see the ops-index persistence slices).

## Operational guidance

- Run the worker elevated when the index is wanted; otherwise expect `Unsupported`
  and a correct but slower walk.
- Log `LinkWalkStats` (attempted/completed/skipped) next to the query. A skipped
  reconcile is a known gap, not an empty file, and must not be reported as "no links".
- A volume that keeps returning `AccessDenied` or journal errors should be treated as
  index-unavailable for the whole request, not retried per file.
