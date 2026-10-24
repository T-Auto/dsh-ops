# Component reference
What each of the seven components publishes, with parameters and permission requirements.
---

## Components at a glance

| Row `name` | Description | Default | Published tools |
| --- | --- | --- | --- |
| `dsh-ops/shell` | Prefer bash as the terminal, with host PowerShell for operations bash cannot cover | On (all platforms) | `ops_bash`; host `pwsh` keeps its own executor |
| `dsh-ops/file` | Bounded Rust file retrieval and text output for the model | On | `ops_read_files`; advanced tools load through discovery |
| `dsh-ops/ptc` | Typed file APIs and progressive SDK in PTC sessions | On | `ops_inspect_local_file`, `ops_result`, `ops_load_sdk`; advanced APIs load through the SDK |
| `dsh-ops/discovery` | Advanced Native tools on demand | On | `ops_discover_tools` |
| `dsh-ops/panel` | Data capture, off at the switch: new conversations write `<cwd>/.dsh-ops/panel/<sessionId>.json` plus the viewer `panel.html` | Row off; capture defaults true | None; see the [configuration reference](configuration-reference.md) |
| `dsh-ops/tui` | Read-only current-session OPS sidebar | Off | None; see [sidebar guide](tui-panel.md) |
| `dsh-ops/hide-official` | Select read/glob/grep alternatives; unselected official tools remain visible | Off | None |

The former `dsh-ops/background` component (FastCtx background jobs: `ops_run`, `ops_run_background`, `ops_job_output`, `ops_job_list`, `ops_job_kill`) has been removed. A profile row that still names it loads as a no-op: it accepts any config, publishes nothing, and logs one warning that the row can be deleted.

---

## Tool summary

The shared catalogue has 20 entries. The generated PTC SDK contains 18 APIs: 15 file/document tools plus batch, result and load_sdk; bash and discover_tools belong to other entry points. Catalogue membership does not mean residency or permission. Fresh PTC pools follow the implemented catalogue; saved explicit pools remain authoritative. Document tools load on demand.

| Tool | Purpose | Full-access requirement |
| --- | --- | --- |
| `ops_read_files` | Resident bounded UTF-8 ranges from 1-32 files | No command permission gate¹ |
| `ops_inspect_local_file` | Bounded UTF-8 text lines and hex | No command permission gate¹ |
| `ops_grep` | Rust regex search, multiple file filters, counts/summaries | No command permission gate¹ |
| `ops_glob` | Multiple path patterns with exclusions | No command permission gate¹ |
| `ops_replace` | Mechanical cross-file literal replacement; use host edit for precise changes | No command permission gate¹ |
| `ops_write_file` / `ops_edit_file` | File writes and atomic edits within one file, retaining revision/CAS | Writes follow current authority¹ |
| `ops_diff` / `ops_stat` | Compare text and inspect metadata | No command permission gate¹ |
| `ops_copy` / `ops_move` / `ops_remove` | Fixed file operations | Writes follow current authority¹ |
| `ops_read_table` / `ops_read_docx` / `ops_read_pdf` | Bounded CSV/TSV, DOCX and restricted PDF readers; see below | No command permission gate¹ |
| `ops_bash` | Preferred general bash command executor; `command` for short commands, `script_path` for long scripts | Confined in restricted modes; matched Windows x64 private IPC runtime |
| `ops_batch` | Preflight and execute copy / move / remove with audit and recovery | See the PTC notes |
| `ops_result` | Bounded result references: put, page, release | See the PTC notes |
| `ops_load_sdk` | Load 1-5 named PTC APIs for the next model step; no file operation runs | PTC-only |
| Host `pwsh` | Windows-native operations using the host-selected PowerShell | Host policy |

¹ **Fixed file operations use a trusted-operation policy fence, matching DSH fs-sandbox, not arbitrary-code isolation.** OS-readable paths are readable in all modes subject to the credential fence and current scoped authority; read-only rejects replacement, including its dry run; workspace-write permits writes under the workspace and this session's private temporary directory, and full access adds no write fence. The fixed Rust worker uses host subprocess governance plus no-follow traversal, budgets and CAS. Bash/run_code still require OS confinement; no unconfined fallback exists. On Windows, owned workspaces automatically receive directory-only WRITE_OWNER for the host grant prerequisite, with DACL backups; no recursive ACL edits or ownership changes. That preparation runs the package's own script as the current user before sandbox confinement applies, only in workspace-write, with `-ExecutionPolicy Bypass` (Group Policy still wins).

---

## `dsh-ops/file` — file tools

