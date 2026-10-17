# Changelog

All notable changes to this package are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### A repository-only benchmark harness, merged from #103 and #183 (#205, #173)

- `bench/` is one cross-platform harness with two measurement modes and one JSON data
  contract. It is repository-only: `files` does not carry `bench/`, no release build
  touches it, no default CI run executes it, and `npm run bench:*` outside a checkout
  fails with exit 2 instead of a dead path.
- The model-free tool-level comparison is adopted from #103 (@OldLigant): its
  `MATCH / MISMATCH / EXPECTED_DIFFERENCE / EXPECTED_REJECTION / UNSTABLE` state machine,
  strictly created (never overwritten) reports, and the fixed size-boundary fixture corpus.
- The model-driven token A/B skeleton is adopted from #183 (@Richeir): pass-drop before
  cost, per-task pairing, the geomean summary and the archive of the raw evidence.
- This set follows #173's intent: local performance measurement. Timings are printed as
  human evidence, never adjudicated; a cost direction is read only when the paired,
  both-sides-passing delta clears the A/A noise floor.

### Platform defaults confirmed by the operator (#170)

- PTC enhancement is enabled by default (`defaultEnabled: true`, no disabled bundle row).
  This changes the published 0.3.0/0.3.1 opt-in baseline, but does not force PTC presentation:
  native/hybrid sessions do not acquire batch/result tools or their scoped guidance.
- Shell stays enabled on Windows, Linux and macOS. Strict official-tool hiding stays opt-in.
  Existing explicit profile choices are not migrated or overwritten; users can disable the
  PTC component explicitly. Enabling the component does not raise filesystem permissions.
- The catalog's POSIX shell-default claim now agrees with the bundle/manifest. No unsupported
  `defaultEnabledPlatforms` field or platform `!!js` expression is needed.
- No token saving is claimed. The pinned-host declaration-cost check is recorded in
  `docs/ptc-cost.md`: PTC-only added 4,671 prompt characters in the isolated Windows sample;
  native/hybrid added zero. This is not a tokenizer or net-usage measurement. #145/#148
  comparisons require equal-task usage/latency/retry evidence before claiming savings.

### PTC paging and discoverability (#171, #160)

- Default enablement is decided separately in #170. Enabled PTC-only scopes
  receive batch/result usage guidance; native/hybrid scopes do not inherit that guidance or tools.
- Argument schemas use the pinned host's supported JSON Schema subset, retaining numeric limits
  as descriptions and native validation. Actual host SDK rendering is tested against `unknown`.
- Result pages expose expiry, sourceTotal and stable ordered-row contentHash before projection or
  filtering. Hashes are observations, never authority. First/last/beyond-end pages, invalid IDs,
  ownership, expiry, release and oversized rows have executable assertions, including real run_code.
- Expired references return `REFERENCE_EXPIRED` with release/reobserve guidance; batch audit pages
  have `expires: null` and cannot be released. Current authority and PTC presentation are rechecked
  before execution; changed authority never silently reuses the producing request's permissions.

### Safety and atomicity (#168)

- Darwin nonempty extended ACLs now fail closed with `METADATA_UNSUPPORTED` before staging.
  APFS cloning alone is not an exact ACL guarantee; deny-delete entries also prevent safe
  staging rename/unlink. Use a dedicated metadata-aware tool for ACL-bearing files; changing
  DSH permissions is not a repair. Plain files still require supported metadata-preserving cloning.

- Replacement receipts hash observed bytes, not a second racy read. Cooperating writers retain
  the persistent path lock across CAS and atomic publication. Later-file failures retain
  `effectState: applied` when earlier files have changed; receipt output is bounded before writes.
- Only trusted host anchors are canonicalized; descendant links remain subject to native
  no-follow validation. Session temp paths never fall back to the shared root.
- Windows replacement preserves supported owner/group/DACL/basic metadata through the existing
  metadata crate. Darwin requires metadata-preserving cloning. Unsupported metadata returns
  `METADATA_UNSUPPORTED` with repair guidance, not permission-selector advice.
- `CREDENTIAL_DENIED`, `PATH_RESTRICTED`, `AUTHORITY_CHANGED` and `EXECUTION_RESTRICTED` distinguish
  credential/path fences, changed authority and OS execution restrictions from actual DSH denials.
- This cut retains four public file tools. The seven additional tools and end-to-end
  `expectedRevision` acceptance belong to #167; the shared revision primitive is tested here.
  Locks serialize cooperating OPS writers, not unrelated programs. Cross-compilation is not
  macOS/Linux runtime acceptance; repeated macOS/APFS concurrency remains an acceptance gate.

- Tools trial: `node scripts/tools-trial.mjs` calls every published tool on a real host and prints a
  per-tool table; CI runs it in a separate, non-required `tools-trial` job.
- Documentation now matches the shipped 0.3.1 surface (no behavior change): the component reference
  describes `ops_inspect_local_file` as the bounded UTF-8/hex reader it implements (not multi-range,
  extra encodings or PDF), calls `ops_replace` a literal replacement, states that read-only refuses
  replacement including its dry run, and names the session's private temporary directory as the
  workspace-write fence; the Chinese reference is kept in sync. `docs/schema-measurement.md` and
  `docs/schema-current.json` are marked as the historical 0.2.x FastCtx snapshot, and the READMEs
  mark the DOC/PDF, web-search and crawl4ai-style tools as roadmap items instead of shipped ones.

### The config-update marker goes to the profile patch, and never to the composed tree

