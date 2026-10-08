# dsh-ops

An additive DSH repository-tool bundle backed by [FastCtx](https://github.com/yc-duan/fastctx). It keeps the three-layer design: **repository tools → bash → PowerShell 7**, without duplicating image reading or precise editing. General command lines prefer bash; PowerShell is for necessary Windows-native operations only.

| | |
| --- | --- |
| Host target | DSH `0.2.0-rc.2` |
| Manifest | dsh-std Community v0.15 |
| Surface | Four file tools; preferred `ops_bash` executor plus five command/job tools in authorized sessions |
| License | `MIT AND Apache-2.0` |

## Tool surface

| Task | Tool / genuine increment |
| --- | --- |
| Multiple text ranges, source encoding, PDF text, hex | `ops_inspect_local_file`; prefer `files[]` (1–32 ranges) |
| Images | Host `read_image`; ops rejects image results instead of pretending to display them |
| Content search | `ops_grep`: one Rust regex, `glob[]` filters with `!` exclusions, count/summary, encoding fallback |
| Find paths | `ops_glob`: `pattern[]` with `!` exclusions; paths/details output |
| Cross-file mechanical replacement | `ops_replace`; use host `edit` for precise edits |
| General commands, builds, git/gh, pipelines and scripts | `ops_bash` — preferred command executor |
| Windows-native cmdlets, registry and services | Host pwsh, using provisioned PowerShell 7 when available |
| Bounded bash commands and owned background jobs | `ops_run`, `ops_run_background`, `ops_job_output`, `ops_job_list`, `ops_job_kill`; full access only |

`ops_bash` is the second layer, not a duplicate to remove: it runs the plugin-resolved bash through the host subprocess service. `publishBashTool` defaults to true. Shell provisioning remains; the Windows bundle patch points the **host's** pwsh executor at provisioned PowerShell 7 when available. File operations stay in the tool layer, general commands prefer bash, and pwsh is reserved for Windows-native necessities. Fix bash errors in bash; do not switch shells or mix syntax.

The plugin contributes just **one compact routing table**, plus two rules: do not construct shell commands for file operations; correct failed tool arguments rather than switching to a shell workaround. Authorized sessions also get the own-job rule. The old host-shell section and `mcp:fastctx` instructions are not published. Turning off `promptPolicy` disables this routing section.

## Permission authority

`enableShellTools` is a deployment opt-in, not permission. The five command/job tools are published together only when the host's `sandboxPolicy.resolve({ session })` returns exactly `danger-full-access`. `read-only`, `workspace-write`, absent authority, or absent session do not qualify. Environment variables and permission-preset labels are not used as authority.

`ops_bash` independently requires `publishBashTool`, a resolved bash, the host subprocess service and the same authoritative full-access session. It remains available when FastCtx is missing or `enableShellTools` is false. Its definitions are likewise plugin-owned agent fibers, reconciled on mode changes; execution rechecks authority and defaults workdir to the calling session workspace.

Command definitions live in a plugin-owned child fiber inheriting the agent's registration scope. `sandbox/mode` session events reconcile those definitions without reconnecting FastCtx. The plugin also checks the current authority immediately before each command/job call, protecting against stale handles. Permission downgrades prevent **new calls**, not already-started commands; background jobs are not automatically terminated by a mode change.

`danger-full-access` is the file-sandbox mode, not an assertion that every approval policy is disabled. Host approval guards still apply. This bridge does not implement per-command approval escalation.

The default `shellPolicy: advise` leaves host shell tools alone. Explicit `deny-host-shell` masks the configured inherited host names and rejects their calls even when no ops command capability exists. This can intentionally leave a session with **no command executor**; the denial does not advertise an unavailable ops replacement. Scope-local host tools may resist masking but remain denied at execution.

**This is not a filesystem sandbox.** The four FastCtx file tools run outside the host's confined file backend; in particular, `ops_replace` is not made workspace-confined by the shell permission gate. Do not treat this bundle as suitable for an untrusted confined deployment without a separate filesystem-enforcement design.

## Job isolation and bounded output

Only successful `ops_run_background` responses grant ownership of a job ID, keyed by **calling session and current connection**. List/footer output never grants ownership. Foreign `job_output` and `job_kill` calls are rejected before forwarding. `ops_job_list` privately scans bounded upstream pages and returns only owned entries with owned pagination/counts; no global totals or offsets are exposed. An incomplete scan says so explicitly.

Background footers are filtered at their server-decorated terminal position. Foreign jobs and unfilterable aggregate summaries disappear; no owned jobs means no footer. Existing continuation/status lines remain.

Reconnect or plugin unload clears job ownership. Durable FastCtx jobs may still exist, but this new connection cannot adopt them. A timed-out launch can also leave a job whose ID was never delivered. Operator cleanup is needed in those cases; do not claim the jobs were killed.

The schemas are presentation projections: shorter descriptions, only symmetric `context` advertised by grep, PDF text mode only. Other arguments are forwarded unchanged; legacy before/after context values remain accepted by FastCtx. Images returned under renamed paths are also explicitly rejected; `view: hex` remains available for raw-byte inspection.

The three read-only definitions declare `isConcurrencySafe: () => true`. Mutation and command definitions remain exclusive. `toolCallTimeoutMs` bounds RPC waiting. Host definition `timeoutMs` is deliberately **not** asserted: the current transport abandons waiting on cancellation but does not prove server work reached quiescence. `ops_run.timeout_ms` is the separate FastCtx process-tree timeout.

## Install, update, remove

```console
dsh plugin --profile desktop add <absolute checkout path or package spec>
dsh plugin --profile web add <absolute checkout path or package spec>
dsh --profile desktop --dump-config
```

Installation belongs to the target profile, not `npm i -g`. The host `plugin_manager` can likewise use `install_bundle` / `remove_bundle`. No downloads or dependency installs occur at plugin load.

Config changes can reapply through host HMR. Replacing already-loaded JavaScript requires a DSH restart; permission-mode changes do not. Restart after applying this source update before manually validating it.

```console
dsh plugin --profile desktop remove dsh-ops
node bin/dsh-ops.mjs uninstall             # report/dry run
node bin/dsh-ops.mjs uninstall --yes       # remove owned managed runtime/shell directory
```

Unload releases file registrations, per-agent command fibers, restrictions, listeners, the routing section, and the MCP process. Managed `<DSH_HOME>/dsh-ops/` files and upstream `~/.fastctx/` state are not deleted by bundle removal; purging FastCtx state requires explicit `--purge-fastctx`.

## Configuration

Validated in `lib/config.js`; unknown keys fail and are named.

```yaml
config:
  # binaryPath: 'C:\tools\fastctx.exe'
  serverName: fastctx       # legacy server identity; no MCP prompt section
  enableShellTools: true   # additionally requires session danger-full-access
  toolCallTimeoutMs: 300000
  required: false
  shellPolicy: advise      # advise | deny-host-shell
  deniedHostTools: [pwsh, bash, pwsh_persistent]
  promptPolicy: true
  # extraGuidance: 'Deployment-specific guidance'
  publishBashTool: true    # preferred bash layer, gated by session full access
  # bashPath: 'C:\Program Files\Git\bin\bash.exe'
  allowSystemShellFallback: true # allow resolved system bash if no bundled copy
```

`required` makes missing/unusable runtime resolution fail synchronously; connection failure also rejects activation. With `false`, the runtime can retry in the background (up to ten attempts with bounded backoff). A disconnected server withdraws tools immediately, avoiding phantom schema/prompt entries.

## Runtime utilities

FastCtx resolution order: `binaryPath`, `DSH_OPS_FASTCTX_BIN`, managed `<DSH_HOME>/dsh-ops/bin/`, vendored release build, `@dsh-ops/fastctx-<platform>-<arch>`, upstream `@fastctx/<platform>-<arch>`, then PATH. Explicit paths are authoritative and do not fall through on error.

```console
node bin/dsh-ops.mjs status        # diagnostic file-tool list; no session authorization
node bin/dsh-ops.mjs ladder        # legacy command: resolution and compact routing policy
node bin/dsh-ops.mjs build         # vendored Rust build; Rust >=1.88
node bin/dsh-ops.mjs provision     # managed runtime and SHA-256 receipt
node bin/dsh-ops.mjs provision-shells --bash
node bin/dsh-ops.mjs provision-shells --pwsh
```

Shell pin packages contain metadata, not upstream payloads. Explicit provisioning downloads official upstream assets, verifies pinned SHA-256, and unpacks under `<DSH_HOME>/dsh-ops/shells/`. It neither modifies PATH nor bypasses permission policy; the bash layer uses the resolved executable. See [PROVENANCE.md](PROVENANCE.md) for upstream identity and license records.

## Manual validation and measurement

No regression tests or CI were added for this slimming change; the existing test suite was not updated or run and retains obsolete ladder/publication expectations. It is not evidence of this version's acceptance. Follow [the manual checklist](docs/manual-validation.md).

```console
node scripts/measure-schemas.mjs docs/schema-current.json
```

This command only handshakes/lists schemas; it executes no tool. [Baseline](docs/schema-baseline.json) and [current measurement](docs/schema-current.json) use compact UTF-8 JSON `{name,description,parameters}`. Token estimates are `ceil(bytes/4)`, not tokenizer counts, observed API billing, or tool-use frequency. Four-tool and nine-tool subtotals distinguish sandboxed from full-access surfaces; `ops_bash` savings are not included in the nine-tool baseline.

## Registration boundary

All public names come from `lib/policy.js` `publicToolName()`. Definitions are registered through this plugin's contexts only. No shared `ToolRuntime` method is replaced and no `@deepseek-ai/*` value is imported by the host half. Vendor functionality is unchanged by this slimming pass.

## License

This distribution is licensed under **`MIT AND Apache-2.0`**: everything outside `vendor/fastctx/` is MIT; vendored FastCtx is Apache-2.0. See [NOTICE](NOTICE), `vendor/fastctx/LICENSE-APACHE`, and `vendor/fastctx/NOTICE`.

## Acknowledgments

FastCtx is the work of [yc-duan](https://github.com/yc-duan). This distribution depends on upstream's runtime, tool design, and output discipline. Its NOTICE requires the following text verbatim:

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

Vendor identity and deletion-only distribution changes are recorded in [vendor/fastctx/FORK.md](vendor/fastctx/FORK.md) and [vendor/fastctx/UPSTREAM.md](vendor/fastctx/UPSTREAM.md).
