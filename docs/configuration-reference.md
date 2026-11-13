# Configuration reference

English | [中文](配置参考.md)

OPS ships **one `dsh-ops` row**, following the single-row plugin-page model. Built-in and explicitly
configured custom presets share one consumer assembler. Installation does not opt unknown presets in.
Plugin authors can also mount the [public integration API](integration-api.md) independently.

## Single-row switches

| Section | Defaults and behavior |
| --- | --- |
| `global` | `bash`, `hidePwsh`, `hideOfficialTools`, `dynamicTools` all true; each gates the corresponding row-managed consumer choice. The same section also carries `forceDefaultOpsPtc`, see the next row |
| `global.forceDefaultOpsPtc` | true by default; while the `ops-ptc` preset is registered, forces the default preset to `ops-ptc` at runtime by writing `selectedDefault` through the host settings service (the settings-page mechanism, overriding a manual choice). Turning it off, disabling or unloading the row restores the captured pre-force default, or the host `config.default` (the official default) when nothing was captured or the captured value is `ops-ptc`; forcing only happens after successful registration; a failed registration never forces, best-effort restores a leftover `ops-ptc` default and only warns |
| `minimal` | Enabled; no resident file surface; optional Bash and dynamic selection |
| `standard`, `cordis` | Enabled; resident Native inspect/glob/grep profile, optional Bash, replacement and discovery |
| `ptc` | Enabled; typed resident APIs and progressive SDK loading under actual host PTC presentation |
| `ops-ptc` | Enabled; the fifth enhanced built-in mode, same surface as PTC, preset registered at plugin runtime, plus batch-call context guidance (`batchingGuidance`, default true for `ops-ptc` in both code and the packaged section; explicit false disables it) |
| `presets` | Empty by default; map of exact preset ids to explicit consumer options |
| `discovery` | Enabled; default built-in Native pool, maxResults 3, no always-loaded selections |
| `panel`, `tui` | Disabled by default; opt-in capture and read-only sidebar |
| `resultCache` | Enabled; sweeps idle result-cache roots at start-up and after the last owner unloads. `maxRoots`/`maxTotalBytes` default 0 (report only), `maxAgeMs` defaults to 3600000 (idle grace), `sweepEnabled` defaults true |
| `other.pwsh7Link` | When absent follows companion detection; saved boolean wins |
| `disk` | Read-only ownership report; `status.includeRepository` false and `status.maxEntries` 5000 by default; the `retention` block is a validated contract only (no eviction in this release) |

`disk.status.*` and the reserved `disk.retention.*` keys are YAML-only. See [Disk and cache](disk-and-cache.md) for
the resource inventory, the read-only `dsh-ops disk status` report and what it deliberately never scans.

The page uses native Switch controls. Built-in cards start collapsed. Disabling a card greys its
switches without erasing saved values. Standard/PTC/OPS PTC/Cordis have `residentTools` (default true),
independent of dynamic loading. Minimal retains its intentionally non-resident default; an explicit
consumer for `minimal` can select a different profile. Bash has an independent publication switch.
File replacement and Windows host-PowerShell hiding are independent.

Bundle switches apply an AND gate and preserve each consumer's saved intent. Companion linkage
forces every row-managed `hidePwsh` off, keeping the host shell available to `dsh-win-pwsh7`.
An unsaved linkage means untouched: saving another switch never turns detection into a stored
value, while flipping the link itself is always written (on or off). Detection reads the profile
that installed this package, so it also answers in the host process, where no `DSH_PROFILE_DIR` is
set.
These are publication choices, not filesystem permissions. No switch bypasses host authorization.

**Force the default agent preset to OPS (PTC)** (`global.forceDefaultOpsPtc`) only decides which preset new
sessions use; it changes no tool publication surface or permission. It writes the same `selectedDefault` field
as the Agent presets settings page: while on, it forces `ops-ptc` after a successful preset registration (so a
manual choice is overridden); while off, it restores the value captured before forcing, or the official
`config.default` when none was captured. The write persists through the host settings layer into the profile's `cordis.patch.yml` (an `agent-preset-registry` override that also writes the `default` field) and survives a restart; a remount caused by saving another switch re-registers the preset and re-confirms the default. A missing host settings service or a failed write only logs a warning.

