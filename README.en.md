# dsh-ops

[中文](README.md) | **English**

Reduce the tokens, time and model attention wasted on repeated PowerShell errors in Windows DSH. The plugin provides three main capabilities:

- Independent **bash 5.3.15**, preferred for general commands so your AI no longer has to fight PowerShell.
- Independent **PowerShell 7.6.6** for necessary Windows-native operations through the host `pwsh` tool. PowerShell 7 also offers many improvements over the built-in PowerShell 5.
- Faster, higher-performance Rust tools for reading, searching and replacing files, speeding up tasks and reducing unnecessary input/output. Because some tools do not use DSH's restricted terminal backend, command and background-task tools are enabled only with **full access**.
- A range of lightweight, easy-to-use Rust tools for DOCX and PDF processing will be added in the future; each can be toggled without taking up context.

<img width="1603" height="1028" alt="247c1326cca5b66e60d330c3f32150e2" src="https://github.com/user-attachments/assets/7c9ba485-5323-42a2-b5a8-6dcda07f91c4" />

Routing: **toolkit → bash → PowerShell 7**.

Currently supports **Windows x64** only. Linux and Mac support will follow once the Rust tools are added for those platforms (bash functionality will not be provided on Linux or Mac). Target host DSH `0.2.0-rc.2`.

## Install, update and remove

### Official plugin marketplace

In the target DSH application's plugin marketplace, enter the npm package name **`dsh-ops`**, install, then enable. Installation belongs to the currently running profile, which is `desktop` for the desktop app. The published package depends on complete FastCtx, bash and PowerShell 7 payloads; it does not download them through install scripts or change the system PATH.

### One-command npm installation

```console
npx --yes dsh-ops@latest install --profile desktop
npx --yes dsh-ops@latest install --profile web
npx --yes dsh-ops@latest install --profile tui
```

An explicit target profile is required. `tui` maps to the **dsh-TUI product's `dsh-tui` profile**, not the old `tui` directory. Initialize the target application first. This entry point delegates installation to the official DSH CLI rather than implementing separate profile locking and rollback logic.

Desktop must use the CLI bundled with the desktop application; the default auto-detected path is `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`. For another installation location, add `--dsh-cli "<installation>\resources\runtime\cli\bin\dsh.cmd"`. Web/TUI require an available DSH CLI, which can also be specified explicitly.

You can also use the official commands directly:

```console
dsh plugin --profile web add dsh-ops
dsh plugin --profile dsh-tui add dsh-ops
"<desktop installation>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-ops
```

The ordinary DSH CLI cannot manage the reserved `desktop` profile; do not confuse it with the desktop app's bundled entry point.

**Update**: repeat the same `npx --yes dsh-ops@latest install --profile ...` command, or use the official CLI's `add dsh-ops@latest`. Reload as requested by the application; restart it when replacing already-loaded code.

The current version, `0.2.4`, supports three independent components and retains the bash parameter schema fix and custom icon. The three binary dependencies remain at `0.2.1`; they install automatically without affecting the main plugin version. See the original [payload release record](docs/release-0.2.1.md).

**Remove and check status**:

```console
npx --yes dsh-ops@latest status --profile desktop
npx --yes dsh-ops@latest uninstall --profile desktop
```

Replace `desktop` with `web` or `tui` as appropriate. You can also uninstall in the marketplace or run the official `dsh plugin --profile ... remove dsh-ops`. Binaries are managed as profile plugin dependencies; uninstalling removes dependency references without deleting system shells, copies in other profiles or shared package-manager caches.

Legacy explicitly provisioned `<DSH_HOME>/dsh-ops/` files must be cleaned separately with `npx --yes dsh-ops@latest uninstall --yes`. Persistent `~/.fastctx/` state is kept by default; add `--purge-fastctx` explicitly if needed. Disabling the background component waits for in-flight calls, then attempts to terminate only its own jobs remembered on the current connection; failures produce warnings. Old jobs whose ownership was lost after disconnect, and permission downgrades alone, do not guarantee termination; handle your own jobs first.

## Components and prompts

The official marketplace displays three independently toggled components. On first installation, the first two are enabled by default:

| Component | Description | Default | Published tools |
| --- | --- | --- | --- |
| `dsh-ops-bash & powershell 7` | Prefer bash as the terminal, with PowerShell 7 for operations bash cannot cover | On | `ops_bash`; host `pwsh` uses bundled PowerShell 7 |
| `dsh-ops-file` | Faster, higher-performance Rust file retrieval with more concise, token-efficient output | On | Four file tools |
| `dsh-ops-background` | Managed background tasks for scientific simulations, model training and other long-running processes | Off | Start, read output, list and terminate background jobs |

