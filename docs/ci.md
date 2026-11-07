# CI

Four workflows, one gate — and every merge-gating job is a real gate. This page is the map: what
runs, what actually blocks a merge, how to reproduce any of it locally, and the repository settings
that make the gate real. The intent is that a reviewer can trust a green PR without re-running
anything by hand, and that a red check is never something to "read and ignore".

## What runs

| Workflow | Trigger | Blocks a merge? | Purpose |
| --- | --- | --- | --- |
| `ci.yml` — **Cross-platform validation** | `push: main`, `pull_request` (no filters), `merge_group`, manual dispatch | **Yes** (via the single `CI required` check) | The functional gate on Linux x64, macOS arm64, macOS Intel and Windows x64, plus the Node floor, the source size gate, workflow lint, Rust lint and the tool trial |
| `sync-master.yml` — **Sync master with main** | `push: main`, manual dispatch | No | Fast-forwards the `master` mirror; fast-forward only, so a divergent `master` fails loudly |
| `release.yml` — **Release** | `push: v*` tags, manual dispatch | No (but it publishes) | Builds the four declared targets, gates them, and publishes the GitHub Release. Nothing here runs on a branch or a pull request. `release.yml` is **active**: v0.5.0 was published by it |
| `benchmark-gates.yml` — **Opt-in OPS acceptance benchmarks** | manual dispatch, monthly schedule | No | Real-host acceptance gates (dispatch) and the tool-level bench smoke (also monthly). A benchmark is a measurement; it never gates a merge |

`sync-master.yml` is not a gate and never touches `main`. It exists so the `master` mirror cannot go
stale by accident.

### Jobs inside `ci.yml` — all of them are gates

| Job | Runner | Blocking? | What it proves |
| --- | --- | --- | --- |
| `validate-posix` | `ubuntu-24.04` (linux-x64), `macos-latest` (darwin-arm64) | **Yes** | `cargo test --workspace --locked`, the native worker builds, then `scripts/verify-gate.mjs --skip-install`: no unauthorised skips (`DSH_OPS_REQUIRE_RUNTIME=1` on POSIX turns a missing runtime into a failure), every suite file on disk was collected, and the packed artifact unpacks and passes `native-runtime check` |
| `validate-macos-intel` | `macos-15-intel` (darwin-x64) | **Yes** | The same gate on Intel macOS, including the Mach-O x86_64 worker and its receipt; uploads `native-darwin-x64` |
| `validate-windows` | `windows-latest` (win32-x64) | **Yes** | The same gate on Windows, plus the UNC directory regression; uploads `native-win32-x64` |
| `tools-trial` | `ubuntu-24.04` | **Yes** | Boots a real host and calls every published tool; a broken tool is a blocked merge |
| `node-floor` | `ubuntu-24.04`, `windows-latest` | **Yes** | `package.json` promises `^22.19 \|\| >=24`; this runs the same gate on the declared **floor** on both platform families |
| `workflow-lint` | `ubuntu-24.04` | **Yes** | `scripts/check-workflows.mjs`: every workflow parses, declares triggers/jobs/permissions, bounds each job with `timeout-minutes`, avoids `write-all` and `pull_request_target`, keeps `ci.yml`'s aggregate check wired to every blocking job, every job classified, and the release path's guards present |
| `source-size` | `ubuntu-24.04` | **Yes** | `scripts/check-file-size.mjs`: every tracked code file stays at or under 1000 lines. The file set comes from `git ls-files`, so a new module is in scope the moment it is added |
| `rust-lint` | `ubuntu-24.04` | **Yes** | `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` with the toolchain pinned by `native/rust-toolchain.toml` (1.97.1) |
| `ci-required` | `ubuntu-24.04` | — (this is the check to require) | Collapses the matrix into one status: it waits on every job above and fails unless all of them succeeded |

There are **no non-blocking jobs in `ci.yml`**. The former `continue-on-error` legs (Windows, Intel,
tools-trial) are gates: their red runs were real defects — DACL handling, Niubash execution, the pack
consumer — and a gate that "reads" a red leg is a gate that merges broken Windows code. The one job
that is not deterministic enough to gate a merge (the bench smoke) lives in `benchmark-gates.yml`,
where it is dispatched or scheduled monthly and where failing it never holds a PR.

The set of blocking jobs is stated once, in `scripts/check-workflows.mjs` (`EXPECTED_BLOCKING`).
Adding a job to `ci.yml` without classifying it fails `workflow-lint`; so does a `needs` list or a
failure loop that disagrees with the classification. A job cannot quietly opt out of the gate.

### Measured durations (30-day window ending 2026-11-07)

| Job | p50 | p90 | p99 / max |
| --- | --- | --- | --- |
| `validate-posix` (linux-x64) | 271 s | 389 s | 424 s |
| `validate-posix` (darwin-arm64) | 249 s | 378 s | 581 s |
| `validate-macos-intel` | 494 s | 730 s | 1292 s |
| `validate-windows` | 573 s | 1335 s | 1514 s |
| `node-floor` | 253 s | 364 s | 402 s |
| `tools-trial` | 42 s | 49 s | 209 s |
| `workflow-lint` | 11 s | 16 s | 193 s |
| `source-size` | 7 s | 12 s | 23 s |
| `ci-required` | 3 s | 4 s | 6 s |

