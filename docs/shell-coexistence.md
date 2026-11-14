# Bash and PowerShell coexistence

中文：[Bash 与 PowerShell 共存](Bash与PowerShell共存.md).

`ops_bash` is an independent Bash command tool. Windows uses the selected local Bash runtime, with Niubash as the default; it does not become Linux, WSL or PowerShell. OPS does not rewrite the host OS. Built-in presets hide host PowerShell by default only while their Bash replacement is callable.

## Defaults and explicit choices

- Built-in presets enable Bash and default `hidePwsh` to true. Custom presets still default `hidePwsh` to false; file-tool `replaceOfficial` does not imply shell hiding.
- `global.hidePwsh` remains true by default, but is only an allow gate. Hiding `pwsh` and `pwsh_persistent` requires enabled preset hiding, the global gate, a callable Bash tool in that Windows agent, and no active pwsh7 link.
- Previously saved explicit `hidePwsh: false` or `true` is respected, not silently migrated. An explicit global false vetoes hiding. When Bash is missing or cannot be published under the current authority/services, official PowerShell stays available as fallback, and the prompt states that the slot is unavailable, quoting the resolution `source` and `detail` (which carries the deployment remedy) instead of leaving an empty section that reads as "this deployment has no Bash".
- `other.pwsh7Link` keeps official `pwsh` visible for `dsh-win-pwsh7` to manage its version. An unsaved link still follows existing companion detection; explicit on/off wins. Coexistence does not require the companion. OPS does not modify third-party plugins, bundle order or profiles.

## Prompt and execution contracts

OPS registers its own `dsh-ops:tool-bash:<consumer>` section at the Bash order, rendered only for agents that can actually call the tool. It never registers or overrides `tool:pwsh`; the PowerShell schema and guidance remain host-owned. Reload, disabling and disposal clean up OPS tools and sections without rewriting the shared registry or leaking into other agents.

Bash uses Bash quoting, `$VAR`, `$(command)`, redirection and pipelines. Fresh is the default: each call starts an independent non-login shell. Provide exactly one of `command` or `script_path`, the latter naming an existing Bash script. Fresh relative `workdir` uses the current session directory. On Windows use `D:/repo` or `/d/repo`; drive-less `/tmp` or `/` is not a Windows `workdir`. Inside commands use paths supported by the selected Bash runtime and quote spaces.

[Explicit `execution: "session"`](session-shell.md) is available only with a qualified complete runtime and the required resident capabilities; `execution: "fresh"` remains the default. The qualified candidate inventory is recorded but awaits publication and pin adoption; the stock pin remains fresh-only; configuration cannot bypass qualification. When available, session mode accepts `command` only and serializes calls for the exact Agent/Session, retaining cwd, exported variables, functions and shell options. After initialization, omitted or blank `workdir` preserves the shell's cwd; explicit paths follow the documented host path rules. A session command's hard deadline resets its shell if execution has started, never implicitly hands off to Jobs; queued expiry does not stop an unrelated active command. Explicit fresh jobs do not inherit session shell state.

The host session sandbox and approval remain authoritative; switching shells cannot bypass denial. `description` is required. Check `kind` first: `foreground` includes `status`, possibly null `exitCode`, stdout/stderr and failure `code/effectState/retry`; `background` / `promoted` includes `jobId`, not completion. Fresh background parameters exist only with host jobs; use `job_output` to collect and `job_kill` to stop. Without jobs, the fresh foreground deadline stops the command. Output is bounded; truncation and spill paths do not mean completeness. A missing exit code is not success; inspect postconditions before repeating unknown effects. No PowerShell exit marker is fabricated.

Session caller cancellation preserves the public `ABORTED` result and cancelled tool card. After confirmed cleanup, `additionalContexts` carries the reset notice; a later call also reports prior state loss. Neither path replays the interrupted command. See the session guide for output, reset and cleanup fields.

Regression tests use real Cordis tools/systemPrompt registration, assembly and Bash subprocess execution, plus a pinned third-party bridge (source and MIT license in `test/fixtures/shell-slot-pwsh7/README.md`). This is not a guarantee for all future companion versions. No real Desktop/Web/profile is modified or deployed.
