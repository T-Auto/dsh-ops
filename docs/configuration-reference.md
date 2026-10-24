# Configuration reference

Every configuration key, and **which component row owns it**.

## Built-in row configuration

Active rows expose validated settings through the host Settings/ConfigEditor. Accepted changes persist through the profile writer and reload the owning row; stale or invalid changes preserve saved values. Disabled rows must first be re-enabled with the host row switch, and pending services must become available before editing.

The default bundle retains `dsh-ops/file` and stable ID `dsh-ops-file`, so saved name-qualified overrides continue to match. It does not activate custom browser pages on the pinned host.

## Optional browser settings pages

When a bare-package client carrier is configured, the replacement, discovery and shell rows have settings pages in the host plugin manager. The default seven-row bundle keeps its legacy file module name and does not activate these pages. Changes
remain a draft until **Save changes** succeeds. A stale or refused save keeps the draft for review;
**Reset to saved** loads the latest saved values. Accepted changes persist through the host profile
writer and reload the affected row.

- **Replacements:** choose `read`, `glob` and `grep` independently. Selected tools use OPS contracts.
  Keep each selected counterpart (`inspect_local_file` for `read`, `glob` or `grep`) always loaded in Discovery, or activate it before selecting the replacement. `read_files` does not satisfy the single-file `read` replacement contract.
- **Discovery:** choose the allowed pool, its always-loaded subset and a result limit from 1 to 5.
  Removing an allowed capability removes it from the always-loaded subset in the same save.
- **Shell:** enable Bash, enter an absolute executor override, or select detected managed/Git Bash.
  Selecting a runtime fills the draft path; save it explicitly. Clearing the override inherits the
  configured default. Runtime installation does not silently change that selection.

Bash installation/removal and PowerShell upgrade buttons first show a plan. Execute that reviewed
plan explicitly; cancellation after launch can leave changes and reports an unknown effect. Managed
Bash removal only deletes receipt-owned installations. Stop Bash jobs first. PowerShell actions use
WinGet for the standard host PowerShell 7 installation, preserve Windows PowerShell 5.1, and require
a DSH restart. Check a custom host `pwshPath` separately. No installer runs when opening a page.

A client carrier uses the stable `dsh-ops-file` row with the bare package name `dsh-ops` to load these browser pages. Its
server behavior remains the file component; the `dsh-ops/file` export remains compatible. Disabling
this carrier unloads all custom settings pages. Use the host's **built-in row switch** to re-enable
it. There is no automatic form fallback. A disabled target row must also be re-enabled before its
settings can be edited. The discovery page is available once its component row is installed.

### Enable the optional browser carrier

This is an opt-in offline profile migration, not a prerequisite for upgrading. With DSH stopped,
preview the installed profile using absolute paths:

```console
dsh-ops settings-profile --profile-dir <profile-directory> --host-anchor <DSH-installation-package.json> --dsh-home <DSH-home>
```

`--host-anchor` identifies the host installation whose public profile APIs the command uses.
After reviewing the preview, repeat it with `--offline --yes`. The command selects
`dsh-ops/lib/profiles/client` **instead of** `dsh-ops`, removes only verified legacy file-name
matchers in that profile's patch, and preserves all seven IDs, switches, and effective configuration.
It refuses skipped bundles, duplicate OPS rows, external name-qualified file overrides,
incompatible higher-priority patches, or stale previews. Home patches are included; launch-time command-line overlays are outside this preview.
No other profile is changed. Do not enable both bundle choices together.

Original files are backed up in the reported `.dsh-ops-settings-backup-*` directory. Each write uses
the host's atomic writer and profile lock. The first write remains valid with the old bundle if the
process stops before the second; reported write failures restore unchanged originals when possible.
For manual recovery while stopped, restore `package.json` first, then `cordis.patch.yml` as described
in `recovery.json`. Keep the backup until the restarted profile is verified. The installed `dsh-ops`
package supplies both bundle choices; the nested layer is not a separate package to install.
An already-disabled file row remains disabled, so re-enable it through the builtin switch before
expecting custom pages. The default legacy bundle remains supported without this command.