`mountConfigUpdates()` persisted its one-time marker with `entry.parent.tree.write()`, an API that
writes the **whole composed tree** back into the profile root file. The loader documents that file
as an empty entry list and resets it on boot, so the baked copy carried other plugins' rows —
`ui-theme`'s `preference`/`fontSize` above all — which echoed the previous value back into the
settings scope and made the theme and font size bounce (dark → system → dark); on a desktop profile
the baked rows made the whole bundle fail to mount on the next start, silently (#91, #108).

The marker now goes through `configEditor.edit()`, so it lands in the active profile's patch layer,
leaves every other row alone, is validated as a whole candidate before anything reaches disk, and
preserves comments and `!!js` expressions. `EntryTree.write()` is never called again, and the suite
installs it as a tripwire that throws if anything reaches for it.

When the editor is unavailable, or refuses the save, the migration simply stays in effect for that
activation: no tree write, no fallback write, no error in the boot path, and the notice is emitted
once per process rather than once per activation. Combines #138 (the patch-layer channel) with #136
(the in-memory-only discipline).

### Breaking: the FastCtx background component is removed

The `dsh-ops/background` component and everything that existed only for it are gone. The file,
shell and PTC components behave exactly as before.

- **Removed tools**: `ops_run`, `ops_run_background`, `ops_job_output`, `ops_job_list`,
  `ops_job_kill`. For a long-running process, use the host `pwsh` tool's `run_in_background`, or
  detach inside an `ops_bash` command (`nohup ... & disown`).
- **Existing profiles keep loading.** A `dsh-ops/background` row left in a profile loads as a no-op
  stub: it accepts any config, publishes nothing, and logs one warning that the row can be deleted.
  The bundle patch no longer inserts the row, and the manifest no longer declares the component,
  its prompt section, or the `fastctx` tool namespace.
- **Configuration update 2.** `serverName`, `enableShellTools` and `toolCallTimeoutMs` were read
  only by FastCtx. They stay accepted and type-checked, so rows written by earlier bundles (every
  file row carried `enableShellTools: false` and `toolCallTimeoutMs: 300000`) keep validating, but
  they are no longer resolved, and `configUpdateVersion: 2` removes them from each saved
  `dsh-ops`, `dsh-ops/shell` and `dsh-ops/file` row once. A row already at version 1 keeps a later
  manual `allowSystemShellFallback: true`; the bundle patch no longer writes the keys.
- **CLI**: `resolve`, `status` without `--profile`, `build` and `provision` are removed and exit 2
  with the command that replaces each. `ladder` now reports the native worker (`worker` in
  `--json`, resolved by the same `resolveWorker()` the file component uses) instead of a FastCtx
  runtime, and its `levels` are `{ files, bash, pwsh }`. `uninstall --yes` still removes
  `<DSH_HOME>/dsh-ops` (including a FastCtx runtime an earlier version provisioned), and
  `--purge-fastctx` still removes the leftover `~/.fastctx` state.
- **Public `dsh-ops/policy` exports**: `BACKGROUND_TOOLS` and `SHELL_TOOLS` are removed;
  `ladderLevels()` returns `{ files, bash, pwsh }`, and `renderToolingPolicy()` no longer takes
  `enableShellTools`.
- **Packaging**: `vendor/fastctx/`, `packages/fastctx-win32-x64/`, the optional dependencies
  `@dsh-ops/fastctx-win32-x64` and `@fastctx/darwin-arm64`, the `build:rust`, `provision` and
  `status` npm scripts, `scripts/measure-schemas.mjs`, and the FastCtx build in CI and in
  `scripts/build-platform-packages.mjs` are removed; a release now publishes the two shell payload
  packages. `lib/paths.js` now holds `PACKAGE_ROOT` and `dshHome()`.
- **Licensing is unchanged.** The composite `MIT AND Apache-2.0` statement and FastCtx's required
  attribution are kept verbatim; FastCtx's license text and upstream notice moved from
  `vendor/fastctx/` to `licenses/fastctx/`.

### Fixed

- The inherited-root workspace-preparation test (#43) matched only the built-in Administrator's
  SDDL alias `LA`, so it failed for any other account; it now matches the current user's SID, or
  `LA` when that user is RID 500.

## [0.3.1] — 2026-10-16 — Cross-platform native tools

Exact release targets: **win32-x64, linux-x64, darwin-arm64 (Apple Silicon)**. Intel Mac, Windows ARM64 and Linux ARM64 are not supported. Bash/PowerShell binary payloads remain pinned Windows-only optional dependencies. POSIX uses host Bash; PTC remains opt-in. Final build/test evidence is linked in docs/release-0.3.1.md.

### Integrated macOS and release hardening

- Merge #67 and #81 with their commit histories; include #69 path-alias handling and #107 Windows short-path validation.
- Keep strict release closure over all three worker targets, receipt/hash/architecture checks and mandatory Windows IPC.
- Create replacement temporary files privately, clear inherited Linux ACLs when absent on the original, sync after metadata restoration, and serialize cooperating updates with a stable path lock.
- Enforce credential policy per traversed file and batch source, not only on the initial path.

### Linux x64 adaption

- Build and verify the native worker on `x86_64-unknown-linux-gnu` as a first-class target: `cargo build --release --locked`, `cargo test`, the full `npm run verify` with `DSH_OPS_REQUIRE_RUNTIME=1` (30 suites, no skip counted as a pass) and `npm run verify:release`. `npm run build:ptc` now stages the Linux worker beside the Windows one, each with its own receipt, and the release checks reject a missing or corrupt artifact for any target the package carries.
- Keep the platform paths separate instead of compromising both: directory `fsync` and metadata reapplication on POSIX, `MoveFileExW` publication on Windows, chosen per `cfg` rather than papered over with one behaviour that would be wrong on both.
- Derive platform facts when a suite runs instead of from the host it happens to be on: mount and filesystem fixtures are resolved at run time, no tool is parsed for `LC_MESSAGES`-dependent wording, and whole-suite skips are declared per platform (2 on Linux) rather than counted as passes.
- Close the release gate over the targets a checkout actually staged, so a Linux-only build passes and `DSH_OPS_REQUIRE_ALL_TARGETS=1` states the multi-platform claim; the closure message names the staged platform instead of assuming Windows.
- Document the Linux route end to end in `docs/linux-build.md` and `docs/linux构建.md`: build, stage, `npm pack`, `dsh plugin add ./dsh-ops-0.3.1.tgz`, and the gate commands with their expected output.
- Add 11 boundary suites that run on both platforms: grep across lines, replace metadata, output byte budget, update lock, hex offsets, argument and runtime diagnostics, release scope, PTC provenance, and the Linux argument/attribute suites.

### Credential reads are refused, and the write surface is the session's own

Taken from WTStarMark's PR #40, which found that DSH's filesystem layer does not fence credential
paths: a tool that reads any OS-readable file could hand a model the operator's keys and tokens.

- The file tools now refuse to read a credential location, by default and before the worker is
  spawned: `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `.docker/config.json`,
  `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc` and the DSH credential stores, plus
  `id_rsa`/`id_ed25519`-style keys, `*credentials.{json,yaml,ini}` and `service-account*.json`
  wherever they live. The refusal names the fence and the way out; a row can opt out with
  `denyCredentialReads: false`, and `DSH_OPS_DENY_READ` can only ever *widen* the list (an absolute
  entry is used as written, a relative one is resolved below the home).
- A traversal skips those directories by identity, so `ops_glob` cannot name a private key below one
  and `ops_grep` cannot match inside one — the match text never enters a result. Covered by
  `test/credential-fence.test.mjs`, which runs the same call with and without the skip.
- The shared system temp is no longer endorsed as a `replace`/batch write root: the session's own
  `dsh-ops-session-<id>` directory is, created lazily with mode `0700`. The host sandbox grants the
  whole of `/tmp` to workspace-write on Linux, so endorsing it here would let one session replace
  another's temporary files; this fence is deliberately narrower than the kernel's grant.
- A directory that holds one binary file no longer fails a whole `ops_replace`: the text files around
  it are still edited, the binary is reported through `skipped` and `skippedPaths`, and the previous
  behaviour (refusing the entire call with an error that named no file) is gone.

### Review follow-ups (@Haoming9527, #81)

- An inherited `LC_ALL` silently un-pinned the message locale. POSIX resolves `LC_ALL` before
  `LC_MESSAGES`, so on a host that sets it — a `zh_CN.UTF-8` desktop commonly sets nothing else — the
  English pin that keeps the host's `denialSignatures` matching never took effect, and a sandbox
  refusal was reported as a generic command failure (measured here before the fix:
  `LC_MESSAGES="zh_CN.UTF-8"`). `shellEnvOverrides` now neutralizes the inherited override (an empty
  value is "unset" to the C library) and carries its **encoding** intent forward as `LC_CTYPE`, which
  a host that stated its own ctype keeps. `LC_ALL=C` was not an option: it would make commands read
  UTF-8 input as bytes.
- The profile CLI fallback was Windows-only in shape: with no package-based CLI to resolve it
  selected `dsh.cmd` and launched it through `cmd.exe`, so on Linux the call died as
  `spawnSync cmd.exe ENOENT` even with an executable `dsh` on PATH. The fallback is now
  platform-aware, and the `cmd.exe` wrapper is only used on Windows.
- The Windows update lock blocked the worker's own read. Windows `LockFileEx` denies access to a
  locked range through *any* other handle, including one the same process opens, and the revision
  check re-read the target after taking the lock — so an ordinary, uncontended `replace` failed
  there with a lock violation. Linux cannot show this, because `flock` is per open file description.
  The worker now reads the current bytes through the lock handle, so nothing reopens the target
  between the check and the publish. `docs/windows-verification.md` carries the W1g case.
- Debris cleanup deleted files that merely shared a prefix. The sweep matched
  `.<name>.dsh-ops-` and removed anything that began with it, which took an operator's
  `.notes.txt.dsh-ops-personal-backup` and, for a target named `foo`, the *live* temporary file of a
  different target (`foo.dsh-ops-bar`). A leftover must now be the whole shape this writer creates:
  the tail has to parse as the v4 UUID `atomic_write` generates.
- A single long line could exhaust the worker's memory. In the content modes the grep path built one
  text item per match *before* `limit` was consulted, so a 32 KiB line matched by `pattern: "a"`
  copied that line 32 768 times and the call aborted under a memory cap instead of returning its
  first item. Matches are counted in one non-allocating pass and materialized in a second pass
  bounded by the page; `matched`/`total` stay exact, because they report what was counted.

### The shell component on Linux: the host's own bash, under a mandatory sandbox

Taken from WTStarMark's PR #40, which designed the same capability as a separate opt-in
`dsh-ops-linux` component. It lives in `dsh-ops/shell` here: `dsh-ops/file` already gives Linux the
four file tools, so a second component publishing the same four would be two names for one surface.
The capability is taken; the duplicate component is not.

- On POSIX the resolver answers from `config.bashPath`, then `PATH`, then `/bin/bash`,
  `/usr/bin/bash`, `/usr/local/bin/bash`, and never provisions a plugin-owned shell: a distribution
  bash is tied to that distribution's libc and architecture, so a second copy would add supply-chain
  and licensing burden without solving anything. `allowSystemShellFallback` is the Windows gate on
  reaching past the pinned payload; with no payload on POSIX the host bash *is* the rung, so the flag
  is not required there. Windows is unchanged — same config, same `disabled`.
- `dsh-ops provision-shells` refuses on a POSIX host and names `config.bashPath`, instead of failing
  on an empty pin table: the pinned payload is the Windows one.
- Confinement is not weakened by the new rung. A confined command reaches the host sandbox first, and
  an unavailable or unusable confinement result is refused with no command executed; read-only still
  publishes no command tool.
- The FastCtx job lane is **not** widened by it: `lib/tools.js` resolves that lane with `posix: false`,
  because the lane is Windows-only in 0.3.1 (its payload and IPC proxies are), so a host bash cannot
  make it publish job tools on a platform nothing here has verified.
- The manifest now states each component's platforms — `dsh-ops-shell` and `dsh-ops-file`: win32 +
  linux; `dsh-ops-background`: win32 only — and `npm run validate:manifest` fails if a Linux claim
  rides along (61 checks).
- Covered by `test/linux-shell.test.mjs` (a real `ops_bash` execution through the host bash, the
  refusal under unusable confinement, and the two lanes being one decision apart), by a
  spawn-environment assertion in `test/mount.test.mjs` that fails if the job-lane fence is removed,
  and by `test/shells.test.mjs`, whose Windows-doctrine cases now name their platform instead of
  inheriting the host's.

### Native worker boundary fixes

- Preserve file identity across `ops_replace`. The replacement is published as a new inode, so the target's mode, owner, POSIX ACL and user extended attributes are now captured before the write and reapplied before publication. Previously a `0600` file came back world-readable (typically `0664`) and a `0755` script lost its execute bit. A mode or ACL that cannot be reapplied aborts the call with nothing published; on restore, an owner or attribute that cannot be put back is reported in `items[].metadataWarnings`, while `items[].metadata` reports what was kept. Covered by `test/file-metadata.test.mjs`.
- Make `ops_grep`'s `multiline` match across lines. It previously only changed what `^` and `$` anchored to while still matching one line at a time, so a pattern containing `\n` could never match and the call answered `matched: 0` without an error. `^`/`$` keep their per-line meaning, context lines still apply, and behaviour without the flag is unchanged. Matching the whole file at once also adds one zero-width match after a final newline, so that position is no longer reported as a line of its own: `$` answers once per line, not once per line plus one, and no match lands on a line the file does not have. Covered by `test/grep-multiline.test.mjs`.
- State what the shared parameter names mean, without changing the behaviour they name: `replace`'s `pattern` is a literal substring while `grep`'s is a regular expression, and `maxReplacements` is a ceiling that refuses the whole operation rather than truncating it. The refusal now names the match count, the ceiling and how to raise it instead of blaming the pattern.
- Bound every response by encoded bytes as well as by lines, so a single long line can no longer fail a read outright; `bytesTotal` and `truncatedInLine` report where that applies. The hex view of `ops_inspect_local_file` now reads the first row of the file instead of starting at the second.
- Hold an exclusive lock across the read-check-publish window of `ops_replace`, so concurrent replacements cannot silently lose a write: a peer now receives `REVISION_CONFLICT` rather than reporting a change it did not keep. Covered by `test/replace-concurrency.test.mjs`.
- Bound the debris a hard kill leaves behind. The next writer of a file reclaims its own `.<name>.dsh-ops-*` leftovers, which a `SIGKILL` cannot clean up at the point they are created, and a directory `fsync` that fails after a successful rename reports `effectState: "applied"` with a `nextAction` that says not to repeat it, rather than `"none"`.
- Refuse a native worker that exists without its execute bit, naming the path and the mode, instead of failing later as a bare `EACCES` from `spawn`. The resolver's "unavailable" error lists the candidates it tried, a missing or malformed `provenance.json` is named as an incomplete stage, and `node bin/native-runtime.mjs check` on a package missing a declared platform explains both ways forward instead of raising a raw `ENOENT`.

## [Unreleased]

### Read-only sidebar navigation

- Add focused all/running/anomaly filters and local retained-metadata pages. Preserve unfiltered session totals, continue long diagnostics, clamp pages on resize/live settlement and release key handlers on unmount. No tools, result-page fetches, history reads or persistent preferences are added.

### Aggregate sidebar anomaly alerts

- Add constant-memory, explicitly all-session anomaly badges without opening the panel or changing focus. Count only accepted settlements; acknowledge notifications with focused `a` without changing tool/session facts. Keep observer and badge failures isolated and respect the host-owned panel ID.

### Native sidebar source integration

- Add opt-in real Rust worker → OPS file runtime → DSH AgentLoop/committed Session → admitted TUI coverage, with a scripted model and owned temporary workspace. Keep source-test registration separate from Windows release support and production PTC/confinement acceptance.

### Sidebar result diagnostics

- Distinguish native file/PTC business refusals, errors, previews, partial settlement and unknown effects from transport returns. Parse only bounded native JSON envelopes, retain no result bodies, and leave shell/spilled output unconfirmed. Show omitted details without fetching them and warn against blind retries after unknown effects.

### Optional dsh-TUI sidebar

- Add disabled-by-default `dsh-ops/tui`, with its own admission manifest and no TUI/React runtime dependency. It observes current-session tool events through a bounded store, uses the host UI kit, and releases its panel and listeners on unload. No tool, prompt, command, polling, profile write or focus change is added.

### Read-only activity projection

- Add an internal bounded projection of live OPS native/PTC tool events for optional UI consumers. It stores no tool arguments or result bodies, isolates sessions, and labels normal transport returns neutrally rather than claiming business success. Existing components do not enable observation or change their tools.

### Payload trust

Found while reviewing what runs *before* it is trusted. Independent of the workspace-preparation
fix; see that entry for the `PSModulePath` scope note.

- Never hand a spawned child the host environment implicitly. Child processes now receive an
  **allow-list** (`lib/env.js`): paths, identity, scratch space, locale and proxy variables survive;
  everything else is withheld. The previous shape-based deny-list (`KEY|PASSWORD|SECRET|TOKEN`) let
  `SSH_AUTH_SOCK` (which authorises the host's SSH keys) and `DATABASE_URL` (usually carrying a
  password) through. `probeBinary` also defaults to the scrubbed environment — it **executes** a
  candidate that may have come from `PATH`, so handing it the full environment made the check a
  credential-delivery mechanism.
- Judge the cached confined-Bash runtime with one function on both the cached and the cold path, and
  keep the two anchors that live **outside** the writable cache (the IPC proxies against the
  in-package receipt) separate from two **in-domain consistency checks** (the patched MSYS runtime
  and `bash.exe`, both compared against the source payload). Folding all four into the stat
  comparison lets a tampered `opsipc.dll` through on both paths. A generation that fails
  verification is **quarantined and rebuilt** rather than refused forever — one bad write used to
  brick the bash tool until the host restarted — and the quarantine is bounded to two generations.
- Isolate every teardown callback (`lib/teardown.js`): one throwing disposer no longer strands the
  rest of a capability withdrawal or a tool unpublish, and `ptc`'s publication gate is released in a
  `finally` instead of wedging shut.
- Compare the native-worker candidate path with `path.resolve` + case folding rather than a path
  **substring**, so `…\RUNTIME\…` can no longer skip receipt verification.
- Report a `PATH`-sourced FastCtx on the success path; behaviour is unchanged (same-user, not a
  privilege boundary).

### Workspace preparation

- Prepare a `workspace-write` root whose path is an **8.3 short name** instead of refusing it as a
  junction or symlink. Windows generates a short name wherever a path component does not fit 8.3, so
  a host whose temporary directory is one — GitHub's `windows-latest`, or any machine whose user name
  is longer than eight characters — could not prepare any workspace under it. The check now judges
  the path it was given, and that path's ancestors, for reparse points, rather than comparing the
  given path with its resolved form: a short name changes one into the other with no link involved.

### A host outside the matrix skips the worker-driven suites instead of crashing

`lib/ptc/runtime.js` gains `tryResolveWorker()`, the non-throwing form of
`resolveWorker()`: the support matrix is still checked in one place, and the result is
either the resolved file or a complete reason clause. `test/permissions.test.mjs` and
`test/ptc.test.mjs` use it to leave through `skipSuite` (exit 77) when the host cannot
answer, where the first of them previously threw while the module was still loading and
the second failed a load-time existence check. `DSH_OPS_REQUIRE_RUNTIME=1` turns either
absence into a failure rather than a green run, and a supported host with the worker
built runs every check exactly as before.

### Windows verification follow-ups, and a lock-sidecar assertion

A Windows x64 verification of the 0.3.1 boundary work (2026-10-16) closed most of its own
findings in the release itself — the update lock no longer touches the target, credential
directory names are matched case-insensitively on every host, and `sync_directory` is
`#[cfg(unix)]`. What is still wrong here is the checklist, not the code:

- **`docs/windows-verification.md` carried expectations the report disproved.** The manifest
  count is 59, not 58 (the tree that removed the FastCtx and background components dropped two
  checks); the PE path needs its `.exe`; the L2 hex text is space-separated; a Windows host
  skips three suites rather than two (`linux-shell` joins the two POSIX-only ones) and reports
  24 passed + 3 skipped out of 27, not 27 + 3 out of 30; W1e's measured code is `IO_ERROR`
  (os error 32), not `ACCESS_DENIED`, so the expectation is the structured *shape* rather than
  one code; and the update-lock note now describes the sidecar, which is what the code takes.
  The note that a DSH sandbox cannot answer the checklist at all — `workspace-write` cannot
  spawn the worker, `danger-full-access` cannot let it create its replacement — and the Windows
  build prerequisites are recorded with it.
- **The lock sidecar is asserted invisible.** `test/linux-args.test.mjs` plants a
  `.dsh-ops-update-<hex>.lock` and checks that `glob`, `grep` and a directory-wide `replace`
  never select or edit it — on every host, because the rule that keeps it out is
  platform-independent.
- **No product half remains.** The report's other finding was that a `.cmd` candidate was probed
  with `CreateProcess`, which refuses a launcher script with `EINVAL`. That probe (`probeBinary`
  in `lib/binary.js`) is gone with the background component, and the surviving `.cmd` launch
  path, `lib/profile-install.js`, already goes through `%ComSpec%` with `/d /s /c` and
  `windowsVerbatimArguments`. So this is a documentation change plus one test.

### The ladder's POSIX worker stand-in has to be executable

`test/bin.test.mjs` seeded its worker stand-in with a plain 0644 text file, on the stated grounds
that "an explicit worker path is not provenance-checked". That holds for provenance but not for
the execute bit: `resolveWorker` refuses a non-executable explicit `binaryPath` by mode on POSIX
(report L12, unchanged by the refactor), and the ladder report now goes through it. The stand-in
therefore resolved to `{resolved: false}`, which failed two expectations — `worker.resolved` and,
through `ladderFor`'s publish rule, `levels.files`. Windows passed only because that check is
`platform !== 'win32'`, so the gate was red on Linux and macOS alone.

The two cases that assert the worker rung now seed an executable stand-in, and the report's
refusal path gained the coverage the mistake had been hiding: on POSIX, a `binaryPath` naming a
non-executable file must come back `resolved: false` with the resolver's own "is not executable
(mode 0644)" reason and no file tools published.

### The gate script, after review: Windows can be green, and a missing tool exits 2

`scripts/verify-gate.mjs` set `DSH_OPS_REQUIRE_RUNTIME=1` on every host. `test/run.mjs` turns any
skip into a failure under that variable, and Windows has three suites that skip by platform
(`file-metadata`, `linux-attributes`, `linux-shell`), so the script could never be green there —
its own allowed-skip table was unreachable. It is now set on the POSIX hosts only, and Windows
keeps its protection through the skip set: anything skipped outside that list fails. The script
also asserts the suite total it expects per platform (27), because a suite that stopped being
collected is not a pass, and a tool that is not installed now exits `2` ("this host cannot answer
the gate") instead of waiting on a `close` event that a failed `spawn` never emits.

The documentation caught the same drift it exists to prevent: `docs/verify-locally.md` promised
`61` manifest checks in two places, and `docs/windows-verification.md` still described the ladder
as failing rather than skipping where no worker resolves, and credited the Windows numbers to a
sandbox that cannot run the gate at all.

## [0.3.0] — 2026-10-14 — Windows x64 native tools and PTC

Release scope: **Windows x64 only**, targeting DSH 0.2.0-rc.2. macOS arm64 is
added after this release (see [Unreleased]); Linux/ARM64 are not shipped or
claimed. The package includes the native Rust worker, Windows Bash IPC proxies,
receipts and matching source; payload dependencies remain 0.2.1.

### Permission alignment

- Follow the latest authoritative three-mode session policy for fixed file operations; allow OS-readable external paths, reject read-only replacement, fence workspace writes to DSH writable roots in the host and native worker.
- Execute fixed trusted file operations using the same policy-fence threat model as DSH fs-sandbox, with no-follow native paths and subprocess governance. Arbitrary Bash/PTC code retains OS confinement; no fail-open fallback.
- Prepare owned Windows workspace roots before outer run_code/pwsh launch using directory-only current-user WRITE_OWNER, with DACL backups and no recursive grants, owner changes or denial removal.
- Publish Bash in confined modes and resolve policy at each execution. Report authorization denials with required/current mode and explicit user-action guidance, separately from executor initialization failures.
- Add real Modify-only workspace/provider coverage for native replace, batch copy/move/remove, readonly pages, mode changes and Node worker startup.
- Fix restricted Windows x64 Bash initialization with verified installation-relative IPC proxy binaries and a private MSYS copy. Preserve original payloads, DSH token SIDs and filesystem confinement; adapt only new private pipes and pagefile-backed process trackers. Matching DLL hashes are mandatory; no unconfined fallback.
- Add real pure-PTC Node runtime/SDK tests for Bash command, script_path, pipelines, workspace writes, outside denial and downgrade to read-only. Desktop GUI acceptance remains pending restart.

### Missing Bash payload diagnostics

Issue #20 reported that a profile installed from a registry which does not carry the platform payload package is told only to "repair the profile installation" — advice that cannot repair a package the registry never had. #16 asked for the same case to reach the README. Both are addressed below; no release is cut here.

- Give a platform-package miss a machine-readable cause (`no-manifest` / `not-declared` / `not-installed` / `incomplete-tree`) and render the remedy from that cause instead of matching on the detail text, so a wording change cannot silently route the answer to the wrong branch.
- A missing payload now names the registry as the likely reason and points at `dsh-ops provision-shells --bash` — which bypasses the registry, fetches the pinned upstream release, verifies its sha256 and writes a receipt — rather than the `repair the profile installation` wording. (#20)
- A corrupt payload tree keeps its repair wording and offers the same command as the alternative, so the two shapes stay distinguishable and each names an action that fits it.
- Split the spawn-time `ENOENT` result by `source` (`bundled` / `provisioned` / `config` / `path`), each naming the action that actually applies, instead of one sentence for all of them.
- Document the mirror case in all three READMEs: the measured mirror readings and date, the conditional wording, the cmd and PowerShell proxy forms, the profile-side `ladder` check, and the explicit rejection of `allowSystemShellFallback: true` as a workaround. (#20, Refs #16)

These fixes are included in 0.3.0; the three Windows payload dependencies are unchanged.

### Native file reconstruction and PTC enhancement

- Replace the file component's FastCtx `inspect_local_file`, `grep`, `glob` and `replace` surface with an independent Rust worker and one canonical `path` contract.
- Add DSH-native policy/sandbox/subprocess mediation for file calls, fail-closed executor checks, session-cwd resolution, cancellation and structured canonical results.
- Add bounded UTF-8 inspect/hex, glob traversal, Rust-regex grep, and CAS-protected dry-run/atomic replacement with no-follow and special-object rejection.
- Keep FastCtx only behind the disabled background component; remove file-component runtime discovery, MCP handshake and file-tool fallback.
- Update manifest, prompt guidance, provenance and composition tests to prove the native namespace is separate from the optional FastCtx background namespace.
- Retain the opt-in `dsh-ops/ptc` batch/result capabilities and their existing runtime gates.


- Add opt-in `dsh-ops/ptc`: two structured capabilities, `ops_batch` and `ops_result`, with no FastCtx or shell dependency.
- Share independent safe Rust core for preflighted copy/move/remove, content verification, protected/no-follow paths, write-ahead per-item manifests and conservative resume.
- Add scoped expiring result references, byte/quantity-bounded pages, field/equality projection and operation-reference consumption without widening authority.
- Follow original DSH enforcement levels (including Windows partial ACL confinement), enable no-write read-only reference pages, and allow explicit external roots under danger-full-access without confinement.
- Stage checksum-verified Windows x64 worker and Bash IPC proxy binaries; release checks reject missing artifacts. No install-time downloads/compilation; owned-workspace WRITE_OWNER preparation is runtime-only, backed up and non-recursive.
- Extend the existing PTC simulation suite with original DSH sandbox/subprocess provider acceptance: workspace copy, read-only page, outside-write denial and full-access outside-root operation.
- Execute through DSH policy + native process confinement + subprocess cancellation; standard/native and hybrid/both scopes receive no PTC-only definitions.
- Keep business code separate from one three-scenario simulation suite using the real Rust worker and real Cordis/tools/prompt registration.
- Target native Windows/macOS/Linux; Windows runtime acceptance and Linux/macOS compile checks are recorded separately from pending on-platform sandbox tests. Legacy payloads remain unchanged.
- Keep each component icon inside its exported manifest directory; fix the PTC Plugin Manager metadata error caused by the parent-relative icon path, with coverage in the existing manifest suite.
- Source builds use `npm run build:ptc` and `npm run build:bash-ipc`; published 0.3.0 artifacts are Windows x64 only. macOS arm64 support is added after this release (see [Unreleased]). See `docs/native-ptc.md`.

## [Unreleased] — Bash workdir spawn diagnostics

- Validate `ops_bash` `workdir` as an existing directory before spawning, so a missing, file-valued or inaccessible working directory is reported as an explicit `invalid workdir` error (naming the stat error code when access, not existence, failed) instead of the bash-payload ENOENT remedy; a directory deleted between the check and the spawn still falls back to that remedy. The two ENOENT causes cannot be told apart after the fact: Node puts no `cwd` on the spawn error, and the host's Windows runner maps missing program and missing directory onto one code. The session layer now resolves empty or whitespace `workdir` placeholders to the session directory like an omitted value, instead of letting them fail the spawn. Covered by `test/shells.test.mjs`. (#33)
## [Unreleased] — Workspace preparation

- Write the workspace root's DACL through its own handle (`SetKernelObjectSecurity`) instead of path-based `SetAccessControl`. The added ACE is directory-only, so no descendant needs a new ACL, but the path-based write made Windows walk and re-propagate the whole subtree, and the cost grew with workspace size. Measured on 50,000 files: 18.65 s → 4.30 s cold, versus 3.86 s for 10 files; the warm `ready` path is unchanged. The root DACL is byte-identical to before (control flags including `AI`, existing ACEs, the added `WRITE_OWNER` ACE), and descendant ACLs are untouched. Guards, backup receipt, verification and rollback are kept; rollback uses the same handle-based write. (#43)
- Raise the preparation timeout from 10 s to a 120 s safety net, and never end the error at the colon: a timeout names the limit, the workspace, that the ACL state is unknown and where the receipt is; a non-zero exit names the exit code, elapsed time and the script's stderr (or stdout, or `(no output)`).
- Restore `test/permissions.test.mjs`: a merge resolution had dropped the two closing lines of the root-only preparation test, so the suite failed to parse and none of these tests ran. Add the expensive real-world shape as a regression test: a workspace root that inherits its ACL (`D:AI`, no explicit ACEs) keeps its auto-inherited flag and inherited ACEs, gains one directory-only `WRITE_OWNER` ACE, and leaves descendants untouched.
- Start Windows PowerShell 5.1 with `-ExecutionPolicy Bypass` for the package's own `prepare-workspace.ps1`. Without it, the Windows client default (`Restricted`) refused the script, so every `run_code` / `pwsh` / `bash` / `pwsh_persistent` / `bash_persistent` call in a workspace-write session failed. The flag applies to that one child process; Group Policy still takes precedence. Covered by running the real script under a process-scope `Restricted` policy. (#66)
- Name the cause of a failed preparation instead of the blanket "(not a user permission denial)": an execution-policy refusal (now only possible through Group Policy, with that remedy), a workspace folder that does not meet the `WRITE_OWNER` prerequisite (with the script's reason), an executor that could not start or timed out, or otherwise the exit code with the script's output. Document that preparation runs as the current user before sandbox confinement.

## [Unreleased] — bashPath restricted-mode diagnostics

- Document that `bashPath` (and any system bash) works only in `danger-full-access`: read-only and workspace-write run only the pinned MSYS whose IPC compatibility proxies were verified. The policy itself is unchanged and still fails closed. (#42)
- Replace the restricted-mode `This MSYS version has no verified DSH IPC compatibility build. Rebuild the matching proxies` error with one that names the executable and where it came from, says the refusal is by design and not an authorization denial, and gives real next steps: remove `bashPath` to use the bundled or provisioned pinned bash, or ask the user to switch to `danger-full-access`. The signal-pipe runner-failure message gains the same next step.
- `ops_bash` now says plainly that it has no per-call `sandbox_permissions` escalation when a model passes `sandbox_permissions` / `justification`.
- `dsh-ops ladder` reports `restricted: { compatible, reason }` for the resolved bash, read-only and without copying anything, and drops the stale "bash requires a full-access session" line.
## [Unreleased] — File tool placeholder arguments

- The native file tools (`ops_inspect_local_file`, `ops_grep`, `ops_glob`, `ops_replace`) now drop `null` values and empty `""`/`[]` placeholders for *optional* fields at the plugin's own execute entry before the worker runs, so strict tool-call adapters that fill every schema field no longer trip `path`/`encoding`/`view` validation; required fields, `replacement: ""`, `false` and `0` are forwarded unchanged and real conflicts still error; the caller's argument object is not mutated. (#19)

## [Unreleased] — Background job argument strictness

- Check the background tools' arguments (`ops_run_background`, `ops_job_output`, `ops_job_list`, `ops_job_kill`) against FastCtx's own published schema before the owned-job check, so a mistyped or missing `job_id` is reported as `invalid arguments: unknown key "id"` or `missing required field "job_id"` instead of "This job was not started by this session on the current connection." The ownership check itself is unchanged and still decides every call whose arguments are well formed; no argument error reaches the server. Covered by `test/jobs-args.test.mjs`. (#14)

## [Unreleased] — Optional bash input placeholders

- Treat empty/whitespace/null command and script_path values as absent, so adapters that fill optional inputs do not block a valid command or script. Keep rejecting two non-empty inputs and unknown argument keys before spawn.
- Explain empty placeholders in the parameter descriptions and error recovery; `/dev/null` is not an empty placeholder.
## 0.2.9 — Bug fixes

Bug-fix-only release for issues reported against 0.2.8 and the 0.2.6/DSH 0.2.0-rc.2 combination:

- Skip the Windows `%SystemRoot%\\System32\\bash.exe` WSL distribution launcher during system PATH fallback, so an explicitly enabled fallback selects a real Git for Windows/MSYS bash instead of silently moving commands into WSL. (#12)
- Enforce `ops_bash`'s closed argument schema at runtime and reject undeclared keys such as `run_in_background` before spawning. (#10)
- Persist the one-time legacy shell-fallback migration without calling `Entry.update()` or remounting the plugin. This avoids competing with Desktop profile reloads when configuration is edited, while preserving the safe runtime value and the raw loader row. (B站评论区报告)

No new tools, components, configuration keys, or runtime capabilities are included. The three Windows payload dependencies remain pinned to `0.2.1`.

## [Unreleased] — Tool descriptions and result contract

- Rewrite the native file-tool descriptions to match what the worker enforces: `ops_glob.pattern` and the `glob` filters of `ops_grep`/`ops_replace` are arrays of globs matched against relative paths (`*.md` is top level only, `**/*.md` any depth, `!` excludes; a positive entry is required for `ops_glob` only), `ops_grep` has no `include` field, and `ops_replace.pattern` is literal text, not a regex. (#44)
- State the result contract precisely, in the descriptions and the prompt section, only for published tools: file tools, `ops_batch` and `ops_result` resolve failures as `status: "error"|"rejected"` values and never throw; `ops_bash` resolves command failures as values and throws only for invalid arguments or an unavailable executor. Drop the stale PTC note about catching errors from "legacy ops_* tools".
- Add `status: "completed"|"failed"` to `ops_bash` results (additive; `completed` only for a clean zero exit with no error, permission refusal, signal or timeout).
- Pin the `ops_grep`/`ops_glob`/`ops_replace` parameter keys against their descriptions, and prove the documented behaviour against the real worker.

## [0.2.6] — Owned MCP client lifecycle

- Track only plugin-owned MCP clients and terminate their exact serve processes on explicit Node process exit; never enumerate or kill shared runtime-host processes.
- Force the existing FastCtx identity-aware parent watcher on for spawned serve clients, even if FASTCTX_NO_PARENT_WATCH=1 was inherited. Forced-owner termination and stdin EOF are covered against the published binary.
- Make close immediate for pending requests and idempotent for concurrent callers; wait for the same shutdown and bound force-kill escalation. Close a live child whose reply stream reaches EOF.
- Preserve shared-runtime leases until the final component releases them. Retain all 0.2.5 fixes and the one-time config migration; no Rust/runtime payload changes or context-compaction beta.

## [0.2.5] — Stable safety and verification hotfix

- Default `allowSystemShellFallback` to false in code and the shipped shell row. Ambient PATH/well-known bash discovery requires explicit opt-in; configured and plugin-owned shells still work.
- Run a one-time startup config self-check per owning row: disable legacy explicit fallback before executor resolution, submit write-back with configUpdateVersion 1 through the loader, and preserve later manual opt-ins. Keep all upgrade modifications in lib/config-updates.js.
- Bind FastCtx to the resolved bash or a disabled executor sentinel; with no approved executor, do not publish background commands. Key shared runtimes by executor policy to prevent one component's fallback choice leaking into another.
- Restore `npm run verify` against the current PNG icon, independent components, scoped command permissions, prompt tables, registry ownership and unload lifecycle. Fail on mount deadlines and bound each suite to 120 seconds.
- Map the main package explicitly to the unchanged three payload packages at 0.2.1 and clarify historical Release assets/checksums and verification records.
- Exclude the context-compaction beta branch entirely: no compaction component, dependency, code or bundle row.

## [0.2.4] — Independently toggled components

- Split the market bundle into shell (on), file (on), and background (off) rows with exported per-component titles, descriptions, icons and locales.
- Publish five tools by default, nine with background enabled. Stop publishing duplicate foreground ops_run. Preserve the bash/PowerShell 7 routing and the object-root bash schema.
- Own separate prompt sections for each component; visibility and shutdown withdraw only the matching guidance/tools. Do not append to AGENTS.md.
- Share one ref-counted plugin-owned FastCtx connection for file/background. Drain in-flight calls and attempt to kill only remembered owned jobs when background stops; report cleanup failures.
- Replace the unconditional bundle pwshPath override with a runtime-only official config lifecycle overlay; shell OFF recomputes the executor's current owning raw config without persisting changes.
- Document release-age version selection and the limits of token savings. No host/vendor implementation, old regression suite, or Actions changes.

## [0.2.3] — Strict-argument guidance and display metadata

- Add one routing-section reminder: `ops_* arguments are strict: pass only declared fields.` Keep FastCtx's portable schema subset and runtime guards unchanged.
- Use `dsh-ops` as the display title in both locales and align package/install descriptions with the maintainer's Windows bash, PowerShell 7, and Rust tools wording.
- Replace the display icon with the maintainer-provided image, resized without cropping to a 256×256 PNG (119,677 bytes), below the official host's 256 KiB limit.
- Reuse all three runtime payload dependencies at 0.2.1; preserve the 0.2.2 bash object-root schema fix.

## [0.2.2] — Bash parameter schema hotfix

- Fix `ops_bash` parameters to use a JSON Schema object root with `properties`, `required: ['command']`, and `additionalProperties: false`. The previous field map was forwarded unchanged by the official host and rejected by the model API before tool execution.
- Reuse the three published Windows runtime packages at exact version 0.2.1; only the main plugin package changes.
- Validate the exported schema through the official host tool registry without calling a model. Registry installation and shell version probes alone did not verify this boundary in 0.2.1.

## [0.2.1] — Windows payload packaging — published

Published to the public npm registry on 2026-10-08 as `dsh-ops@0.2.1` with
`@dsh-ops/fastctx-win32-x64@0.2.1`, `@dsh-ops/bash-win32-x64@0.2.1` and
`@dsh-ops/pwsh-win32-x64@0.2.1`. Packed sizes and registry digests:
[docs/release-0.2.1.md](docs/release-0.2.1.md).

- Assemble complete digest-verified PortableGit/bash and PowerShell 7 runtime packages instead of metadata-only pins; inject all three Windows x64 runtime dependencies in the publish artifact.
- Add explicit-profile install/status/uninstall delegation to the official DSH manager; map tui to dsh-tui and use Desktop's installation-owned CLI.
- Resolve the pwsh dependency from the plugin package under pnpm isolation.
- Make the default README Chinese and add a concise English translation.
- Materialize PortableGit's hardlinked paths during assembly: npm rejects hard links with E415, so the shell packages publish regular files with identical bytes.
- Fix credential selection: the first publish attempt used an unrelated local npm token and received E403. The maintainer's explicitly selected bypass credential was accepted; the earlier attribution of that failure to the maintainer's token was wrong.
- Known unresolved item: complete corresponding-source delivery for the GPL/LGPL components in the PortableGit inventory was not collected or reviewed, and no source offer is claimed. Publication proceeded at the maintainer's explicit direction.

## 0.2.8 — Missing bash payload diagnostics

Issue #9 showed that a host package-manager prune can leave the bash payload declared in the profile lockfile but absent on disk. `ops_bash` now converts a spawn-time `ENOENT` into a concise actionable result instead of exposing a raw process exception. It does not silently fall back to an unapproved system shell.

The Electron `workspace-write` `0xC0000142` ACL-runner failure is a DSH host sandbox issue outside this plugin's subprocess API. This release documents that boundary and does not claim to repair the host's Windows ACL runner.



### Changed

- Add `ops_bash.script_path` for executing existing scripts without placing their contents in a large JSON string; retain `command` for short commands and pipelines.
- Guide the model to use `script_path` for long, heredoc-heavy or escape-heavy scripts, reducing malformed tool-call risk and wasted turn tokens.
- Replace the execution ladder and duplicate prompt sections with one compact routing table.
- Preserve `ops_bash` as the preferred general command executor in the tools → bash → PowerShell 7 design; publish it in full-access agent scopes with the host subprocess service. Keep the compact routing table and use pwsh only for necessary Windows-native operations.
- Publish command/job tools only in plugin-owned agent fibers under authoritative per-session `danger-full-access`; reconcile `sandbox/mode` changes and recheck calls. No env/preset fallback.
- Reject image inspection explicitly and advertise PDF text only; preserve batch text ranges, encodings, hex, search filtering, and batch replacement.
- Shorten published schema descriptions and advertise only symmetric grep context. Forward ordinary arguments unchanged.
- Track background-job ownership per session/connection; reject foreign output/kill, filter background footers, and project owned job listings/counts/pagination.
- Withdraw tools on disconnect. Scope all definitions/disposers to plugin ownership, with no shared registry rewrite or host value imports.
- Declare read-only sibling concurrency through the host's function API. Do not assert host timeout quiescence; preserve the existing transport deadline.

### Measurement and validation

- Add a standalone schema measurement command and pre-change baseline, not a test gate.
- Document manual acceptance and limits. No regression tests/CI added, existing tests neither updated nor run for this change.
- Filesystem confinement of FastCtx file tools, per-command approval escalation, and cancellation quiescence remain outside this pass.

## [0.2.0] - Unreleased

The command-execution ladder, the plugin's own shells, the runtime package and the
two shell pins that bring them, and the end of the MCP bridge dependency. Not
published either: the repository still has no remote and no release tags, and this
entry is where `package.json` / `dsh-plugin.json` move to `0.2.0`; no tag has been
cut from it.

### Added

- **The command-execution ladder.** `lib/policy.js` renders the repository-tooling
  section as an explicit ladder — FastCtx (`ops_*`), then `ops_bash`, then
  PowerShell 7, then the host's own shell tools as the last resort — naming only the
  rungs the model can actually reach and renumbering the rest, so the text the model
  reads has no gaps. Preference is wording: the plugin never retries a failed call
  on another rung and never cascades at run time.
- **`ops_bash`** — the plugin's own bash, published as an ordinary tool through
  `ctx.tools.register` (only while the host's subprocess service is mounted) and
  executed through `ctx.get('subprocess')`, so commands run under the harness's own
  credential scrub, output spilling, and process termination. Its environment is the
  terminal overrides (`NO_COLOR`, `TERM`, `PAGER`, `GIT_PAGER`) and nothing else: it
  forwards no credential-shaped name and no `DSH_*` fact, and it never writes
  `process.env`, `PATH`, or the working directory.
- **PowerShell 7 as rung 3.** The bundle patch re-points the host's `pwsh-sandbox`
  row at the plugin's own pwsh through a `!!js` `pwshPath` — Windows-gated,
  `lstat`-based usability checks over both bundled layouts in one order (the
  installed `@dsh-ops/pwsh-<platform>-<arch>` package first, then the vendored copy),
  and a wrapping `try`/`catch`. A deployment whose package carries neither copy gets
  `undefined`, which is the row's own default, so the host's PowerShell resolution is
  untouched. A profile overrides the entry in its own `cordis.patch.yml`, which
  applies after every bundle layer.
- **Per-agent visibility under `deny-host-shell`.** On `agent/created` the plugin
  masks the configured host shell tools out of that agent's view with
  `agent.ctx.tools.restrict({ deny })` — only while a rung of its own is live; the
  fence at `tools/pre-execute` stays the guarantee, and the mask's disposer is owned
  by the plugin as well, so unloading lifts it. With no rung of the plugin's own, the
  fence is kept, visibility is left alone, and the reason is reported once.
- Three config keys: `bashPath` (an explicit bash for rung 2, authoritative),
  `publishBashTool` (default `true`), and `allowSystemShellFallback` (default
  `true`, to confine rung 2 to plugin-provided shells).
- **One runtime package, and two pins instead of two redistributions.**
  `@dsh-ops/fastctx-<platform>-<arch>` carries this fork's slimmed FastCtx build
  (`bin/fastctx.exe`), built here. `@dsh-ops/bash-<platform>-<arch>` and
  `@dsh-ops/pwsh-<platform>-<arch>` carry **metadata only** — the upstream URL,
  release, version, byte count, and SHA-256 of Git for Windows PortableGit and of
  PowerShell 7. Neither upstream binary is repackaged, forwarded, or redistributed
  by this distribution; the tag's GitHub Release carries this distribution's own
  tarballs and a `SHA256SUMS`, and nothing upstream's. `PROVENANCE.md` records every
  pin and licence.
- **`dsh-ops provision-shells [--bash|--pwsh]`.** Reads a pin, downloads that
  upstream archive on the user's own machine, verifies it against the pinned
  SHA-256, and unpacks it under `<DSH_HOME>/dsh-ops/shells/<name>/<version>/`, which
  is the first place both shell rungs resolve from. Nothing is downloaded at plugin
  load time, and nothing is downloaded unless the command is run.
- **`dsh-ops ladder`.** The CLI prints each rung's availability and the executable it
  came from, together with the rungs the prompt text renders for that answer, so a
  deployment can confirm which shells took effect without opening a session.
- **The shell resolution gained a provisioned tier, and so did the runtime chain.**
  Rung 2 resolves `config.bashPath`, then the provisioned copy, then a packaged copy,
  then `PATH`, then the well-known installs; rung 3 and the bundle patch that
  re-points the host's `pwsh-sandbox` row walk the same layouts in the same order. On
  the runtime side, the FastCtx chain tries `@dsh-ops/fastctx-<platform>-<arch>` ahead
  of the upstream `@fastctx/<platform>-<arch>` step, so an install gets this fork's
  build by default while a deployment without it still falls through to the vendored
  source build, the upstream package, or `fastctx` on `PATH`.

### Changed

- The repository-tooling section is no longer a flat tool list; it is the ladder
  above, rendered from the rungs the model can actually reach.
- `dsh-plugin.json` declares a second tool namespace for the tools the plugin
  registers itself (`ops_bash`, `transport: in-process`), and the manifest gate
  checks it against the fully-open ladder text.
- **This distribution's own platform packages are injected into
  `optionalDependencies` at release time, not committed.** Before the first release
  those names resolve nowhere, so listing them in the repository would put a failed
  optional fetch into every contributor's install log for no gain; the release step
  writes them, and the tarball it publishes is the one that declares them. The two
  shell pins cost an install nothing to declare, because they hold metadata and no
  binaries.
- The package version moves to `0.2.0` in `package.json` and `dsh-plugin.json`.

### Removed

- `pwshPath` and `overridePwshExecutor` are not config keys and now fail as unknown
  keys. A bundle patch is evaluated before any `dsh-ops` row is mounted, so a key
  could never reach the `pwsh-sandbox` override; rung 3 follows the executable
  instead, and the override is the patch entry documented above.
- `@deepseek-ai/dsh-mcp-client`, along with the `BRIDGE_PACKAGE` declaration and the
  manifest check that required it. The plugin holds the MCP stdio connection to the
  FastCtx server it spawns and publishes the tools itself (`lib/handshake.js`,
  `lib/tools.js`); it no longer mounts a bridge, and the 0.1.0 entry's
  registry-boundary renaming is gone with it.

### Fixed

- **`ops_bash` registers on the real host.** Its output schema used type arrays
  (`['integer', 'null']`), which the harness's schema gate rejects outright, so the
  tool could not be registered at all. Every `type` is now a single type and
  `exitCode`/`signal` are optional properties: an unknown exit fact omits the key
  rather than sending `null`.
- **Rung 3 and the host row are one fact.** The bundle patch's expression and the
  plugin's own probe now walk the same two bundled layouts
  (`BUNDLED_LAYOUT_ORDER`) in the same order with the same `lstat` test, so the
  ladder cannot advertise a PowerShell rung the host row does not run — or miss one
  it would.
- **The visibility mask follows the rungs that are live.** `deny-host-shell` used to
  hide the host shell tools whenever a bash merely resolved. The question is now
  asked of the ladder the model can reach — `ops_bash` published, or the PowerShell
  rung live — and asked again as each agent appears. With no rung of the plugin's
  own, visibility is left alone and the reason is reported once; the
  `tools/pre-execute` fence is unchanged and is installed by the mode alone.

## [0.1.0] - Unreleased

The first version. Not published: the repository has no remote and no release
tags, and `package.json` still carries `"private": true`.

### Added

- The plugin itself: one bundle that mounts the FastCtx MCP runtime as the
  profile's repository tool surface, publishes its tools under a namespace of the
  plugin's own, and injects two prompt sections that steer repository work away
  from the host shell.
- `shellPolicy: deny-host-shell` — an opt-in `tools/pre-execute` fence that
  refuses the configured host shell tools by name. FastCtx's own tools are never
  refused, so command execution stays available.
- The `dsh-ops` CLI: `resolve`, `status`, `build`, and `provision`. `provision`
  installs the built runtime into `<DSH_HOME>/dsh-ops/bin/` and writes a receipt
  recording its origin, version, and SHA-256.
- Composite licensing — MIT for the plugin, Apache-2.0 for `vendor/fastctx/` —
  with FastCtx's required notice reproduced verbatim in `README.md`,
  `README.zh.md`, and `NOTICE`.

### Changed

- **The FastCtx tools are published as `ops_*`.** The bridge's own
  `mcp__<serverName>__<rawName>` naming is transport vocabulary in every
  transcript, so registrations inside this plugin's bridge namespace are renamed
  at the registry boundary: the model calls `ops_grep`, and a transcript shows
  `ops_grep`. The `mcp__fastctx__*` names never reach the model.
- **The vendored FastCtx is stripped to its MCP server.** Upstream's control
  terminal (`src/tui/`), self-updater and upstream-version check (`src/update/`),
  and Codex integration — including `control/i18n.rs` and the other locale
  catalogs — are deleted rather than left unreachable, along with the
  distribution and CI machinery. 57 files changed, 285 insertions and 24,715
  deletions. The binary now carries `serve` plus the internal entry points the
  shell and session machinery spawn.
- `PROVENANCE.md` now records what was read from the readable `0.2.0-rc.2`
  source, with file and line, next to what a suite actually ran.

### Removed

- Upstream's `.github/`, `packages/` (the npm launcher, `codex-fastctx`, and the
  five `@fastctx/<platform>` binary packages), and `scripts/`.
