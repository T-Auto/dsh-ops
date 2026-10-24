# Contributing

Welcome to dsh-ops. This guide covers how work is claimed, how to build and verify locally, and the
conventions a pull request is reviewed against. 中文版：[贡献指南.md](贡献指南.md).

## Contents

- [What dsh-ops is (and is not)](#what-dsh-ops-is-and-is-not)
- [Workflow: issue first, then PR](#workflow-issue-first-then-pr)
- [Development environment](#development-environment)
- [Building the plugin and installing from source](#building-the-plugin-and-installing-from-source)
- [Building the native worker](#building-the-native-worker)
- [The verification gate](#the-verification-gate)
- [One CI run per pull request](#one-ci-run-per-pull-request)
- [Writing tests](#writing-tests)
- [Code and documentation conventions](#code-and-documentation-conventions)
- [Commits and pull requests](#commits-and-pull-requests)
- [Boundaries that must not be crossed](#boundaries-that-must-not-be-crossed)
- [License and attribution](#license-and-attribution)

## What dsh-ops is (and is not)

- **Minimal and low-intrusion.** dsh-ops only adds extra, easy-to-use tools to DSH — even bash is
  provided as its own `ops_bash`. Changes to DSH's original behaviour are limited to *optionally*
  hiding duplicated official tools, so the plugin stays compatible with other plugins.
- **Integration code lives apart from the core.** When dsh-ops cooperates with another DSH plugin,
  that integration layer gets its own area and stays fully decoupled from the core logic.
- **Small surface on purpose.** The team wants code and features to stay small. New features need an
  approved issue before any code is written.

## Workflow: issue first, then PR

1. **Every PR must link an issue**, and you must **claim the issue** (comment or get assigned)
   before starting. A claimed issue is how contributors see who is working on what and avoid
   duplicated work. A PR without a claimed issue will not be accepted.
2. **Issues are PR workspaces.** Open-ended bug discussions and feature ideas belong in
   [Discussions](https://github.com/T-Auto/dsh-ops/discussions); an issue should describe concrete
   work that a PR will close.
3. **Features need approval.** Write the issue first and wait for a maintainer to approve it.
4. **Large changes are split.** A big change (for example #151) is cut into issues that can be
   reviewed independently; each slice is developed on its own `work/<topic>` branch.

## Development environment

| Component | Requirement |
| --- | --- |
| Node.js | `^22.19` or `>=24` (`package.json#engines`; CI uses 24) |
| Rust | `1.97.1` (the toolchain CI pins); needed to build the native worker |
| Target host | DSH `0.2.0-rc.2` |
| Linux only | the `acl` package for the POSIX ACL checks |

```console
npm ci --ignore-scripts
npm run build             # compile src/ to lib/ and copy component assets
npm run build:ptc         # build and stage the native worker (see below)
npm run verify
```

## Building the plugin and installing from source

Edit the plugin in `src/` using strict TypeScript or TSX. `npm run build` emits JavaScript into
`lib/` and copies component manifests, locale files, icons and the panel HTML. `lib/` is ignored by
Git and must not be edited by hand. Package exports, component entries and tests load `lib/`;
runtime imports retain their `.js` paths.

Run `npm run build` after changing source or assets and before invoking a suite directly with
`node test/run.mjs <filter>`. `npm test`, `npm run test:ptc` and `npm run verify` build first;
`npm run typecheck` checks all plugin source without emitting files. JavaScript source under `src/`
is rejected by the build, including unimported files that the TypeScript compiler would otherwise
silently ignore. Repository scripts and tests may continue to use JavaScript.

For a local or Git-source installation, build and pack a checkout before installing it into DSH:

```console
npm ci --ignore-scripts
npm run build
npm run build:ptc
npm pack
```

On Windows the pinned Bash payload is installed by `npm ci`; if it is missing (for example a checkout installed with `--omit=optional`), run `node bin/dsh-ops.mjs bash-runtime install`, then `npm run build:bash-ipc` before packing. For an offline build, set `DSH_OPS_TEST_BASH` to the absolute pinned `bin/bash.exe`; the build/test helper verifies its digest. The gate acquires its own temporary fixture unless this variable is provided. Install the resulting
`dsh-ops-<version>.tgz` with the DSH CLI for your target profile (see the README). `npm pack` runs
the build through `prepack`, unless lifecycle scripts are disabled. An unbuilt Git checkout has
no `lib/` and is not ready to load; there is no `prepare` hook. Keep development dependencies
installed while building, since they include the compiler. The published tarball contains
compiled `lib/` and its assets, excludes `src/`, and does not require consumers to compile the
plugin.

## Building the native worker

Most suites drive the real native worker. Without one they cannot answer, and they **skip**:

```console
cargo test --workspace --locked --manifest-path native/Cargo.toml   # worker unit tests
npm run build:ptc                                       # build + stage runtime/<platform>-<arch>/
npm run build:bash-ipc                                  # Windows only: Bash IPC proxies
```

What a skip means locally:

- `test/run.mjs` counts a skip apart from a pass. A machine with no worker reports
  `N suite(s) passed, M skipped` — that is **not** a green gate.
- `DSH_OPS_REQUIRE_RUNTIME=1` turns any runtime-absence skip into a failure. The gate sets it on
  Linux and macOS, so if you have not built the worker, expect those suites to **fail** there.
- `DSH_OPS_ALLOW_SKIPS=tui-host,tui-native` keeps suites that need an optional external checkout
  (`DSH_OPS_TUI_ROOT`, `DSH_OPS_TUI_WORKER`) as skips even under `DSH_OPS_REQUIRE_RUNTIME=1`.
- Platform skips are named and fixed in `scripts/verify-gate.mjs` (`ALLOWED_SKIPS`): on Windows
  `file-metadata`, `linux-attributes`, `linux-shell`; on POSIX only `mount`, and only when no worker
  can be resolved. Any other skip fails the gate.

## The verification gate

- `npm run verify` — build `src/` into `lib/`, run `scripts/validate-manifest.mjs`, then
  `test/run.mjs` (every `test/*.test.mjs`
  in its own process with its own temporary `DSH_HOME`).
- `node scripts/verify-gate.mjs --skip-install` — **the release gate**, exactly what
  `.github/workflows/ci.yml` runs on Windows x64, Linux x64 and macOS arm64: worker unit tests, build
  and stage, manifest floor, every suite, the allowed-skip set, the suite inventory on disk, and the
  packed artifact.
- `node test/run.mjs <filter>` runs only the suites whose file names contain `<filter>`, e.g.
  `node test/run.mjs mount file-operations`.

How to read the gate and the expected numbers per host: [verify-locally.md](verify-locally.md).
CI runs on every pull request and every push to `main`, `0.3.2` and `release/0.4.0`. The two POSIX legs (`validate-posix`: Linux x64, macOS arm64) block a merge; the Windows x64 leg (`validate-windows`) still runs on every event but is non-blocking — a red Windows run is a defect to fix, not a reason to hold the merge (#316).

## One CI run per pull request

All target branches are covered, including stacked feature branches. Repository enforcement requires the separate [administrator ruleset and acceptance steps](required-ci-admin.md); passing CI alone does not configure branch protection.

Every pull request must show one run of the [Cross-platform validation](https://github.com/T-Auto/dsh-ops/blob/main/.github/workflows/ci.yml)
workflow that its **own `pull_request` event** triggered. The aggregate job **`CI required`**
summarises the two blocking POSIX legs (Linux x64, macOS arm64); the non-blocking Windows x64 leg
runs alongside it and is deliberately not waited on. That job's run URL is what the pull request
template asks for.

- **What triggers it.** `ci.yml` runs on `pull_request` targeting `main`, `0.3.2` and
  `release/0.4.0` (and on `push` to the same branches, plus `merge_group`). GitHub reads the
  workflow file from the pull request's own head, so a PR against any of those branches starts a
  run when it is opened or updated.
- **How to confirm it.** List the runs for the branch, check the event, then read the run URL:

  ```console
  gh run list --branch <branch> --workflow ci.yml --event pull_request --limit 1
  gh run view <run-id> --json url,event,conclusion --jq '"\(.url) \(.event) \(.conclusion)"'
  ```

  The pull request's **Checks** tab shows the same run; a green `CI required` there is the check
  that has to pass.
- **Fork contributors (#150).** Two verifiable paths: (a) open the pull request upstream so the
  repository triggers the `pull_request` run — a first run from a first-time fork contributor can
  stop at `action_required` until a maintainer approves it; or (b) open a pull request **inside
  your fork** from the feature branch to the fork's default branch, which is also a `pull_request`
  event — paste that URL and mark it as the fork run. Running the workflow by hand or relying on a
  `push` run is still not a substitute.
- **A hand-dispatched run is not a substitute.** 26 of the 27 pull requests merged into
  `release/0.4.0` had no `pull_request` run at all: the green check came from a manual
  `workflow_dispatch`, which validates a branch but never the merge (#303).
- **Required check.** Making `CI required` a *required* status check on `main`, `0.3.2` and
  `release/0.4.0` is a repository-settings change that needs admin rights; it is tracked in #303
  and cannot be done from a code PR. Until it lands, the rule is enforced in review.
- **Dependabot pull requests.** Once the check is required, a dependency bump whose PR is red is
  blocked like any other: rebase or re-run first, fix the version/build in the PR if the upgrade is
  wanted, and close it with a note if it is not. Do not bypass a required check with admin rights;
  an upgrade that cannot pass CI is not merged.

## Writing tests

- **New behaviour comes with an assertion** that fails when the implementation is reverted (red/green
  at the behaviour level, not just the code shape). Mount-related changes must be falsifiable in
  `test/mount.test.mjs`.
- **Prefer real calls over schema checks.** A tool is covered when a suite calls it through the real
  worker or host and asserts the result, including its failure paths (permission denial, CAS
  conflict, no-follow, unsupported metadata, `AUTHORITY_CHANGED`).
- **One suite = one `test/*.test.mjs` file = one process.** The gate asserts that every suite on
  disk was collected. Shared helpers live in `test/lib/` and must **not** end in `.test.mjs`.
- **No silent skips.** A whole suite skips only through `skipSuite()` in `test/lib/harness.mjs`
  and must be on the allowed list. A single check whose fixture cannot be built on a host prints a
  named `... fixture unavailable: <reason>` line instead of passing quietly.
- **No retries to hide flakes.** A concurrency assertion that fails intermittently is a bug in the
  implementation; fix the cause. Retries in the gate (#164) only ever cover suite timeouts.

Capability names, component ownership, presentation modes, mutation/concurrency flags and file/PTC
schemas live in `src/capabilities/`. Keep new capability metadata there; adapters own registration
and rendering. `src/kernel/` defines the 0.4 `Outcome<T>`, coverage/search/reference types and
error-to-retry policies. Their later adapter migrations will change wire results; this foundation
preserves existing output. `node test/run.mjs capabilities kernel-errors kernel-types` checks the
catalogue, retry rules and positive/negative TypeScript contracts. Node declarations are pinned to
`@types/node@22.20.5` (published 2026-10-01) to type the supported Node 22 API without runtime code.

## Code and documentation conventions

- **Language:** code, comments, CLI output and commit messages are English. User-facing docs are
  bilingual; maintainer-only notes may be Chinese.
- **Doc pairs:** each document in `docs/` exists in English and Chinese, e.g. `docs/usage.md` and
  `docs/使用指南.md`. Update both in the same PR.
- **File size:** keep new files under about 500 lines. If a file grows past that, split it into
  modules and group related modules in a folder, following the existing `src/components/*` and
  `test/lib/` layout.
- **Tool names** always come from `publicToolName()` in `src/policy.ts`; never hand-write the `ops_`
  prefix.
- **Config validation** lives in `src/config.ts`; an unknown key is an error that names the key.
  Defaults in `cordis.patch.yml` must match the defaults in code.
- **Parsing and probing** happen synchronously in `apply`; `required: true` must refuse activation
  at load time.

## Commits and pull requests

- Small commits with conventional, imperative English messages, e.g.
  `fix: report undeclared background arguments as argument errors (#14)`.
- Use your real identity; no empty commits, no forged authorship, no rewriting pushed history.
- Fill in `.github/PULL_REQUEST_TEMPLATE.md`. The **Validation** section carries real command output
  (pass/skip/fail counts), not ticked boxes.
- Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) when behaviour or shipped
  documentation changes, or state in Validation why it is not needed.
- Do not add dependencies or change the version or `optionalDependencies` in `package.json` unless
  the issue asks for it.

## Boundaries that must not be crossed

- The host half **must not import `@deepseek-ai/*` values at load time**; use `ctx.inject([...])`
  / `ctx.get()` for host services.
- **Never rewrite the shared tool registry.** Publish `ops_*` tools only through this plugin's own
  `ctx.tools.register`.
- Prompt sections read tools through `ctx.get('tools')`, not `ctx.tools`.
- Do not remove tool contracts (argument semantics, defaults, path base, paging completeness,
  permission boundaries) to save schema or prompt bytes.

## License and attribution

Current releases are MIT-licensed. FastCtx was removed in 0.3.2; the releases that shipped it were
`MIT AND Apache-2.0`. FastCtx's Apache-2.0 text, upstream notice and the acknowledgement reproduced
in `NOTICE` remain for those releases **and must stay verbatim** — do not "polish" it.

Native build and acceptance details: [native-ptc.md](native-ptc.md) and
[manual-validation.md](manual-validation.md).

The credential fence, trusted path anchors and permission helpers are strict TypeScript modules (`src/credential-policy.ts`, `src/authority-paths.ts`, `src/permissions.ts`). Their emitted `.js` imports and wire failures stay stable. Authority policies use type-only host definitions; unknown worker failures must be narrowed before use. `node test/run.mjs kernel-types authority credential-fence credential-denial safety-atomicity permissions` covers the typed boundary and existing authority behavior.

`src/profile-install.ts` and `src/session-temp.ts` are strict TypeScript helpers with unchanged emitted paths. Profile mutations still delegate to the official CLI; manifest data is narrowed before reading it. Private temporary directories retain their session-derived names and refusal of link/file targets. `node test/run.mjs profile-temp kernel-types` checks delegation, dry-run, failures and typed outcomes.

`src/index.ts` types the component entry against the public Cordis `Context` and `Agent` contracts. Raw configuration remains `unknown` until validation; callbacks and tool-denial decisions retain their public host signatures. Runtime imports remain `.js`, and host dependencies remain type-only at module load. `node test/run.mjs kernel-types mount bundle-startup progressive-loop` checks the type boundary, scoped startup/disposal and next-step publication.

The settings integration tests use exact development-only host settings, profile boot and config
editor packages at `0.2.0-rc.2`, with matching Cordis loader/group/include, CosmoKit and Schemastery
patch versions. They exercise the real profile writer and component reload instead of substituting
an in-memory save. These packages are not production dependencies or host runtime imports.

Browser settings are strict TSX. The build uses the existing TypeScript compiler to produce the
host's lazy `./client` factory, with React supplied by the host. Exact development-only React 18.3.1,
React type packages, jsdom 26.1.0 and the pinned `0.2.0-rc.2` client contracts support compilation,
DOM interactions and the real host slot lifecycle tests. No browser bundler or production dependency
is added. `settings-ui`, `settings-client`, `settings-host` and `settings-runtime` suites cover the
form-to-profile and reviewed-action boundaries.

The optional carrier regression also uses development-only `@deepseek-ai/dsh-client-modules`
`0.2.0-rc.2` (published 2026-09-29) to assert actual client registry activation, teardown and
restart against temporary installed profiles. `settings-carrier` covers exact composition,
backups and atomic rollback; it never migrates a developer profile.

`src/panel/collect.ts` uses typed filesystem seams and validates persisted event fields before folding. Valid capture documents keep their text, counters and archive behavior. Invalid persisted text/usage/timestamp fields are counted as malformed and mark the result degraded, with incomplete usage totals; they cannot be silently coerced. Stopping still cancels queued work, waits for issued I/O and retains the append log; explicit sealing remains separate. Run `node test/run.mjs ops-panel-collect panel-records panel-stop kernel-types` for recovery, bounded data, physical-stop and type checks.
