# dsh-ops

Reduce tokens, time and model attention wasted on repeated PowerShell errors in
Windows DSH. The bundle supplies independent **bash 5.3.15**, **PowerShell 7.6.6**,
and high-performance Rust repository tools powered by FastCtx.

Routing: **file tools → bash → PowerShell 7**. Prefer bash for general commands;
use pwsh only for necessary Windows-native operations. Fix bash errors in bash.
Windows x64 only; target DSH `0.2.0-rc.2`. [中文](README.md)

## Install, update and remove

In the official marketplace, enter **`dsh-ops`**, install, then enable. This installs
into the running application's profile. All three Windows runtime packages are
installed as dependencies: no postinstall downloads and no system PATH changes.

```console
npx --yes dsh-ops@latest install --profile desktop
npx --yes dsh-ops@latest install --profile web
npx --yes dsh-ops@latest install --profile tui
```

An explicit profile is required. `tui` maps to the dsh-TUI product's **dsh-tui**
profile, not the old tui directory. Initialize the target application first.
The wrapper delegates locking, compatibility and rollback to the official DSH CLI.

Desktop uses its own `resources/runtime/cli/bin/dsh.cmd`, auto-detected under
`%LOCALAPPDATA%/Programs/DeepSeek Harness`. For another installation, pass
`--dsh-cli "<installation>/resources/runtime/cli/bin/dsh.cmd"`. Ordinary DSH CLI
cannot manage the reserved desktop profile. Web/TUI require an available DSH CLI;
`--dsh-cli` can also specify that executable explicitly.

Equivalent official commands:

```console
dsh plugin --profile web add dsh-ops
dsh plugin --profile dsh-tui add dsh-ops
"<desktop installation>/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add dsh-ops
```

Update by repeating the npx install command, or official `add dsh-ops@latest`.
Reload/restart as the application requests; replacing loaded code may require restart.

Version `0.2.4` adds three independently toggled components and retains the bash
object-root schema fix and custom icon. Runtime dependencies remain at `0.2.1` and
install automatically. Desktop pnpm's 24-hour release-age policy may show new metadata
but select an older package for a bare name: specify `dsh-ops@0.2.4` from the official
npm registry, confirm the installed version, then fully quit/restart. See the original
[payload release record](docs/release-0.2.1.md).

```console
npx --yes dsh-ops@latest status --profile desktop
npx --yes dsh-ops@latest uninstall --profile desktop
```

Use web/tui as appropriate. Marketplace uninstall and official `remove dsh-ops`
also remove profile dependency references. Runtime files are package dependencies,
not a new shared provisioned directory. System shells, other profiles and package
manager caches are never manually deleted. Clean legacy provisioned files separately
with `npx --yes dsh-ops@latest uninstall --yes`; `~/.fastctx/` is kept unless
`--purge-fastctx` is explicit. Background OFF drains in-flight calls and attempts to
kill only jobs remembered by this component on its current connection; failures warn.
Lost ownership after disconnect and permission downgrade do not guarantee termination.

## Components and prompts

| Component | Default | Capability |
| --- | --- | --- |
| dsh-ops-bash & powershell 7 | On | Prefer ops_bash for general commands; bundled PowerShell 7 for Windows-native work |
| dsh-ops-file | On | Rust batch reads, search, path discovery and replacement |
| dsh-ops-background | Off | Scientific simulations, model training and other long-running tasks |

Each row owns its tools and runtime prompt section; OFF withdraws both. Nothing is
appended to AGENTS.md. Shell ON adds a runtime-only configuration overlay for the
stock pwsh-sandbox path; OFF recomputes its latest owning raw configuration via the
official lifecycle, without writing profile files. It does not change the OS default
terminal or cancel already-running host commands. File/background share one owned
FastCtx connection; turning one off does not stop the other. Default tool count is
five; duplicate ops_run is no longer published. Reduced fixed schema cost is not a
promise of lower task-total tokens. Minimal's complete persona excludes extra sections;
PTC invokes the tools through its generated SDK with unchanged permission checks.

## Configuration and tools

Edit the corresponding dsh-ops/shell, dsh-ops/file or dsh-ops/background row's config.
Unknown keys fail; normal component enablement is available in the marketplace.

```yaml
config:
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

`enableShellTools` controls the background component's four run/job tools; file never
publishes commands. `publishBashTool` controls bash. Both additionally require authoritative session `danger-full-access`; bash
also requires the host subprocess service. `promptPolicy` controls compact routing;
`extraGuidance` appends text. RPC wait timeout does not prove server termination.
`required` fails activation on unavailable runtime. Explicit binary/bash paths are
authoritative. `shellPolicy: deny-host-shell` blocks `deniedHostTools` (default
`[pwsh, bash, pwsh_persistent]`), including the third-layer pwsh; use cautiously.

| Tools | Purpose | Full access |
| --- | --- | --- |
| ops_inspect_local_file | Batch text ranges, encoding, PDF text and hex | No command gate¹ |
| ops_grep | Rust regex, file filters, counts/summaries | No command gate¹ |
| ops_glob | Multiple path patterns and exclusions | No command gate¹ |
| ops_replace | Mechanical cross-file replacement; host edit for precise edits | No command gate¹ |
| ops_bash | Preferred general bash executor | Required |
| ops_run_background | Start background jobs | Required |
| ops_job_output / ops_job_list / ops_job_kill | Operate on this session's owned jobs | Required |
| Host pwsh | Bundled PowerShell 7 Windows-native operations | Host policy |

¹ File tools are **not host filesystem-confined**, including ops_replace. Do not
use this bundle as a security boundary for untrusted restricted deployments.
Images belong to host read_image. Permissions are reconciled dynamically and
rechecked on execution; job ownership is per session and connection, lost on reconnect.
See [manual validation](docs/manual-validation.md) and [schema measurements](docs/schema-measurement.md).

## License

Plugin source: **MIT AND Apache-2.0**. Outside vendor/fastctx: MIT; vendored FastCtx:
Apache-2.0. See [NOTICE](NOTICE), vendor/fastctx/LICENSE-APACHE and vendor/fastctx/NOTICE.
The independent Windows payload packages retain upstream component licenses:
Git for Windows includes GPL components; PowerShell includes MIT and third-party
components. The plugin's MIT does not relicense them. See [PROVENANCE](PROVENANCE.md).

## Acknowledgements

The Rust tools use source from yc-duan's FastCtx Codex plugin. Distribution changes
are recorded in vendor/fastctx/FORK.md and vendor/fastctx/UPSTREAM.md. Required notice:

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