Only the bounded multi-file reader `ops_read_files` is resident; `ops_inspect_local_file`, including hex reading, is discoverable. The advanced contracts below are activated through [tool discovery](discovery.md) or explicit always-loaded choices. Routing lists only the tools currently published.

File paths resolve relative to the DSH session cwd. `ops_read_files` takes a `files` array of paths with independent 1-based offsets and limits; single-file operations take `path`. The Native reference pager accepts the original reference `root`. No file tool accepts `workspace`, `cwd` or `file_path` aliases. Text tools are UTF-8 first; document tools use their own bounded format/encoding contracts. glob and grep do not traverse symlinks, junctions, reparse points, hidden files or `.git`.

When the host provides its `fs` service, `ops_inspect_local_file` reads and real `ops_replace` writes are recorded in the host's read-before-edit table (`fs/observed`) exactly like host `read`/`edit`: a file read with ops can be edited with host `edit` directly, and an ops write does not make the host's earlier read look like an external change. `ops_grep`, `ops_glob` and `dryRun` record nothing.

### `ops_inspect_local_file`

Read bounded UTF-8 text lines, or a hex view of one path. Directories are rejected — use `ops_glob` or `ops_grep` instead.

Native emits a file header, numbered escaped source lines and revision/continuation notices. PTC retains canonical typed records. Backslashes, controls and Unicode line separators are reversibly escaped; source text cannot forge extra rows. Worker byte limits and long-line continuation remain explicit. See [Native range rendering](native-ranges.md). Rendered bytes are not measured tokens.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | Resolved against the DSH session cwd |
| `offset` | integer ≥ 0 | 1-based line/hex row, default 1; legacy 0 also reads the first unit |
| `limit` | integer 1–10000 | Maximum lines returned |
| `encoding` | `utf-8` | Encoding |
| `view` | `text` \| `hex` | View mode |

### `ops_glob`

The discovered file-tool schemas include concise field-level help. `pattern` here is a JSON array of quoted strings, unlike the single regex string accepted by `ops_grep` or the literal strings accepted by `ops_replace`. Search defaults, output modes and preview flags are described on the corresponding fields; validation constraints are unchanged.

Find regular files below `path`. `pattern` is an **array** of globs matched segment by segment against paths relative to `path` (ASCII case-insensitive), e.g. `["**/*.md","!vendor/**"]`: `*.md` matches the top level only and `**/*.md` any depth; a `!` prefix excludes, and at least one positive entry is required. A bare string is rejected; there is no `include` field.

`outputMode: "details"` adds `bytes` (the on-disk size) and `modified`, a real modification time in **milliseconds since the Unix epoch** — the same quantity and unit `ops_stat` reports as `modifiedMs`, and `null` when the filesystem cannot report one. `sort: "modified"` orders newest first and is stable: equal timestamps keep the walk's path order. `sort: "path"` and an omitted `sort` both keep that walk order.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | Search root |
| `pattern` | string[] (required, ≥1) | Glob patterns |
| `outputMode` | `paths` \| `details` | Output shape |
| `sort` | `path` \| `modified` | Ordering |
| `offset` | integer | Paging start |
| `limit` | integer 1–10000 | Maximum entries |

### `ops_grep`

Search UTF-8 files below `path` with Rust regex, bounded output, paging and optional line context. `pattern` is **one** regex string; filter files with `glob`, an array in the same syntax as `ops_glob`. **There is no `include` field.** `glob` may contain only exclusions ("everything except"); when `path` is a single file, `glob` is ignored.

Use `summary` for aggregate file/match totals, `count` for per-file counts, `content` for matching text (default). Each item page defaults to 100 entries. Every call scans candidates to count global totals while materializing only the requested window, so later matches are not silently lost at the first page boundary. Follow `nextOffset` for remaining pages; `truncated`/`failed` scans are not exhaustive and must not be blindly retried. Non-UTF-8 and oversized files are excluded and counted in `skippedFiles`; read failures increment `failed` and prevent completion. Traversal/file-size bounds still apply, and repeated pages rescan rather than use a persistent cursor.

| Parameter | Type | Notes |
| --- | --- | --- |
| `pattern` | string (required) | Rust regex |
| `path` | string | Search root |
| `glob` | string[] | Restrict files |
| `outputMode` | `files_with_matches` \| `content` \| `count` \| `summary` | Output shape |
| `caseInsensitive` | boolean | Ignore case |
| `lineNumbers` | boolean | Show line numbers |
| `beforeContext` / `afterContext` | integer ≤ 32 | Context lines |
| `multiline` | boolean | Multi-line matching |
| `offset` / `limit` | integer ≥ 0 / integer 1–10000 | 0-based offset (default 0); limit default 100 |

