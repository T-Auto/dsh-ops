# Component reference
What each of the four components publishes, with parameters and permission requirements.
---

## Components at a glance

| Row `name` | Description | Default | Published tools |
| --- | --- | --- | --- |
| `dsh-ops/shell` | Prefer bash as the terminal, with PowerShell 7 for operations bash cannot cover | On | `ops_bash`; host `pwsh` uses bundled PowerShell 7 |
| `dsh-ops/file` | Faster, higher-performance Rust file retrieval with more concise, token-efficient output | On | Four file tools |
| `dsh-ops/ptc` | Independent Rust safe batches and bounded result references, only in pure PTC sessions | Off | `ops_batch`, `ops_result` |
| `dsh-ops/tui` | Read-only current-session OPS sidebar | Off | None; see [sidebar guide](tui-panel.md) |

The former `dsh-ops/background` component (FastCtx background jobs: `ops_run`, `ops_run_background`, `ops_job_output`, `ops_job_list`, `ops_job_kill`) has been removed. A profile row that still names it loads as a no-op: it accepts any config, publishes nothing, and logs one warning that the row can be deleted.

---

## Tool summary

| Tool | Purpose | Full-access requirement |
| --- | --- | --- |
| `ops_inspect_local_file` | Bounded UTF-8 text lines and hex | No command permission gate¹ |
| `ops_grep` | Rust regex search, multiple file filters, counts/summaries | No command permission gate¹ |
| `ops_glob` | Multiple path patterns with exclusions | No command permission gate¹ |
| `ops_replace` | Mechanical cross-file literal replacement; use host edit for precise changes | No command permission gate¹ |
| `ops_bash` | Preferred general bash command executor; `command` for short commands, `script_path` for long scripts | Confined in restricted modes; matched Windows x64 private IPC runtime |
| `ops_batch` | Preflight and execute copy / move / remove with audit and recovery | See the PTC notes |
| `ops_result` | Bounded result references: put, page, release | See the PTC notes |
| Host `pwsh` | Windows-native operations using bundled PowerShell 7 | Host policy |

¹ **Fixed file operations use a trusted-operation policy fence, matching DSH fs-sandbox, not arbitrary-code isolation.** OS-readable paths are readable in all modes; read-only rejects replacement, including its dry run; workspace-write permits writes under the workspace and this session's private temporary directory, and full access adds no write fence. The fixed Rust worker uses host subprocess governance plus no-follow traversal, budgets and CAS. Bash/run_code still require OS confinement; no unconfined fallback exists. On Windows, owned workspaces automatically receive directory-only WRITE_OWNER for the host grant prerequisite, with DACL backups; no recursive ACL edits or ownership changes. That preparation runs the package's own script as the current user before sandbox confinement applies, only in workspace-write, with `-ExecutionPolicy Bypass` (Group Policy still wins).

---

## `dsh-ops/file` — file tools

All file tools resolve relative paths against the DSH session cwd, accept a single `path`, and expose no `root`, `workspace`, `cwd` or `file_path` alias. All are UTF-8 first with bounded output; glob and grep do not traverse symlinks, junctions, reparse points, hidden files or `.git`.

When the host provides its `fs` service, `ops_inspect_local_file` reads and real `ops_replace` writes are recorded in the host's read-before-edit table (`fs/observed`) exactly like host `read`/`edit`: a file read with ops can be edited with host `edit` directly, and an ops write does not make the host's earlier read look like an external change. `ops_grep`, `ops_glob` and `dryRun` record nothing.

### `ops_inspect_local_file`

Read bounded UTF-8 text lines, or a hex view of one path. Directories are rejected — use `ops_glob` or `ops_grep` instead.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | Resolved against the DSH session cwd |
| `offset` | integer ≥ 1 | First line |
| `limit` | integer 1–10000 | Maximum lines returned |
| `encoding` | `utf-8` | Encoding |
| `view` | `text` \| `hex` | View mode |

### `ops_glob`

Find regular files below `path`. `pattern` is an **array** of globs matched segment by segment against paths relative to `path` (ASCII case-insensitive), e.g. `["**/*.md","!vendor/**"]`: `*.md` matches the top level only and `**/*.md` any depth; a `!` prefix excludes, and at least one positive entry is required. A bare string is rejected; there is no `include` field.

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
| `offset` / `limit` | integer 1–10000 | Paging |

