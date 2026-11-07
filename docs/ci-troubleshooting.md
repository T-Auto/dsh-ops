# CI troubleshooting

Every job in `ci.yml` is a merge gate, and `release.yml` refuses to publish from an unvalidated or
moved tag. A red check therefore always means something: a defect, a missing toolchain, an
environment problem, or a run that was cancelled before it could finish. This page is the
self-diagnosis path — start at the triage, then jump to the section that matches the log line.

中文版本：[ci-troubleshooting.zh.md](ci-troubleshooting.zh.md)。

## 0. Sixty-second triage

```console
gh pr checks <pr>                                        # which check is red, and its job URL
gh pr view <pr> --json mergeStateStatus,reviewDecision    # BLOCKED here is about reviews, not CI
gh run view <run-id> --json event,conclusion,jobs --jq '.jobs[] | .name + " => " + .conclusion'
gh run view <run-id> --log-failed                         # the failed step's log
```

Decide these four things before reading any stack trace:

1. **Which event?** `pull_request`, `push`, `workflow_dispatch`, `merge_group`, `dynamic`. A
   `workflow_dispatch` on a branch is a dry run; a fork PR's first run may sit at
   `action_required` (see §2.1).
2. **Was it cancelled?** `conclusion: cancelled` means a newer push superseded this run
   (`concurrency.cancel-in-progress` on pull requests). A cancelled run's red aggregate is not a
   defect signal — re-run it. But if a blocking job had already failed before the cancellation, the
   failure is real; read that job.
3. **Job-level or run-level?** `gh run view <run-id> --json jobs` tells you which job failed. A run
   can be red only because `CI required` judged a job that failed (in `ci.yml` it is the only
   aggregator).
4. **Is it in the gate or in the release path?** `ci.yml` and `release.yml` are independent; a tag
   run only exists for `v*` tags (or a manual dispatch).

If `gh run view --log-failed` prints `stream error` or omits the failing lines (this happens with
very large steps), fetch the full archive instead:

```console
gh api repos/T-Auto/dsh-ops/actions/runs/<run-id>/logs > run.zip && unzip -o run.zip -d run-logs
# or a single job:
gh api repos/T-Auto/dsh-ops/actions/jobs/<job-id>/logs
```

## 1. Index: log line → section

| What you see | Where to look |
| --- | --- |
| 0 jobs, red X, `action_required` | §2.1 fork PR approval |
| `cancelled` on a job | §2.2 superseded run |
| `ENOTFOUND`, `ECONNRESET`, registry/proxy errors during `npm ci` / `rustup` / cache | §2.3 network |
| `No space left on device` | §2.4 disk |
| `check-workflows: N of M check(s) failed` | §3.1 workflow-lint |
| `check-file-size: … FAIL` | §3.2 source-size |
| `rustfmt` diff / `warning: … clippy` / `error: could not compile` | §3.3 rust-lint |
| `step failed (…): <step>` inside `verify-gate` | §3.4 verify-gate steps |
| `--- <suite> exited 1` | §3.4.7 a suite failed |
| `--- <suite> skipped while DSH_OPS_REQUIRE_RUNTIME=1` | §3.4.3 forbidden skip |
| `suites skipped that must not skip on <target>` | §3.4.4 skip policy |
| `the runner discovered N suite(s); M test file(s) are on disk` | §3.4.2 inventory |
| `manifest checks: expected at least 59` | §3.4.5 manifest |
| `no suite summary line` | §3.4.6 runner died / timed out |
| `grep -Eq 'statically linked'` failure | §3.4.8 musl |
| `native-runtime check` error | §3.4.9 runtime closure |
| `niu: line 1: … Permission denied` | §3.5.1 Niubash execution |
| `Pinned Bash is unavailable` / `DSH_OPS_TEST_BASH` | §3.5.2 Bash payload |
| `EPERM … .tgz.modes-…` rename | §3.5.4 EPERM renames |
| `no FSEvents event … within 30s` | §3.6 macOS |
| `spawnSync … ETIMEDOUT` on Node 22.19 | §3.7 node floor |
| `tools-trial: N tool(s) failed` / `tools-trial-report.md` | §3.8 tools trial |
| `CI required` prints a job result that is not `success` | §3.9 aggregate |
| `tag vX does not match the package version` | §4.2 |
| `tag … points at …, but this run builds …` | §4.3 moved tag |
| `no successful 'CI required' check` | §4.4 unvalidated commit |
| `check-release` / receipt / `SHA256SUMS` mismatch | §4.5 release closure |
| `Publish the GitHub Release` skipped | §4.6 not a tag / dry run |
| `gh release upload` missing asset failure | §4.7 append-only publish |