“Prefer bash as the terminal” means prompting the model to use `ops_bash` first; it **does not change the system default terminal, PATH or existing host shell tool names**. When the shell component is on, the official configuration lifecycle temporarily sets the PowerShell 7 path for `pwsh-sandbox`; when off, it restores the executor's latest original configuration without writing profile configuration. Switching executor configuration does not cancel already-running host commands.

Prompts are registered as independent runtime sections, **not written to AGENTS.md**: shell OFF withdraws bash/pwsh routing; file OFF withdraws retrieval guidance; background OFF withdraws background tools and owned-job guidance. File and background share one plugin-owned FastCtx connection; disabling one does not stop the other. Only five tools are added by default; the duplicate foreground `ops_run` is not published. These changes reduce fixed declaration costs. The Minimal preset overrides additional system sections; PTC mode calls the underlying tools through the SDK with unchanged permission gates.

## Configuration and tools

In DSH's configuration editor, find the corresponding `dsh-ops/shell`, `dsh-ops/file` or `dsh-ops/background` row, adjust `config`, then save; unknown configuration keys cause errors naming the key. You can also toggle components directly in the marketplace. Main settings:

```yaml
config:
  # background component only; its market row is disabled by default
  enableShellTools: true
  publishBashTool: true
  promptPolicy: true
  toolCallTimeoutMs: 300000
  required: false
  shellPolicy: advise
  allowSystemShellFallback: true
  # binaryPath: 'C:\tools\fastctx.exe'
  # bashPath: 'C:\tools\bash.exe'
```

- `enableShellTools`: deployment switch for the background component; enabling it still requires session `danger-full-access` to publish the four background tools. The file component never publishes command tools.
- `publishBashTool`: whether to publish `ops_bash`; also requires full access and the host subprocess service.
- `promptPolicy`: whether to inject the component's runtime guidance; use `extraGuidance` to append instructions.
- `toolCallTimeoutMs`: FastCtx RPC wait timeout; it does not mean server-side work has terminated.
- `required`: whether to reject activation when the runtime is unavailable.
- `shellPolicy`: defaults to `advise`; `deny-host-shell` rejects host shells in `deniedHostTools` (default `[pwsh, bash, pwsh_persistent]`). This also disables third-layer pwsh; enable cautiously.
- `binaryPath` / `bashPath`: optional explicit paths; unavailable paths cause an error rather than silently switching executors. Usually no configuration is needed.

| Tool | Purpose | Full-access requirement |
| --- | --- | --- |
| `ops_inspect_local_file` | Batch text ranges, encoding, PDF text and hex | No command permission gate¹ |
| `ops_grep` | Rust regex search, multiple file filters, counts/summaries | No command permission gate¹ |
| `ops_glob` | Multiple path patterns with exclusions | No command permission gate¹ |
| `ops_replace` | Mechanical cross-file replacement; use host edit for precise changes | No command permission gate¹ |
| `ops_bash` | Preferred general bash command executor | Yes |
| `ops_run_background` | Start background jobs | Yes |
| `ops_job_output` / `ops_job_list` / `ops_job_kill` | Read, list and stop jobs started by the current session | Yes |
| Host `pwsh` | Windows-native operations using bundled PowerShell 7 | Host policy |

¹ **File tools are not the host filesystem sandbox.** They do not use DSH's restricted file backend; in particular, `ops_replace` has no workspace confinement. Do not treat the tools provided by this plugin as a security solution for untrusted restricted environments.

## License

Plugin source distribution uses **`MIT AND Apache-2.0`**: files outside `vendor/fastctx/` are MIT; vendored FastCtx is Apache-2.0. See [NOTICE](NOTICE), `vendor/fastctx/LICENSE-APACHE` and `vendor/fastctx/NOTICE`.

Independent Windows payload packages are distributed under their upstream component licenses: Git for Windows includes GPL and other licensed components; PowerShell includes MIT and third-party components. Original licenses, notices and provenance records are retained with the payloads; the plugin's MIT license does not replace them. See [PROVENANCE.md](PROVENANCE.md).

## Acknowledgements

The Rust tools are based on [yc-duan](https://github.com/yc-duan)'s FastCtx Codex plugin and use its source code. Vendor identification and deletion-only distribution changes are recorded in [vendor/fastctx/FORK.md](vendor/fastctx/FORK.md) and [vendor/fastctx/UPSTREAM.md](vendor/fastctx/UPSTREAM.md). The required FastCtx notice follows:

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
