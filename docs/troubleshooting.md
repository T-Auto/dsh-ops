# Troubleshooting

Start here when installation fails, an error is unclear, or behaviour is unexpected.

---

## Installation and payloads

### `bash-win32-x64` or `pwsh-win32-x64` is missing under `node_modules/@dsh-ops/`

**This is not a broken installation.** The two shell payloads are installed on demand by this package's `postinstall` (`postinstall.mjs`), which runs when the package is installed: a shell the machine already has is not downloaded a second time, and when the registry has not synced the platform package — or the script was skipped — it prints one line and the install still exits 0. `fastctx-win32-x64` remains an exact-versioned **optional dependency** (`optionalDependencies`), which the package manager **skips silently** when the registry has not synced it — the install still exits 0 and prints no warning that names the missing payload.

Measured on 2026-10-12: on `registry.npmmirror.com`, `@dsh-ops/bash-win32-x64` reports `dist-tags.latest = 0.0.0-stage` with `versions` holding only `0.0.0-stage`; the official `registry.npmjs.org` reports `0.2.1`. `npm view @dsh-ops/bash-win32-x64 version` through the mirror therefore prints a misleading old version — do not use it to decide whether the payload is available. Because the published manifest does not declare the payload, the request `postinstall` makes names the package without a version, so a mirror like that one hands over whatever its `latest` points at rather than failing; the pinned executor then refuses that payload against its own receipt in the package (`EXECUTOR_UNAVAILABLE`, with the remedy below) instead of running it. This section expires by itself once the mirror catches up. Below is how to verify and how to work around it.

**Preferred remedy when `postinstall` could not fetch it**: `provision-shells` bypasses the registry, fetches the pinned asset from the upstream GitHub Release, checks its sha256, unpacks it and writes a `.provisioned.json` receipt.

```console
npx --yes dsh-ops@latest provision-shells --bash
```

Behind a proxy (`HTTPS_PROXY` is handed to curl explicitly as `--proxy` and is inherited through the environment as well):

```console
:: cmd
set HTTPS_PROXY=http://127.0.0.1:<clash-port>
npx --yes dsh-ops@latest provision-shells --bash
```

```console
# PowerShell
$env:HTTPS_PROXY = 'http://127.0.0.1:<clash-port>'
npx --yes dsh-ops@latest provision-shells --bash
```

**To check the result, run the profile's own copy**: `ladder` reports the bundled rung of **the copy that runs it**, so `npx … ladder` inspects the npx cache copy and its answer has nothing to do with your profile.

```console
node "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-ops\bin\dsh-ops.mjs" ladder
```

The provisioned copy lives in `<DSH_HOME>/dsh-ops/shells` (shared across profiles, so one provision covers every profile on the machine) and outranks the bundled copy when the shells are resolved; `ladder` reports `source: provisioned`.

**Do not** work around a missing payload with `allowSystemShellFallback: true`: that lowers the security posture (it uses a system bash with no pinned digest), and the one-time startup configuration migration sets it back to `false`.

### `ops_bash` errors when the bundled bash payload is gone

When the bash payload was installed but its package directory has since been removed by the host package manager, `ops_bash` returns a readable `ENOENT` diagnostic instead of exposing a raw `spawn` exception to the model. Restore it with the profile's frozen install or official plugin manager, or fetch the pinned copy without a registry with `npx --yes dsh-ops@latest provision-shells --bash` (the profile's own install runs `postinstall` again when the package is written again, not on every install); it does not silently switch to an unauthorized system bash.

---

## Command execution

### A whole turn is discarded as `MALFORMED_RESPONSE`

Long scripts, heredocs and multi-layer quotes and backslashes make the model escape JSON repeatedly. Write the script with the host file tools first and pass it through `script_path` instead of putting it in `command`. See the [usage guide](usage.md).

### Passing `run_in_background` to `ops_bash` is rejected

**`ops_bash` has no `run_in_background` and returns no job id**; every command runs in the foreground. The host `bash` and `pwsh` tools accept the parameter, which is why a model tries it here. For a long-running process, use the host `pwsh` tool's `run_in_background`, or detach inside the command (for example `nohup ... & disown`). Otherwise the call occupies the whole `timeoutMs` (up to about 24.9 days).

### An argument is rejected as unknown

A key the `ops_bash` schema does not declare is refused before execution, and the error names both the unknown keys and the accepted ones. This is deliberate — nothing is silently ignored.

### `ops_bash` cannot run a custom bashPath or Git for Windows in restricted modes

Symptom, in a read-only or workspace-write session: `EXECUTOR_UNAVAILABLE: ops_bash cannot run the configured bashPath … in restricted modes` (0.3.0 printed `This MSYS version has no verified DSH IPC compatibility build. Rebuild the matching proxies`).

**This is by design.** Under the DSH Windows restricted token, MSYS cannot create its own signal pipe (`couldn't create signal pipe, Win32 error 5` / `0xC0000142`). dsh-ops makes Bash work there with IPC compatibility proxies verified against one pinned `msys-2.0.dll`. Any other MSYS build — your own Git for Windows, a custom `bashPath`, a system bash from `allowSystemShellFallback` — is refused rather than run unconfined. Rebuilding the proxies is not an end-user remedy: `npm run build:bash-ipc` only re-pins the bundled payload.

What to do:

