# Upgrade and uninstall safely

中文：[升级与卸载](升级与卸载.md).

## Binary locations and update cleanup

This candidate embeds complete Niubash 1.5.0; `@latest` remains the published release until publication. These locations apply equally to marketplace installs, `npx dsh-ops install --profile ...`, official `plugin ... add`, local tarballs, and direct npm/pnpm installs:

| Ownership | Binary location | Update/removal behavior |
| --- | --- | --- |
| Installed package | `<installed dsh-ops>/runtime/<platform>-<arch>/dsh-ops-worker[.exe]`; Windows Niubash at `runtime/win32-x64/niubash/niu.exe` with its complete sibling tree | Upgrade the same profile/package, not a new folder per version. The package manager replaces its package; do not manually copy binaries beside it. pnpm may resolve the package into its store. |
| Explicit provisioning | `<DSH_HOME>/dsh-ops/shells/niubash/niu.exe` | One fixed directory. Staging verifies a fresh sibling, rolls back replacement failure, and removes the previous tree after successful replacement. It does not accumulate version directories on successful updates. Normally the bundled payload needs no separate provisioning. |
| Kept provision download | `<OS temp>/dsh-ops-<pwsh\|bash>-<rand>` plus one record under `<DSH_HOME>/dsh-ops/pending/` | A failed provision keeps its downloaded bytes because a digest mismatch is only actionable with the file in hand, and writes a durable record. The next `provision-shells` reclaims registered entries under a count/byte/age budget; `cache status` reports the rest and `cache reclaim --yes --all-hosts-stopped` reclaims it. Never swept by name or age alone. |
| Per-call execution | `<OS temp>/dsh-ops-niu-exec-*` | A verified disposable copy is removed after completion/cancellation. Cleanup failure is reported; crashes may leave copies. `cache reclaim --yes --all-hosts-stopped` reclaims the ones whose execution provenance verifies; nothing is removed on a name pattern, and stop all OPS hosts/jobs before applying it. |
| Legacy managed Git Bash / IPC | `<DSH_HOME>/dsh-ops/shells/bash/<version>`; `<DSH_HOME>/dsh-ops/bash-ipc/` | Old state is not silently deleted by npm upgrade. Inspect `bash-runtime status`; preview managed removal with `bash-runtime remove --dry-run`, then use `remove --yes` only when all listed managed copies are unwanted. This removes managed Niubash too, not just legacy Bash. IPC cleanup requires `bash-runtime clean-cache --yes --all-hosts-stopped` after stopping every host/job; that offline command also reclaims quarantined copies beyond the newest two, while an online sweep keeps them. `cache status` reports them. A successful install never deletes a staging sibling it could not verify. |
| User-selected shell / shared stores | Explicit `bashPath`, system installations, npm/pnpm stores and npm `_npx` cache | Not OPS-owned: never automatically removed by OPS. `npx` may cache a separate full package; do not use it for every runtime invocation. Package-manager retention/pruning is separate from uninstalling the plugin. |

Direct npm installs live under the selected project's `node_modules/dsh-ops`; global installs use `npm root -g`. DSH installs normally resolve under `<DSH_HOME>/profiles/<profile>/node_modules/dsh-ops`; follow the actual resolved package location, not a guessed store path. Each profile may intentionally own a separate package. `bash-runtime status` reports the selected executor and managed directories.

There is **no automatic npm update/uninstall cleanup hook**: it cannot safely determine active jobs, shared stores or user-owned shells. Install-time hooks remain prohibited by the manifest gate. Existing fixed-directory replacement and per-call cleanup prevent normal owned-copy accumulation; receipt-scoped, explicit cleanup handles legacy state. Future cross-version sweeping needs ownership and live-process evidence, not directory-name guessing. Never run the broad legacy `uninstall --yes` merely to reclaim one shell: it can remove other explicitly provisioned OPS state.

## Stop the affected profile before replacing packages

