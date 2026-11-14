# Usage

The complete install, update and remove flow, plus every option of the command-line interface.

Before replacing a running installation, read [Upgrade and uninstall safely](upgrading.md)
for stopping the host, registry-policy failures and the 0.4.x-to-0.5.x migration checklist.

## 0.5.0 candidate and component defaults

Native file paths (including copy/move destinations), omitted search paths and Bash's default or
relative `workdir` follow the live `workingDirectory` service. Each call resolves its base once;
`resolvedFrom` and `cwdSource` identify that base in structured and rendered file/Bash results
(credential refusals remain path-free).
The DSH 0.2.2 `workingDirectory` service is required. Missing services, service errors
or cancellation stop the call rather than silently using an old directory. Changing cwd never
widens `sandboxPolicy.workspaceRoot` write authority. Native `ops_result` defaults to the live cwd;
after changing directories, pass the original returned `referenceRoot` as `root` to page or release
an older reference. The shared PTC result capability also defaults to the live cwd; use an explicit root for workspace-bound batch audits.

This checkout is an unreleased candidate. The bundle declares one enabled `dsh-ops` row. Its
built-in preset consumers, explicit `presets` map, Native discovery, panel, TUI and companion link
are configured on the same page. Panel and TUI start off. Migrate saved legacy-row values into
this row before removing obsolete overrides; OPS does not rewrite profiles automatically.

Standard and Cordis publish resident Native tools; Minimal has no file baseline; PTC publishes
typed APIs with a separate SDK loader; OPS PTC (`ops-ptc`) is registered at plugin runtime and keeps
that surface, adding the batch-call guidance from the editable `prompts/batching-guidance.md` once at
session start, then shape notices for root `run_code` programs (`bypass`/`plan`/`shape`, each latched per
 turn) appended as `additionalContexts` (on in the packaged bundle; see [presets](presets.md)).
