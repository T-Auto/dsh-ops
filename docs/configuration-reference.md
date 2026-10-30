# Configuration reference

Third-party preset authors: use the explicit [integration API](integration-api.md), not private mode
files or a frozen preset map. Its independent option defaults and [diagnostics](diagnostics.md) are
separate from the eight built-in component rows documented below.

Every configuration key, and **which component row owns it**.

## Built-in row configuration

Active rows expose validated settings through the host Settings/ConfigEditor. Accepted changes persist through the profile writer and reload the owning row; stale or invalid changes preserve saved values. Disabled rows must first be re-enabled with the host row switch, and pending services must become available before editing.

The default bundle declares the eight rows listed below and no legacy `shell`, `file`, `ptc` or `hide-official` row. A saved profile override for a removed row matches no target, is reported by the host patch composer and must be deleted. The default bundle does not activate custom browser pages on the pinned host.

## Browser settings page

Resident OPS tools and dynamic OPS tool loading are independent. Standard, PTC and Cordis expose `residentTools` (default true) immediately before `dynamicTools`; Minimal has no resident-tools option and publishes no resident file tools. Bash retains its independent switch. Turning resident tools off keeps their saved settings but loads file APIs only on demand when dynamic loading is enabled. Turning both off publishes neither baseline file APIs nor a loader.

The bundle inserts one row named exactly like the package, so this plugin's browser
half mounts on it and the Plugins page configures it directly. By the maintainer's
decision the page keeps **four bundle switches and mode-specific preset switches**;
everything else (worker paths, PTC pools, extra routing text, capture limits, the
credential fence) stays YAML-only so the page cannot grow into a second settings app.

- **Bundle switches:** Bash, Hide the host PowerShell, Hide the official tools, Dynamic tool loading. They decide
  whether the same-named switch in each preset below applies.
- **Each preset (minimal / standard / ptc / cordis):** enabled, Enable the Bash tool,
  Hide the host PowerShell, Hide the official tools, Dynamic tool discovery — all on
  by default. The last two are gated: while the matching bundle switch is off the
  control keeps its saved value but is disabled.
- **Other:** activity capture and the TUI link (one switch each, off by default) plus
  the `dsh-win-pwsh7 link`: while on, the host pwsh tool stays visible for that plugin to
  point at pwsh 7, and every “Hide the host PowerShell” switch locks to off. Until a value is
  saved it follows detection — installing the plugin turns it on by default, and a saved
  value (off or on) is never overridden by detection.

With "Hide the host PowerShell" off the host shell stays visible; when
`dsh-win-pwsh7` is installed it replaces PowerShell 5.1 with PowerShell 7 instead,
and with the switch on it adds PowerShell 7 alongside. Runtime installation stays in
the status card and always shows a plan before it executes.

Saves write only the switches that changed, as nested paths (for example
`standard.hidePwsh`), with the revision the page read; a host reload while the page
is dirty cannot turn an untouched switch into a write. A refused or stale save keeps
the draft, **Reset to saved** loads the latest values, and leaving the page discards
the draft.

The page also renders one **status section** after its content (`plugins.detail.section`,
order 50), only on this package's own page or the `dsh-ops` row page. It keeps a
heading row (title, refreshed-at, check-again) and opens its shaded block with one
sentence: ops_bash runs on the managed Bash, on the detected Git Bash, or no usable Bash
was found. The facts below come from the host snapshot: platform, managed Bash, Git Bash,
PowerShell 7 (with the probed version when available) and `dsh-win-pwsh7` (可用 with the package
version when installed, otherwise 未检测到 plus a separate 安装 action). The managed Bash row carries its
own action — install when absent, remove when ops owns the installation — and the
companion row installs from that action. Both open the same plan panel (details plus
execute/close), which carries either the host's Bash plan or the version resolved by
`pluginManager.inspect()`. A disabled row or package renders nothing, and an unavailable
remote shows its reason instead of a green state.

### Row ids from earlier versions

`dsh-ops-mode-*`, `dsh-ops-discovery`, `dsh-ops-compat`, `dsh-ops-panel` and `dsh-ops-tui`
(and the older `shell`, `file`, `ptc`, `hide-official`, `background`) are no longer rows
this bundle inserts. A saved patch entry for one of them never fails startup: it either
stays unmatched or composes as its own row, and that module notices the package now ships
the single-row layout, logs one warning and publishes nothing. Move the settings into this
row and delete the stale entry; the patch file itself is never rewritten.

---

## Where configuration lives

