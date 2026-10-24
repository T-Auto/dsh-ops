# Running the whole gate on a host (and reading what it says)

`node scripts/verify-gate.mjs` **is** the release gate: `.github/workflows/ci.yml` invokes this
exact script on every platform, so what you run locally is what gates a merge. It runs the steps in
order — native worker unit tests, build and stage, the suite set, the staged closure, and the packed
artifact — and then **asserts instead of printing**: the manifest floor, the suite inventory on
disk, and the set of suites allowed to skip on this platform. Three properties are the reason it
exists:

- **A skip is never a pass.** `test/run.mjs` already counts skips apart from passes,
  but a host that silently skips a suite still exits 0. This script knows which suites
  may skip on this platform, names any other one, and fails on it.
- **The artifact, not just the build.** `npm pack` honours `files`, so a package that silently drops
  `runtime/` installs fine and only fails inside the user's profile. The gate therefore packs,
  unpacks and runs the closure check against the unpacked package.
- **The numbers in the docs cannot go stale.** The suite total is *derived* from `test/*.test.mjs`
  (the same inventory `test/run.mjs` discovers) rather than pinned, and the manifest validator's
  count is asserted against a floor. The per-platform skip set is asserted here, so a newly guarded
  suite is a failure rather than a quiet drift.

```bash
node scripts/verify-gate.mjs                 # this host, full gate
node scripts/verify-gate.mjs --skip-install  # node_modules is already current
node scripts/verify-gate.mjs --json          # machine-readable summary
node scripts/verify-gate.mjs --keep-going    # run every step, report all failures
```

Exit codes are part of the contract: `0` every step passed, `1` a step failed, `2` the
host cannot answer this gate (a `--target` that is not the host, a missing toolchain).
There is no exit code for "green with a surprise in it" — that is `1`.

## The pull request run (CI, not this host)

Feature-branch targets also run CI. Applying and proving repository enforcement is a separate [administrator task](required-ci-admin.md); a local gate never configures GitHub rulesets.

Every pull request must show one `Cross-platform validation` run triggered by its own
`pull_request` event, and paste the `CI required` run URL into the PR template. A local
`verify-gate` run — however green — is not that run: it proves the checkout, not the merge
request. Confirm it with:

```console
gh run list --branch <branch> --workflow ci.yml --event pull_request --limit 1
gh run view <run-id> --json url,event,conclusion --jq '"\(.url) \(.event) \(.conclusion)"'
```

