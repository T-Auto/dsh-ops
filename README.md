# dsh-ops

A DSH plugin that gives a profile **one repository tool surface** and takes the
shell out of the loop.

It hosts [FastCtx](https://github.com/yc-duan/fastctx) — a local Rust runtime
that reads files, searches contents, finds paths, applies replacements, and runs
commands through MCP — as a normal DSH bundle. The plugin spawns that server
itself, speaks MCP to it over stdio, and publishes its tools as `ops_*` in its
own registration scope; no bridge is mounted and no shared registry is rewritten.
On top of that it injects a prompt policy that states an explicit command-execution
ladder — FastCtx first, then the shells the plugin itself brings, then the host's
own shell tools as a last resort — and it can hide those host shell tools from an
agent outright.

| | |
| --- | --- |
| Plugin name | `dsh-ops` |
| Tool namespace | `ops_*` — the nine FastCtx tools plus `ops_bash` |
| Host target | DSH `0.2.0-rc.2` |
| Manifest | dsh-std Community `dsh-plugin.json` v0.15 |
| License | `MIT AND Apache-2.0` — see [License](#license) |

## Why

On Windows, an agent that reaches for PowerShell to read a file spends its
attention on quoting, escaping, path forms, and encoding instead of on the
repository. `Select-String` output is not a search result, `Get-ChildItem` output
is not a file list, and a truncated terminal buffer is not a file. FastCtx
replaces all of that with structured tools whose inputs are parameters and whose
outputs are bounded, paginated, and marked.

That only helps if the model actually uses them. A tool that exists next to a
shell is a tool the model forgets, so this plugin also states the rule in the
system prompt and can enforce it at the tool gate.

## What it does

Four contributions, each scoped to the service it needs:

1. **States the command-execution ladder.** Two prompt sections: a host-shell rule
   that is always present, and a tooling section that names the rungs the model can
   actually reach, in the order to reach for them. A rung whose tool is not
   published is absent from the text rather than named anyway.
2. **Hosts the shells it brings.** `ops_bash` runs one command in the bash this
   plugin resolved, through the harness subprocess service; on Windows the bundle
   patch points the host's `pwsh-sandbox` row at the plugin's own PowerShell 7
   whenever the package carries one. Both are optional: a deployment without them
   loses the rung and nothing else.
3. **Can refuse and hide the host shell.** With `shellPolicy: deny-host-shell` the
   plugin masks the configured host shell tools out of each new agent's view
   (`tools.restrict`) while it still has a shell rung of its own, and a
   `tools/pre-execute` listener refuses them by name with a reason that names the
   FastCtx replacement. The mask is convenience; the fence is the guarantee, and the
   fence is installed by the mode alone.
4. **Hosts the FastCtx MCP server.** The plugin resolves a FastCtx executable,
   proves it runs, and spawns it itself, configured for `fastctx serve` (plus
   `--enable-shell` when the shell tools are wanted). The plugin owns the stdio
   connection, the handshake, the reconnect policy, and the tool registrations:
   every tool the server lists is published as `ops_<name>` through this plugin's
   own `ctx.tools.register`. Disposing the plugin unregisters those tools and
   stops the child.

### The command-execution ladder

The tooling section is a ladder written from the model's point of view, and these
are its rungs in the order they are offered:

1. **Rung 1 — FastCtx (`ops_*`)**: reading, searching, listing, replacing, and
   plain command execution, through the tools below.
2. **Rung 2 — `ops_bash`**: the bash this plugin resolved, for POSIX pipelines,
   shell scripts, and a `git`/`gh`/build toolchain.
3. **Rung 3 — PowerShell 7**: Windows-native work — a cmdlet, an environment
   variable, a registry or service operation, a native path.
4. **Rung N — the host's own shell tools**: the last resort, for an operation none
   of the rungs above can run.

**Preference is wording, and nothing switches rungs for you.** The text says that
directly, and the plugin holds itself to it: it never retries a failed call on
another rung, never marks a rung unavailable at run time, and never cascades. Every
rung is a fact about what the model can reach, asked of the live registry at each
assembly: rung 1 is live when any FastCtx tool is published, rung 2 when `ops_bash`
is, and rung 3 when this plugin's own PowerShell 7 is present on this platform —
the same fact the bundle patch acts on. Resolution answers a different question
(which executable, by which route, and why not) and never decides whether a rung
exists. A rung that is not live is not mentioned, and the rungs below it are
renumbered, so the model never reads a gap. The only behaviour beyond the text is
`shellPolicy`, described below.

### The tool surface

| Tool | Purpose | Replaces |
| --- | --- | --- |
| `ops_inspect_local_file` | Read text, images, PDFs, or a hex view, with line numbers and paging | a shell command that prints a file |
| `ops_grep` | Search contents across a file or a tree | `Select-String`, `findstr`, shell `rg`/`grep` |
| `ops_glob` | Find files by path pattern | `Get-ChildItem`, shell `dir`/`ls`/`find` |
| `ops_replace` | Apply one mechanical replacement across files | `-replace`, `sed`, `perl` |
| `ops_run` | Run a command in a bash shell | the host shell tool |
| `ops_run_background` | Start a long-running job | `Start-Job`, `&` |
| `ops_job_output` / `job_list` / `job_kill` | Inspect and stop jobs | job bookkeeping in a shell |
| `ops_bash` | Run one command in the bash this plugin resolved (rung 2) | a host shell tool, for POSIX work |

The first four are always published. The next five come with FastCtx's
`--enable-shell`, which `enableShellTools: false` turns off. `ops_bash` is a tool
this plugin registers itself: it appears once a bash resolved *and* the host's
subprocess service is mounted to run it, and `publishBashTool: false` turns it off.

`ops_bash` returns one settled run: `stdout` and `stderr` (each with `text`,
`truncated`, and a `spillPath` when the output was spilled), `timedOut`, and
`timeoutMs`. `exitCode` and `signal` are present only when the process reported
them — an unknown exit fact omits the key rather than sending `null`.

## Install

Install it into the profile that should have the FastCtx tool surface:

```console
dsh plugin --profile desktop add dsh-ops
dsh plugin --profile web     add dsh-ops
```

`dsh plugin --profile <name> <args…>` forwards its arguments to pnpm inside the
profile directory, so every pnpm verb works and any spec pnpm accepts is valid.
Because this package declares `dsh.bundle`, the same command appends it to the
profile's `dsh.profile.bundles`. The patch in `cordis.patch.yml` inserts one row,
so nothing else in the profile changes.

To work on a local checkout instead, install it by path — `dsh plugin` links a
directory rather than copying it:

```console
dsh plugin --profile desktop add <absolute path to the checkout>
```

pnpm records that as `link:<path>`. Keep runtime state out of the linked
directory: the profile holds a live link to it, so writing scratch files,
build outputs, or logs into the package directory can make the host rebuild the
composition under a session that is already running. `provision` writes to
`<DSH_HOME>/dsh-ops/` for exactly that reason.

Verify the layer without booting, then boot:

```console
dsh --profile desktop --dump-config   # shows a "# == dsh-ops" layer
dsh --profile desktop
```

An agent can install through the same service the GUI uses:

```text
plugin_manager { action: "install_bundle", target: "<spec>" }
```

`install_bundle` performs package installation and bundle selection, and
`remove_bundle` is its inverse; do not reproduce either with shell commands in
the profile directory. Two of its inputs matter here:

- `approvedBuilds` grants a package's install scripts permission to run on this
  machine, so pass those names only after the user approves them.
- `registry` names the registry to ask first, when the user names one.

An install that fails, is cancelled, or adds a package with no bundle patch
restores the profile's `package.json` and `pnpm-lock.yaml`; downloaded files can
stay. The plugin itself has no install scripts and no build step.

Installing from npm or from a git host is the same command with a different
spec (`dsh-ops`, `@T-Auto/dsh-ops@<version>`, `github:T-Auto/dsh-ops`). A git
install fetches sources rather than built artifacts, so it succeeds only for a
package that builds itself through a `prepare` script — this one needs none,
because it ships plain JavaScript.

### What an install brings

The install path is the profile command above, or `plugin_manager`'s
`install_bundle` — **not** `npm i -g`. The plugin has to be a dependency of the
profile that should carry it, because adding the package is also what appends the
row to `dsh.profile.bundles`; a global install puts the package on the machine and
into no profile.

The copy that goes to the registry injects this distribution's own platform
packages as optional dependencies:

| Platform package | Contents | Size |
| --- | --- | --- |
| `@dsh-ops/fastctx-<platform>-<arch>` | this fork's own slimmed FastCtx build, `bin/fastctx.exe` | 49,492,480 B unpacked, 23.5 MiB packed |
| `@dsh-ops/bash-<platform>-<arch>` | a **pin** — the upstream URL, release, version, and SHA-256 of Git for Windows PortableGit. No binaries | kilobytes |
| `@dsh-ops/pwsh-<platform>-<arch>` | a **pin** — the same for PowerShell 7. No binaries | kilobytes |

**Neither shell's payload is in anything we publish.** Those bytes stay upstream,
and `dsh-ops provision-shells` fetches the pinned official asset on the machine
that wants it, checks it against the pin's SHA-256, and unpacks it under
`<DSH_HOME>/dsh-ops/shells/<name>/<version>/`:

```console
node bin/dsh-ops.mjs provision-shells            # both shells
node bin/dsh-ops.mjs provision-shells --bash     # 60,027,568 B from Git for Windows, ~390 MiB unpacked
node bin/dsh-ops.mjs provision-shells --pwsh     # ~101 MiB from PowerShell 7, ~245 MiB unpacked
```

We neither forward, nor repackage, nor redistribute those downloads: the command
points at upstream's own release asset, verifies the digest the pin records, and
unpacks the archive with upstream's own extractor. Nothing is downloaded at plugin
load time, and nothing is downloaded at all unless that command is run.

**Without them the ladder is shorter, not broken.** No bash from the plugin — no
provisioned copy and no packaged one — and none found on `PATH` or in the well-known
locations while `allowSystemShellFallback` is true, means no rung 2; no pwsh from the
plugin means no rung 3, and the bundle patch then leaves the host's `pwsh-sandbox`
row untouched. A bash or a PowerShell 7 the machine already has keeps working
through the resolution orders below, and `node bin/dsh-ops.mjs ladder` prints which
rungs are live and where each came from.

**The same tarballs are attached to the GitHub Release** for the tag, with a
`SHA256SUMS` beside them: the main package, this distribution's FastCtx platform
package, and the two pin packages. Nothing upstream's is a release asset. That is
the channel that needs no registry account and no network beyond one download:

```console
# the release carries SHA256SUMS: check every asset you downloaded against it
sha256sum -c SHA256SUMS

# PowerShell: one file at a time, compared with that file's line in SHA256SUMS
(Get-FileHash .\dsh-ops-fastctx-win32-x64-0.2.0.tgz -Algorithm SHA256).Hash.ToLower()
Select-String -Path .\SHA256SUMS -Pattern 'dsh-ops-fastctx'

# then install by path with the same profile command
dsh plugin --profile desktop add <path to the downloaded package>
```

The tarballs are the npm tarballs for the same packages, so the file a registry
would serve and the file downloaded from the release are the same bytes.

## Updating

What a new version needs depends on what changed:

| Change | Takes effect |
| --- | --- |
| A row's `config` (including this plugin's row) | live, via `ctx.hmr` |
| A row's `disabled` | live, via `ctx.hmr` |
| A newly installed bundle that was not loaded before | by HMR |
| Replacing a package that is already installed | **restart** |
| Profile `dsh.profile.bundles` ordering | **restart** |

The distinction is module generations. The HMR service (`ctx.hmr`: `runExclusive`,
`watchConfig`, `getLinked`, and the `hmr/change` and `hmr/reload` events) can
re-apply configuration and load modules that were not loaded yet, but Node does
not re-evaluate a module it has already loaded, so new JavaScript in a package
that is already installed is only read by a fresh process. Upstream states the
rule directly: installing a new bundle can activate through HMR, while replacing
an installed package requires a restart to load a fresh JavaScript module
generation.

So the update path is:

```console
dsh plugin --profile desktop add dsh-ops@<version>   # or re-add the local path
# restart DSH, then confirm the layer again
dsh --profile desktop --dump-config
```

Config-only changes do not need that restart. In the DSH GUI, the Plugin
Manager's component rows edit the same values and report `restart-required` when
a change cannot be applied live; treat that outcome as the honest answer rather
than a failure.

**The runtime is the exception.** The FastCtx executable can change without
restarting DSH, because the plugin owns the child process rather than a loaded
module: apply a new `config.binaryPath` or `DSH_OPS_FASTCTX_BIN` (row config is
live through `ctx.hmr`), or replace the file behind the resolved path, and the
next connection spawns it. The `ops_*` tools are republished by the plugin
whenever it connects.

**The ladder follows the registry; resolution follows the mount.** Rung 1 and rung 2
are decided by what is published, so the text follows the live registry at every
assembly — a FastCtx reconnect republishes its generation and the next read reflects
it. Resolution and publication happen while the plugin is applied, so a bash or a
pwsh installed later is picked up when the row is re-applied (or DSH restarts); rung
3 is that same fact, which is why it is not a live-registry question.

## Uninstalling

```console
dsh plugin --profile desktop remove dsh-ops
```

or, from an agent, `plugin_manager { action: "remove_bundle", target: "dsh-ops" }`.

Removal deletes the profile dependency and the bundle layer together, which is
what puts the profile back to its pre-install state: no `dsh-ops` row, no
`ops_*` tools, no prompt sections. It does not delete anything the profile does
not own:

| Left behind | Why, and what to do |
| --- | --- |
| `<DSH_HOME>/dsh-ops/bin/fastctx[.exe]` and `<DSH_HOME>/dsh-ops/runtime.json` | The managed runtime and its receipt. Removing the plugin does not remove a binary the operator asked `provision` to install. |
| `<DSH_HOME>/dsh-ops/shells/` | The two shells `provision-shells` downloaded and unpacked, if it was run. Same rule: the plugin's removal does not delete them; `dsh-ops uninstall --yes` does. |
| `~/.fastctx/` (`config.toml`, `jobs/`) | FastCtx's own user state, not this plugin's. It survives the plugin by design; leave it alone unless FastCtx is being retired. |
| The pnpm store entries for this package and the platform packages it pulled in | pnpm's own store, shared with other profiles. Do not delete them by hand. |
| Session history that mentions `ops_*` calls | Historical records. They stay readable, and a model without the tools does not call them. |

Every registration the plugin makes — the prompt sections, the `ops_*` tool
registrations (the hosted nine and `ops_bash`), the child process, the
`tools/pre-execute` fence, and the per-agent visibility mask it installed — is
owned by `ctx.effect` or `ctx.on` and released on unload, so nothing of the plugin
survives in the running process.

`dsh-ops uninstall` finishes the job outside the profile. It reports the runtime
directory it owns — `<DSH_HOME>/dsh-ops/`, holding the managed binary, the receipt,
and any provisioned shells — and, with `--yes`, removes it. Without `--yes` it is a
dry run. `~/.fastctx/` is reported and kept, and removed too only with
`--purge-fastctx`.

## Runtime and binary sources

The plugin's own tarball carries no FastCtx binary, and it never downloads anything
at load time. It searches, in order:

1. `config.binaryPath` — authoritative; an unusable path fails, it does not fall through;
2. `DSH_OPS_FASTCTX_BIN`;
3. the managed copy, `<DSH_HOME>/dsh-ops/bin/fastctx[.exe]`;
4. the vendored source build, `vendor/fastctx/target/release/fastctx[.exe]`;
5. this distribution's platform package, `@dsh-ops/fastctx-<platform>-<arch>` (an
   `optionalDependency`);
