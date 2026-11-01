# Bash and PowerShell coexistence

中文：[Bash 与 PowerShell 共存](Bash与PowerShell共存.md).

`ops_bash` is an independent Bash command tool. Windows uses local MSYS Bash, not Linux, WSL or PowerShell. OPS does not rewrite the host OS or hide host `pwsh` by default.

## Defaults and explicit choices

- Built-in presets enable Bash but default `hidePwsh` to false. Custom presets also default `hidePwsh` to false; file-tool `replaceOfficial` does not imply shell hiding.
- `global.hidePwsh` remains true by default, but is only an allow gate, not hiding intent. Hiding `pwsh` and `pwsh_persistent` requires explicit preset `hidePwsh: true`, the global gate, a callable Bash tool in that Windows agent, and no active pwsh7 link.
- Previously saved explicit `hidePwsh: true` is respected, not silently migrated. An explicit global false vetoes hiding. When Bash is missing or cannot be published under the current authority/services, official PowerShell stays available as fallback.
- `other.pwsh7Link` keeps official `pwsh` visible for `dsh-win-pwsh7` to manage its version. An unsaved link still follows existing companion detection; explicit on/off wins. Coexistence does not require the companion. OPS does not modify third-party plugins, bundle order or profiles.

## Prompt and execution contracts

OPS registers its own `dsh-ops:tool-bash:<consumer>` section at the Bash order, rendered only for agents that can actually call the tool. It never registers or overrides `tool:pwsh`; the PowerShell schema and guidance remain host-owned. Reload, disabling and disposal clean up OPS tools and sections without rewriting the shared registry or leaking into other agents.

Bash uses Bash quoting, `$VAR`, `$(command)`, redirection and pipelines. Each call is a fresh non-login shell without persistent shell state. Provide exactly one of `command` or `script_path`, the latter naming an existing Bash script. Relative `workdir` uses the current session directory. On Windows use `D:/repo` or `/d/repo`; drive-less `/tmp` or `/` is not a Windows `workdir`. Inside commands use MSYS paths and quote spaces.

The host session sandbox and approval remain authoritative; switching shells cannot bypass denial. `description` is required. Check `kind` first: `foreground` includes `status`, possibly null `exitCode`, stdout/stderr and failure `code/effectState/retry`; `background` / `promoted` includes `jobId`, not completion. Background parameters exist only with host jobs; use `job_output` to collect and `job_kill` to stop. Without jobs, the foreground deadline stops the command. Output is bounded; truncation and spill paths do not mean completeness. A missing exit code is not success; inspect postconditions before repeating unknown effects. No PowerShell exit marker is fabricated.

Regression tests use real Cordis tools/systemPrompt registration, assembly and Bash subprocess execution, plus a pinned third-party bridge (source and MIT license in `test/fixtures/shell-slot-pwsh7/README.md`). This is not a guarantee for all future companion versions. No real Desktop/Web/profile is modified or deployed.
