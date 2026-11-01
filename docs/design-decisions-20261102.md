# Editing, navigation and review: current design decisions

[中文](设计决策-20261102.md)

Decision date: 2026-11-02. Baseline: `main` at `065cd7f`.
This records a **no-go for new production features in this round** for
[#424](https://github.com/T-Auto/dsh-ops/issues/424),
[#459](https://github.com/T-Auto/dsh-ops/issues/459) and
[#534](https://github.com/T-Auto/dsh-ops/issues/534). It does not declare the proposed
features implemented or permanently rule them out. Existing tools remain the supported path.

## #424: revision-bound ranges and anchors

The problem is real: converting numbered, possibly partial read results into unique old text
is awkward. A line number alone is not a file identity, a byte boundary, or evidence that all
replacement text was observed. The existing edit contract already combines an expected
revision, exact old-text matching and atomic single-file publication. Keep that contract.

| Candidate | Benefit | Additional obligation | Current decision |
| --- | --- | --- | --- |
| PTC helper over returned lines | Avoid repetitive caller code | Prove complete contiguous input, exact newline/BOM reconstruction and unique old text | Best candidate for a later small experiment; not a shipped helper |
| Revision plus byte/line range | Avoid text matching ambiguity | Define inclusive/exclusive ends, encoding boundaries, empty insertion, overlap and lock-time revalidation | No-go until the contract and negative cases are settled |
| Opaque read token | Bind an edit to an observation | Own session lifetime, authority revocation, cache eviction, identity and replay prevention | No-go: unnecessary new state without measured benefit |
| Hashline/text anchor | Compact references in text | Handle collisions, repeated lines, stale identity and normalization | No-go: no fuzzy relocation or automatic rebase |

The current safe workflow is to use typed read data and its revision directly within PTC,
check the returned status/completeness, and submit exact old text with `expectedRevision`.
If the text is ambiguous or clipped, obtain sufficient fresh context before editing.
PR [#541](https://github.com/T-Auto/dsh-ops/pull/541) adds real read-to-edit composition
regressions, including stale external writes; it is a separate correctness fix, not a range API.

A future helper must pass the following matrix **before** it is called safe:

| Input/change | Required result |
| --- | --- |
| Duplicate lines or duplicate old-text regions | Reject ambiguity; no bytes changed |
| Adjacent or overlapping edits | Specify ordering; reject overlap; all-or-none for one file |
| CRLF, BOM, UTF-8 multibyte text, no final newline | Preserve exact bytes outside the selected edit |
| Paged, truncated or missing read lines | Reject incomplete evidence rather than reconstructing unseen bytes |
| External change, including outside the selected range | Revision conflict; no silent relocation |
| Symlink/reparse replacement or changed file identity | Existing no-follow and identity checks still reject |
| Read-only or out-of-authority destination | Existing host/worker authorization still rejects |
| Successful edit | Return the new revision and accurate applied-effect receipt |

Reconsider only with an independently implemented prototype, the matrix above, and a
representative comparison of failed/retried edits and request/response bytes. Do not copy
another project's source or internal lineage structures. No prototype or performance gain is
claimed by this decision.

## #459: Tree-sitter symbol maps

An outline can save returned text when the caller needs navigation. The current proposal does
not establish a small, portable implementation with an end-to-end benefit under OPS authority.
Keep targeted text search and ranged reads; do not add parser dependencies or a second file
execution path in this round.

The inspected contributor candidate is the closed, unmerged
[PR #469](https://github.com/T-Auto/dsh-ops/pull/469), head `badd4c8`.
Its source diff adds 2,522 lines under `src/` across 19 files, before tests/docs. Its
[benchmark note](https://github.com/yanfei0725/dsh-ops/blob/badd4c83ae04bfe85555aed08f6915e534832b07/docs/symbol-map-benchmark.md)
reports a generated 400-line TypeScript example: a 14.7 ms first parse and a 0.13 ms warm
cache hit, with 1,282 outline bytes versus 5,039 bytes from a default partial read.
Those are the contributor's measurements, not a fresh cross-platform benchmark here.

The warm result is useful evidence about that cache, but it does not measure a complete
find-symbol → read-body → solve-task workflow, aggregate RSS, grammar loading, invalidation,
or the cost of a first encounter with many different files. A smaller outline is not equivalent
to reading the required source body. Estimated tokens are not model usage or billing evidence.

Queries match nodes in an already parsed syntax tree; using queries does not remove parsing
and tree storage. Tree-sitter exposes byte and row/column locations and error/missing nodes,
which a trustworthy outline must handle explicitly.
Sources: [basic parsing](https://tree-sitter.github.io/tree-sitter/using-parsers/2-basic-parsing.html),
[query syntax](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html).

Reconsider a smaller opt-in slice only with:

- A single file-authority path using existing no-follow, credential, revision and cancellation
  boundaries; an outline must not count as an observed full read or authorize a later edit.
- Explicit limits for file bytes, parse time, parser/tree/cache memory and grammar count,
  with cold, warm, churn and many-distinct-file measurements on supported platforms.
- Pinned grammar/version availability, named unavailable-language errors and no installation
  scripts or silent successful empty outlines when a grammar is absent.
- Negative tests for stale revisions, parse errors/missing nodes, Unicode/newline locations,
  session/permission changes, path replacement and cache eviction.
- A task comparison that includes the subsequent source read, all tool declarations and
  output bytes, and correctness. Report medians and spread; no timing threshold in CI.
- Independently reviewable implementation slices within the contribution size policy.

The contributor branch is preserved. This decision does not merge, rewrite or delete it.

## #534: verification environments, merge trains and schema probes

Keep the existing CLI-first review snapshot as the supported product surface. The fork CI
association and GitHub merge-state defect is addressed separately in
[PR #538](https://github.com/T-Auto/dsh-ops/pull/538). A snapshot remains evidence, not merge approval.

For this round, do not add an automated environment builder, a merge-train executor, or a
model-visible review component. They introduce ownership of arbitrary candidate builds,
dependency installation, cancellation, cleanup and cross-PR state without an agreed workload
showing that the extra product surface saves enough work.

The existing [snapshot command](review-snapshot.md) accepts at most five PRs and caps JSON
output at 64 KiB. One live three-PR observation in this audit was 8,876 UTF-8 bytes and correctly
reported `partial` when the requested base and reported PR base differed and no local probe was
provided. That is one command's output size, **not** a measured saving over a manual review.
It adds zero resident model schema. No controlled manual-versus-automated review cost study
has been performed, so no token or review-time reduction is claimed.

| Proposal | Current path | Evidence needed before a new implementation |
| --- | --- | --- |
| P1 isolated verification | Explicit disposable worktree/dependency graph; record exact base/head, commands, failures and skips | Reproducible baseline/candidate workload, bounded logs, cancellation/cleanup, no maintainer checkout mutation, explicit environment/credential policy |
| P2 merge train | Read-only snapshot and local isolated merge probe; explicit reviewed integration branch when needed | Base/head invalidation, ordered dependency graph, conflicts and tests on the combined tree; remote mutation must be a separate explicit action |
| P3 schema probe/review tool | Compare the existing catalog/declarations as an offline artifact | Proven recurring review task; measured schema/context cost; opt-in loading and bounded output; no resident tool for occasional work |

Reopening one proposal should identify one independently reviewable deliverable and its
measurement protocol. Failed builds, missing workers, absent CI, policy blocks and unknown
merge evidence must remain explicit; no automatic retry may convert them into success.

## Recorded cost scope and verification

At the baseline, UTF-8 bytes of compact `JSON.stringify({description, parameters})` from the
built capability catalog were: `edit_file` 1,514; `read_files` 660; `inspect_local_file` 814.
This excludes output schemas, tool names, host wrapping and prompt text. It is a reproducible
catalog-fragment measurement, not a provider request or a token count. These decision documents
change none of those schemas, declarations or defaults: added product-schema bytes are zero.

Verification for this slice is documentation/link consistency and an unchanged production tree.
Existing tests demonstrate only the behavior they assert; they are not evidence that any
unimplemented range editor, parser or review automation passes the proposed acceptance matrix.