### `ops_replace`

Perform a deterministic UTF-8 replacement under `path`. `pattern` is **literal text, not a regex**; `glob` works as in `ops_grep`. `dryRun` observes only; writes use revision checks and atomic replacement. Read-only sessions are rejected.

Each proposed file is limited to **32 MiB of UTF-8 bytes**, including in `dryRun`. The complete plan is checked with overflow-safe arithmetic before replacement content is constructed or any file is published. If any file would exceed the bound, the whole call returns `OUTPUT_LIMIT` with no file changes; narrow `path`/`glob` or reduce the replacement size. `maxReplacements` remains a separate match-count ceiling, not a truncation setting.

Cooperating writers serialise on a hidden update-lock sidecar beside each target (`.dsh-ops-update-<sha256 of the lowercased name>.lock`). It is created before the target is read and removed by the writer that holds it, so a refused call leaves nothing behind; see [Update-lock sidecars](native-ptc.md#update-lock-sidecars) for the binding rule that makes removal safe and for the one residue a killed writer can leave.

| Parameter | Type | Notes |
| --- | --- | --- |
| `pattern` | string (required) | Literal text |
| `replacement` | string (required) | Replacement text |
| `path` | string | Operation root |
| `glob` | string[] | Restrict files |
| `maxReplacements` | integer 1–100000 | Hard replacement limit |
| `dryRun` | boolean | Never writes |

### Document readers

`ops_read_table` reads CSV/TSV string cells (UTF-8 by default, with explicit UTF-16LE/BE support). `ops_read_docx` reads DOCX main-body paragraphs and table coordinates, not legacy binary DOC. Both default to offset 1 and limit 200 (maximum 1000), with a 32 MiB input bound. `ops_read_pdf` handles only PDF 1.3–1.7 classic xref and standard Type 1 font text, up to 16 MiB/32 pages; offset defaults to 1 and limit to 10 (maximum 32). It excludes OCR, embedded fonts and modern object/xref streams.

Each reader separates scan, page, display and reference-capture completeness. A later error may retain safe preceding complete records, but cannot produce a false full total or revision; an offset cannot bypass a physical scan gap. See [native kernel contracts](native-kernel.md) for all format bounds, encoding rules and recovery guidance.

### Results and errors

- **File tools, `ops_batch` and `ops_result` return failures as values.** PTC Outcomes use completed or partial data, or rejected/conflict/error/unknown with an error code, effect state and retry policy. Batch plan/run states remain in typed data. A try/catch alone misses returned failures; check status and coverage before data. Native projects the same facts into text.
- **`ops_bash`** returns host-compatible `foreground`, `background` or `promoted` values. Failures, including invalid arguments and unavailable executors, return values rather than throwing. A foreground failure retains the string `error` plus structured `failure` code, effect state and retry policy. Effects after launch can be unknown; do not replay automatically. Collect background output through host job tools.
- Host tools (`read` / `write` / `edit` / `pwsh` …) throw `ToolCallError` on failure.

---

## `dsh-ops/ptc` — native batches and result references

Available by default, with tools published only in pure PTC sessions. Explicit profile disablement is preserved.

### `ops_batch`

Preflight and verify copy / move / remove.

| Parameter | Type | Notes |
| --- | --- | --- |
| `action` | `plan` \| `run` \| `resume` (required) | Action |
| `root` | string | Defaults to session cwd; when supplied it must be an absolute path (a relative root is rejected at preflight with `INVALID_ARGUMENT`) |
| `operations` | array, ≤512 items | Each item: `op` (`copy`/`move`/`remove`) + `path` + `to` |
| `operationsRef` | string | Reference a stored operation list |
| `protect` | string[], ≤128 items | Protected paths |
| `id` | string | The existing plan for `resume` |

> `action=plan` requires `operations` and creates a no-effect audit plan; execute that exact plan with `action=resume` plus `id` (**do not change it to `run`**). `action=run` requires `operations` and executes immediately. Operations use relative `/` paths, with no overwrite or link traversal. Page a plan's `detailsRef` with `ops_result`, passing the same `root` when it differs from the session workspace root (otherwise the page returns `NOT_FOUND`).

### `ops_result`

Bounded session-owned result references: PTC can put object rows; Native file tools expose page/release only for ref:// handles. Page uses top-level equals/fields and quantity/byte budgets. New references default to session lifetime (ttlMs=0), optionally up to seven days; only legacy r- snapshots use 24h expiry. Job audits are read-only and remain PTC-only. References are observations, never authority. Native root defaults to current session cwd; PTC defaults to the workspace root. See [paging and capture completeness](result-budgets.md#native-and-ptc-reference-pages).

| Parameter | Type | Notes |
| --- | --- | --- |
| `action` | `put` \| `page` \| `release` (required) | Action |
| `items` | object array, ≤10000 items | PTC put; whole request ≤2 MiB, snapshot ≤10 MiB |
| `ttlMs` | integer 0–604800000 | PTC put; default 0 means session lifetime |
| `root` / `id` | string | Operation root and result id |
| `offset` | integer ≥ 0 | Paging start |
| `limit` | integer 1–512 | Rows per page |
| `maxBytes` | integer 512–65536 | Byte budget per page |
| `fields` | string[], ≤32 items | Projected fields |
| `equals` | object | Top-level filter |

---

## `dsh-ops/shell` — terminal and shells

Routing: **toolkit → bash → host PowerShell**.

On Windows x64 the install carries the pinned Bash payload as an optional dependency of the main package (`@dsh-ops/bash-win32-x64@0.2.1`, PortableGit `v2.56.0.windows.2`, GNU bash 5.3.15); `bashPath` can select Git Bash instead, and `dsh-ops bash-runtime install` repairs or installs a managed copy when the payload is absent. POSIX hosts use the system Bash and ship no payload. PowerShell stays host-selected.

- `ops_bash`: the preferred general command executor. Use `command` for short commands and `script_path` for long scripts.
  Cancellation also stops pending sandbox preparation; a late preparation result cannot start the command. When cancellation races a timeout, the first cause is reported.
  Relative `workdir` paths (including `.`) resolve against the calling session's workspace, not the host process directory. Omitting `workdir` or passing a blank string uses that workspace; absolute paths remain absolute. Missing or non-directory targets are rejected before execution, with the resolved path in the error.
  On Windows, `\child` uses the session's drive; a drive-relative path such as `C:child` on a different drive must be written as an absolute path. A POSIX-style absolute path names its drive as `/d/…` (bash's own spelling for `D:\…`) and is mapped onto the Windows form before validation; a `/`-rooted path with no usable drive letter (`/`, `/tmp/x`) is refused, because Windows would read it against the host process's current drive.