On Windows, an active Bash, old bundled PowerShell or legacy FastCtx process can
hold files in the profile's dependency tree. An `ERR_PNPM_EPERM` / `importPackage`
failure is a file-lock problem, including when another plugin triggered the
dependency rebuild (#175). A failed package-manager operation can leave the
manifest, enabled bundle list and installed files inconsistent.

1. Save work and stop affected jobs through the host's job controls. Let their
   processes finish. Do not run the upgrade from an OPS shell in that profile.
2. Fully exit the affected DSH application, including its tray process. Use an
   external terminal and the same `DSH_HOME` and profile as the application.
3. Back up the profile's `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
   and `cordis.patch.yml` when present. Run the official CLI belonging to that
   application; Desktop needs its bundled CLI, not an unrelated global `dsh`.
4. Complete the operation successfully before reopening DSH. Check the installed
   version and enabled rows in the intended profile after restart.

For a standard Windows Desktop installation, the following selects its CLI.
Change the path for a custom installation. Choose one operation:

```powershell
$desktopCli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
# Update to the version you have reviewed:
& $desktopCli plugin --profile desktop add 'dsh-ops@<version>' --registry=https://registry.npmjs.org
# Or remove the plugin:
& $desktopCli plugin --profile desktop remove dsh-ops --registry=https://registry.npmjs.org
```

Replace `<version>` with the chosen version. `web` and `dsh-tui` use their own
application CLI/profile. Keep any custom `DSH_HOME` from the original setup.
If a failed operation left an inconsistent tree, keep the logs and use that
same official CLI's `plugin --profile desktop install` to reconcile the saved
manifest while the host is stopped; pass the verified registry there as well.
This is recovery of the intended saved dependencies, not a promise that the host
rolled back every file. Do not delete the lockfile or sweep/force-kill processes
by executable name. Older FastCtx hosts may need to finish their normal idle
shutdown before their files are released.

## Removal can fail a registry policy check

`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` with `version not present in registry
manifest` is different from a locked file (#335). pnpm can validate existing
lockfile entries even during removal. A mirror missing a pinned Bash version
cannot provide the metadata needed by that check, even if the payload is already
installed. Restarting the host does not repair the mirror.

Use the same trusted registry with complete version metadata for installation,
repair and removal. The examples above pass the registry to the official CLI's
forwarded package-manager command explicitly; the OPS uninstall wrapper does
not expose a registry argument. Do not rely on a plugin manager remembering a
previous installation's source after restart. Read the operation's pnpm log to
identify the rejected entry and active source; `npm config get registry` alone
does not establish the registry used by the host's pnpm.

For a legacy 0.4.x profile that still pins the old optional Git Bash package, check
that exact version rather than `latest` before retrying (this candidate no longer
requests the package by default):

```powershell
npm view @dsh-ops/bash-win32-x64@0.2.1 version dist.integrity --registry=https://registry.npmjs.org
```

A missing version, network error or actual policy rejection still requires
resolution. Keep `minimumReleaseAge`, integrity and other supply-chain checks
enabled; do not add a blanket exclusion or remove lockfile entries to force the
operation through. If removal only disabled the bundle, it has not necessarily
removed the dependency or payload. Verify the final profile manifest, bundle
selection and installed package state through the official manager. Transaction
rollback and registry persistence belong to DSH's package manager.

## An unmapped Windows error while pnpm fetches or unpacks

`ERR_PNPM_UNKNOWN` with `UNKNOWN: unknown error, open '<path>'` identifies an
installation failure, but that text alone does not identify the root cause.
Read the package URL and exact path in the operation log. In #524 the failing
archive is `yujunzhixue/dsh-purge`, and the failing member is in that package's
`skills/redteam/` directory. That excerpt does not show dsh-ops code running or
establish that changing dsh-ops would repair the installation.

1. Preserve the host operation log and record the versions, requested package,
   archive URL, failing member, and store location. Redact credentials and user paths.
2. Inspect protection/quarantine history and filesystem diagnostics for that
   exact path. An absent record is not proof either way; do not disable protection
   or add broad profile/store exclusions to force installation.
3. If a comparison is needed, use a disposable empty directory and an alternate
   store, for example `pnpm --store-dir D:/pnpm-store add <the same spec> --ignore-scripts`.
   This changes only the diagnostic fixture. Success narrows the investigation but
   does not prove which filesystem, cache, permission or security condition differed.
4. Send the sanitized evidence to the owner of the failing package or installer.
   A new failure naming dsh-ops itself should be reported separately with its log.

Keep `minimumReleaseAge`, integrity checks and registry policy enabled. Do not
remove user lockfiles or change an installed profile as a diagnostic shortcut.

## Duplicate YAML mapping keys during installation

`duplicated mapping key (12:3)` means a YAML parser encountered the same key twice
in one mapping. The excerpt in #479 does not name the input file, so it cannot
identify the plugin bundle, host profile, pnpm configuration or lockfile as the cause.
Keep the operation log and obtain the parser's filename plus a sanitized surrounding
mapping. Back up the identified file before correcting that mapping; do not delete
the entire profile or lockfile. OPS's manifest gate parses its shipped bundle, but
a passing bundle check does not validate a user's other YAML inputs.

## Installing from Git is not a supported channel

Direct installation of `git+https://github.com/T-Auto/dsh-ops.git` or an unbuilt
source checkout is unsupported. `.gitignore` excludes `lib/` and
`runtime/`; `prepack` compiles `lib/` but never stages the native worker, and
staging it (`npm run build:ptc`) needs cargo and the full toolchain. Adding a
`prepare` hook would compile `lib/` for every git install and still leave
`runtime/` empty, so the file tools would publish nothing after an install that
looks successful. This package therefore declares no install-time lifecycle hook:
nothing matching `(pre|post)?(prepare|install)` — `prepare`, `preprepare`,
`postprepare`, `install`, `preinstall` and `postinstall` — and
`scripts/validate-manifest.mjs` fails on any of them, including a hook unrelated to
the build, because the gate cannot tell an innocent hook from one that tries to
repair the unsupported channel. Install the published registry target
(`add dsh-ops`), or build and `npm pack` a checkout yourself; see
[contributing](CONTRIBUTING.md#building-the-plugin-and-installing-from-source).

## Moving from 0.4.x to 0.5.x

| Change | Action after upgrade |
| --- | --- |
| The bundle declares one `dsh-ops` row. Legacy `mode-*`, `discovery`, `compat`, `panel`, `tui`, `shell`, `file`, `ptc` and `hide-official` rows are not inserted. | Back up and move saved values into the single row, then remove obsolete overrides. OPS does not rewrite the profile automatically. |
| Built-in and explicit consumers use one assembler. | Use `presets.<exact-id>` for custom profiles; unlisted presets remain untouched. An explicit disabled binding suppresses the built-in fallback. |
| File replacement, Bash and host-shell hiding have independent switches; Compatibility is removed. | Set `hideOfficialTools`/`replaceOfficial` false for files and `hidePwsh` false for the host shell. Global switches preserve saved intent. |
| Residency and dynamic loading are independent; Native discovery does not control the PTC loader. | Configure `residentTools`, per-preset dynamic switches and the global gate. PTC requires typed host presentation, not just a preset name. |
| Panel and TUI remain opt-in. | Enable `panel.enabled` or `tui.enabled` on the single row only when needed. |

## Moving from 0.3.x to 0.4.x

| Change | Action after upgrade |
| --- | --- |
| FastCtx/background tools and the bundled PowerShell dependency were removed. The pinned Windows Bash dependency remains. | Use host jobs for long-running Bash commands and the host's PowerShell tool for PowerShell. Remove an obsolete `dsh-ops/background` row to silence its no-op warning. Legacy provisioned state is separate; see [troubleshooting](troubleshooting.md#legacy-provisioned-files-were-not-cleaned-up). |
| The host-facing `ops_bash` requires `description`. | Include a short task description with `command` or `script_path`, for example `{"description":"Check checkout status","command":"git status --short","workdir":"D:\\project"}`. `script_path` executes Bash; use host `pwsh` for `.ps1` scripts. |
| Advanced Native tools are discovered on demand. | If `ops_edit_file` or another advanced tool is absent, call `ops_discover_tools` with `{"query":"select:ops_edit_file"}`, finish the tool round, then use it on the next model step. Configure the owning row's `alwaysLoaded` for capabilities you need at startup. See [discovery](discovery.md). |
| PTC has a separate typed SDK and loader. | In `run_code`, call `tools.ops_load_sdk({ tools: ['glob'] })`, inspect the Outcome and finish the round. Use `tools.ops_glob` in the next step after successful loading. Loading and using a missing method in the same frozen SDK snapshot will not work. See [PTC loading](ptc-sdk-loading.md). |
| Settings are layered profile patches. | Inspect the intended profile's `cordis.patch.yml`, home patches and installed bundle declarations. An empty root `cordis.yml` can be valid host composition; OPS does not rewrite that root to empty. Back up and diagnose the host's composed configuration before replacing anything. |
| Package code is loaded into the host process. | Fully restart after replacing a package or after third-party hot reload leaves tools missing. A single-row remount is not a reliable package-code upgrade. Check enabled rows and actual loaded version in a fresh session before reinstalling. |

Discovery publishes a selection; it does not guarantee that the model will
choose it automatically. Native discovery and PTC SDK loading are separate
surfaces. A missing loader, host tool-update protocol error or explicit permission
failure needs its own diagnosis; the table does not bypass those conditions.

## Report a native crash with evidence

The NUL-stdin condition has a separate empty-pipe mitigation in [PR #392](https://github.com/T-Auto/dsh-ops/pull/392).
That regression verifies pipe input and immediate EOF; it does not establish the
cause of every Desktop crash. The update-window access violation in #372 lacks a
dump. File-operation `.dsh-ops-update-*.lock` files are unrelated to replacing an
npm package directory.

Record host/plugin versions, launch method, exact operation, executable path,
exit code and stderr. For a repeatable Windows crash, an administrator can enable
[WER per-application LocalDumps](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps)
under `HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\<executable>.exe`:
set `DumpType` (DWORD) to `2` and `DumpCount` to `2`. Select the actual crashing
executable, such as `DeepSeek Harness.exe` or `bash.exe`. The default dump folder
is `%LOCALAPPDATA%\CrashDumps`; custom crash handlers may prevent WER collection.
Remove only the diagnostic settings you added after capture. Dumps may contain
session data and credentials; share them privately after review, not in a public
issue attachment. A missing dump is not proof of a particular native fault.
