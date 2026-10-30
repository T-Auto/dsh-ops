# 0.4.0 manual acceptance

中文：[手动验收](手动验收.md). These are operator checks, not claims that every UI or deployment
has been exercised. Use a disposable profile and workspace; retain commands, observed results,
platform/host versions and candidate commit. Do not install or upgrade a real runtime merely to
open its settings page.

## Build and release evidence

Run the [full release gate](CONTRIBUTING.md#the-verification-gate) with the required worker and,
on Windows, the verified Bash fixture. A skipped required runtime is not a pass. Run the separate
[BM-01–05 gates](benchmark-gates.md); record individual failed/blocked/passed states and raw receipts.
Apply the explicitly approved criteria: BM-01 requires at least 40% fewer bytes than OPS 0.3.x on the fixed lossless workload; retain the official reader as a separate comparison. BM-03 applies ≤400 tokens to the file/discovery schemas while keeping Bash at startup. Record both the scoped score and the full actual provider total, and require the exact default tool inventory including a usable Bash (pinned Windows payload or host Bash). A smaller workload, missing Bash or functional CI success cannot replace these measurements.

## Profiles and configuration

1. Start a saved six-row profile with explicit name-qualified overrides, mixed on/off switches and
   unrelated plugin settings. Upgrade and restart twice. Verify seven unique OPS IDs, the unchanged
   legacy file name/configuration, preserved switches and the added discovery row.
2. In a fresh profile, verify file/PTC/discovery on, shell on for all three platforms, and
   panel/TUI/replacements off. Enable a fresh panel row and observe new events; disable it and verify queued collection stops
   with no final fold. An explicit legacy capture:false must stay inert until changed by the operator.
3. Save valid built-in row settings and restart. Reject an unknown key or wrong type without changing
   saved values. A stale revision must not overwrite a newer edit. Null legacy file/root/shell settings
   must keep their defaults. A disabled row must be enabled before editing.
   Apply only to the stopped disposable profile with --offline --yes. Verify backup originals, seven
   retained IDs/switches/configs, restart and custom-page activation. Disable/re-enable the carrier and
   verify custom pages unload/recover. External ambiguous overrides must refuse without writes.

## Tool publication and results

1. Inspect the actual first provider request: Native has read_files/discover_tools and a usable Bash (pinned Windows payload or host Bash);
   advanced document schemas are absent. Select one advanced capability and verify it appears only in
   the owning next request, not in current-round diagnostics or a sibling agent.
2. PTC starts with inspect_local_file/result/load_sdk. Load permitted advanced APIs through ops_load_sdk and
   check the next SDK snapshot, typed Outcome status and data. Preserve an operator's explicit allowed
   pool; tool listing must not imply filesystem permission.
3. Read three file ranges once. Reconstruct escaped lines exactly, check per-file errors and both
   pending-input and in-file continuations. Edit five ranges in one file with a revision; stale or
   overlapping edits must change nothing. Never treat a partial response as full coverage.
4. Exercise CSV/TSV, DOCX and a supported text-layer PDF, plus malformed/unsupported later content.
   Safe prefixes may survive, but total/revision require a stable complete scan. Check page versus scan
   versus display/reference-capture completeness and the explicit excluded document scope.
5. Select an official replacement only when its exact OPS counterpart is ready: read requires
   inspect_local_file, not read_files. An unrelated same-name tool must not satisfy readiness.

## Authority, runtime and teardown

Use read-only, workspace-write and full-access sessions. Credential-fenced reads must reject.
Writes must reject in read-only, and outside writes must reject in workspace-write, without leaking
denied paths/content or changing files. Full access follows its documented broader write authority. A host-authorized ordinary outside
read is an allowed control, not a failed workspace jail. Verify authority changes and cancellation
stop or invalidate owned work, and unloading removes only this plugin's registrations.

Bash must keep the host command/description/cwd/timeout contract, approvals, job IDs and output kinds.
Default timeout is 120 seconds, maximum 600. Without jobs, background is absent. With jobs, collect or
stop through host job tools; a timeout promotion must not execute the command twice. Windows restricted
modes have documented partial enforcement and exact MSYS compatibility requirements.

Runtime management must first show a plan, then require explicit execution. Cancellation after launch
may have unknown effects. Git/managed selection edits a draft until saved. PowerShell upgrades target
the standard host installation, require restart and leave custom pwshPath review to the operator.
Do not claim installation success from opening a page or losing a transport connection.

Record TUI acceptance separately when a compatible dsh-TUI host is available. The optional host suites
must be reported as skipped when it is absent; synthetic registry tests do not replace terminal UI
acceptance. Preserve every failure and skip in the release review.
