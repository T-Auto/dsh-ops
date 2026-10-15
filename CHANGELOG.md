# Changelog

All notable changes to this package are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [0.3.0] — 2026-10-14 — Windows x64 native tools and PTC

Release scope: **Windows x64 only**, targeting DSH 0.2.0-rc.2. Linux/macOS/ARM64
are not shipped or claimed. The package includes the native Rust worker, Windows
Bash IPC proxies, receipts and matching source; payload dependencies remain 0.2.1.

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
- Source builds use `npm run build:ptc` and `npm run build:bash-ipc`; published 0.3.0 artifacts are Windows x64 only. See `docs/native-ptc.md`.

## [Unreleased] — Bash workdir spawn diagnostics

- Validate `ops_bash` `workdir` as an existing directory before spawning, so a missing, file-valued or inaccessible working directory is reported as an explicit `invalid workdir` error (naming the stat error code when access, not existence, failed) instead of the bash-payload ENOENT remedy; a directory deleted between the check and the spawn still falls back to that remedy. The two ENOENT causes cannot be told apart after the fact: Node puts no `cwd` on the spawn error, and the host's Windows runner maps missing program and missing directory onto one code. The session layer now resolves empty or whitespace `workdir` placeholders to the session directory like an omitted value, instead of letting them fail the spawn. Covered by `test/shells.test.mjs`. (#33)
## [Unreleased] — Workspace preparation

- Write the workspace root's DACL through its own handle (`SetKernelObjectSecurity`) instead of path-based `SetAccessControl`. The added ACE is directory-only, so no descendant needs a new ACL, but the path-based write made Windows walk and re-propagate the whole subtree, and the cost grew with workspace size. Measured on 50,000 files: 18.65 s → 4.30 s cold, versus 3.86 s for 10 files; the warm `ready` path is unchanged. The root DACL is byte-identical to before (control flags including `AI`, existing ACEs, the added `WRITE_OWNER` ACE), and descendant ACLs are untouched. Guards, backup receipt, verification and rollback are kept; rollback uses the same handle-based write. (#43)
- Raise the preparation timeout from 10 s to a 120 s safety net, and never end the error at the colon: a timeout names the limit, the workspace, that the ACL state is unknown and where the receipt is; a non-zero exit names the exit code, elapsed time and the script's stderr (or stdout, or `(no output)`).
- Restore `test/permissions.test.mjs`: a merge resolution had dropped the two closing lines of the root-only preparation test, so the suite failed to parse and none of these tests ran. Add the expensive real-world shape as a regression test: a workspace root that inherits its ACL (`D:AI`, no explicit ACEs) keeps its auto-inherited flag and inherited ACEs, gains one directory-only `WRITE_OWNER` ACE, and leaves descendants untouched.

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