In DSH's configuration editor, find the corresponding `dsh-ops/mode-*`, `dsh-ops/discovery`,
`dsh-ops/panel`, `dsh-ops/tui` or `dsh-ops/compat` row, adjust `config`, then save; unknown
configuration keys cause errors naming the key.
The bundle declares eight independently toggled components. Fresh defaults follow the table. Saved profile switches and raw configuration override bundle defaults; adding discovery does not rewrite them. Profiles without explicit switch overrides inherit updated defaults.
| Row `name` | Component | Default |
| --- | --- | --- |
| `dsh-ops/mode-minimal` | Enhanced Minimal preset: dynamic loading and the Windows shell replacement | On |
| `dsh-ops/mode-standard` | Enhanced Standard preset: resident file tools, official read/glob/grep and Windows shell replacement | On |
| `dsh-ops/mode-ptc` | Enhanced PTC preset: typed SDK and Windows shell replacement | On |
| `dsh-ops/mode-cordis` | Enhanced Cordis preset: resident file tools, official read/glob/grep and Windows shell replacement | On |
| `dsh-ops/discovery` | Advanced Native tool discovery | On |
| `dsh-ops/compat` | Compatibility mode: keep official tools visible | Off |
| `dsh-ops/panel` | Capture subsequent events | Row off; enabling starts capture |
| `dsh-ops/tui` | Read-only sidebar, separate config | Off |

A `dsh-ops/background` row left over from an earlier version loads as a no-op stub (the FastCtx background component was removed); it ignores its config and can be deleted.

---

## 🔴 Which key belongs to which component

