# Upgrade and uninstall safely

中文：[升级与卸载](升级与卸载.md).

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

For the currently pinned Windows payload, check the exact version rather than
the `latest` tag before retrying the operation:

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