---

## Where configuration lives

In DSH's configuration editor, find the corresponding `dsh-ops/shell`, `dsh-ops/file` (`dsh-ops-file`), `dsh-ops/ptc` or `dsh-ops/panel` row, adjust `config`, then save; unknown configuration keys cause errors naming the key.
The bundle declares seven independently toggled components. Fresh defaults follow the table. Saved profile switches and raw configuration override bundle defaults; adding discovery does not rewrite them. Profiles without explicit switch overrides inherit updated defaults.
| Row `name` | Component | Default |
| --- | --- | --- |
| `dsh-ops/shell` | Terminal and shell | On (all platforms) |
| `dsh-ops/file` (`dsh-ops-file`) | Rust file tools | On |
| `dsh-ops/ptc` | Native PTC batches | On |
| `dsh-ops/discovery` | Advanced Native tool discovery | On |
| `dsh-ops/panel` | Capture subsequent events | Row off; enabling starts capture |
| `dsh-ops/tui` | Read-only sidebar, separate config | Off |
| `dsh-ops/hide-official` | Per-tool official replacements, separate config | Off |

A `dsh-ops/background` row left over from an earlier version loads as a no-op stub (the FastCtx background component was removed); it ignores its config and can be deleted.

---

## 🔴 Which key belongs to which component