`dsh-ops/tui` uses only `maxSessions`, `maxActive` and `recentLimit`; see [sidebar limits](tui-panel.md#limits). The table lists where each setting is used. The four mode rows share one validator that accepts the retained worker and executor keys plus the PTC pool keys, so a key can be present on any mode row without affecting a mode that does not read it. PTC mode, discovery, panel and TUI use their own strict key sets; do not copy unrelated settings into them. `dsh-ops/compat` accepts no configuration. The Loader row switch is disabled, outside config.

| Key | Type | Default | Owning component |
| --- | --- | --- | --- |
| `configUpdateVersion` | non-negative integer | `0` | mode rows (migration marker) |
| `binaryPath` | absolute path | — | mode rows / discovery |
| `bashPath` | string path | — | mode rows |
| `publishBashTool` | boolean | `true` | mode rows |
| `promptPolicy` | boolean | `true` | mode rows |
| `extraGuidance` | string | empty | mode rows (Standard/Cordis guidance) |
| `required` | boolean | `false` | mode rows / discovery |
| `allowSystemShellFallback` | boolean | `false` | mode rows |
| `denyCredentialReads` | boolean | `true` | mode rows / discovery |
| `allowedTools` / `alwaysLoaded` | string arrays | `[]` | PTC mode / discovery |
| `maxResults` | integer 1–5 | `3` | discovery |
| `enabled` | boolean | `true` | discovery |
| `capture` | boolean | `true` | panel (row defaults off) |
| `textLimit` | integer | `2000` | panel |
| `maxSessionBytes` | integer | `8388608` | panel |

The PTC mode row owns `allowedTools` and `alwaysLoaded` in addition to the shared keys; its always-loaded list is independent of the dynamic allowed pool. Discovery owns `enabled`, `maxResults`, `allowedTools`, `alwaysLoaded`, `binaryPath`, `required` and `denyCredentialReads`, and requires alwaysLoaded to be a subset of allowedTools. See [PTC settings](ptc-sdk-loading.md) and [discovery settings](discovery.md) for defaults and exact names. The Compatibility row owns no keys; panel and TUI have only their documented capture/display fields.

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

**Removed row keys.** `shellPolicy` and `deniedHostTools` belonged to the removed `dsh-ops/shell` row; the current bundle declares no row that accepts them, and a mode row rejects them as unknown keys naming the key. `replaceTools` belonged to the removed `dsh-ops/hide-official` row and is replaced by the Compatibility switch. `strict`, `scope` and `additionalOfficialTools` remain validated only by that legacy module.

**Deprecated keys.** `serverName`, `enableShellTools` and `toolCallTimeoutMs` were read only by the removed FastCtx background component. They are still accepted (and still type-checked) so existing rows keep loading — earlier bundles wrote `enableShellTools: false` and `toolCallTimeoutMs: 300000` into every file row — but they have no effect, and configuration update 2 removes them from saved rows on the next start.

---

## Examples

The `dsh-ops/mode-standard` row:

```yaml
config:
  promptPolicy: true
  publishBashTool: true
  allowSystemShellFallback: false
  denyCredentialReads: true
  # bashPath: 'C:\tools\bash.exe'   # restricted Windows execution requires matching MSYS/IPC; see below
  # binaryPath: 'C:\tools\dsh-ops-worker.exe'
  # Managed update metadata; do not remove after the first startup self-check
  # configUpdateVersion: 2
```

The `dsh-ops/mode-ptc` row adds its own pool keys; the host schema edits them:

```yaml
config:
  allowedTools: []
  alwaysLoaded: []
  required: false
  # binaryPath: 'C:\tools\dsh-ops-worker.exe'
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
- `shellPolicy` / `deniedHostTools`: the removed `dsh-ops/shell` row's host-shell routing keys. The current bundle declares no row that accepts them; a mode row rejects them as unknown keys. Hiding of replaced official tools is now owned by the enabled mode rows and lifted by Compatibility mode.
- `allowSystemShellFallback`: defaults to `false`. Without a bundled/provisioned bash, do not discover system PATH or well-known installations (**on a POSIX host this key has no effect**: a mode row already resolves the host bash and there is no pinned payload to fall back from). Explicit `true` opts into an unpinned system bash that the operator must trust and maintain. Explicit `bashPath` is a separate operator selection, not an automatic fallback. See the update configuration modification area in the [usage guide](usage.md) for the first-start migration.
- Hiding and executor fallback are independent: an enabled mode row hides an official tool only while its OPS counterpart is visible in the same scope, Compatibility mode lifts that hiding, and disabling fallback constrains the plugin's bash resolver rather than the host's own `pwsh`. None of these is a filesystem sandbox.
- `binaryPath` (the native worker executable) / `bashPath`: optional explicit absolute paths; unavailable paths cause an error rather than silently switching executors. On Windows the pinned Bash payload is an optional npm dependency of the main package and arrives with the install, so normally no configuration is needed; use `dsh-ops bash-runtime install` if it is missing or incomplete, or `dsh-ops bash-runtime git` / `managed` to print a Bash selection.
- **On a POSIX host `ops_bash` already runs the distribution's own bash**: `bashPath` → `PATH` → `/bin/bash`, `/usr/bin/bash`, `/usr/local/bin/bash`, with no second shell shipped, so there is no payload to "fall back" from and `allowSystemShellFallback` does not affect it. In a confined mode (`workspace-write` / `read-only`) `bashPath` still takes effect, with the constraint enforced by a host sandbox (bwrap / Landlock); when no sandbox can confine the call it is **refused** rather than run unrestricted.
- `bashPath` **(Windows) must match the pinned MSYS for restricted execution.** In read-only and workspace-write, `ops_bash` runs only the pinned MSYS whose IPC compatibility proxies were verified (`dsh-ops bash-runtime install`, or a compatible existing copy); any other `msys-2.0.dll`, including your own Git for Windows, returns `EXECUTOR_UNAVAILABLE` by design and is never run unconfined. Do not point `bashPath` at your own Git Bash to work around a restricted-mode problem. Check a selection with `dsh-ops ladder --config <file>`, which reports `restricted: yes/no` for the resolved bash. See [Troubleshooting](troubleshooting.md#ops_bash-cannot-run-a-custom-bashpath-or-git-for-windows-in-restricted-modes).
- `configUpdateVersion`: completion marker for the configuration migrations (currently `2`: update 1 retires the old implicit system-bash opt-in, update 2 removes the deprecated FastCtx keys). It is accepted by every mode row; do not remove it, or the self-check runs again.
Disabling the row or saving `capture: false` stops event collection immediately, cancels queued filesystem work, and waits for already-started I/O before the host finishes the change. It does not start a final fold: existing NDJSON remains recoverable, and a temporary file from an interrupted fold may remain. Re-enabling captures only subsequent events; disabled events are not replayed.

- The panel row defaults disabled and registers no listener or file. Once enabled, `capture` defaults to `true`; an explicit legacy `false` still registers nothing and is never silently changed. The host cannot atomically clear that old field while disabling its row, so the compatibility setting remains visible for deliberate edits. Captured events write into the session working directory:
  - `<cwd>/.dsh-ops/panel/<sessionId>.json` — the only data source: conversation text, the tool-call/result/milestone trace, usage buckets, and trimmings/limits;
  - `<cwd>/.dsh-ops/panel/panel.html` — a static viewer that reads that JSON in the browser and inlines no data (drag the JSON onto it, or run `dsh-ops panel [dir]` to serve the directory on loopback; a plain static server can pass `?data=<sessionId>.json`).

  While a session is live the sink appends NDJSON (`<sessionId>.ndjson`, crash safe) and folds it into the JSON at each turn end and when the session is sealed; sealing removes the append log. The capture row opens no port, registers no UI and writes no `~/.dsh`; only the explicit `dsh-ops panel` operator command starts a loopback-only server, reads the named directory and writes nothing. There is no build step — `panel.html` ships in the package. Sessions whose working directory is inside the DSH home, or whose id cannot be a file name, are refused with one log line. Capture writes into the conversation's working directory, so add `.dsh-ops/` to that project's `.gitignore`: reports can contain prompts, conversation text and tool output.
- `textLimit`: characters kept per message text, tool argument and reasoning field; a clamp sets `truncated`/`droppedChars` on that row instead of silently shortening it. `64`–`100000`.
- `maxSessionBytes`: the per-session budget for the append log, and therefore the ceiling the merged JSON is trimmed to fit. Records over it are dropped and counted in `limits.droppedEvents`; when the JSON would overrun, the oldest conversation/trace rows are dropped and counted in `limits.trimmedRows`, while the usage totals stay complete. `65536`–`268435456`.

---

## Compatibility mode (`dsh-ops/compat`)

The row is **disabled by default** and accepts no configuration. Enabling it sets one runtime switch:
every enabled mode row keeps publishing its OPS tools, but no official tool is hidden — `read`,
`glob`, `grep` and the Windows official shell stay exposed and callable. Disabling it restores the
hiding each enabled mode row performs, without unloading any row.

- Hiding is per agent scope and applies only while the OPS counterpart of an official tool is
  visible in that same scope. A missing counterpart leaves the official tool exposed instead of
  removing a capability.
- The switch is a configuration fact; it does not change which tools a mode row publishes, and the
  OPS counterparts remain callable while it is on.
- Compatibility costs token efficiency and model ability because both tool surfaces are visible.
  Prefer enabling only the mode rows a profile needs over leaving Compatibility on.
- There is no per-tool `replaceTools` selection in this version. The removed
  `dsh-ops/hide-official` row is a legacy module outside the bundle; delete a saved override for it.
  Its old `strict`, `scope` and `additionalOfficialTools` keys are validated only by that legacy
  module and grant no authority here.

The built-in Compatibility form is the host row switch; the row has no editable settings page.
Cordis validates mode configuration through `StandardSchemaV1`, and the browser page
described above edits the mode and discovery rows.


---

## Prompt registration

Prompts are registered as scoped runtime sections, not written to AGENTS.md. Each enabled mode row
publishes routing guidance only for sessions composed from its preset, and only while its OPS tools
are visible in that scope; disabling the row withdraws it. The discovery row publishes guidance for
the capabilities it publishes, and Compatibility mode publishes none. Standard and Cordis publish
the resident OPS file tools, the discovery row serves every native session (Minimal included) while
it is enabled, and PTC owns its separate typed SDK and current permission checks. Advanced Native
tools are discovered or explicitly always loaded, and a capability a running mode already publishes
resident is not offered as a discovery choice. The approved BM-03 budget measures file/discovery schemas at ≤400 tokens.
Bash startup residency is unchanged; its schema and the complete startup total are reported
separately, and missing Bash cannot satisfy the Windows readiness check.

---

## See also

- [Usage](usage.md) — install, update, remove, CLI
- [Component reference](component-reference.md) — components and tools
- [Troubleshooting](troubleshooting.md) — errors and diagnosis

## Host settings forms

Each enabled row exposes its supported validated fields to the host settings service. Saving uses the
profile revision the form read; a stale revision or invalid
selection is rejected before writing. The host persists accepted changes and reloads the affected
row, so the running configuration follows the saved selection. Ordinary row fields are preserved.
A disabled row has no editable form; re-enable it with the host's built-in row switch first.

A mode descriptor exposes Bash publication and an absolute executor override; PTC mode additionally
exposes its own pool through the shared schema. Internal revision markers, the removed file/shell
row keys and retired FastCtx compatibility keys are deliberately excluded. Discovery exposes all
seven accepted fields, including `binaryPath`, `required` and `denyCredentialReads`. The release
gate checks component entries, targets, published tool declarations, retained host commands and
explicit bundle defaults against their runtime definitions.

Runtime actions use the host's authenticated gateway and managed subprocess service. Installation,
removal and upgrade require a preview followed by execution of that current preview; expired,
changed or reused plans are refused. Only one action runs at a time. Closing/unloading the owning
mode row cancels outstanding work and waits for settlement; cancellation after launch may
leave changes and reports an unknown effect. Bash install refuses a store containing unowned
version directories. The PowerShell action targets the standard WinGet installation and requires
a DSH restart; an explicit host `pwshPath` remains authoritative. Installer output stays in host
logs; use the previewed command in a terminal if WinGet needs interactive input.