## 2. Before any job starts

### 2.1 Fork PR: red X with zero jobs

A first run for a pull request from a fork waits for a maintainer (`conclusion: action_required`).
Some fork runs never start at all and are recorded as `failure` with **no jobs** and no annotation —
that is the fork approval/permission gate, **not** the contributor's code. Do not ask the contributor
to "fix the CI". Approve it:

```console
gh api -X POST repos/T-Auto/dsh-ops/actions/runs/<run-id>/approve
```

The same registration applies when the pull request's head predates the current `ci.yml`: GitHub
reads the workflow file from the pull request itself, so an old branch runs an old workflow (or
nothing). Ask for a rebase.

### 2.2 Cancelled runs

`ci.yml` uses `concurrency: cross-platform-${{ github.ref }}` with
`cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. A new push cancels the previous
PR run. A cancelled job is not evidence of a defect — re-run it. Only read a cancelled run when a
blocking job already shows a real failure before the cancellation.

### 2.3 Network, registry and cache

Any of these are environment, not code, when they are the only failure and a re-run is green:

- `npm ci` — `ENOTFOUND`, `ECONNRESET`, `EAI_AGAIN`, registry 5xx. The workflow installs with
  `--ignore-scripts --registry=https://registry.npmjs.org`.
- `rustup toolchain install 1.97.1` — toolchain download failure.
- `actions/cache` — restore/save warnings are non-fatal; a failed save does not fail the job.
- `actions/upload-artifact` — `Failed to CreateArtifact: … ENOTFOUND` is a GitHub-side DNS blip,
  not an action-version problem. Re-run; it happened once in 235 runs.
- `gh api` / `git ls-remote` in the release gate — a 5xx or DNS error fails the gate; re-dispatch.

### 2.4 Disk

Hosted runners have ~14 GB. The Windows leg installs the pinned Bash payload (411 MB) and the
Niubash payload; macOS keeps a ~1.3 GB cargo cache. `No space left on device` during `cargo test`
or `npm ci` is usually a cached `native/target` from an older, larger tree plus the payload
downloads. Delete the cache entry or bump the cache key; nothing in the product needs to change.

## 3. Gate-by-gate dictionary

### 3.1 `workflow-lint` — `scripts/check-workflows.mjs`

Every failure is a structural invariant, not a test. The message names it; the fix is in the
workflow, never in the lint.

| Message fragment | Meaning | Fix |
| --- | --- | --- |
| `every job is classified in EXPECTED_BLOCKING / EXPECTED_NON_BLOCKING` | a job was added to `ci.yml` without being classified | add the id to `EXPECTED_BLOCKING` in `scripts/check-workflows.mjs`, to `ci-required`'s `needs` and to its failure loop |
| `"CI required" waits on exactly the blocking jobs` | `needs` and the list disagree | edit `needs` |
| `failure loop covers exactly the blocking jobs` | the `for job in …` loop and the list disagree | edit the loop |
| `no blocking job sets continue-on-error` | a gate opted out | remove `continue-on-error`, or (only for a measurement) move the job to `benchmark-gates.yml` |
| `"CI required" runs even when a dependency fails` | lost `if: always()` | restore it |
| `native/rust-toolchain.toml pins a channel` / `rustup installs the toolchain pinned by …` | the pinned Rust version drifted between the file and a workflow | edit both to the same channel |
| `release.yml: refuses a tag that was force-moved …` / `requires a green CI required check` / `runs the same verify-gate` / `checks the release closure` / `publishing is append-only` | a release guard was deleted or renamed | restore the step (grep the step name in `release.yml`); the lint is the only thing that notices these disappear |
| `release.yml: the gate may read the tagged commit's check runs` | lost `checks: read` | restore the job permission |
| `benchmark-gates.yml: carries the bench smoke` / `schedules the measurement monthly` | the measurement job moved or the schedule was removed | restore it in `benchmark-gates.yml`; it must not be in `ci.yml` |
| `does not ask for write-all` / `does not use pull_request_target` | security invariant | remove it; an escaped workflow should be redesigned, not exempted |

