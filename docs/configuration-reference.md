# Configuration reference

Every configuration key, and **which component row owns it**.

---

## Where configuration lives

In DSH's configuration editor, find the corresponding `dsh-ops/shell`, `dsh-ops/file`, `dsh-ops/ptc` or `dsh-ops/panel` row, adjust `config`, then save; unknown configuration keys cause errors naming the key.
The bundle declares six independently toggled components. On first installation shell, file and the panel row are enabled, and the panel row's own switch (`capture`) is **off**:
| Row `name` | Component | Default |
| --- | --- | --- |
| `dsh-ops/shell` | Terminal and shell | On |
| `dsh-ops/file` | Rust file tools | On |
| `dsh-ops/ptc` | Native PTC batches | Off |
| `dsh-ops/panel` | Data capture, off at the switch | Row on, `capture: false` |
| `dsh-ops/tui` | Read-only sidebar, separate config | Off |
| `dsh-ops/hide-official` | Strict official-tool hiding, separate config | Off |

A `dsh-ops/background` row left over from an earlier version loads as a no-op stub (the FastCtx background component was removed); it ignores its config and can be deleted.

---

## 🔴 Which key belongs to which component

`dsh-ops/tui` uses only `maxSessions`, `maxActive` and `recentLimit`; see [sidebar limits](tui-panel.md#limits). The following legacy configuration does not apply to the tui row. The table below gives the **owning component** for each key. Putting a key on a row that does not own it is rejected by configuration validation, which names the offending key.

| Key | Type | Default | Owning component |
| --- | --- | --- | --- |
| `configUpdateVersion` | non-negative integer | `0` | any (migration marker) |
| `binaryPath` | string path | — | file / ptc |
| `bashPath` | string path | — | shell |
| `publishBashTool` | boolean | `true` | shell |
| `promptPolicy` | boolean | `true` | all |
| `extraGuidance` | string | empty | all |
| `required` | boolean | `false` | all |
| `shellPolicy` | `advise` \| `deny-host-shell` | `advise` | shell |
| `deniedHostTools` | string array | `[pwsh, bash, pwsh_persistent]` | shell |
| `allowSystemShellFallback` | boolean | `false` | shell |
| `denyCredentialReads` | boolean | `true` | file / ptc |
| `capture` | boolean | `false` | panel |
| `textLimit` | integer | `2000` | panel |
| `maxSessionBytes` | integer | `8388608` | panel |

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
  # bashPath: 'C:\tools\bash.exe'   # honoured in danger-full-access only; see bashPath below
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

The `dsh-ops/panel` row — the settings item 「启动数据检测」 (`capture`) is **off by default**:

```yaml
config:
  capture: false        # 「启动数据检测」: on captures NEW conversations only
  textLimit: 2000       # characters kept per text field, marked when clamped
  maxSessionBytes: 8388608
```

---

## Key by key

- `publishBashTool`: publish `ops_bash` using current session policy; restricted modes require the host sandbox, full access uses the host subprocess service.
- `promptPolicy`: whether to inject the component's runtime guidance; use `extraGuidance` to append instructions.
- `required`: whether to reject activation when the native worker is unavailable.
- `shellPolicy`: defaults to `advise`; `deny-host-shell` rejects host shells in `deniedHostTools` (default `[pwsh, bash, pwsh_persistent]`). This also disables third-layer pwsh; enable cautiously.
- `allowSystemShellFallback`: defaults to `false`. Without a bundled/provisioned bash, do not discover system PATH or well-known installations (**on a POSIX host this key has no effect**: the shell component already resolves the host bash and there is no pinned payload to fall back from). Explicit `true` opts into an unpinned system bash that the operator must trust and maintain. Explicit `bashPath` is a separate operator selection, not an automatic fallback. See the update configuration modification area in the [usage guide](usage.md) for the first-start migration.
- `shellPolicy` is independent: `deny-host-shell` masks/refuses host tools; disabling fallback constrains the plugin's bash resolver, not the host's own `pwsh`, and is not a filesystem sandbox.
- `binaryPath` (the native worker executable) / `bashPath`: optional explicit paths; unavailable paths cause an error rather than silently switching executors. Usually no configuration is needed.
- **On a POSIX host `ops_bash` already runs the distribution's own bash**: `bashPath` → `PATH` → `/bin/bash`, `/usr/bin/bash`, `/usr/local/bin/bash`, with no second shell shipped, so there is no payload to "fall back" from and `allowSystemShellFallback` does not affect it. In a confined mode (`workspace-write` / `read-only`) `bashPath` still takes effect, with the constraint enforced by a host sandbox (bwrap / Landlock); when no sandbox can confine the call it is **refused** rather than run unrestricted.
- `bashPath` **(Windows) works only in `danger-full-access`.** In read-only and workspace-write, `ops_bash` runs only the pinned MSYS whose IPC compatibility proxies were verified (the bundled payload or `dsh-ops provision-shells --bash`); any other `msys-2.0.dll`, including your own Git for Windows, returns `EXECUTOR_UNAVAILABLE` by design and is never run unconfined. Do not point `bashPath` at your own Git Bash to work around a restricted-mode problem. Check a selection with `dsh-ops ladder --config <file>`, which reports `restricted: yes/no` for the resolved bash. See [Troubleshooting](troubleshooting.md#ops_bash-cannot-run-a-custom-bashpath-or-git-for-windows-in-restricted-modes).
- `deniedHostTools`: the host tool names refused by the `deny-host-shell` policy.
- `configUpdateVersion`: completion marker for the configuration migrations (currently `2`: update 1 retires the old implicit system-bash opt-in, update 2 removes the deprecated FastCtx keys). Do not remove it, or the self-check runs again.
- `capture` (「启动数据检测」): defaults to `false`, and **off means nothing happens** — the row registers no listener and creates no directory. When on, every *new* conversation writes into its own working directory:
  - `<cwd>/.dsh-ops/panel/<sessionId>.json` — the only data source: conversation text, the tool-call/result/milestone trace, usage buckets, and trimmings/limits;
  - `<cwd>/.dsh-ops/panel/panel.html` — a static viewer that reads that JSON in the browser and inlines no data (drag the JSON onto it, or pass `?data=<sessionId>.json` under a static server).

  While a session is live the sink appends NDJSON (`<sessionId>.ndjson`, crash safe) and folds it into the JSON at each turn end and when the session is sealed; sealing removes the append log. There is no port, no UI registration, no `~/.dsh` write, and no build step — `panel.html` ships in the package. Sessions whose working directory is inside the DSH home, or whose id cannot be a file name, are refused with one log line.
- `textLimit`: characters kept per message text, tool argument and reasoning field; a clamp sets `truncated`/`droppedChars` on that row instead of silently shortening it. `64`–`100000`.
- `maxSessionBytes`: the per-session budget for the append log, and therefore the ceiling the merged JSON is trimmed to fit. Records over it are dropped and counted in `limits.droppedEvents`; when the JSON would overrun, the oldest conversation/trace rows are dropped and counted in `limits.trimmedRows`, while the usage totals stay complete. `65536`–`268435456`.

---

## Prompt registration

Prompts are registered as independent runtime sections, **not written to AGENTS.md**: shell OFF withdraws bash/pwsh routing; file OFF withdraws native file guidance. The file component uses its independent Rust worker. Four native file tools and `ops_bash` are added by default. These changes reduce fixed declaration costs. The Minimal preset overrides additional system sections; PTC mode calls the underlying tools through the SDK with unchanged permission gates.

---

## See also

- [Usage](usage.md) — install, update, remove, CLI
- [Component reference](component-reference.md) — components and tools
- [Troubleshooting](troubleshooting.md) — errors and diagnosis