- Host `pwsh`: Windows-native operations, using the host-selected PowerShell.

`ops_bash` requires a non-empty `description` and keeps the host Bash fields and result kinds: `foreground`, `background`, or `promoted`. Its default timeout is 120 seconds and the cap is 600 seconds. When the host jobs service is available, `run_in_background: true` returns a job ID immediately; a foreground timeout promotes the same running job. Use the host `job_output` and `job_kill` tools to collect or stop it. Without host jobs, the background parameter is absent and a foreground timeout stops the command. Unknown arguments return a failed foreground value before execution. The compatible string `error` remains; `failure` adds stable code, effect state and retry guidance. Invalid arguments have no command effects and require input changes. An ordinary nonzero exit keeps `status: failed` and unknown effects, but reports `failure.code: EXIT_CODE` with `retry: after-input-change`: inspect the exit code and output, then correct the command or its inputs before retrying; prior effects may remain. Timeouts, cancellation, signal termination and execution failures retain their conservative retry guidance. If job admission fails after accepting its run hook, the queued starter is cancelled and no foreground retry occurs.

`sandbox_permissions` plus `justification` can request a strictly wider mode through the host approval service. An allowed-once grant applies to that command only; rejection never executes it or changes the session mode. Authority is checked again after approval and sandbox preparation. Windows confinement reports the host provider’s actual enforcement (including `partial`); incompatible Bash runtimes fail closed.

`ops_bash` supplies the host's terminal-card presentation: multiline command or script path, session-relative working directory, captured output, and recorded exit code or signal. Hosts supporting this public presentation contract can show a dedicated card without a tool-name-specific client registration; older UIs retain their generic fallback. This is captured-output presentation, not a live terminal connection. Background and promoted calls retain their job IDs; collect later output with host job tools.

`script_path` (instead of `command`), `graceMs`, and `includeDiagnostics` remain explicit OPS compatibility extensions. They do not change the host command contract or its timeout limits.

"Prefer bash as the terminal" means prompting the model to use `ops_bash` first; it **does not change the system default terminal, PATH or existing host shell tool names**. OPS never overlays the host PowerShell executor configuration. Use `dsh-ops upgrade-host-pwsh` to preview an explicit standard PowerShell 7 installation; `--yes` executes it. Restart DSH afterwards, and review any custom host `pwshPath` in host settings. Existing running commands and old provisioned copies are not removed.