### 3.2 `source-size` — `scripts/check-file-size.mjs`

A tracked code file exceeded 1000 lines. Split it into modules (the repo already does this in
`src/shells/`, `scripts/lib/build/`, `bench/lib/fixtures/`). Do not raise the limit and do not add an
exclusion. Run `node scripts/check-file-size.mjs` locally for the list.

### 3.3 `rust-lint` — formatting and clippy

The toolchain is `native/rust-toolchain.toml` (1.97.1, with rustfmt and clippy). Local commands must
use it:

```console
cargo +1.97.1 fmt --all --manifest-path native/Cargo.toml            # fix
cargo +1.97.1 fmt --all --check --manifest-path native/Cargo.toml    # verify, what CI runs
cargo +1.97.1 clippy --workspace --all-targets --locked --manifest-path native/Cargo.toml -- -D warnings
```

- `cargo fmt` failure — always fix by running the formatter with the pinned toolchain; never hand-edit
  formatting. A different rustfmt version can produce a different result, which is why the version is
  pinned in one file.
- `clippy` failure — `-D warnings` turns every lint into an error. Reproduce locally, then either
  apply the suggestion (`cargo clippy --fix`) or, when the lint is wrong for the code, silence that
  one lint at that one item with a comment. Never add a crate-level `#![allow(...)]`.
- A new Rust release can add lints; the version is pinned, so the lint set only changes when
  `native/rust-toolchain.toml` changes — do that in its own PR.

### 3.4 The functional gate (`validate-posix`, `validate-macos-intel`, `validate-windows`, `node-floor`)

All of these run the same entry point:

```console
node scripts/verify-gate.mjs --skip-install
```

It runs, in order: `node --version`, `cargo --version`, `npm run build` (tsc), `cargo test
--workspace --locked`, `npm run build:ptc`, `npm run stage:niubash`, Windows-only legacy MSYS
fixture + `npm run build:bash-ipc`, `npm run validate:manifest`, `npm run verify` (all suites),
`native-runtime check`, `npm pack`, unpack, packed `native-runtime check`. A failure prints
`step failed (<code>): <step>` and then a summary block; the six assertions after the steps are the
ones that catch the silent failures.

#### 3.4.1 `step failed (101): native worker unit tests`

`cargo test --workspace --locked` failed. This is a Rust unit/integration test — read the
`---- <test> stdout ----` block. Local reproduction:

```console
cargo +1.97.1 test --workspace --locked --manifest-path native/Cargo.toml
cargo +1.97.1 test --workspace --locked --manifest-path native/Cargo.toml <filter> -- --nocapture
```

macOS-only tests (`ops-mac-index`, FSEvents, the ACL clone path) and Windows-only tests
(`windows-metadata`, UNC) cannot be reproduced on Linux. If the failing test is a timing test on a
hosted runner, see §5 before changing the code.

#### 3.4.2 `the runner discovered N suite(s); M test file(s) are on disk`

Every `test/*.test.mjs` must be collected. The common causes: a suite file was renamed and the old
name is still referenced; a suite crashed before its summary line; a platform gate turned the suite
into a *discovery* filter instead of a skip. Listing the files and re-running the runner locally is
enough:

```console
ls test/*.test.mjs | wc -l
DSH_HOME=$(mktemp -d) node test/run.mjs        # prints "N suite(s) passed, M skipped"
```

#### 3.4.3 `--- <suite> skipped while DSH_OPS_REQUIRE_RUNTIME=1`

On POSIX the gate sets `DSH_OPS_REQUIRE_RUNTIME=1`, so a suite that says "this host cannot answer"
becomes a failure. Typical causes:

- the native worker was not built/staged — run `npm run build:ptc` first (the gate does this, so a
  failure here means the worker build failed earlier);
- `niubash-consumer` / `niubash-payload-integration` skipped for lack of `DSH_OPS_NIUBASH_ARCHIVE` —
  the gate stages the frozen archive itself, so a skip means staging failed (see the
  `stage complete frozen Niubash payload` step);