6. the upstream published platform package, `@fastctx/<platform>-<arch>`, on a
   deployment that has one;
7. `fastctx` on `PATH`.

When nothing is found the failure lists every candidate and what was wrong with
it. `node bin/dsh-ops.mjs status` prints the answer, the version, and the tools
the resolved executable actually publishes.

An explicitly configured path and `DSH_OPS_FASTCTX_BIN` are authoritative: when
either names something that does not exist or does not run, resolution fails
instead of quietly hosting a different binary. The remaining five steps are a
preference order, and every miss is reported rather than skipped.

There are three ways to get a runtime, and they are not exclusive:

- **Take the one the install brings.** A registry install declares
  `@dsh-ops/fastctx-<platform>-<arch>` as an optional dependency, so the search finds
  a runtime with no further work. See [What an install
  brings](#what-an-install-brings).
- **Prefer the vendored source.** `vendor/fastctx/` is the complete FastCtx
  source, so a checkout can build the runtime instead of trusting a download.
- **Provision to the managed location.** `provision` installs that build into
  `<DSH_HOME>/dsh-ops/bin/` and writes a receipt beside it, which keeps the
  runtime stable across package upgrades and out of the linked package
  directory.

The vendored build and provisioning are commands of the CLI that ships with the
package. `build` is the Rust build over `vendor/fastctx/`; `provision` is the
install step that puts the result where resolution finds it first. Rust 1.88 or
newer is required (the Cargo package is edition 2024).

```console
node bin/dsh-ops.mjs build        # cargo build --release over vendor/fastctx
node bin/dsh-ops.mjs provision    # build if stale, then install into <DSH_HOME>/dsh-ops/bin
```

`provision` writes `<DSH_HOME>/dsh-ops/runtime.json` recording the origin, the
version, and the SHA-256 of the installed executable. Set `CARGO_HOME`,
`RUSTUP_HOME`, `DSH_OPS_RUST_HOME`, or `DSH_OPS_CARGO` when the toolchain is not
where `cargo` expects to be found.

### The shells the plugin brings

The two rungs below FastCtx have their own resolution, and it is read-only: no
`PATH` write, no profile write, no `process.chdir`, and a rung that cannot be found
reports `available: false` instead of failing the plugin. Resolution answers "which
executable, by which route, and why not" — detail and reporting. It does not decide
whether a rung exists: rung 2 exists when `ops_bash` is published, and rung 3 when
the bundled executable is there.

`ops_bash` (rung 2) resolves in this order:

1. `config.bashPath` — authoritative; an unusable path fails the rung rather than
   falling through to another shell;
2. **the provisioned copy** — what `dsh-ops provision-shells --bash` unpacked,
   `<DSH_HOME>/dsh-ops/shells/bash/<version>/bin/bash.exe`;
3. **the packaged copy** — `vendor/bash/<platform>-<arch>/bash.exe` inside this
   package, or an installed `@dsh-ops/bash-<platform>-<arch>` that carries one;
4. `bash` on `PATH`;
5. well-known installs (Git for Windows, Scoop, Chocolatey, msys64).

Steps 4 and 5 are used only while `allowSystemShellFallback` is true. The Windows
WSL launcher, `%SystemRoot%\System32\bash.exe`, is deliberately never used: it is
not a POSIX shell over this filesystem. A bash that resolved still has to be
publishable — without the host's `subprocess` service there is no `ops_bash`, and
therefore no rung 2.

PowerShell 7 (rung 3) has no configured path, no `PATH` step, and no tool of its
own: the rung is live when this plugin has a pwsh on this machine, and what runs it
is the host's own `pwsh-sandbox` row, which `cordis.patch.yml` re-points through a
`!!js` `pwshPath`. Every layout that pwsh can arrive in is probed in one order —
the provisioned copy under `<DSH_HOME>/dsh-ops/shells/pwsh/<version>/` first, then
the packaged copy, `vendor/pwsh/<platform>-<arch>/pwsh.exe` inside this package or
an installed `@dsh-ops/pwsh-<platform>-<arch>` that carries one (the order named by
`BUNDLED_LAYOUT_ORDER` in `lib/shells.js`) — and the patch expression implements
exactly that order, with an `lstat`-based usability test (a Windows Store execution
alias counts; a directory named `pwsh.exe` does not), a Windows platform gate, and a
wrapping `try`/`catch`. A deployment with no pwsh in any of those layouts therefore
gets `undefined` — the row's own default — which leaves the host's PowerShell
resolution completely untouched, and the ladder has no rung 3.

There is no config key for that rewrite on purpose: a bundle patch is evaluated
before any `dsh-ops` row is mounted, so a key could never reach the expression. A
profile that does not want the rewrite edits or removes that entry in its **own**
`cordis.patch.yml`, which is applied after every bundle layer and therefore has the
last word.

The two pin packages carry no executable, so a registry install brings no shell with
it: what puts one on the machine is `dsh-ops provision-shells`, and a deployment
that has not run it keeps whatever the machine already had — `PATH` and the
well-known locations for bash, the host's own pwsh tool as the ladder's last rung.
A rung that resolves nowhere is not an error; it is a shorter ladder, and
`node bin/dsh-ops.mjs ladder` prints each rung's availability, the executable it
came from, and which rungs the prompt text renders for that answer.

## How the tool surface is published

The plugin spawns FastCtx itself — `fastctx serve`, or `fastctx serve
--enable-shell` when `enableShellTools` is on — and owns that child for as long
as it is mounted. It then speaks MCP over the child's stdio, one newline-delimited
JSON-RPC request per line: `initialize` and `tools/list` when it connects,
`tools/call` for each call, and a fresh `tools/list` after a reconnect. Each
listed tool is published as `ops_<name>` through **this plugin's own**
`ctx.tools.register`, and the disposer that call returns is what releases it —
one generation is published and released together. **The plugin never rewrites
the shared tool registry**: no own property is installed on the `ToolRuntime`
instance, and no method on `ctx.get('tools')` is replaced. Establishing that
boundary cost an incident — an interceptor on `register` made every foreign
registration look like this plugin's, so the host's second registration of a name
such as `subagent` threw and no new session could be created (2026-10-08). The
mechanism, its symptoms, and the regression assertions that hold the boundary are
recorded in [`PROVENANCE.md`](PROVENANCE.md), under "The boundary the 2026-10-08
incident established".

`ops_bash` is published the same way — a plain definition through this plugin's own
`ctx.tools.register`, released through the disposer that call returned — so both
tool namespaces in `dsh-plugin.json` describe registrations this plugin owns.

## Configuration

Every key is optional; the bundle patch documents the defaults. Unknown keys fail
the plugin at load rather than being ignored.

```yaml
- insert:
    - id: dsh-ops
      name: dsh-ops
      config:
        binaryPath: 'C:\tools\fastctx.exe'   # default: automatic resolution
        serverName: fastctx                  # default: fastctx
        enableShellTools: true               # default: true
        toolCallTimeoutMs: 300000            # default: 300000
        required: false                      # default: false
        shellPolicy: advise                  # advise | deny-host-shell
        deniedHostTools: [pwsh, bash, pwsh_persistent]
        promptPolicy: true                   # default: true
        extraGuidance: ''                    # appended to the tooling section
        bashPath: 'C:\Program Files\Git\bin\bash.exe'   # default: automatic resolution
        publishBashTool: true                # default: true
        allowSystemShellFallback: true       # default: true
```

- **`serverName`** — the hosted server's own name. It names the prompt section the
  FastCtx server's own instructions are published under (`mcp:<serverName>`), at the
  host's `MCP_SERVERS` placement; it is no longer a tool namespace, because every
  tool is published as `ops_<name>` by this plugin itself.
- **`required`** — when true, a runtime that cannot be resolved, probed, or
  started rejects plugin activation. When false (the default), the plugin logs the
  failure, keeps the prompt policy, and leaves the tooling section empty rather
  than telling the model to call tools that do not exist.
- **`shellPolicy`** — `advise` injects the policy only. `deny-host-shell` does two
  things: it masks the names in `deniedHostTools` out of each new agent's view
  (`tools.restrict`, on that agent's own scoped context), and it refuses them at
  `tools/pre-execute`, which is the guarantee and is installed by the mode alone.
  The mask is offered only while this deployment still has a shell rung of its own —
  `ops_bash` is published, or the PowerShell 7 rung is live; without one the host
  shell stays visible, the fence still refuses it, and the plugin says why once.
  FastCtx's own tools are never refused, so command execution stays available.
- **`bashPath`** — the bash `ops_bash` runs, authoritative: an unusable path fails
  rung 2 instead of quietly running a different bash. Unset, a provisioned copy is
  preferred, then the packaged copy, then `PATH`, then the well-known installs.
- **`publishBashTool`** — set false to publish no `ops_bash` at all; rung 2 then
  disappears from the ladder whether or not a bash resolved.
- **`allowSystemShellFallback`** — set false to confine rung 2 to what this plugin
  provides — a provisioned copy, the packaged copy, or `bashPath` — and to drop the
  "the host's own pwsh tool is the last rung" note from rung 3's report. It never
  affects whether rung 3 runs: the host's `pwsh-sandbox` row follows this plugin's
  own pwsh being there.
- **`extraGuidance`** — appended verbatim to the tooling section, for
  deployment-specific rules.
- `pwshPath` and `overridePwshExecutor` are **not** keys, and now fail loud as
  unknown keys: a bundle patch is evaluated before this plugin's row is mounted, so
  no config key can steer rung 3. See [The shells the plugin
  brings](#the-shells-the-plugin-brings).

## Verify

```console
npm install
npm run verify      # dsh-std manifest gate + the test suites
```

`npm run verify` runs two gates:

- **`scripts/validate-manifest.mjs`** parses `dsh-plugin.json` with the pinned
  `@dsh-std/manifest` Community v0.15 parser, projects it, and then checks the
  facts this repository can get wrong about itself: version and license agreeing
  with `package.json`, the declared host entry and bundle patch existing, both
  declared tool namespaces matching `lib/policy.js` (the hosted nine, and the
  in-process `ops_bash`), every tool of the in-process namespace being named as
  `ops_<name>` by the fully-open ladder text, and the declared prompt sections
  being the registered ones. 47 checks.
- **`node test/run.mjs`** runs each `test/*.test.mjs` in its own process with its
  own throwaway `DSH_HOME` — seven suites, 133 checks. The mount suite is a real
  composition: real Cordis `Context`, the harness's real `@deepseek-ai/dsh-tools`
  registry, `@deepseek-ai/dsh-system-prompt` assembly, and
  `@deepseek-ai/dsh-scope` agent scopes, plus a real FastCtx binary spawned by the
  plugin's own MCP client. It asserts that the nine tools register, that a tool call
  round-trips, that both prompt sections render, that `deny-host-shell` refuses
  `pwsh` while allowing FastCtx and hides it from a new agent once a rung of the
  plugin's own is live, that disposal leaves nothing behind, and — the incident,
  pinned — that the shared registry carries no own `register`, that the same foreign
  name registered once in each of two scopes is attributed to neither, and that the
  FastCtx child never inherits credential-shaped names. The shell suite covers the
  resolution order and its refusals (`System32\bash.exe` is never bash), the
  `ops_bash` spawn spec through a recording subprocess service, that the definition
  passes the real registry's schema gate, and the L3 override agreeing with the
  plugin's own probe on every layout, in the same order. The policy suite
  pins the ladder: the rungs in order, the renumbering when one is missing, that a
  rung follows the published tool rather than a resolved executable, and that the
  wording never promises a fallback the plugin does not perform.

## Known limitations

- **FastCtx's own command runner is a POSIX bash.** On Windows, FastCtx resolves a
  bash from the environment (Git for Windows' MSYS bash works, and
  `dsh-ops provision-shells --bash` puts one under `<DSH_HOME>/dsh-ops/shells/`). A
  deployment without one should set `enableShellTools: false`; the four file tools,
  `ops_bash`, and the ladder's other rungs are unaffected.
- **Rung 3 is one executable in one of three places, and only one of them is
  downloaded by us.** The rung is live when this plugin has a pwsh, and every layout
  it can arrive in is probed in the same order by the plugin and by the bundle patch
  that re-points the host's `pwsh-sandbox` row: the provisioned copy under
  `<DSH_HOME>/dsh-ops/shells/pwsh/<version>/` first, then the packaged copy
  (`vendor/pwsh/<platform>-<arch>/pwsh.exe`, or an installed
  `@dsh-ops/pwsh-<platform>-<arch>` that carries one) — `BUNDLED_LAYOUT_ORDER` in
  `lib/shells.js`. With no pwsh in any layout the expression yields `undefined`, the
  host row is untouched, and the ladder has no PowerShell rung. A profile that
  re-points or removes the entry in its own `cordis.patch.yml` overrides the plugin
  completely.
- **Rung 2 needs the host's subprocess service, not just a bash.** `ops_bash` is
  published only when a bash resolved *and* `ctx.subprocess` is mounted; without that
  service the plugin publishes nothing, reports the resolved bash by name, and the
  ladder has no rung 2. Every profile built on the host's base bundle mounts the
  provider (`@deepseek-ai/dsh-subprocess-local`).
- **A dead server keeps its tools listed until the reconnect budget runs out.**
  A crash is an event, not a failed request, so the plugin notices it between
  calls and reports it; the `ops_*` registrations are not withdrawn, and a call
  fails loudly instead (`ops_grep is unavailable: …`). Only after 10 consecutive
  failed reconnect attempts does the plugin unpublish, which is also when the
  tooling section goes empty. There is no notification, only the next read.
- **The MCP client is the plugin's own, and it is deliberately minimal.**
  `lib/handshake.js` speaks newline-delimited JSON-RPC 2.0 and implements only
  what this plugin uses: `initialize`, `notifications/initialized`, `tools/list`,
  `tools/call`, and `close`. A server that needs the rest of the MCP surface —
  resources, prompts, sampling, server-initiated requests — is not supported.
- **A foreign tool squatting on an `ops_` name costs the whole generation.** The
  tools are published as one generation: if any `ops_<name>` is already taken in
  this plugin's scope, the partial generation is rolled back and the attempt is
  reported as a connection failure rather than a half-published surface.
- **The vendored FastCtx is stripped to its MCP server.** The upstream control
  terminal, self-updater, and Codex integration are deleted rather than merely
  left unreachable, so the binary carries `serve` plus the internal entry points
  the shell and session machinery spawn. Every source file this fork touches
  carries its own Apache-2.0 §4(b) notice. See `vendor/fastctx/FORK.md`.

## License

This distribution is licensed under the composite expression
**`MIT AND Apache-2.0`**:

- the **dsh-ops plugin** — everything except `vendor/fastctx/` — is MIT
  (`LICENSE`);
- the **vendored FastCtx source** in `vendor/fastctx/` is Apache-2.0 by its
  author (`vendor/fastctx/LICENSE-APACHE`, `vendor/fastctx/NOTICE`).

The full statement is in [`NOTICE`](NOTICE).

## Acknowledgments

FastCtx is the work of [yc-duan](https://github.com/yc-duan). This plugin is a
distribution of it, not a replacement for it: nothing here would exist without
the runtime, the tool design, and the output discipline that upstream built.

FastCtx's `NOTICE` requires this notice to be reproduced verbatim, and it is:

> This product includes FastCtx
> (https://github.com/yc-duan/fastctx), Copyright (c) 2026 yc-duan,
> used under the Apache License 2.0.
>
> FastCtx is redistributed and/or modified here by the maintainer of
> this distribution. Any such change is that maintainer's own work
> and their sole responsibility. It is not endorsed by, not
> supported by, and not attributable to the author of FastCtx, who
> accepts no liability of any kind arising from this distribution or
> from anything built on top of it.

### What was changed

`vendor/fastctx/` is upstream `main` at
`ccaa157790d02328a60786eb94ee5ad698995a5f`, with upstream's distribution and CI
machinery removed: `.github/`, `packages/` (the npm launcher, the `codex-fastctx`
package, and the five `@fastctx/<platform>` binary packages), and `scripts/` (the
PowerShell release tooling). No FastCtx source file was modified. Every difference
is enumerated in
[`vendor/fastctx/FORK.md`](vendor/fastctx/FORK.md); the pinned revision is in
[`vendor/fastctx/UPSTREAM.md`](vendor/fastctx/UPSTREAM.md).
