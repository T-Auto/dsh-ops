# CI

Three workflows, one gate. This page is the map: what runs, what actually blocks a merge, how to
reproduce any of it locally, and the repository settings that make the gate real. The intent is that
a reviewer can trust a green PR without re-running anything by hand.

## What runs

| Workflow | Trigger | Blocks a merge? | Purpose |
| --- | --- | --- | --- |
| `ci.yml` — **Cross-platform validation** | `push: main`, `pull_request: main`, `merge_group`, manual dispatch | **Yes** (via the single `CI required` check) | The functional gate on Linux and macOS arm64 (blocking), macOS Intel and Windows (non-blocking signals), plus the Node floor, the source size gate, workflow lint and the tool trial |
| `sync-master.yml` — **Sync master with main** | `push: main`, manual dispatch | No | Fast-forwards the `master` mirror; fast-forward only, so a divergent `master` fails loudly |
| `release.yml` — **Release** | `push: v*` tags, manual dispatch | No (`disabled_manually` today) | Builds the four declared targets, gates them, and publishes the GitHub Release. Nothing here runs on a branch or a pull request |

### Jobs inside `ci.yml`

| Job | Runner | Blocking? | What it proves |
| --- | --- | --- | --- |
| `validate-posix` | `ubuntu-24.04` (linux-x64), `macos-latest` (darwin-arm64) | **Yes** | `cargo test --workspace --locked`, the native worker builds, then `scripts/verify-gate.mjs --skip-install`: no unauthorised skips (`DSH_OPS_REQUIRE_RUNTIME=1` on POSIX turns a missing runtime into a failure), every suite file on disk was collected, and the packed artifact unpacks and passes `native-runtime check` |
| `validate-macos-intel` | `macos-15-intel` (darwin-x64) | **No** (`continue-on-error`) | The same gate on Intel macOS, including the Mach-O x86_64 worker and its receipt; it runs on every push, pull request and merge group and uploads `native-darwin-x64`. The leg measured **318 s**, past the >300 s line (#316), so it is a signal, not a gate (see below) |
| `validate-windows` | `windows-latest` (win32-x64) | **No** (`continue-on-error`) | The same gate on Windows, and it still runs on every push, pull request and merge group — the result is a **signal, not a gate**: a red Windows leg is a defect to fix, but it does not hold a merge (see below) |
| `node-floor` | `ubuntu-24.04` | **Yes** | `package.json` promises `^22.19 \|\| >=24`; this runs the same gate on the declared **floor** so the promise is exercised rather than asserted |
| `workflow-lint` | `ubuntu-24.04` | **Yes** | `scripts/check-workflows.mjs`: every workflow parses, declares triggers/jobs/permissions, bounds each job with `timeout-minutes`, avoids `write-all` and `pull_request_target`, and keeps `ci.yml`'s aggregate check wired to every blocking job — in `needs` and in its failure loop — while keeping every `continue-on-error` job out of both |
| `source-size` | `ubuntu-24.04` | **Yes** | `scripts/check-file-size.mjs`: every tracked code file stays at or under 1000 lines. The file set comes from `git ls-files`, so a new module is in scope the moment it is added |
| `tools-trial` | `ubuntu-24.04` | **No** (`continue-on-error`) | Boots a real host and calls every published tool; a broken tool shows up in its own job and in the uploaded `tools-trial-report` without blocking unrelated work |
| `ci-required` | `ubuntu-24.04` | — (this is the check to require) | Collapses the matrix into one status: it fails unless every blocking job succeeded, and it waits only on blocking jobs — `validate-windows`, `validate-macos-intel`, `tools-trial` and `bench-smoke` are `continue-on-error` and are deliberately not in its `needs` |

`validate-windows` is non-blocking by measurement, not by preference: on `main` after #307 the leg took **527 / 529 s** — up from 482 s before #307, because `npm ci` now downloads the 411 MB Windows Bash payload — while the blocking legs took 136–139 s (Linux x64) and 168–182 s (macOS arm64). That is well past the approved ">300 s → non-blocking" line (#316); splitting the leg into shards was measured at 1.5–2.4× the runner minutes and still stayed above 300 s on a slow runner. It is still a signal worth reading — a red Windows run is a defect — but the aggregate check does not wait for it, so a merge does not pay for the slowest leg.

`validate-macos-intel` follows the same rule. On the PR run that added the target it took **318 s**, against 174 s for Linux x64 and 146 s for macOS arm64 in the same run. It still runs on every event and uploads `native-darwin-x64`; a red Intel run is a defect to fix, not a reason to hold the merge. The blocking set remains Linux x64 and macOS arm64, plus `node-floor`, `workflow-lint` and `source-size`.

`connectivity` of the required check matters more than its name: require **`CI required`**, not the
per-platform names. The blocking matrix expands into one check per runner, so requiring those names
by hand means keeping them in sync forever, and losing the gate the day a runner label changes.
`scripts/check-workflows.mjs` fails if `ci-required` stops depending on every blocking job, starts depending on a `continue-on-error` one, or drops a blocking job from its failure loop.

## Reproduce it locally

```bash
npm ci --ignore-scripts --registry=https://registry.npmjs.org
cargo test --workspace --locked --manifest-path native/Cargo.toml
npm run build:ptc

# The gate, exactly as CI runs it (POSIX: a skipped runtime suite is a failure, not a pass)
DSH_HOME=$(mktemp -d) node scripts/verify-gate.mjs --skip-install

# The workflow lint, the size gate and the tool trial
node scripts/check-workflows.mjs
node scripts/check-file-size.mjs
node scripts/tools-trial.mjs
```

`DSH_OPS_SUITE_TIMEOUT_MS` and `DSH_OPS_RETRY_TIMEOUTS=1` are set in CI (300s and one retry of a
*deadline* only — a logic failure is never retried). Without them a slow runner can turn a passing
suite into a red run; with them, a retry prints, so a green summary still shows what happened.

## One-time repository settings (admin)

Actions are **enabled** at repository level — `ci.yml` and `sync-master.yml` are `active`; only
`release.yml` is `disabled_manually`, which is that file's documented state, not a repository
outage. Verify at any time:

```bash
gh api repos/T-Auto/dsh-ops/actions/workflows --jq '.workflows[] | "\(.state)\t\(.path)"'
```

Two settings still have to be made by a maintainer with admin rights (they cannot be expressed in a
workflow file):

1. **Require the gate on `main`.** Until this exists, every green check above is advisory: a reviewer
   can merge on red.

   ```bash
   gh api -X PUT repos/T-Auto/dsh-ops/branches/main/protection \
     -H 'Accept: application/vnd.github+json' \
     -f 'required_status_checks[strict]=true' \
     -f 'required_status_checks[checks][][context]=CI required' \
     -F 'enforce_admins=false' \
     -F 'required_pull_request_reviews=' \
     -F 'restrictions='
   ```

   `strict=true` also demands that the branch be up to date with `main` before merging, which is what
   stops "green on an old base" from being merged on top of a red `main`.

2. **(Optional, recommended) Turn on the merge queue.** CI already listens for `merge_group`, so a
   queued group is validated as a unit. Enable it in **Settings → Rules → Rulesets** for `main`
   (admin), then the required check above applies to groups instead of individual PRs.

`release.yml` stays disabled on purpose. When a release is actually planned, an admin enables it with
`gh workflow enable Release`, dispatches it once on `main` as a dry run (the `publish` job is skipped
for a non-tag ref, so nothing is written), checks the three `native-*` artifacts plus `release-dist`
and `SHA256SUMS`, and only then pushes the `v*` tag.

## Fork pull requests

Two GitHub mechanics decide whether a pull request runs anything at all:

- For a `pull_request` event GitHub reads the workflow files **from the pull request itself**, not
  from `main`. A branch whose head predates the live `ci.yml` therefore starts no run, and the
  checks listed above only appear once the branch carries a `pull_request` trigger.
- The first run for a pull request opened from a fork waits for a maintainer to approve it
  (`action_required`); every later push to that branch runs without a new approval. Approving one is
  a write on the run, not on the branch:

  ```bash
  gh api -X POST repos/T-Auto/dsh-ops/actions/runs/<run-id>/approve
  ```

A pull request whose head is a branch of this repository runs immediately and needs neither.

## Known gaps, stated rather than hidden

- **`rustfmt` and `clippy` are not enforced.** `cargo fmt --all --check` is currently not clean, so
  wiring it in as a blocking job would paint every PR red for formatting. Fix the tree first, then
  add the job.
- **`actionlint` is not used.** It cannot be installed on these runners without network installs, so
  `scripts/check-workflows.mjs` covers the structural half of what it does (triggers, permissions,
  job shape, the aggregate-check wiring). Expression-level type checking is not covered.
- **One suite is intermittently red on macOS.** `linux-protocol`'s "concurrent replaces of one file
  are atomic" has failed on `macos-latest` in several unrelated runs (#163); re-running the job
  passes. It is a real concurrency window in the native publication path, not a test defect — see
  #168.
- **`Release` has never run end to end.** It is disabled, so its YAML is reviewed but unexecuted;
  the first dispatch on `main` is the real test.