- `DSH_OPS_TEST_BASH` was not set on Windows and the legacy MSYS fixture could not be provisioned;
- `mount` skipped because no native worker could be resolved (POSIX allows `mount` to skip only in
  that case — if it skips for another reason the skip policy below fails too).

The allowed-skip lists live in `scripts/verify-gate.mjs`:

- POSIX (`linux-x64`, `darwin-arm64`, `darwin-x64`): `mount`, `result-storage-cache-prep`,
  `windows-security`, `niubash-consumer`, `niubash-security-host`, plus the optional external-checkout
  suites `tui-host`, `tui-native` (`DSH_OPS_ALLOW_SKIPS`).
- Windows (`win32-x64`): `file-metadata`, `linux-attributes`, `linux-shell`, plus the same external
  suites.

Anything else that skips is a defect, by design. Do not add a name to the list to make a run green —
a skip is not a pass.

#### 3.4.4 `suites skipped that must not skip on <target>`

Same policy, reported by name: a suite skipped outside the platform's allowed set. Fix the suite (or
the environment it needs). Do not widen the list without a documented reason in the same PR.

#### 3.4.5 `manifest checks: expected at least 59, got none`

`npm run validate:manifest` failed or printed fewer checks than the floor. The floor is deliberately
a floor, not the current count. Read the `manifest contract` step output; a validator that collapses
prints nothing.

#### 3.4.6 `no suite summary line; the runner did not finish`

The suite runner died (OOM, a panic outside a test, a dead child). Look at the end of the
`full suite verification` output. If it is a deadline, the runner prints
`--- <suite> exceeded the <N>s suite deadline` and (when `DSH_OPS_RETRY_TIMEOUTS=1`) retries once;
a retry that also fails is a real problem — do not raise the timeout to hide it.

#### 3.4.7 `--- <suite> exited 1`

The suite itself failed. Every suite prints `FAIL <check name>` and an assertion; read that, then
reproduce with `DSH_HOME=$(mktemp -d) node test/run.mjs <filter>`. `DSH_HOME` must be a fresh temp
directory or the harness refuses to run.

#### 3.4.8 `file runtime/linux-x64/dsh-ops-worker | grep -Eq 'statically linked|static-pie linked'`

The Linux worker is not a musl static binary. The step before it (`build-ptc --target
x86_64-unknown-linux-musl`) must have run; a `gnu` build or a missing target produces a dynamically
linked binary with a GLIBC floor that would break older hosts.

#### 3.4.9 `native-runtime check` — staged or packed runtime closure

The staged `runtime/<target>/` or the packed tarball's `runtime/` is missing the worker, has a
foreign-architecture binary, or lost its `provenance.json` receipt. Check what the build staged:

```console
node bin/native-runtime.mjs check --platform linux-x64
ls runtime/linux-x64/
tar -tzf dist/*.tgz | grep '^package/runtime/' | head
```

### 3.5 Windows-specific

#### 3.5.1 `niu: line 1: … Permission denied`

The Niubash payload cannot execute the file it was asked to run. Known real defects are tracked in
the open `niu: Permission denied` issues; a run that repeats this is a product defect, not a runner
problem. Collect the full `replace`/`bash` stderr from the suite (it prints the command and exit
status) before filing.

#### 3.5.2 `Pinned Bash is unavailable. Run dsh-ops bash-runtime install, or set DSH_OPS_TEST_BASH …`

The pinned legacy Bash payload is missing from `node_modules/@dsh-ops/bash-win32-x64` (the package is
installed by `npm ci`) and no explicit `DSH_OPS_TEST_BASH` was provided. The release gate provisions
the fixture explicitly; the CI legs rely on `npm ci`. Check that `npm ci` ran with
`--ignore-scripts` (it still installs the payload package) and that the platform filter step did not
delete it.

#### 3.5.3 `UNC directory regression`

This step mounts `\\localhost\C$\dsh-ops-unc` and runs an `--ignored` Rust test. It depends on the
hosted Windows image exposing the administrative share; an image change can fail it with a mount
error. Treat a mount error as runner-image drift (report it), and an assertion failure as a real
`ops-search` defect.

#### 3.5.4 `EPERM: operation not permitted, rename '….tgz.modes-…' -> '….tgz'`