Timeouts are set from these numbers with headroom (20 minutes for the POSIX legs and `node-floor`,
30 for Intel and Windows), so a hung job fails in minutes rather than in the old 35-minute default.
The 411 MB Windows Bash payload is installed by `npm ci` in ~11 s on the hosted image; it is not the
reason the Windows leg is slow — the suites are.

## Reproduce it locally

```bash
npm ci --ignore-scripts --registry=https://registry.npmjs.org
cargo test --workspace --locked --manifest-path native/Cargo.toml
npm run build:ptc

# The gate, exactly as CI runs it (POSIX: a skipped runtime suite is a failure, not a pass)
DSH_HOME=$(mktemp -d) node scripts/verify-gate.mjs --skip-install

# The structural gates
node scripts/check-workflows.mjs
node scripts/check-file-size.mjs

# Rust formatting and lints, with the toolchain the repository pins
cargo +1.97.1 fmt --all --check --manifest-path native/Cargo.toml
cargo +1.97.1 clippy --workspace --all-targets --locked --manifest-path native/Cargo.toml -- -D warnings

# The bench smoke (a measurement; never a merge gate)
node scripts/tools-trial.mjs
node test/run.mjs bench
```

`native/rust-toolchain.toml` is the single source of the Rust version: it lists 1.97.1 with `rustfmt`
and `clippy`, and every workflow's `rustup toolchain install` must name the same channel
(`workflow-lint` asserts that).

`DSH_OPS_SUITE_TIMEOUT_MS` and `DSH_OPS_RETRY_TIMEOUTS=1` are set in CI (300 s; 600 s on Windows)
and one retry of a *deadline only* — a logic failure is never retried. Without them a slow runner can
turn a passing suite into a red run; with them, a retry prints, so a green summary still shows what
happened.

## The required check and the ruleset

`main`, `0.3.2` and `release/0.4.0` are protected by the ruleset template in
`.github/required-ci-ruleset.json`: pull request required, `CI required` required as a status check,
strict (up to date with the base), no bypass actors, no force pushes — and a merge queue, which is
part of the same ruleset write.

Applying it is a **one-time admin action**; the repository cannot grant it to itself:

```bash
# Dry run: prints the desired vs live fingerprint and writes nothing.
node scripts/apply-ruleset.mjs

# Apply once, from a machine holding an admin token. The merge queue is enabled by the same write.
GH_ADMIN_TOKEN=… node scripts/apply-ruleset.mjs --apply
```

`scripts/check-workflows.mjs` keeps the template honest offline; `scripts/apply-ruleset.mjs` is the
only thing that talks to the live API and it is never run by CI.

Require **`CI required`**, not the per-platform names: the matrix expands into one check per runner,
so requiring those names by hand means keeping them in sync forever and losing the gate the day a
runner label changes.

## Fork pull requests

Two GitHub mechanics decide whether a pull request runs anything at all:

- For a `pull_request` event GitHub reads the workflow files **from the pull request itself**, not
  from `main`. A branch whose head predates the live `ci.yml` therefore starts no run, and the
  checks listed above only appear once the branch carries a `pull_request` trigger.
- The first run for a pull request opened from a fork waits for a maintainer to approve it
  (`action_required`); every later push to that branch runs without a new approval. A fork PR whose
  run never starts shows a red X with no jobs — that is the approval gate, not a code failure.
  Approving one is a write on the run, not on the branch:

  ```bash
  gh api -X POST repos/T-Auto/dsh-ops/actions/runs/<run-id>/approve
  ```

A pull request whose head is a branch of this repository runs immediately and needs neither.

## How to add a job

1. Add it to `ci.yml`.
2. Add its id to `EXPECTED_BLOCKING` in `scripts/check-workflows.mjs`, and to `ci-required`'s `needs`
   and failure loop.
3. Run `node scripts/check-workflows.mjs` locally — it fails until all three agree.

A job that genuinely cannot gate a merge (a measurement) does not belong in `ci.yml`: put it in a
non-gating workflow. There is currently exactly one such job, the bench smoke in
`benchmark-gates.yml`.

## Known limits, stated rather than hidden

- **`actionlint` is not used.** It cannot be installed on these runners without network installs, so
  `scripts/check-workflows.mjs` covers the structural half of what it does (triggers, permissions,
  job shape, the aggregate-check wiring, the release guards). Expression-level type checking is not
  covered.
- **Benchmarks are measurements.** The bench smoke and the acceptance gates cannot produce a
  performance verdict on a shared runner; they print medians as evidence and assert only
  deterministic outcomes. Making a timing threshold a merge gate would block PRs on runner noise.
- **One native concurrency window is still open.** `linux-protocol`'s "concurrent replaces of one
  file are atomic" has failed on `macos-latest` in unrelated runs (#163). It is a real window in the
  native publication path (#168), not a test defect; a stress reproduction is the prerequisite for
  fixing it, and until then it is tracked rather than papered over with a retry.