`dsh-ops/tui` uses only `maxSessions`, `maxActive` and `recentLimit`; see [sidebar limits](tui-panel.md#limits). The table lists where each setting is used. File/root and shell retain their shared legacy validator, so some compatibility keys may be accepted without affecting that row. PTC, discovery, panel, TUI and replacement use their own strict key sets; do not copy general file/shell settings into them. The Loader row switch is disabled, outside config.

| Key | Type | Default | Owning component |
| --- | --- | --- | --- |
| `configUpdateVersion` | non-negative integer | `0` | file / shell (migration marker) |
| `binaryPath` | absolute path | — | file / ptc / discovery |
| `bashPath` | string path | — | shell |
| `publishBashTool` | boolean | `true` | shell |
| `promptPolicy` | boolean | `true` | file / shell |
| `extraGuidance` | string | empty | file / shell |
| `required` | boolean | `false` | file / ptc / discovery |
| `shellPolicy` | `advise` \| `deny-host-shell` | `advise` | shell |
| `deniedHostTools` | string array | `[pwsh, bash, pwsh_persistent]` | shell |
| `allowSystemShellFallback` | boolean | `false` | shell |
| `denyCredentialReads` | boolean | `true` | file / discovery |
| `capture` | boolean | `true` | panel (row defaults off) |
| `textLimit` | integer | `2000` | panel |
| `maxSessionBytes` | integer | `8388608` | panel |

PTC accepts exactly binaryPath, required, allowedTools and alwaysLoaded; its credential fence stays enabled. Its always-loaded list is independent of the dynamic allowed pool. Discovery additionally owns enabled, maxResults and denyCredentialReads, and requires alwaysLoaded to be a subset of allowedTools. See [PTC settings](ptc-sdk-loading.md) and [discovery settings](discovery.md) for defaults and exact names. Replacement owns replaceTools plus its inert legacy compatibility keys; panel and TUI have only their documented capture/display fields.

### The credential fence (`denyCredentialReads`)

Preflight credential denials retain `rejected`, `CREDENTIAL_DENIED`, no-effect and no-retry guidance. Their Native text and PTC values omit the denied path, resolved parents and matching policy rules.

The key name is historical; the fence itself is on the **path**, not on one direction of access. A
credential location is refused as a read (`inspect_local_file`, and `grep`/`glob` never report or
list one), as a write (`write`, `edit`, `replace`, `remove`), and as the destination of `copy`/`move` —
for a single path, a batch operation root, and every child of a recursion, including under
`danger-full-access`. A refused operation reports `CREDENTIAL_DENIED` with `phase: preflight` and
`effectState: none`, before the native worker is spawned. `denyCredentialReads: false` turns the fence
off for that row only, and `DSH_OPS_DENY_READ` can only widen the list. A `.env` or `~/.ssh/config`
cannot be **created** through these tools either; see [troubleshooting](troubleshooting.md).

**Deprecated keys.** `serverName`, `enableShellTools` and `toolCallTimeoutMs` were read only by the removed FastCtx background component. They are still accepted (and still type-checked) so existing rows keep loading — earlier bundles wrote `enableShellTools: false` and `toolCallTimeoutMs: 300000` into every file row — but they have no effect, and configuration update 2 removes them from saved rows on the next start.

---

## Examples

The `dsh-ops/shell` row:

```yaml
config:
  promptPolicy: true
  publishBashTool: true
  shellPolicy: advise
  allowSystemShellFallback: false
  # bashPath: 'C:\tools\bash.exe'   # restricted Windows execution requires matching MSYS/IPC; see below
```

The `dsh-ops/file` row:

```yaml
config:
  promptPolicy: true
  required: false
  # binaryPath: 'C:\tools\dsh-ops-worker.exe'
  # Managed update metadata; do not remove after the first startup self-check
  # configUpdateVersion: 2
```

The `dsh-ops/panel` row is **disabled by default**. Enabling a fresh row starts capture; explicit legacy `capture: false` remains off until the operator changes it:

```yaml
config:
  capture: true         # The row switch controls capture; legacy false stays inert
  textLimit: 2000       # characters kept per text field, marked when clamped
  maxSessionBytes: 8388608
```

---

## Key by key

- `publishBashTool`: publish `ops_bash` using current session policy; restricted modes require the host sandbox, full access uses the host subprocess service.
- `promptPolicy`: whether to inject the component's runtime guidance; use `extraGuidance` to append instructions.
- `required`: whether to reject activation when the native worker is unavailable.
- Host PowerShell is outside OPS runtime selection: no bundled executable or `pwshPath` override. `upgrade-host-pwsh` previews a standard Windows installation; `--yes` runs it. Restart DSH and review any custom host `pwshPath` afterwards.
- `shellPolicy`: defaults to `advise`; `deny-host-shell` rejects host shells in `deniedHostTools` (default `[pwsh, bash, pwsh_persistent]`). This also disables third-layer pwsh; enable cautiously.
- `allowSystemShellFallback`: defaults to `false`. Without a bundled/provisioned bash, do not discover system PATH or well-known installations (**on a POSIX host this key has no effect**: the shell component already resolves the host bash and there is no pinned payload to fall back from). Explicit `true` opts into an unpinned system bash that the operator must trust and maintain. Explicit `bashPath` is a separate operator selection, not an automatic fallback. See the update configuration modification area in the [usage guide](usage.md) for the first-start migration.
- `shellPolicy` is independent: `deny-host-shell` masks/refuses host tools; disabling fallback constrains the plugin's bash resolver, not the host's own `pwsh`, and is not a filesystem sandbox.
- `binaryPath` (the native worker executable) / `bashPath`: optional explicit absolute paths; unavailable paths cause an error rather than silently switching executors. On Windows the pinned Bash payload is an optional npm dependency of the main package and arrives with the install, so normally no configuration is needed; use `dsh-ops bash-runtime install` if it is missing or incomplete, or `dsh-ops bash-runtime git` / `managed` to print a Bash selection.
- **On a POSIX host `ops_bash` already runs the distribution's own bash**: `bashPath` → `PATH` → `/bin/bash`, `/usr/bin/bash`, `/usr/local/bin/bash`, with no second shell shipped, so there is no payload to "fall back" from and `allowSystemShellFallback` does not affect it. In a confined mode (`workspace-write` / `read-only`) `bashPath` still takes effect, with the constraint enforced by a host sandbox (bwrap / Landlock); when no sandbox can confine the call it is **refused** rather than run unrestricted.
- `bashPath` **(Windows) must match the pinned MSYS for restricted execution.** In read-only and workspace-write, `ops_bash` runs only the pinned MSYS whose IPC compatibility proxies were verified (`dsh-ops bash-runtime install`, or a compatible existing copy); any other `msys-2.0.dll`, including your own Git for Windows, returns `EXECUTOR_UNAVAILABLE` by design and is never run unconfined. Do not point `bashPath` at your own Git Bash to work around a restricted-mode problem. Check a selection with `dsh-ops ladder --config <file>`, which reports `restricted: yes/no` for the resolved bash. See [Troubleshooting](troubleshooting.md#ops_bash-cannot-run-a-custom-bashpath-or-git-for-windows-in-restricted-modes).
- `deniedHostTools`: the host tool names refused by the `deny-host-shell` policy.
- `configUpdateVersion`: completion marker for the configuration migrations (currently `2`: update 1 retires the old implicit system-bash opt-in, update 2 removes the deprecated FastCtx keys). Do not remove it, or the self-check runs again.
Disabling the row or saving `capture: false` stops event collection immediately, cancels queued filesystem work, and waits for already-started I/O before the host finishes the change. It does not start a final fold: existing NDJSON remains recoverable, and a temporary file from an interrupted fold may remain. Re-enabling captures only subsequent events; disabled events are not replayed.

- The panel row defaults disabled and registers no listener or file. Once enabled, `capture` defaults to `true`; an explicit legacy `false` still registers nothing and is never silently changed. The host cannot atomically clear that old field while disabling its row, so the compatibility setting remains visible for deliberate edits. Captured events write into the session working directory:
  - `<cwd>/.dsh-ops/panel/<sessionId>.json` — the only data source: conversation text, the tool-call/result/milestone trace, usage buckets, and trimmings/limits;
  - `<cwd>/.dsh-ops/panel/panel.html` — a static viewer that reads that JSON in the browser and inlines no data (drag the JSON onto it, or run `dsh-ops panel [dir]` to serve the directory on loopback; a plain static server can pass `?data=<sessionId>.json`).

  While a session is live the sink appends NDJSON (`<sessionId>.ndjson`, crash safe) and folds it into the JSON at each turn end and when the session is sealed; sealing removes the append log. The capture row opens no port, registers no UI and writes no `~/.dsh`; only the explicit `dsh-ops panel` operator command starts a loopback-only server, reads the named directory and writes nothing. There is no build step — `panel.html` ships in the package. Sessions whose working directory is inside the DSH home, or whose id cannot be a file name, are refused with one log line. Capture writes into the conversation's working directory, so add `.dsh-ops/` to that project's `.gitignore`: reports can contain prompts, conversation text and tool output.
- `textLimit`: characters kept per message text, tool argument and reasoning field; a clamp sets `truncated`/`droppedChars` on that row instead of silently shortening it. `64`–`100000`.
- `maxSessionBytes`: the per-session budget for the append log, and therefore the ceiling the merged JSON is trimmed to fit. Records over it are dropped and counted in `limits.droppedEvents`; when the JSON would overrun, the oldest conversation/trace rows are dropped and counted in `limits.trimmedRows`, while the usage totals stay complete. `65536`–`268435456`.

---

## Per-tool official replacements (`dsh-ops/hide-official`)

The row is **disabled by default** and `replaceTools` defaults to `[]`. Enabling an untouched row hides nothing. Choose any subset of the reviewed official names `read`, `glob`, and `grep`; unselected tools stay visible without warnings. These are deliberate alternative workflows: read the [mapping and coverage differences](component-reference.md#dsh-opshide-official--per-tool-replacements) before selecting them.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `replaceTools` | string[] | `[]` | Official tools to replace. Only `read`, `glob`, `grep` are accepted; duplicates are removed. Unknown keys and unsupported names produce errors naming the key/value. |

For example, replace only host read and grep while retaining host glob:

```yaml
- name: dsh-ops/hide-official
  config:
    replaceTools: [read, grep]
```

Set `replaceTools: []` or disable the row to restore every official tool. A selected OPS counterpart must be an exact OPS-owned Native definition registered and visible in each agent scope; a same-name foreign tool or a PTC-only data API does not qualify. If any is missing, that scope restores its masks and refuses prompt assembly and execution with `READINESS_BLOCKED`; healthy scopes remain usable. Restore the counterpart, remove that selection, or disable the row. Unrelated OPS tools are not required.

With the slim Native defaults, configure discovery `alwaysLoaded: [inspect_local_file, grep]` before selecting the example above, or activate those Native capabilities first. `read` still maps to `inspect_local_file`; resident `read_files` does not satisfy that selection. Removing or shadowing an owned counterpart rechecks readiness immediately, even if its schema is byte-identical.

**Migration from 0.3:** `strict`, `scope`, and `additionalOfficialTools` are accepted only for compatibility and validated with their old types/values. They grant no hiding authority, including `scope: extended` and aliases. An existing row containing only those keys becomes inert. Explicit `replaceTools` is the sole source of selections even if legacy keys remain. No saved profile is rewritten by this component.

Cordis validates configuration through `StandardSchemaV1`; detached public settings descriptors expose editable arrays in the built-in Settings/ConfigEditor. Accepted changes persist and reload the row. The optional browser multi-select uses the client carrier described above; the default legacy row does not activate it.


---

## Prompt registration

Prompts are registered as scoped runtime sections, not written to AGENTS.md. Disabling shell withdraws its routing; disabling file withdraws its Native file guidance. Fresh Native file publishes only ops_read_files, discovery publishes ops_discover_tools, and shell scopes on every platform add ops_bash (the pinned Windows payload or the distribution Bash). Advanced Native tools are discovered or explicitly always loaded. PTC owns its separate typed SDK and current permission checks. The approved BM-03 budget measures file/discovery schemas at ≤400 tokens. Bash startup residency is unchanged; its schema and the complete startup total are reported separately, and missing Bash cannot satisfy the Windows readiness check.

---

## See also

- [Usage](usage.md) — install, update, remove, CLI
- [Component reference](component-reference.md) — components and tools
- [Troubleshooting](troubleshooting.md) — errors and diagnosis

## Host settings forms

All seven enabled rows expose their supported validated fields to the host settings service. Saving uses the profile revision the form read; a stale revision or invalid
selection is rejected before writing. The host persists accepted changes and reloads the affected
row, so the running configuration follows the saved selection. Ordinary row fields are preserved.
A disabled row has no editable form; re-enable it with the host's built-in row switch first.

The shell descriptor includes routing policy, prompt guidance and system-shell fallback alongside Bash selection. Its internal revision marker, file-only and retired FastCtx compatibility keys are deliberately excluded. Discovery exposes all seven accepted fields, including `binaryPath`, `required` and `denyCredentialReads`. The release gate checks component entries, targets, published tool declarations, retained host commands and explicit bundle defaults against their runtime definitions.

Runtime actions use the host's authenticated gateway and managed subprocess service. Installation,
removal and upgrade require a preview followed by execution of that current preview; expired,
changed or reused plans are refused. Only one action runs at a time. Closing/unloading the owning
shell component cancels outstanding work and waits for settlement; cancellation after launch may
leave changes and reports an unknown effect. Bash install refuses a store containing unowned
version directories. The PowerShell action targets the standard WinGet installation and requires
a DSH restart; an explicit host `pwshPath` remains authoritative. Installer output stays in host
logs; use the previewed command in a terminal if WinGet needs interactive input.