The tar-mode repair renames a sibling file over the packed tarball; Windows can hold a handle on the
tarball (antivirus, an open `npm pack` child). It is environment-dependent: re-run the job and check
whether the same commit fails again. If it reproduces on a second run, treat it as a defect in the
pack path, not as flake.

### 3.6 macOS-specific

- `no FSEvents event for … within 30s` — the FSEvents delivery bound in
  `native/crates/ops-mac-index/src/fsevents_tests.rs`. It is a bounded wait, not a latency
  assertion; on a loaded hosted runner delivery can take a dozen seconds. If it fires repeatedly,
  treat the stream code as broken rather than raising the bound again.
- `macos-15-intel` leg is slower (median ~494 s, p99 ~1292 s). The 30-minute job timeout is there for
  that; do not "fix" a slow run by lowering the workload.
- Case-insensitive filesystem: a test that creates `Foo` and `foo` in one directory behaves
  differently here. Use distinct names.

### 3.7 `node-floor`

Runs the same gate on the declared Node floor (22.19) on one host. A failure that reproduces only on
22.19 is a real support-boundary bug (an API newer than the floor). Windows-on-22.19 fails three
npm-pack suites and is tracked in #774 — do not re-add the Windows leg until that is fixed.

### 3.8 `tools-trial`

`node scripts/tools-trial.mjs` boots a real host under a temp `DSH_HOME` and calls every published
tool. A `FAIL` is a broken published tool: fix it or revert the change that broke it. `skipped` with
a reason is not a failure (a tool that this build does not publish yet), and the report is uploaded
as `tools-trial-report`. Reproduce with `node scripts/tools-trial.mjs` after `npm run build` and
`npm run build:ptc`.

### 3.9 `CI required`

The aggregate prints one line per blocking job. A red here means one of those lines is not
`success`; there is no separate failure to debug. If the aggregate itself is red while every job
line is `success`, the workflow wiring is broken (see §3.1, `needs`/loop assertions).

If `CI required` says `skipped` for a job because the workflow was cancelled, re-run.

### 3.10 The bench smoke (`benchmark-gates.yml`)

It is a measurement, never a merge gate: it runs on dispatch and monthly, and a red smoke does not
block anything. When it fails, the evidence is in `benchmark-gates.json` / `bench-smoke-*-report`.
It asserts deterministic outcomes only (corpus builds and is removed, the same worker answers
identically twice, every query lands on `MATCH` or a declared `EXPECTED_*`); it never asserts a
duration. Do not turn its timings into a gate — a shared runner's timing is noise.

## 4. Release path (`release.yml`)

### 4.1 It did not run at all

`release.yml` only runs for `push` of a `v*` tag or a manual dispatch. A branch push or a pull
request never publishes.

### 4.2 `tag <name> does not match the package version v<version>`

The tag and `package.json` disagree. Fix the version in the PR, merge it, then tag the merge commit —
never force-move the tag.

### 4.3 `tag <name> points at <commit>, but this run builds <commit>`