Saves use exact nested paths and the revision read by the page. Unchanged fields are not written;
conflicts retain the draft. Reset reloads current saved values. The runtime status section shows
actual host platform, managed/Git Bash, PowerShell and companion facts. Installation/removal needs
a preview and explicit execution; configuration saves do not deploy binaries or alter PATH.

## OPS PTC mode (`ops-ptc`)

`ops-ptc` is the fifth enhanced built-in mode (both the preset id and the single-row section are named
`ops-ptc`). Its publication surface matches the official PTC preset: under real host PTC presentation only
`run_code` is visible and this plugin publishes the same-stack typed SDK file tools. Compaction stays the
official `compaction-basic`; `dsh-compress-codex` is not introduced. It accepts the same keys as the `ptc`
section; the only behavioral difference is `batchingGuidance`. The plugin registers this preset at apply
time through the host `agentPresets.register`, using the shipped `presets/ops-ptc.patch.yml` fragment parsed by
the host's `loadOverlayPatches`; there is no matching preset row in the plugin manager, and disabling the
`dsh-ops` row removes the preset with it. In the host picker it is named `OPS (PTC)` and described as
"代码驱动的 PTC 工具面，由 dsh-ops 的 ops_* 工具扩展。"; whether it is the default is controlled by
`global.forceDefaultOpsPtc` (on by default). Generation and the forced/manual default paths are covered in
[Presets and the default mode](presets.md).

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | true | Publish this surface for sessions of the `ops-ptc` preset; page switch, also settable in YAML |
| `residentTools` | true | Publish the startup APIs. The PTC resident surface is only `ops_inspect_local_file`; everything else loads on demand through `ops_load_sdk` |
| `bash` | true | Allow publishing `ops_bash` on Windows; POSIX sessions keep the host bash |
| `hidePwsh` | true | Hide the official Windows shell while Bash is available; disabled entirely when `global.hidePwsh` is false |
| `hideOfficialTools` | true | Hide the official file tools this mode replaces; disabled entirely when `global.hideOfficialTools` is false |
| `dynamicTools` | true | Publish the progressive SDK loader `ops_load_sdk`; effective only while `global.dynamicTools` is also on (AND gate) |
| `batchingGuidance` | true for `ops-ptc`, false otherwise | Teach once at session start (logged history, system prompt untouched), then correct the shape of root `run_code` programs: `bypass`, `plan` and `shape` each latch once per turn and re-arm when the program complies; the notice rides the triggering result as `additionalContexts` and never blocks or rewrites the program. Text lives in the editable `prompts/batching-guidance.md`. YAML-only; an omitted `ops-ptc` section in a legacy whole-row profile override retains true; explicit false disables it |
| `spillRetentionDays` | 30 | Host subprocess spill retention window; `0` reports only and never deletes |
| `spillTotalBudgetMiB` | 256 | Total retained spill budget in MiB; `0` disables the budget |
| `spillSweepEnabled` | true | Run one bounded sweep on activation and every 256 settlements |

The remaining keys (`binaryPath`, `required`, `denyCredentialReads`, `promptPolicy`, `extraGuidance`,
`allowSystemShellFallback`, `allowedTools`, `alwaysLoaded`) keep the PTC meaning (`extraGuidance` only feeds
Native guidance; `allowedTools`/`alwaysLoaded` accept loadable raw API names only, see
[Progressive PTC SDK loading](ptc-sdk-loading.md)). The three `spill*` keys bound host subprocess spill
retention, described under built-in advanced configuration below.

### Batch-call guidance (`batchingGuidance`)

Off contributes no extra context. The code default is on for `ops-ptc` only, even when a legacy profile replaces the whole row config without that section; explicit `batchingGuidance: false` still disables it. On, the guidance is delivered in two places, from an
external English Markdown file:

- **Once at session start**: one plugin-context message joins the session's first accepted non-empty
  user-message batch (step-tail, source `dsh-ops:step-tail` / `batching-guidance`). It enters logged history,
  so the model's first request already sees the whole procedure: the first-line `// plan:` comment, the
  dependency split, the load-before-call step and four copyable trajectories.
- **On a thin program**: when a **root** `run_code` program breaks one of three latched categories, a short
  notice is appended to that call's own result as `additionalContexts`. The tool result keeps its value, its
  content and its existing contexts; the program is never blocked or rewritten.