### `ops_replace`

Perform a deterministic UTF-8 replacement under `path`. `pattern` is **literal text, not a regex**; `glob` works as in `ops_grep`. `dryRun` observes only; writes use revision checks and atomic replacement. Read-only sessions are rejected.

| Parameter | Type | Notes |
| --- | --- | --- |
| `pattern` | string (required) | Literal text |
| `replacement` | string (required) | Replacement text |
| `path` | string | Operation root |
| `glob` | string[] | Restrict files |
| `maxReplacements` | integer 1–100000 | Hard replacement limit |
| `dryRun` | boolean | Never writes |

### Results and errors

- **File tools, `ops_batch` and `ops_result` never throw.** Failures resolve as values with `status` `"error"` or `"rejected"` (authorization refusal) plus `error.code` / `error.message` / `error.nextAction`; success is `"completed"` (`ops_batch` also reports `planned` and related states). In PTC, a `try/catch` alone misses these failures — check `status`.
- **`ops_bash`** resolves command results as values: `status` (`completed` only for exit code 0 with no error, permission refusal, signal or timeout; otherwise `failed`), `exitCode`, `stdout` / `stderr`, `error`, `permission`. It throws (a `ToolCallError` in PTC) only for **invalid arguments** or an **unavailable executor**.
- Host tools (`read` / `write` / `edit` / `pwsh` …) throw `ToolCallError` on failure.

---

## `dsh-ops/ptc` — native batches and result references

Loaded only in pure PTC sessions, off by default.

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

Bounded session-owned result references: put object rows, page with top-level `equals`/`fields` and quantity/byte budgets, release results. 24h expiry. Job audits are read-only. References are observations, never authority.

| Parameter | Type | Notes |
| --- | --- | --- |
| `action` | `put` \| `page` \| `release` (required) | Action |
| `items` | object array, ≤10000 items | Rows for `put` |
| `root` / `id` | string | Operation root and result id |
| `offset` | integer ≥ 0 | Paging start |
| `limit` | integer 1–512 | Rows per page |
| `maxBytes` | integer 512–65536 | Byte budget per page |
| `fields` | string[], ≤32 items | Projected fields |
| `equals` | object | Top-level filter |

---

## `dsh-ops/shell` — terminal and shells

Routing: **toolkit → bash → PowerShell 7**.

- `ops_bash`: the preferred general command executor. Use `command` for short commands and `script_path` for long scripts.
  Relative `workdir` paths (including `.`) resolve against the calling session's workspace, not the host process directory. Omitting `workdir` or passing a blank string uses that workspace; absolute paths remain absolute. Missing or non-directory targets are rejected before execution, with the resolved path in the error.
  On Windows, `\child` uses the session's drive; a drive-relative path such as `C:child` on a different drive must be written as an absolute path.
- Host `pwsh`: Windows-native operations, using bundled PowerShell 7.

"Prefer bash as the terminal" means prompting the model to use `ops_bash` first; it **does not change the system default terminal, PATH or existing host shell tool names**. When the shell component is on, the official configuration lifecycle temporarily sets the PowerShell 7 path for `pwsh-sandbox`; when off, it restores the executor's latest original configuration without writing profile configuration. Switching executor configuration does not cancel already-running host commands.

The routing table the model sees is rendered by the plugin from what it actually published:

```
# Shell routing: bash → PowerShell 7

| Task | Tool |
| --- | --- |
| Text / multiple ranges / encoding / PDF text / hex | ops_inspect_local_file |
| Images | read_image (host) |
| Search contents | ops_grep |
| Find paths | ops_glob |
| Batch replacement; use host edit for precise edits | ops_replace |
| General commands / builds / git / pipelines / scripts — preferred command executor | ops_bash |
| Windows-native cmdlets / registry / services only | pwsh (bundled PowerShell 7 via host) |
```

---

## See also

- [Configuration reference](configuration-reference.md) — keys and owning components
- [Usage](usage.md) — install, update, remove, CLI
- [Troubleshooting](troubleshooting.md) — errors and diagnosis
- [Native PTC](native-ptc.md) — the PTC design and build