The tag was force-moved after the run was queued (or the dispatch ref is not the tag's commit).
Publishing is immutable, so the run refuses. Release a new version. If the tag already points at the
built commit, re-dispatch the same tag to finish an interrupted release — it only appends missing
assets.

### 4.4 `the tagged commit <sha> has no successful 'CI required' check`

The release gate requires the tagged commit's `CI required` to be `success`. Causes: the commit was
pushed straight to `main` without a CI run; the run failed; the check is older than the retention
window; the check name changed. Push the commit through a PR and let CI pass, or pick the right
commit — do not bypass this guard.

### 4.5 `check-release` / receipt / `SHA256SUMS` failures

The gate verifies: all four targets present; every `provenance.json` receipt matches the staged
bytes; the Windows IPC binary and source digests match; the manifest and the runtime allow-list
agree. Read which target/receipt it names:

```console
node bin/check-release.mjs
ls runtime/*/provenance.json
```

A partial artifact download, a stale receipt (rebuilt worker but not re-staged) or a missing target
fails here instead of shipping.

### 4.6 `Publish the GitHub Release` is `skipped`

`publish` only runs for `github.ref_type == 'tag'`. A dispatch on a branch (or on `main`) is a dry
run by design: it builds, gates and packs, then stops. That is the recommended rehearsal.

### 4.7 `publish` fails on a missing asset / already-published asset

Publishing is append-only: an existing Release only receives the assets that are missing. If an
asset name exists with different bytes, the run will not replace it (no `--clobber`); bump the
version instead. If upload fails for a file that is genuinely absent, re-dispatch the same tag and
commit.

### 4.8 npm was not published

By design. `npm publish` needs an `NPM_TOKEN` this repository does not grant to Actions; see
[release-process.md](release-process.md).

## 5. Noise or defect?

- **Cancelled** → noise; re-run.
- **Fork approval / 0-job failure** → not code; approve.
- **Network / DNS / registry** → noise when the only failure and a re-run is green; open an issue if
  it repeats for the same step.
- **Timing test on a hosted runner** → check whether the same commit passed elsewhere (Intel vs
  arm64, Windows vs Linux) and whether the assertion has a bounded wait. If the wait is the only
  thing that failed, the bound may be too tight *for that host* — say so in the fix, and do not turn
  it into a retry loop that hides a real stream bug.
- **Flake or defect** → run the same commit twice. A second red on the same job is a defect. A green
  re-run of the same commit is a candidate flake: file it with both run ids so the next person can
  judge the rate.
- **Runner image drift** (unchanged commit, one platform fails on a tool/image assumption) → record
  the image version from the log (`ImageOS`, `ImageVersion`), then adapt the step.

Rerunning is fine for noise. Rerunning is **not** a fix for a defect: the audit of the 30 days before
the gate flip found 20 reruns, none of which turned a real failure green.

## 6. Local reproduction

```console
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run build                                            # tsc + assets
npm run build:ptc                                        # native worker (most suites need it)
cargo +1.97.1 test --workspace --locked --manifest-path native/Cargo.toml
node scripts/check-workflows.mjs                          # the workflow lint
node scripts/check-file-size.mjs                          # the 1000-line gate
node scripts/tools-trial.mjs                              # the tools trial
node test/run.mjs <filter>                                # one or a few suites
DSH_HOME=$(mktemp -d) node scripts/verify-gate.mjs --skip-install   # the whole gate
node scripts/apply-ruleset.mjs                            # admin: ruleset dry run (never in CI)
```

On Windows, `DSH_OPS_TEST_BASH` points at a verified pinned `bash.exe` (the gate provisions one) and
`DSH_OPS_TEST_NIUBASH` at the staged `niu.exe`. `DSH_OPS_SUITE_TIMEOUT_MS` (300 s; 600 s on Windows)
and `DSH_OPS_RETRY_TIMEOUTS=1` are what CI sets; `DSH_HOME` must be a temp directory.

## 7. Do not

- **Do not** move or delete a published tag to make a release green; release a new version.
- **Do not** add `--clobber` to the publish step.
- **Do not** delete or weaken the skip assertions to turn a red gate green; provision the runtime or
  fix the suite.
- **Do not** widen `ALLOWED_SKIPS` or `EXPECTED_NON_BLOCKING` without a documented reason and a test.
- **Do not** raise a job timeout to hide a hang, or a suite deadline to hide a slow test.
- **Do not** use a retry to pass a deterministic failure; retries are for deadlines only.
- **Do not** push a fix straight to `main`; the `CI required` guard is what a release gate checks.

## 8. Known issues register

| Symptom | Issue | Status |
| --- | --- | --- |
| `linux-protocol` "concurrent replaces of one file are atomic" fails on macOS in unrelated runs | #163 / #168 | open; real native concurrency window, needs a stress reproduction |
| Three npm-pack suites fail on Windows + Node 22.19 (`ETIMEDOUT`, `EPERM` renames) | #774 | open; `node-floor` stays on one host until fixed |
| `replay_from_a_persisted_id_reports_a_new_file` misses its FSEvents delivery bound | #775 | mitigated (30 s bound); root cause open |
| Fork PR run is red with zero jobs | #150 / this page §2.1 | not a defect; approval flow |
| `Release` used to be `disabled_manually`, tags were force-moved | #767 | fixed; publishing is immutable now |

## 9. When you add a gate

Add a section to this page **in the same PR**: what the gate asserts, the exact log line a human
will see, the local command that reproduces it, and what to do when it fires. A gate without an entry
here is a gate whose first red will be debugged from scratch.
