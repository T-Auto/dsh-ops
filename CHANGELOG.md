# Changelog

All notable changes to this package are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
