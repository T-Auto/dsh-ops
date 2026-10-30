# Configuration reference

English | [中文](配置参考.md)

OPS ships **one `dsh-ops` row**, following the single-row plugin-page model. Built-in and explicitly
configured custom presets share one consumer assembler. Installation does not opt unknown presets in.
Plugin authors can also mount the [public integration API](integration-api.md) independently.

## Single-row switches

| Section | Defaults and behavior |
| --- | --- |
| `global` | `bash`, `hidePwsh`, `hideOfficialTools`, `dynamicTools` all true; each gates the corresponding row-managed consumer choice |
| `minimal` | Enabled; no resident file surface; optional Bash and dynamic selection |
| `standard`, `cordis` | Enabled; resident Native reader/search/pager profile, optional Bash, replacement and discovery |
| `ptc` | Enabled; typed resident APIs and progressive SDK loading under actual host PTC presentation |
| `presets` | Empty by default; map of exact preset ids to explicit consumer options |
| `discovery` | Enabled; default built-in Native pool, maxResults 3, no always-loaded selections |
| `panel`, `tui` | Disabled by default; opt-in capture and read-only sidebar |
| `other.pwsh7Link` | When absent follows companion detection; saved boolean wins |

The page uses native Switch controls. Built-in cards start collapsed. Disabling a card greys its
switches without erasing saved values. Standard/PTC/Cordis have `residentTools` (default true),
independent of dynamic loading. Minimal retains its intentionally non-resident default; an explicit
consumer for `minimal` can select a different profile. Bash has an independent publication switch.
File replacement and Windows host-PowerShell hiding are independent.

Bundle switches apply an AND gate and preserve each consumer's saved intent. Companion linkage
forces every row-managed `hidePwsh` off, keeping the host shell available to `dsh-win-pwsh7`.
These are publication choices, not filesystem permissions. No switch bypasses host authorization.

Saves use exact nested paths and the revision read by the page. Unchanged fields are not written;
conflicts retain the draft. Reset reloads current saved values. The runtime status section shows
actual host platform, managed/Git Bash, PowerShell and companion facts. Installation/removal needs
a preview and explicit execution; configuration saves do not deploy binaries or alter PATH.

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
| `residentNames` | Native raw names: `inspect_local_file`, `glob`, `grep`, `read_files`, `result`; exact list may be empty |
| `shell` | false except shell profile; authorized resident Bash, never a discovery choice |
| `hidePwsh` | defaults to `replaceOfficial && shell`; independent Windows shell hiding |
| `presentation` | native except PTC profile; selects projection, never changes host presentation |
| `discovery` | true except shell profile; false removes the selector/SDK loader, not explicit startup selections |
| `allowedTools` | all supported loadable tools when discovery is enabled, otherwise empty |
| `alwaysLoaded` | empty; must be allowed; separate from the Native residentNames profile |
| `replaceOfficial` | false; hides ready reviewed file counterparts only; does not hide arbitrary tools |
| `promptPolicy` | true; guidance names only actually published tools |
| `extraGuidance` | empty; Native-only guidance, rejected in PTC |
| `externalTools` / `externalAlwaysLoaded` / `externalDisabled` | empty; explicit external allow/startup/deny lists, disabled wins |
| `binaryPath` / `bashPath` | managed worker/Shell resolution unless explicitly selected |
| `required` | false; missing required worker fails activation |
| `denyCredentialReads` | true; Native-only override, PTC rejects overrides and retains its boundary |
| `downloadGuard.template` | empty; inert until set. A command with `{url}` (required) and optional `{file}` that a disk-writing shell download is redirected to |
| `allowSystemShellFallback` | false; Windows automatic fallback is opt-in |

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

On Windows restricted Bash requires the pinned MSYS and verified private IPC proxies. Unsupported
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
