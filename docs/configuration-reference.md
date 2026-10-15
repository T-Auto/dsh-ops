# Configuration reference

Every configuration key, and **which component row owns it**.

---

## Where configuration lives

In DSH's configuration editor, find the corresponding `dsh-ops/shell`, `dsh-ops` (file), `dsh-ops/background` or `dsh-ops/ptc` row, adjust `config`, then save; unknown configuration keys cause errors naming the key.

The file row now uses the root entry `dsh-ops` instead of `dsh-ops/file`, retaining id `dsh-ops-file`; the root was already a file alias, so no components were added or removed. The old `/file` entry still works, but a handwritten composition using only subpaths does not discover the browser companion; the root file row is needed for the configuration UI.

In the GUI, open Plugins → dsh-ops → file row → Configuration. Its single “Hide overlapping built-in tools” switch (`hideBuiltinTools`, off by default) saves and takes effect immediately through `volatile` + `configForms`.

The bundle declares four independently toggled components. On first installation, the first two are enabled by default:

| Row `name` | Component | Default |
| --- | --- | --- |
| `dsh-ops/shell` | Terminal and shell | On |
| `dsh-ops` | Rust file tools | On |
| `dsh-ops/background` | Background tasks | Off |
| `dsh-ops/ptc` | Native PTC batches | Off |

---

## 🔴 Which key belongs to which component

The table below gives the **owning component** for each key. Putting a key on a row that does not own it is rejected by configuration validation, which names the offending key.

| Key | Type | Default | Owning component |
| --- | --- | --- | --- |
| `configUpdateVersion` | non-negative integer | `0` | any (migration marker) |
| `serverName` | string, `[A-Za-z0-9_-]{1,32}` | `fastctx` | legacy compatibility |
| `binaryPath` | string path | — | background / ptc |
| `bashPath` | string path | — | shell |
| `enableShellTools` | boolean | `true` | background |
| `publishBashTool` | boolean | `true` | shell |
| `hideBuiltinTools` | boolean | `false` | file / root entry `dsh-ops` |
| `promptPolicy` | boolean | `true` | all |
| `extraGuidance` | string | empty | all |
| `toolCallTimeoutMs` | positive integer (ms) | `300000` | background / file |
| `required` | boolean | `false` | all |
| `shellPolicy` | `advise` \| `deny-host-shell` | `advise` | shell |
| `deniedHostTools` | string array | `[pwsh, bash, pwsh_persistent]` | shell |
| `allowSystemShellFallback` | boolean | `false` | shell |

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

The `dsh-ops/background` row (its market row is disabled by default):

```yaml
config:
  promptPolicy: true
  enableShellTools: true
  required: false
  toolCallTimeoutMs: 300000
  # binaryPath: 'C:\tools\fastctx.exe'
  # Managed update metadata; do not remove after the first startup self-check
  # configUpdateVersion: 1
```

---

## Key by key

- `enableShellTools`: deployment switch for the background component; enabling it still requires session `danger-full-access` to publish the four background tools. The file component never publishes command tools.
- `publishBashTool`: publish `ops_bash` using current session policy; restricted modes require the host sandbox, full access uses the host subprocess service.
- `hideBuiltinTools`: defaults to `false`, owned only by file/root. When on, hides and refuses calls to only `read/write/edit/glob/grep/bash/pwsh/pwsh_persistent`; `read_image`, third-party tools, `run_code`, `ops_batch`, `ops_result` and background `ops_*` remain. It does not remove every non-ops tool or change sandbox permissions. Turn it off if the available ops tools cannot cover a task. Disabling file or uninstalling also lifts the mask; independent `shellPolicy` denials remain.
- `promptPolicy`: whether to inject the component's runtime guidance; use `extraGuidance` to append instructions.
- `toolCallTimeoutMs`: FastCtx RPC wait timeout; it does not mean server-side work has terminated. Ceiling `2147483647`.
- `required`: whether to reject activation when the runtime is unavailable.
- `shellPolicy`: defaults to `advise`; `deny-host-shell` rejects host shells in `deniedHostTools` (default `[pwsh, bash, pwsh_persistent]`). This also disables third-layer pwsh; enable cautiously.
- `allowSystemShellFallback`: defaults to `false`. Without a bundled/provisioned bash, do not discover system PATH or well-known installations; background commands cannot bypass this through FastCtx discovery either. Explicit `true` opts into an unpinned system bash that the operator must trust and maintain. Explicit `bashPath` is a separate operator selection, not an automatic fallback. See the update configuration modification area in the [usage guide](usage.md) for the first-start migration.
- `shellPolicy` is independent: `deny-host-shell` masks/refuses host tools; disabling fallback constrains the plugin's bash resolver, not the host's own `pwsh`, and is not a filesystem sandbox.
- `binaryPath` / `bashPath`: optional explicit paths; unavailable paths cause an error rather than silently switching executors. Usually no configuration is needed.
- `bashPath` **works only in `danger-full-access`.** In read-only and workspace-write, `ops_bash` runs only the pinned MSYS whose IPC compatibility proxies were verified (the bundled payload or `dsh-ops provision-shells --bash`); any other `msys-2.0.dll`, including your own Git for Windows, returns `EXECUTOR_UNAVAILABLE` by design and is never run unconfined. Do not point `bashPath` at your own Git Bash to work around a restricted-mode problem. Check a selection with `dsh-ops ladder --config <file>`, which reports `restricted: yes/no` for the resolved bash. See [Troubleshooting](troubleshooting.md#ops_bash-cannot-run-a-custom-bashpath-or-git-for-windows-in-restricted-modes).
- `deniedHostTools`: the host tool names refused by the `deny-host-shell` policy.
- `serverName`: the legacy FastCtx server identity, kept for existing deployment rows; server instructions are no longer published as a separate prompt section.
- `configUpdateVersion`: completion marker for the one-time configuration migration. Do not remove it, or the self-check runs again.

---

## Prompt registration

Prompts are registered as independent runtime sections, **not written to AGENTS.md**: shell OFF withdraws bash/pwsh routing; file OFF withdraws native file guidance; background OFF withdraws background tools and owned-job guidance. The file component uses its independent Rust worker; FastCtx is retained only by the disabled background component. Four native file tools and `ops_bash` are added by default; duplicate foreground `ops_run` is not published. These changes reduce fixed declaration costs. The Minimal preset overrides additional system sections; PTC mode calls the underlying tools through the SDK with unchanged permission gates.

---

## See also

- [Usage](usage.md) — install, update, remove, CLI
- [Component reference](component-reference.md) — components and tools
- [Troubleshooting](troubleshooting.md) — errors and diagnosis