- The three categories are `bypass` (file work through the shell or `node:fs`), `plan` (no `// plan:` on the
  first physical line) and `shape` (a single operation in its own round trip). Each is latched once per turn,
  and a program that complies with a category re-arms it, so a regression inside the same turn speaks again;
  there is no per-turn cap.
- Delivery priority is `bypass`, then `plan`, then `shape`: one program earns at most one notice.
- Only the root call is inspected (`exec.parent === undefined`). Nested `tools.ops_*` calls belong to the PTC
  execution and say nothing about the shape of the step.
- The analysis is a literal heuristic over the program text: a loop or `map` counts one dispatch site, not its
  runtime fan-out, and strings or comments can mislead it. Notices say so, nothing claims a measured dispatch
  count, and a cancelled or never-dispatched call is not analysed.
- Everything is plugin-context history and the tool schema is untouched, so the system prompt and its cache
  survive. The lesson counts as spent only once it appears as a durable `user/message`; a batch withdrawn
  before admission (cancellation, rejection) leaves the next accepted batch free to teach it again.

`batchingTelemetry` (same row, YAML-only, default `false`) emits one structured log line per delivered
notice, for example `dsh-ops batching: turn=3 category=plan plan=1 bypass=0 shape=2 total=3`. It is
observation only: no context, no message, no extra dependency.

The text file is `prompts/batching-guidance.md` (shipped with the package, English, editable). It is read
once per path and cached in the process, so restart to apply edits; an unreadable file logs one warning and
skips delivery, an empty file also skips, and a failed delivery only logs a warning without rewriting the
tool result.