The plugin renders routing guidance from what it actually published. The excerpt below is a synthesised example; in production the model sees the file and shell prompt sections separately, each rendered from its own published tools (including `ops_discover_tools`, `ops_read_files`, the document readers and the other file tools):

```
# Shell routing: bash → host PowerShell

| Task | Tool |
| --- | --- |
| Bounded UTF-8 text / hex | ops_inspect_local_file |
| Images | read_image (host) |
| Search contents | ops_grep |
| Find paths | ops_glob |
| Batch replacement; use host edit for precise edits | ops_replace |
| General commands / builds / git / pipelines / scripts — preferred command executor | ops_bash |
| Windows-native cmdlets / registry / services only | pwsh (host PowerShell) |
```

---

## `dsh-ops/hide-official` — per-tool replacements

Disabled by default, with `replaceTools: []`. Explicit selections switch the model to these reviewed read/search workflows. Their names, arguments and results differ from the host tools; calls are never translated or forwarded under an official name. A `run_code` presentation (PTC) is never masked: its transport is not gated, while the selected official tools stay refused in that scope. The replacement contract covers native presentation only.

<!-- hide-official-scope:start -->
| Official tool | OPS alternative | Reviewed purpose |
| --- | --- | --- |
| `read` | `ops_inspect_local_file` | Bounded local UTF-8 text reading; optional hex view |
| `glob` | `ops_glob` | Bounded regular-file path search |
| `grep` | `ops_grep` | Bounded UTF-8 content search |
<!-- hide-official-scope:end -->

- **read:** both use 1-based line offsets and bounded limits. OPS additionally offers hex viewing, returns revision and paging information, and uses its local-file permission and credential fences. This selection does not replace `read_image`, attachments, directories, or non-local filesystem providers.
- **glob:** the host accepts one pattern string and matches a bare basename at any depth, including hidden and ignored files. OPS accepts an array of globs relative to `path`; `*.ts` matches only the top level, so use `**/*.ts` for recursion. OPS supports exclusions and paging, and does not traverse symlinks, reparse points, hidden files or `.git`. The search coverage and ordering are not identical.
- **grep:** the host accepts a single glob filter and ripgrep regular expressions. OPS uses Rust regex, an array of relative globs, optional context and output modes, plus bounded paged coverage. Read its completion/truncation fields; a partial scan is not an exhaustive negative result. Host overflow artifacts and OPS paging are different workflows.

All OPS calls keep their own session-cwd base, permission checks and output contracts. Selecting an alternative does not broaden authority. Choose only the workflows that fit the task; leave a tool unselected when its host-specific coverage is needed.

`write`, `edit`, and `str_replace_editor` are deliberately unavailable as selections. OPS write/edit require an observed `expectedRevision` and CAS publication; host write and replace-all edit do not share that contract. A similarly named registration is not evidence of compatibility. Shells, `run_code`, delegation, jobs, media and third-party tools also remain visible without a warning list.

Only the selected OPS counterparts must be registered and visible as exact OPS-owned Native definitions. A foreign registration with the same name or identical schema cannot satisfy readiness. Ownership changes are checked even when the schema bytes stay unchanged; Native shadows created by the OPS PTC adapter retain their tracked ownership. PTC data APIs alone cannot replace a Native tool. An unavailable selected counterpart blocks the affected scope with `READINESS_BLOCKED` and lifts that scope's replacement masks; healthy scopes and inherited authority restrictions retain their masks. Removing a selection, unloading, or disabling the component restores the corresponding official tool. Old `strict`/`scope`/`additionalOfficialTools` values are validated but ignored until explicit `replaceTools` selections are supplied.

The resident `ops_read_files` is not the reviewed replacement for `read`. Before selecting `read`, configure discovery `alwaysLoaded: [inspect_local_file]` or ensure that single-file capability is already active in that Native scope. Apply the same readiness rule to `glob` and `grep`. Internal presentation inspection lets discovery publish these configured tools during startup; ordinary prompt assembly and dispatch remain blocked until they are ready.

The component exports StandardSchemaV1 validation together with public JSON schema descriptors for built-in host row forms. Optional browser multiselect pages require the explicit client carrier migration; see [configuration](configuration-reference.md).


---

## See also

- [Configuration reference](configuration-reference.md) — keys and owning components
- [Usage](usage.md) — install, update, remove, CLI
- [Troubleshooting](troubleshooting.md) — errors and diagnosis
- [Native PTC](native-ptc.md) — the PTC design and build