- Remove `bashPath` (and `allowSystemShellFallback`) from the `dsh-ops/shell` row so the bundled pinned bash is used; if that payload is missing, run `npx --yes dsh-ops@latest provision-shells --bash`.
- Or switch the session to `danger-full-access`, where `bashPath` runs directly.
- Check with the profile's own copy: `node "<profile>\node_modules\dsh-ops\bin\dsh-ops.mjs" ladder --config <file>` reports `restricted: yes/no` for the resolved bash.

### `ops_bash` rejects `sandbox_permissions` / `justification`

The host `bash` tool accepts per-call escalation; `ops_bash` does not, and says so in the error. Ask the user to change the session permission mode instead of retrying the call.
### Empty placeholder arguments on file tools

Strict tool-call adapters that fill every schema field send `""`, `null` or `[]` for unused optional fields of `ops_inspect_local_file`, `ops_grep`, `ops_glob` and `ops_replace`. The plugin drops those placeholders for optional fields before the native worker runs, so they no longer trip `path`/`encoding`/`view` validation. Required fields, `replacement: ""`, `false` and `0` are forwarded unchanged, so genuinely invalid values still error.

---

## Permissions and sandboxing

### Host `edit` says "has not been read" or "changed since it was read" after ops file tools

Fixed since this change: `ops_inspect_local_file` and `ops_replace` report to the host's read-before-edit table like host `read`/`edit`, so host `edit` works right after them. On older versions (FastCtx-backed 0.2.x), ops reads did not count — read the file with the host `read` tool before using host `edit`. (#17)

### Do the file tools need command permission?

No. Fixed file operations follow a trusted-operation policy fence matching DSH fs-sandbox and **never execute model code**. Read-only rejects replacement, workspace-write permits writes under the workspace and DSH temporary areas, and full access adds no write fence.

### Why are the background tools still unavailable after enabling them?

Once the `dsh-ops/background` component is enabled, session `danger-full-access` is still required to publish the four background tools.

### `DSH workspace preparation failed`

Before the first restricted `run_code` / `pwsh` / `bash` / `ops_bash` call in a workspace-write session, dsh-ops gives the workspace root a directory-only `WRITE_OWNER` ACE, which the host sandbox needs. The original DACL is backed up to `<DSH_HOME>/dsh-ops/acl-backups/` first. Later calls take a fast `ready` path.

This step runs the package's own `bin/prepare-workspace.ps1` with Windows PowerShell 5.1 **as the current user, before sandbox confinement applies**, only on Windows in workspace-write mode, and changes only the workspace root's own DACL. Read-only and danger-full-access sessions skip it.

The message names the cause:

- `PowerShell execution policy blocked dsh-ops's own preparation script …`: dsh-ops passes `-ExecutionPolicy Bypass` (earlier versions did not, so the Windows client default `Restricted` blocked every shell tool, #66). A refusal now means Group Policy (MachinePolicy/UserPolicy) enforces the policy; `Set-ExecutionPolicy -Scope CurrentUser` cannot override it. Check `powershell.exe -NoProfile -Command Get-ExecutionPolicy -List`, ask an administrator, or use danger-full-access for the session.
- `the workspace root … does not meet the sandbox prerequisite …`: the folder itself is the problem — it is not owned by the current user, its path goes through a junction or symlink, or `WRITE_OWNER` is explicitly denied or cannot be granted. Fix the folder's owner or permissions, or open a workspace you own. This is not a DSH authorization denial.

- The root DACL is written through its own handle, without Windows' inheritance walk, so the cost no longer grows with the number of files (measured: 18.7 s → 4.3 s for 50,000 files; about 3.9 s for 10 files, mostly PowerShell startup). Earlier versions walked the whole tree and hit a 10 s limit on large workspaces, with nothing after the colon. (#43)
- `the preparation executor timed out after 120000 ms …`: a 120 s safety net was hit. The ACL state is unknown, so compare the root DACL with the newest receipt in `acl-backups` before retrying. `the preparation executor could not start …` means `powershell.exe` itself could not be launched.
- `exited with code N …: <text>`: any other failure, with the script's own output.

### Host shells are being refused

`shellPolicy: deny-host-shell` refuses the host shells in `deniedHostTools` (default `[pwsh, bash, pwsh_persistent]`). The policy is independent of `allowSystemShellFallback`. It also disables third-layer pwsh; enable cautiously.

---

## Installation location and profiles

### What is the `tui` profile?

`tui` maps to the **dsh-TUI product's `dsh-tui` profile**, not the old `tui` directory.

### Why must the desktop app use its own CLI?

The ordinary DSH CLI cannot manage the reserved `desktop` profile; do not confuse it with the desktop app's bundled entry point. Desktop auto-detects `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`; for another location, specify it with `--dsh-cli`.

### `~/.fastctx/` survives uninstallation

Persistent state is kept by default; add `--purge-fastctx` explicitly if you want it removed.

### Legacy provisioned files were not cleaned up

Legacy explicitly provisioned `<DSH_HOME>/dsh-ops/` files must be cleaned separately with `npx --yes dsh-ops@latest uninstall --yes`.

---

## Processes

### Is the `runtime-host` process a leak?

No. It is a reusable upstream shared process; a dead parent alone is not a leak. With no clients and about ten minutes of inactivity, it exits normally. Do not kill it by process-name sweeps. This release does not automatically sweep processes left by older versions.

---

## See also

- [Usage](usage.md) — the complete install flow and CLI
- [Configuration reference](configuration-reference.md) — keys and owning components
- [Component reference](component-reference.md) — tools and permissions
