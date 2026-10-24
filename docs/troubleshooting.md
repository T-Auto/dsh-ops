# Troubleshooting

Start here when installation fails, an error is unclear, or behaviour is unexpected.

---

## Installation and payloads

### `bash-win32-x64` is missing under `node_modules/@dsh-ops/`

**This is not a broken installation.** The Windows Bash payload is an exact-versioned **optional dependency** (`optionalDependencies`): if your registry has not synced that platform package at the pinned version, the package manager **skips it silently** — the install still exits 0 and prints no warning that names the missing payload.

Measured on 2026-10-12: on `registry.npmmirror.com`, `@dsh-ops/bash-win32-x64` reports `dist-tags.latest = 0.0.0-stage` with `versions` holding only `0.0.0-stage`; the official `registry.npmjs.org` reports `0.2.1`. `npm view @dsh-ops/bash-win32-x64 version` through the mirror therefore prints a misleading old version — do not use it to decide whether the payload is available. This section expires by itself once the mirror catches up; below is how to verify and how to work around it.

**Preferred remedy**: `provision-shells` bypasses the registry, fetches the pinned asset from the upstream GitHub Release, checks its sha256, unpacks it and writes a `.provisioned.json` receipt.

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

When the bundled bash payload remains declared in the profile lockfile but its package directory has been removed by the host package manager, `ops_bash` returns a readable `ENOENT` diagnostic instead of exposing a raw `spawn` exception to the model. Restore the dependency with the profile's frozen install or official plugin manager; it does not silently switch to an unauthorized system bash.

### How do I verify what I downloaded from a Release

Two checksums are involved and they cover different bytes: `SHA256SUMS` lists the released tarballs, while each tarball records the digest of the native worker it contains in `runtime/<target>/provenance.json`. Neither value is defined by the Release body.

The tarball ships its own checker, so no platform-specific hashing tool is needed:

```console
tar -xzf dsh-ops-<version>.tgz
node package/bin/native-runtime.mjs check --root package --platform win32-x64
# win32-x64: <bytes> bytes, sha256 <digest>
```

That digest is the one `package/runtime/<target>/provenance.json` holds. Run `tar` from inside the download directory with the bare file name: Git for Windows ships GNU tar, which reads a `C:\...` argument as a remote host. `SHA256SUMS` covers every tarball of that release — including the Windows Bash payload — so `sha256sum -c SHA256SUMS` only passes when all of them sit side by side; macOS has no `sha256sum` and uses `shasum -a 256 -c SHA256SUMS`.

---

## Command execution

### A whole turn is discarded as `MALFORMED_RESPONSE`

Long scripts, heredocs and multi-layer quotes and backslashes make the model escape JSON repeatedly. Write the script with the host file tools first and pass it through `script_path` instead of putting it in `command`. See the [usage guide](usage.md).

### Background Bash requires host jobs

`run_in_background` is available only while the host jobs service is mounted. It returns a host job ID; use `job_output` / `job_kill`. Without that service, remove the background argument and run a bounded foreground command. The default timeout is 120 seconds, capped at 600 seconds. With jobs, foreground expiry promotes the same job; otherwise it stops the command.

### An argument is rejected as unknown

A key the `ops_bash` schema does not declare is refused before execution, and the error names both the unknown keys and the accepted ones. This is deliberate — nothing is silently ignored.

### `ops_bash` cannot run a custom bashPath or Git for Windows in restricted modes

Symptom, in a read-only or workspace-write session: `EXECUTOR_UNAVAILABLE: ops_bash cannot run the configured bashPath … in restricted modes` (0.3.0 printed `This MSYS version has no verified DSH IPC compatibility build. Rebuild the matching proxies`).

**This is by design.** Under the DSH Windows restricted token, MSYS cannot create its own signal pipe (`couldn't create signal pipe, Win32 error 5` / `0xC0000142`). dsh-ops makes Bash work there with IPC compatibility proxies verified against one pinned `msys-2.0.dll`. Any other MSYS build — your own Git for Windows, a custom `bashPath`, a system bash from `allowSystemShellFallback` — is refused rather than run unconfined. Rebuilding the proxies is not an end-user remedy: `npm run build:bash-ipc` only re-pins the bundled payload.

What to do:

- Remove `bashPath` (and `allowSystemShellFallback`) from the `dsh-ops/shell` row so the bundled pinned bash is used; if that payload is missing, run `npx --yes dsh-ops@latest provision-shells --bash`.
- Or switch the session to `danger-full-access`, where `bashPath` runs directly.
- Check with the profile's own copy: `node "<profile>\node_modules\dsh-ops\bin\dsh-ops.mjs" ladder --config <file>` reports `restricted: yes/no` for the resolved bash.

### Bash approval is rejected or unavailable

`ops_bash` uses host approval for a strictly wider `sandbox_permissions` mode. Supply a non-empty `justification` for that exact command. A rejection or missing approval service prevents execution; do not retry through another shell. Approval does not repair an incompatible restricted Bash runtime.
### Empty placeholder arguments on file tools

Strict tool-call adapters that fill every schema field send `""`, `null` or `[]` for unused optional fields of `ops_inspect_local_file`, `ops_grep`, `ops_glob` and `ops_replace`. The plugin drops those placeholders for optional fields before the native worker runs, so they no longer trip `path`/`encoding`/`view` validation. Required fields, `replacement: ""`, `false` and `0` are forwarded unchanged, so genuinely invalid values still error.