Fork contributors have two verifiable paths (open the PR upstream, or open a PR inside the
fork); see [CONTRIBUTING.md](CONTRIBUTING.md#one-ci-run-per-pull-request). A hand-dispatched
`workflow_dispatch` run, or a `push` run on a release branch, does not count.

## What each step proves

| Step | Command | What it settles |
| --- | --- | --- |
| versions | `node --version`, `cargo --version` | The toolchain is the pinned one, before anything else can be blamed |
| install | `npm ci --ignore-scripts --registry=https://registry.npmjs.org` | Locked dependencies, and no install-time script runs. The Windows Bash payload is an optional dependency, so a Windows x64 install carries it; a Linux install skips it through npm's `os` filter, and `--ignore-scripts` guarantees no install script tries to fetch it |
| worker unit tests | `cargo test --workspace --locked --manifest-path native/Cargo.toml` | The Rust worker in isolation |
| stage | `npm run build:ptc` | Builds the worker **and stages it with its provenance receipt** into `runtime/<platform>-<arch>/`. Skipping this is the most common way to get a misleading failure — see the traps below |
| Bash fixture | `node bin/dsh-ops.mjs bash-runtime install` (Windows) | Repair path for a missing or incomplete payload; `DSH_OPS_TEST_BASH` can name a verified offline copy |
| platform payloads | `npm run build:bash-ipc` (Windows) | The Windows IPC proxies |
| manifest | `npm run validate:manifest` | The declaration layers agree; asserts a floor of `59` (currently `62`) |
| suites | `DSH_HOME=<temp> DSH_OPS_REQUIRE_RUNTIME=1 npm run verify` | Every suite on this host. `DSH_OPS_REQUIRE_RUNTIME=1` turns a runtime-absence skip into a failure, and `DSH_HOME` must be a temporary directory or `test/lib/harness.mjs` refuses to run |
| closure | `node bin/native-runtime.mjs check --platform <target>` | The staged runtime is complete and its receipt matches the worker byte for byte |

## The tools trial (separate, not part of the gate)

`DSH_HOME=$(mktemp -d) node scripts/tools-trial.mjs` boots a real host, mounts the plugin, and
**calls every tool this build publishes** against real files in a temporary workspace, printing a
table (`tools-trial-report.md`). Tools the build does not publish, and published tools without a
scenario yet, are reported as `skipped` with the reason, never silently.

It is not a suite on purpose: `test/*.test.mjs` is the inventory the gate asserts was collected, and
this trial is not a gate. CI runs it in its own `tools-trial` job with `continue-on-error`, so a tool
that breaks is visible without blocking a merge.

## Expected numbers

| Host | Suites | Skipped, and why |
| --- | --- | --- |
| `linux-x64`, `darwin-arm64` | all of `test/*.test.mjs` | `tui-host` and `tui-native` unless an optional DSH-TUI checkout is present (`DSH_OPS_TUI_ROOT`, plus `DSH_OPS_TUI_WORKER` for the native one); `mount` only when no native worker can be resolved there |
| `win32-x64` | same inventory | the two above, plus `file-metadata` and `linux-attributes` (mode bits, POSIX ACLs, user xattrs, inode identity, sparse allocation) and `linux-shell` (the POSIX bash rung, which is its own subject) |

`DSH_OPS_REQUIRE_RUNTIME=1` — which turns any skip into a failure — is set on the POSIX hosts
only. On Windows the three suites above skip by platform, and `test/run.mjs` cannot tell that
apart from a missing runtime, so the script keeps its protection there through the skip set
instead: anything skipped outside that list fails. The suites that would betray a worker that was
never built (`permissions`, `ptc`) are not in the list.

**A note on what "green" cost.** `5bf33d4` was red on Linux and macOS in `test/bin.test.mjs`
(2 of 19 checks) because the ladder's worker stand-in was a non-executable text file and the
ladder report had started going through the resolver's POSIX execute-bit check. The scripts
here are what surfaced it — the gate reports a red host rather than smoothing over it, which is
also why it names the failing step and the failing suite count when a host is red.

The manifest validator's count grows with the manifest — **62** at the time of writing — so the gate
asserts a **floor** (`59`) instead of the current number: a growing manifest cannot make the gate
stale, while a validator that collapses and reports nothing still fails it. The suite total is
whatever `test/*.test.mjs` holds (**34** at the time of writing) and the gate derives it from that
directory, so the assertion stays meaningful (a suite whose file is on disk but which stops being
collected is a failure) without being invalidated by every new suite. For history: on `5bf33d4`, the
commit that removed the FastCtx and background components, the numbers were 59 checks and 27 suites;
before it they were 61 and 30. The script fails when a host disagrees — which is how `docs/windows-verification.md` learned it had been
promising "exactly 2" skips on Windows when the real answer is three.

## Traps that produce a wrong verdict

- **A stale staged runtime.** `test/permissions.test.mjs` and friends drive the worker
  the resolver picks, which is the **staged** copy under `runtime/`, not
  `native/target/release`. Rebuild after switching branches (`npm run build:ptc`) or the
  suites fail against an old binary — the giveaway is a worker-side
  `unknown field ...` from a request the current code sends.
- **Checking the package out under `/tmp` on Linux.** The sandbox provider runs `bwrap`
  with `--tmpfs /tmp`, which hides the checkout, so the package can never exec its own
  worker. Sandbox-dependent suites then fail as `SANDBOX_UNAVAILABLE`.
- **Running a suite file directly.** Always `node test/run.mjs <name>` (or the gate):
  the harness requires `DSH_HOME` to point inside a temporary directory and exits 77 for
  a skip, which only the runner interprets.
- **A non-ASCII `CARGO_HOME` or target directory on Windows.** mingw's `gcc` driver drops
  non-ASCII paths, so the build fails somewhere that looks unrelated.
- **Reading a skip as a pass.** If a suite's subject does not exist on this host, the
  suite has to say so. `DSH_OPS_REQUIRE_RUNTIME=1` is set by the gate precisely so that
  the two runtimes cannot go missing quietly.

## What this gate cannot answer

The security-descriptor half of `ops_replace` on Windows (W1a–W1e) and the two
concurrency windows (W1g/W1h) need a host where DACLs are measurable and where one
process can hold a lock while another is mid-call. A DSH agent sandbox cannot do either:
under `workspace-write` Node cannot spawn the worker at all (`spawn EPERM`), and under
`danger-full-access` the worker's own atomic create is refused. That half stays a manual
checklist — `docs/windows-verification.md` §W1 and §W3, tracked in **#119** — and a hosted
`windows-latest` runner can run it without a human, because a runner is not an agent
sandbox (the repository already measures DACLs in hosted tests).