The default preset is forced by `global.forceDefaultOpsPtc` only when it is turned on (off by default).
Residency, dynamic loading, Bash, file replacement and
Windows host-shell hiding are independently controlled. Global gates preserve saved per-preset
intent. Explicit consumers use the same assembler; unlisted presets remain unchanged.
[Configuration](configuration-reference.md) describes native Switch controls and exact custom ids;
see the [upgrade notes](upgrading.md#moving-from-04x-to-05x) for migration.


In 0.5, enabling official-tool replacement does not guarantee that a conditional official tool disappears from the model's tool table. When the OPS counterpart has conditional admission, OPS keeps the official registration visible and guards its dispatch only when the same captured step toolSet admits the counterpart and the consumer still has current authority. An absent, revoked or not-yet-ready counterpart cannot disable the official tool as well. Safe unconditional resident replacements may still use host restrictions. OPS never wraps official definitions or hides tools from inside admission conditions or prompt assembly.

---

## Prerequisites

For repository review evidence, the explicit [review snapshot CLI](review-snapshot.md)
aggregates bounded PR, claim, CI and base-head facts without adding resident tools.

| Item | Requirement |
| --- | --- |
| OS | Windows x64, Linux x64 or macOS 13+ (arm64 or Intel x64); OPS Bash is on by default on all of them (pinned payload on Windows, distribution Bash on POSIX) |
| Node.js | `^22.19 \|\| >=24` (the `engines` field in `package.json`) |
| Host | DSH `0.2.2-rc.1` or later in the 0.2.2 series |
| Target application | Initialized |

### macOS (arm64 and Intel)

macOS carries no bundled shell payload, and the native worker is not part of the
repository on any platform. Build and stage the worker for the host:

```console
cargo build --release --manifest-path native/Cargo.toml
# Apple Silicon
node bin/native-runtime.mjs stage --platform darwin-arm64
# Intel
node bin/native-runtime.mjs stage --platform darwin-x64
```

Then set the single row's built-in section to a Bash the machine already has:

```yaml
standard:
  bashPath: /opt/homebrew/bin/bash   # Intel Homebrew: /usr/local/bin/bash
```

`/bin/bash` also works. macOS 12 is not fully supported: the write path needs
`CLONE_ACL`, which macOS 13+ provides; read-only tools still work. See
[macOS (arm64 and Intel)](macos.md) for the capability matrix and the known
limitations.

The desktop application's bundled CLI lives inside its own installation, at
`.../Contents/Resources/runtime/cli/bin/dsh` on macOS, rather than at the
`%LOCALAPPDATA%` path used on Windows. The host exposes no pwsh row on macOS, so
PowerShell 7 is unavailable there.

---

## Install

### Official plugin marketplace

In the target DSH application's plugin marketplace, enter the npm package name **`dsh-ops`**, install, then enable. Installation belongs to the currently running profile, which is `desktop` for the desktop app. The main package declares the Windows Bash payload as an optional dependency (`@dsh-ops/bash-win32-x64@0.2.1`), so a Windows x64 install automatically fetches the pinned PortableGit runtime (GNU bash 5.3.15); other platforms skip it and keep the system Bash. PowerShell stays under host control. Installation runs no shell downloader and does not change system PATH.

### Optional Bash runtime

On Windows the pinned Bash payload arrives with the install; `bash-runtime` remains the selection and repair path when a copy is missing or damaged, and can install the verified managed copy or select an existing Git Bash:

```console
dsh-ops bash-runtime status
dsh-ops bash-runtime install
dsh-ops bash-runtime git [--path <exe>]
dsh-ops bash-runtime niubash
dsh-ops bash-runtime remove            # preview only
dsh-ops bash-runtime remove --yes      # remove receipt-marked managed versions
```

`niubash` reports the default executor the deployment resolves and states that the mode rows' `bashPath` must be removed for it; `git` prints an absolute `bashPath` for the host config editor (the first scanned installation when `--path` is omitted). Neither edits a profile or PATH. The settings page's **Bash executor** card is the same choice with a UI: switch to Niubash, click a scanned Git Bash, or type a path; the host validates it before the save is written. Reload the mode row after applying the selection or installing/removing its runtime. Stop running Bash jobs before removal. Removal refuses links in the managed path and preserves unmarked versions, system Git and PowerShell. `install` reuses the pinned download and checksum checks from `provision-shells --bash`; `--dry-run` makes no download or change. Windows restricted modes still require the pinned MSYS IPC compatibility match. A different Git Bash remains a full-access choice; approval never repairs an incompatible restricted runtime. Linux/macOS continue using host Bash.

Windows confined calls stage a private MSYS tree under `<DSH_HOME>/dsh-ops/bash-ipc`. Identical verified payloads share a content-addressed generation across profiles using the same DSH home; separate homes remain isolated. Lifecycle locking and durable process leases protect selected runtimes, including the interval before a child starts. Automatic reclamation retains the current generation and one predecessor, plus leased, legacy or uncertain entries. `bash-runtime status` and `ladder` expose observed cache usage. To reclaim historical copies, first run `dsh-ops bash-runtime clean-cache` to preview. Stop **all** OPS hosts and Bash jobs, then run `dsh-ops bash-runtime clean-cache --yes --all-hosts-stopped` against the intended `DSH_HOME`; `--dry-run` never removes anything. Only recognized marker-owned generations are eligible; unrelated directories and linked paths are not removed. The selected generation and one predecessor remain. Removed caches are rebuilt on demand. Do not manually delete caches while any OPS host or shell may still use them.

Long command output that overflows the in-memory tail is spilled by the host subprocess service to `<tmpdir>/dsh-subprocess-*`, and DSH itself keeps those files until an external cleanup that does not exist. OPS therefore records every spill path it settles in `<DSH_HOME>/ops-spill-ledger.jsonl` and reclaims only those recorded files: files older than `spillRetentionDays` (default 30), then the oldest files while the retained total exceeds `spillTotalBudgetMiB` (default 256 MiB), at most 64 files per bounded pass. `spillRetentionDays: 0` reports without deleting and `spillSweepEnabled: false` stops the automatic passes. `dsh-ops bash-runtime spill-report` shows the ledger count, existing and expired bytes, skipped non-local entries and the last failure; add `--json` for the raw report or `--sweep --yes` to delete the eligible files. `bash-runtime status` includes a one-line summary. OPS never removes a `dsh-subprocess-*` directory, never scans a directory for files to delete, and never touches a path no settlement recorded.

### Reclaiming OPS temporary state

`dsh-ops cache status` reports every temporary resource OPS itself can reproduce, with its ownership evidence and the bytes it occupies: kept provision downloads under `<DSH_HOME>/dsh-ops/pending`, Niubash staging and previous siblings beside the fixed payload, quarantined Bash IPC generations, audit-store writer temporaries under `<root>/.dsh-ops`, legacy Niubash execution trees from 0.5.0–0.5.2, and non-current prepared Niubash versions plus broken/stage/retired leftovers. New calls reuse one prepared runtime, not temporary trees. Nothing is deleted on a name pattern: ownership evidence must verify inside a known root and no live lease may name it. Legacy execution trees may be incomplete or lack receipts, but every existing payload member must match the frozen bytes. Prepared directories instead belong to the exact manifest-hash namespace under the known prepared root; old manifests need not be installed. The current plain hash, unrelated names and links are excluded. Prepared reclamation renames a live name once before best-effort deletion, removes an already `.retired-` name in place, and keeps a refused rename for a later host start/reclaim.

`dsh-ops cache reclaim` is the same report with a decision. It previews by default, deletes only with `--yes`, and refuses outright without `--all-hosts-stopped`, because several of these roots belong to processes that may still be running — stop every OPS host and Bash job first. Each row reports `deleted`, `kept` or `unverified` plus bytes; a removal that fails is moved aside for the next run. `--kind` narrows the run to one class, `--root` names an audit-store root explicitly, and `--json` prints the same facts as data. Kept provision downloads are also reclaimed automatically, under a count/byte/age budget, by the next `provision-shells` run.

### One-command npm installation

```console
npx --yes dsh-ops@latest install --profile desktop
npx --yes dsh-ops@latest install --profile web
npx --yes dsh-ops@latest install --profile tui
```

An explicit target profile is required. `tui` maps to the **dsh-TUI product's `dsh-tui` profile**, not the old `tui` directory. Initialize the target application first. This entry point delegates installation to the official DSH CLI rather than implementing separate profile locking and rollback logic.

Desktop must use the CLI bundled with the desktop application; the default auto-detected path is `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`. For another installation location, add `--dsh-cli "<installation>\resources\runtime\cli\bin\dsh.cmd"`. Web/TUI require an available DSH CLI, which can also be specified explicitly.

### Using the official commands directly

```console
dsh plugin --profile web add dsh-ops
dsh plugin --profile dsh-tui add dsh-ops
"<desktop installation>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-ops
```

The ordinary DSH CLI cannot manage the reserved `desktop` profile; do not confuse it with the desktop app's bundled entry point.

### Which channels install a loadable plugin

`add dsh-ops` resolves the published registry tarball, which carries the compiled
`lib/` and every staged `runtime/` target. A fully built source tarball is also supported.
Direct Git installation or an unbuilt checkout is unsupported. `.gitignore` keeps `lib/` and `runtime/` out
of the repository, and the native worker is staged by `npm run build:ptc`, which needs cargo
and the full toolchain. `npm ci && npm run build && npm run build:ptc && npm pack` produces a
tarball you can install; `git+https://…` on its own produces a package that loads without
tools, because the file tools stay unpublished while no worker resolves. `package.json`
therefore declares `prepack` and no install-time lifecycle hook — `prepare`,
`preprepare`, `postprepare`, `install`, `preinstall` and `postinstall` are all
refused — and the manifest gate fails if one appears. See
[installing from Git is not a supported channel](upgrading.md#installing-from-git-is-not-a-supported-channel).

### Host compatibility and display metadata

The 0.5 series declares `>=0.2.2-rc.1 <0.2.3-0` in `engines.dsh` and the DSH peer dependency. DSH 0.2.0/0.2.1 and earlier 0.2.2 previews are unsupported; use an older OPS release with those hosts. The adapter architecture remains, but its host APIs and development dependencies target 0.2.2-rc.1 natively. Version-range tests check metadata, not runtime coverage of future releases. Discovery and PTC definitions remain stable while the host captures each step's admitted tool set; selections commit at step end and cannot expand the current request. The live working-directory service is required, with no session-header execution fallback.

The bundle icon comes from the root manifest. Each component exports its own
`dsh-ops/<component>/icon` and `locale/*.json`; DSH 0.2.1 does not use a component's
`package.json` for these resources. The metadata gate resolves the PNG bytes and
bilingual text through host APIs. This is resource-loading evidence, not a Desktop
screenshot or a claim about a particular theme.

Keep `--profile` before `add` and its package-manager arguments. For an existing
test profile, refresh the bundle through the official installer, then inspect the
composition and schema without starting a model request:

```console
dsh plugin --profile ops-test add dsh-ops@latest
dsh --profile ops-test --dump-config
dsh --profile ops-test --dump-config-schema
```

Use the intended package version or a packed checkout instead of `@latest` when
testing an unpublished change. The dump must contain the single `dsh-ops` row with no
`patch: entry ... not found` diagnostic. Migrate values from saved obsolete row overrides into
this row before deleting those overrides. Manifest validation checks the single-row declaration
and its validated defaults; the real-host settings suites verify saves and reloads.

---

## Update

For inherited whitelist limits, missing discovery rows and provider tool-change
errors, see [host integration troubleshooting](host-integration.md).

Repeat the same `npx --yes dsh-ops@latest install --profile ...` command, or use the official CLI's `add dsh-ops@latest`. Reload as requested by the application; restart it when replacing already-loaded code.

---

## Remove and check status

```console
npx --yes dsh-ops@latest status --profile desktop
npx --yes dsh-ops@latest uninstall --profile desktop
```

Replace `desktop` with `web` or `tui` as appropriate. You can also uninstall in the marketplace or run the official `dsh plugin --profile ... remove dsh-ops`. Binaries are managed as profile plugin dependencies; uninstalling removes dependency references without deleting system shells, copies in other profiles or shared package-manager caches.

Legacy explicitly provisioned `<DSH_HOME>/dsh-ops/` files (provisioned shells, and the FastCtx runtime earlier versions could provision) must be cleaned separately with `npx --yes dsh-ops@latest uninstall --yes`. The `~/.fastctx/` state left by the removed background component is kept by default; add `--purge-fastctx` explicitly to remove it as well.

---

## Host PowerShell on Windows

OPS no longer bundles PowerShell or changes the host's `pwshPath`. Windows PowerShell 5.1, existing custom executors and old OPS provisioned copies remain untouched. To install or upgrade the standard PowerShell 7 installation, first inspect the plan:

```console
dsh-ops upgrade-host-pwsh
dsh-ops upgrade-host-pwsh --yes --dry-run
dsh-ops upgrade-host-pwsh --yes
```

Only `--yes` executes WinGet; `--dry-run` always previews. The action uses the exact stable `Microsoft.PowerShell` package from the `winget` source and retains WinGet's installer and agreement prompts. It may require Windows elevation. Missing WinGet produces guidance without attempting installation; see [Microsoft's Windows installation guide](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows).

Restart DSH after successful installation so the host probes its executor again. An explicit host `pwshPath` remains authoritative: review it in host settings if it points elsewhere. A `no-update` result means WinGet found no applicable update for this package, not that every custom PowerShell copy is current. Cancellation after the installer starts has unknown effects; check the standard installation before retrying. The older `provision-shells --pwsh` command remains an explicit compatibility download, but OPS does not activate its copy automatically.

## Command-line interface

```console
dsh-ops install --profile <desktop|web|tui> [--dsh-cli <path>]
dsh-ops uninstall --profile <desktop|web|tui> [--dsh-cli <path>]
dsh-ops status --profile <desktop|web|tui>
                                Report target-profile installation (tui maps to dsh-tui)
dsh-ops build-ptc              Build the independent native Rust worker (all platforms)
dsh-ops uninstall [--yes] [--purge-fastctx]
dsh-ops ladder [--json] [--config <file>]
                                prompt ladder actually renders; nothing is spawned
dsh-ops upgrade-host-pwsh [--yes] [--dry-run]
dsh-ops provision-shells [--bash] [--pwsh] [--force] [--dry-run] [--pin <file>]
                                their digests, and install them under <DSH_HOME>/dsh-ops/shells
dsh-ops panel [--serve] [dir] [--port <n>]
                                Serve the panel viewer and capture reports over loopback
```

With `--profile`, install/uninstall delegate to the official DSH profile manager.
Without `--profile`, uninstall only cleans legacy provisioned runtime/shell files.
`resolve`, `status` (without `--profile`), `build` and `provision` were removed with the FastCtx background component; each now exits with a message naming its replacement.

### Panel viewer

The panel capture row (off by default) writes each new conversation to
`<cwd>/.dsh-ops/panel/<sessionId>.json` and leaves a static `panel.html` that inlines no data. Open
those reports without dragging a file or starting a static server:

```console
dsh-ops panel                  # serves ./.dsh-ops/panel on 127.0.0.1
dsh-ops panel <capture-dir>    # serves a directory written by another workspace
dsh-ops panel --port 8123      # fixed loopback port; 0 (default) asks the kernel
```

The command prints `http://127.0.0.1:<port>/`, preselects the newest valid report and lists the
other valid reports for switching. `--serve` is accepted as an explicit alias. It binds loopback
only, reads that one directory, writes nothing, and names malformed reports it skipped. The capture
row itself still opens no port: only this operator command starts a server. Opening `panel.html`
directly through `file://` still requires dragging the JSON in, because browsers block
same-directory `fetch`; under any static server, append `?data=<sessionId>.json`.

Capture writes inside the conversation's own working directory. Add `.dsh-ops/` to that project's
`.gitignore` before committing: reports contain prompts, conversation text and tool output.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `HTTPS_PROXY` | Proxy handed to curl explicitly by provision-shells |
| `DSH_OPS_REQUIRE_RUNTIME` | Make `npm run verify` require an available runtime |
| `DSH_OPS_WORKER_BIN` | Select a worker build (otherwise `runtime/<platform>-<arch>/` then `native/target/release`) |
| `DSH_OPS_VCVARS64` | Supplies the MSVC environment when building Bash IPC proxies |

---

## Script files: `command` versus `script_path`

Use `ops_bash`'s `command` for short commands and pipelines. For scripts longer than about 1 KB, or containing heredocs, quotes, backslashes or non-ASCII text, write the script with the host file tools first, then execute it with `script_path`; do not put the entire heredoc in `command`. This substantially reduces multi-layer escaping in tool-call JSON and lowers the chance that a turn is discarded as `MALFORMED_RESPONSE`.

`script_path` accepts only the script path, so the script body is not repeated in the `ops_bash` arguments. `command` and `script_path` are mutually exclusive and exactly one is required. This interface cannot repair JSON that the model or host failed to parse; an unparseable tool call still requires a host/model retry.

`ops_bash` requires a non-empty `description` and keeps the host Bash fields and result kinds: `foreground`, `background`, or `promoted`. Its default timeout is 120 seconds and the cap is 600 seconds. When the host jobs service is available, `run_in_background: true` returns a job ID immediately; a foreground timeout promotes the same running job. Use the host `job_output` and `job_kill` tools to collect or stop it. Without host jobs, the background parameter is absent and a foreground timeout stops the command. Unknown arguments are rejected before execution.

The host job list and waiting view use `description` as the task label. Both `background` and `promoted` results include that same `label` beside `jobId`, and the rendered result quotes it. When migrating from the old `ops_run_background` / `ops_job_output` / `ops_job_kill` tools, start work with `ops_bash`'s `run_in_background` (or let a foreground call promote), then use the host `job_output` / `job_kill` with the returned ID. Keep `description` concise so the job is recognizable while waiting.

`sandbox_permissions` plus `justification` can request a strictly wider mode through the host approval service. An allowed-once grant applies to that command only; rejection never executes it or changes the session mode. Authority is checked again after approval and sandbox preparation. Windows confinement reports the host provider’s actual enforcement (including `partial`); incompatible Bash runtimes fail closed.

`script_path` (instead of `command`), `graceMs`, and `includeDiagnostics` remain explicit OPS compatibility extensions. They do not change the host command contract or its timeout limits.

---

## Process reclamation

This version starts no long-lived server process: the native file worker is owned by the enabled mode rows (and the discovery row) and stops with them. Earlier versions with the background component started `fastctx serve` clients and could leave a shared FastCtx `runtime-host`; that process exits on its own after about ten minutes without clients. This release does not sweep processes left by older versions; do not kill them by process-name sweeps.

---

## Update configuration modification area

`lib/config-updates.js` centralizes one-time config migrations. On first startup with 0.2.5, each owning component row runs a self-check:

- With no `configUpdateVersion` (or `0`), change legacy `allowSystemShellFallback: true` to `false` before resolving executors or publishing tools.
- Submit the raw owning row through the official loader lifecycle with `configUpdateVersion: 1`. Preserve other fields; never change foreign plugins, PATH or global config. Disabled components migrate when first started.
- After completion, restarts/hot reload do not overwrite a later manual `true`. Do not remove the marker unless you intend to repeat the self-check.
- Without an owning loader row, apply the safe value for this activation and warn. Migration/loader logs report write failures; a marker not persisted to disk cannot guarantee once-only behavior across restarts.

---

## See also

- [Configuration reference](configuration-reference.md) — every configuration key
- [Component reference](component-reference.md) — components and tools
- [Troubleshooting](troubleshooting.md) — errors and diagnosis
- [Native PTC](native-ptc.md) — the PTC design and build


## Native file results

Native file tools present readable text: `=== FILE: path (Lines a-b of n) ===`
followed by `N | text`; fully returned multi-file ranges use compact `N|text` and may share one JSON-quoted parent path. Paths, observed revisions and paging notices remain visible. See [compact ranges](native-ranges.md).
Native execution values and PTC SDK values share the typed `Outcome` contract: inspect `status`, then `data` for canonical facts, and preserve coverage/continuation on partial results. Native text stays independently rendered and compact. Grep context labels use the physical source line, while glob
path mode lists one path per line. Stat retains size, revision and metadata facts;
diff shows removed/added lines. Mutation tools return short receipts without
repeating file contents.

Only physical LF ends a line (CRLF is one boundary). Empty files have zero lines;
a final LF adds no empty line. Bare CR and Unicode separators do not add lines; control separators are escaped
in the display so they cannot break a numbered line.
Writing text preserves its bytes and line endings. Invalid UTF-8 or an unsupported
text encoding returns `ERR_INVALID_ENCODING`, with guidance to use a document/binary
reader or `view: "hex"`; no lossy text replacement is performed.

Native content blocks are capped at 64 KiB after JSON escaping. A clipped display
says `Display incomplete` / `TruncatedBy: output-budget`; request a smaller original
read range instead of advancing past undisplayed text. A truncated line cannot be
recovered by moving to the next line: use hex byte rows. A clipped mutation receipt
is not permission to repeat a write: inspect current state first. Error notices
show effect state and retry guidance before potentially long diagnostic messages.