---

## Permissions and sandboxing

### Host `edit` says "has not been read" or "changed since it was read" after ops file tools

Fixed since this change: `ops_inspect_local_file` and `ops_replace` report to the host's read-before-edit table like host `read`/`edit`, so host `edit` works right after them. On older versions (FastCtx-backed 0.2.x), ops reads did not count — read the file with the host `read` tool before using host `edit`. (#17)

### Do the file tools need command permission?

No. Fixed file operations follow a trusted-operation policy fence matching DSH fs-sandbox and **never execute model code**. Read-only rejects replacement, workspace-write permits writes under the workspace and DSH temporary areas, and full access adds no write fence.

### Credential locations are refused in every direction

**This is by design.** The file tools refuse to touch a credential location (`~/.ssh`, `~/.aws`,
`~/.config/gcloud`, `.netrc`, `.npmrc`, `.pypirc`, `id_rsa`/`id_ed25519`-style keys,
`*credentials.{json,yaml,ini}`, `.env` and the DSH credential stores) and answer `CREDENTIAL_DENIED`:
reads are refused, and so are writes, `copy`/`move` destinations, `replace` targets and `remove`.
`glob` and `grep` never list those paths either. Under `danger-full-access` the DSH permission mode
would allow the writes, so this fence is what keeps a credential file from being created, overwritten
or deleted through the file tools.

The configuration key is still named `denyCredentialReads` for compatibility, but its scope includes
writes. Practical consequence: a file named `.env` **cannot be created through the ops tools**. Write
it with the host `write` tool instead (the host is fenced by the DSH permission mode, not by this
fence). `denyCredentialReads: false` on a row disables this fence for that row only;
`DSH_OPS_DENY_READ` can only add locations, never remove one.

### A `.dsh-ops-update-*.lock` file appeared in a directory

**This is a cooperative writer lock, and a normal write does not leave it behind.** Writers serialize
on a hidden sidecar beside the target: `.dsh-ops-update-<sha256 of the file name>.lock`. It is created
on first use and **removed by the writer that holds it when that writer is done** (#319). It never
contains data, and `glob`, `grep` and directory-wide `replace` skip it.

A published write leaves nothing behind, and neither does a request refused *after* the lock (a
concurrent writer winning the race, a publication failure, a `write_roots` fence around a directory-wide
`replace`): the guard removes the sidecar on release, and it unlinks only after checking that the name
still leads to the inode it locked. Requests refused before the lock (stale `expectedRevision`,
`EDIT_CONFLICT`, an existing destination, a credential path) never created one.

The only way to see a leftover is a writer killed between locking and release (`SIGKILL`, power loss),
which cannot run a cleanup path. That is not a stuck lock: the next writer of the same name binds to
it, publishes under it and removes it. Sidecars an older release left permanently are reclaimed by
those same writes; in a directory nothing writes any more they can be deleted by hand
(`Get-ChildItem -Recurse -Force -Filter .dsh-ops-update-*.lock | Remove-Item`), because the current
release never creates them.

### Where did the background tools go?

The `dsh-ops/background` component and its FastCtx-backed tools (`ops_run`, `ops_run_background`, `ops_job_output`, `ops_job_list`, `ops_job_kill`) were removed. A profile row that still names `dsh-ops/background` loads as a no-op and logs `the dsh-ops/background component (FastCtx background jobs) was removed in this version; it publishes no tools`; delete the row to silence it. For a long-running process, use `ops_bash` with `run_in_background` when host jobs are available, then collect it with the host `job_output` tool.

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

It is state left by the removed background component and is kept by default; add `--purge-fastctx` explicitly if you want it removed.

### Legacy provisioned files were not cleaned up

Legacy explicitly provisioned `<DSH_HOME>/dsh-ops/` files must be cleaned separately with `npx --yes dsh-ops@latest uninstall --yes`.

---

## Processes

### Is a leftover `runtime-host` process a leak?

No. It is FastCtx's reusable shared process, started by earlier versions with the background component; this version starts none. With no clients and about ten minutes of inactivity, it exits normally. Do not kill it by process-name sweeps. This release does not automatically sweep processes left by older versions.

## macOS arm64

### There is no bundled bash or PowerShell payload

macOS ships no `@dsh-ops/bash-darwin-arm64` or `@dsh-ops/pwsh-darwin-arm64`
package, and no portable upstream bash exists for macOS. Select the shell the
plugin should use with `bashPath` (for example `/opt/homebrew/bin/bash`) on the
`dsh-ops/shell` row. PowerShell 7 can be provisioned, but the host disables its `pwsh-sandbox` and
`tool-pwsh` rows outside Windows, so no pwsh tool appears on macOS.

### The file tools reject a path under `/tmp`

`/tmp` is a symlink to `/private/tmp` on macOS, and the native file worker
refuses to traverse links. The file tools answer
`POLICY_DENIED: Links, reparse points and special objects are not traversed` for
such a path; pass the canonical path (`/private/tmp/...`) instead. This is the
intended no-follow behaviour, not a defect.

### The file tools disappeared after changing the package

The host imports the plugin's modules once, so a profile patch edit can remount
or unmount a component but cannot replace already-loaded code. After swapping the
package version, restart the application. Configuration changes alone do take
effect without a restart.

---

## See also

- [Usage](usage.md) — the complete install flow and CLI
- [Configuration reference](configuration-reference.md) — keys and owning components
- [Component reference](component-reference.md) — tools and permissions