**Contrast-arm usage.** To compare the guidance on one shared PTC surface, keep `ptc` and `ops-ptc` on the same
API configuration and set `batchingGuidance: true` only on the `ops-ptc` section (the packaged default), or
set it on the `ptc` section as well to verify the guidance itself; set the `ops-ptc` section to false to return
to the no-guidance baseline. Both keys are YAML-only: the plugin page has no switch, and a saved `dsh-ops` row
override replaces the packaged config as a whole, so add them explicitly after upgrading (see
[Presets and the default mode](presets.md#risks-and-rollback)).

## Explicit custom consumers

```yaml
presets:
  acme-chat:
    enabled: true
    files: true
    residentTools: true
    residentNames: [read_files, stat]
    shell: false
    hidePwsh: false
    discovery: true
    allowedTools: [diff, grep]
    alwaysLoaded: [diff]
    replaceOfficial: false
    promptPolicy: true
    extraGuidance: Use bounded repository inspection.
    externalTools: [acme_lookup]
    externalAlwaysLoaded: []
    externalDisabled: []
```

The map key is the exact preset id; do not repeat `preset` inside it. Custom records appear on the
same native-switch page, with enabled/files/resident/Shell/hiding/discovery/guidance switches. The
host descriptor also accepts the detailed validated options; name lists and executor paths can be
saved in YAML. Dot-containing ids are single path segments, not interpreted as nested objects.
Unlisted presets remain unchanged. An explicit binding for a built-in id overrides its default
consumer in either mount order. `enabled: false` keeps that explicit override disabled instead of
falling back to the built-in surface; scoped diagnostics remain accessible.

| Option | Default / meaning |
| --- | --- |
| `profile` | `native`; shortcuts are `native`, `ptc`, `discovery`, `shell` |
| `files` | true for native/PTC, false for discovery/shell; controls resident built-in file surface |
| `residentTools` | true; false removes baseline residency, not explicit discovery selections |
| `residentNames` | Native raw names: `inspect_local_file`, `glob`, `grep`; exact list may be empty. `read_files`/`result` use discovery by default |
| `shell` | false except shell profile; authorized resident Bash, never a discovery choice |
| `hidePwsh` | defaults to `replaceOfficial && shell`; independent Windows shell hiding |
| `presentation` | native except PTC profile; selects projection, never changes host presentation |
| `discovery` | true except shell profile; false removes the selector/SDK loader, not explicit startup selections |
| `allowedTools` | all supported loadable tools when discovery is enabled, otherwise empty |
| `alwaysLoaded` | empty; must be allowed; separate from the Native residentNames profile |
| `replaceOfficial` | false; replaces only ready, admitted file counterparts; conditional official tools may remain visible |
| `promptPolicy` | true; guidance names only actually published tools |
| `extraGuidance` | empty; Native-only guidance, rejected in PTC |
| `externalTools` / `externalAlwaysLoaded` / `externalDisabled` | empty; explicit external allow/startup/deny lists, disabled wins |
| `binaryPath` / `bashPath` | managed worker/Shell resolution unless explicitly selected |
| `required` | false; missing required worker fails activation |
| `denyCredentialReads` | true; Native-only override, PTC rejects overrides and retains its boundary |
| `downloadGuard.template` | empty; inert until set. A suggested command with standalone unquoted `{url}` (required) and optional `{file}` arguments; never executed automatically |
| `downloadGuard.shell` | `bash` by default; `pwsh` quotes suggested arguments for PowerShell. See [download guard](download-guard.md) for the opt-in row section and detection limits |
| `allowSystemShellFallback` | false; retained for compatibility, never enables implicit Windows Bash fallback; use explicit `bashPath` |

In 0.5, enabling official-tool replacement does not guarantee that a conditional official tool disappears from the model's tool table. When the OPS counterpart has conditional admission, OPS keeps the official registration visible and guards its dispatch only when the same captured step toolSet admits the counterpart and the consumer still has current authority. An absent, revoked or not-yet-ready counterpart cannot disable the official tool as well. Safe unconditional resident replacements may still use host restrictions. OPS never wraps official definitions or hides tools from inside admission conditions or prompt assembly.

`shell: false` retains explicit `bashPath`, `allowSystemShellFallback` and `hidePwsh` intent,
but does not publish Bash or hide the host shell. Re-enabling Shell applies those saved choices.
The custom PTC card locks `files` on and explains that `residentTools` controls startup APIs.
PTC requires `files: true`, actual run_code-only host
presentation and the host PTC runtime. PTC does not accept `residentNames` or external Native
providers as typed SDKs. [Third-party PTC provider registration is not supported](external-provider.md).

Standalone `integration({ preset, ...options })` uses the same options and assembler but belongs
to its own mounting plugin; unrelated bundle global switches do not control it. Avoid duplicate
bindings for the same id/scope. See [scope/lifetime restrictions](integration-api.md#lifecycle-and-ownership).

## Built-in advanced configuration

Built-in sections retain validated worker/Shell settings (`binaryPath`, `required`, `bashPath`,
`denyCredentialReads`, `promptPolicy`, `extraGuidance`, `allowSystemShellFallback`) and the
`publishBashTool` alias for `bash`. `ptc.allowedTools` / `ptc.alwaysLoaded` control typed SDK APIs;
`discovery.allowedTools` / `discovery.alwaysLoaded` configure the built-in Native pool. Use
`presets.<id>` for an exact fully customized profile rather than adding preset-name exceptions.
`resultCache` is a YAML section: the default sweep only reclaims roots with no snapshot data left
(empty roots, or scope directories holding just the lock). The aggregate root/byte budgets default
to 0 and mark over-budget roots as blocked in the report; the sweep never deletes a root that still
holds snapshot data. `dsh-ops result-cache status|reclaim [--apply]` reports and runs the same
bounded pass.

Host subprocess spill retention is bounded by three more built-in keys. `spillRetentionDays`
(default 30; `0` reports only and never deletes) is the window applied to the mtime of a spilled
file. `spillTotalBudgetMiB` (default 256; `0` disables the budget) caps the total retained bytes,
evicting the oldest first. `spillSweepEnabled` (default true) controls the automatic pass on
component activation and every 256 settlements. Only paths recorded at a settlement in
`<DSH_HOME>/ops-spill-ledger.jsonl` are eligible, at most 64 files are removed per pass, and the
host's `dsh-subprocess-*` directories are never removed. Inspect and sweep from the CLI with
`dsh-ops bash-runtime spill-report` (see [usage](usage.md)).

The bundle's `discovery.enabled` controls built-in **Native** dynamic entry publication, not the
PTC SDK loader. PTC loading follows `ptc.dynamicTools` and `global.dynamicTools`. The Native keys
are `maxResults` (1–5, default 3), `allowedTools`, `alwaysLoaded`, `binaryPath`, `required` and
`denyCredentialReads`; alwaysLoaded must be allowed. Per-preset dynamic switches and the global
switch must also be enabled for the selector. Native and PTC selectors do not execute actions;
activation takes effect on the next model step.

## Credential and execution boundaries

The credential fence protects every direction: a denied path cannot be used as a read source or
as a write, copy/move destination or removal target. The historical name `denyCredentialReads`
therefore covers more than reads. It defaults on even in danger-full-access. Refusals
report `CREDENTIAL_DENIED`, no effect and no retry, and do not disclose denied paths or parents.
`DSH_OPS_DENY_READ` can widen the fence; disabling the Native override is an explicit operator
choice for that consumer, not an authorization grant.

Windows Niubash bytes are hashed against the frozen manifest only by the package build and
`provision-shells --bash`. Selection checks that the pinned files are present with their pinned
sizes and reads no contents. The first Bash call in a process prepares one copied runtime at
`<DSH_HOME>/dsh-ops/shells/niubash-prepared/<manifest hash>`, including command faces and six
startup directories. Source files are never hardlinked into it. Later calls reuse that runtime without
per-call cloning, hashing, seals or execution receipts, while every call follows the current host policy (`confine` in restricted modes).
`DSH_HOME` must place the prepared runtime outside the session workspace; each call enforces this.
`DSH_OPS_EXEC_ROOT` and `NIUBASH_VERIFY=deep` are deprecated and ignored by runtime execution.
Only offline legacy execution-tree reclamation still reads `DSH_OPS_EXEC_ROOT` to discover old roots.
A prepared version missing a pinned file or with a wrong size is moved aside and rebuilt once from
the selected payload; failed repair reports both causes instead of looping. After the first successful preparation in a process, other prepared
versions and broken/retired leftovers, plus staging leftovers of the selected hash only are renamed to `.retired-<uuid>`
siblings before best-effort deletion. Only exact prepared-version names and real directories are
touched; a refused rename is not retried until the next host start. `cache status/reclaim --kind
exec-tree` also lists/reclaims these non-current prepared directories (including other hashes'
staging leftovers), never the current hash. If another profile with a different Niubash pin retires
the selected version, its next call prepares that pin once from its selected verified source,
without retiring other versions.

Custom MSYS Bash in Windows restricted modes requires the pinned build and verified private IPC proxies. Unsupported
custom Bash returns `EXECUTOR_UNAVAILABLE`; never bypass confinement or change shells as a repair.
POSIX Bash uses the host executable and host sandbox. Worker and Shell explicit selections never
silently substitute a different executable. PowerShell installation is a separate host action;
OPS does not bundle or override the host PowerShell executable.

## Capture and sidebar

`panel.enabled` starts/stops capture. `capture` defaults true inside an enabled panel; explicit
legacy false remains off. `textLimit` is 64–100000 (default 2000), `maxSessionBytes` is
65536–268435456 (default 8388608). Capture writes only to the session workspace's `.dsh-ops/panel/`,
never the real DSH home. Reports can contain conversation/tool text; ignore that directory in Git.
Stopping cancels queued I/O and waits for issued work, retaining recoverable NDJSON rather than
starting a final fold. `tui` accepts `maxSessions`, `maxActive`, `recentLimit` only; it grants no tool
execution. See [sidebar limits](tui-panel.md#limits).

## Migration

The bundle no longer inserts separate `mode-*`, `discovery`, `compat`, `panel`, `tui`, `shell`,
`file`, `ptc`, `hide-official` or `background` rows. Delete saved overrides after migrating their
values to the single row; OPS never rewrites the profile automatically. Retained legacy component
modules warn and stay inert under the merged bundle. `dsh-ops/compat` was removed with the old
compatibility switch; use `hideOfficialTools: false` / `replaceOfficial: false` and `hidePwsh: false`.

Old FastCtx keys remain type-checked for saved configuration migration only; they do not enable an
old executor. `configUpdateVersion` is a migration marker, not a capability switch. `shellPolicy`,
`deniedHostTools`, `replaceTools` and related old hiding keys do not belong to current consumers.

## See also

- [Integration API](integration-api.md), [external providers](external-provider.md), [diagnostics](diagnostics.md)
- [Internal architecture](internal-architecture.md), [usage](usage.md), [troubleshooting](troubleshooting.md)
- [Presets and the default mode](presets.md), [dynamic tool directory](dynamic-tool-directory.md)
