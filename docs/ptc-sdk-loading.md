# Progressive PTC SDK loading

The PTC row owns its file APIs independently of the Native file row. A PTC-only agent normally starts with `ops_inspect_local_file`, `ops_result` and `ops_load_sdk`. The host generates the typed SDK from the registered argument and Outcome output schemas. Native and both presentations receive no SDK loader.

Call `tools.ops_load_sdk({ tools: ['grep', 'read_files'] })` inside `run_code`. A completed Outcome contains `data.tools` and `data.nextTurn: true`. Finish the current tool round; the owning session's committed `step/end` makes the requested APIs visible in the immediately following provider request. They are absent from the current frozen SDK snapshot. Prompt and diagnostic assembly before that boundary, and registry notifications, never activate queued names. Assembly waits for owned publication and obtains a fresh public snapshot when needed; internal presentation probes bypass that barrier to avoid recursion.

PTC and discovery probe independent root sessions separately. Related ancestors and descendants still publish together because their tool overlays depend on one another. If a host prompt hook never returns, that family cannot gain newly verified tools, but another root can create, assemble, change authority and dispose. Superseded probes receive cancellation; disposal and unload release OPS's wait even when the hook ignores its signal, and late responses cannot publish. This isolates the shared-queue failure class; it does not establish the cause or recovery of the multi-plugin Desktop freeze reported in [#359](https://github.com/T-Auto/dsh-ops/issues/359).

The PTC row accepts these settings through central config validation:

| Key | Default | Meaning |
| --- | --- | --- |
| `allowedTools` | All implemented advanced file APIs and batch | Exact raw names the loader may request. An empty list disables advanced selections; with resident publication disabled, only the `result` exception remains eligible. |
| `alwaysLoaded` | `[]` | Implemented advanced names published immediately in every PTC agent covered by this row; independent of the allowed pool. |
| `binaryPath` | Packaged worker | Optional absolute worker executable selection. |
| `required` | `false` | Fail component startup when the worker is unavailable. |

Advanced names are `grep, glob, replace, write_file, edit_file, diff, stat, copy, move, remove, read_files, read_table, read_docx, read_pdf, batch`. Requests accept 1–5 names atomically. Unknown keys, public-prefixed names, resident names and unimplemented APIs are rejected. The built-in PTC row form edits these validated arrays, plus required and binaryPath, and persists them through the host. Optional custom browser pages currently cover discovery, replacement and shell, not PTC. Fresh profiles derive all implemented advanced APIs; saved explicit allowedTools arrays remain authoritative. The full SDK has 18 APIs, including its three resident entries. See [configuration](configuration-reference.md) and [document limits](native-kernel.md).

Selections belong to the exact live agent and persist until its component or agent unloads. Siblings and descendants do not inherit another agent's loaded SDK. A sandbox mode change drops pending selections and cancels active calls; every worker call independently rechecks current authority. Disposal withdraws owned registrations and rejects retained callbacks. Switching to Native/both removes the PTC surface and restores only the file row's previously visible Native definitions. For overlapping configured PTC rows, the nearest row owns its descendant scopes; a later row wins within the same scope, and unload restores the earlier row. The shared registry is never patched.

Read Outcome status before data. A partial result retains coverage and a continuation; failures retain code, effect state and retry policy. The loader performs no file work and grants no filesystem permission. No token benchmark or IO speedup is claimed here.

## Live PTC directory

With resident publication disabled, the directory and loader use configured `allowedTools` plus `result` only. They no longer implicitly restore `inspect_local_file`, or `read_files` when it is absent from the allowed pool. The config parser still rejects resident-only names; ordinary resident-on baseline publication is unchanged.

The existing scoped OPS prompt section includes a compact task directory only when this row's actual `ops_load_sdk` is available. It derives exact raw names and task hints from the PTC capability metadata and the same allowed pool used by selection. Use resident/callable SDK APIs first; if they cover the task, do not load more. Otherwise inspect the hints, select 1–5 listed raw names, and wait for the next model step. There is no keyword-search SDK API: an absent match means only that this eligible pool has no matching hint, not that other tools exist.

Already callable APIs are omitted because the host's typed SDK describes them. Empty pools, disabled dynamic loading or guidance, unavailable workers/services, non-owning rows and Native/both presentation advertise no directory. Read-only authority omits mutations and batch; result remains eligible for its read-only page action when resident APIs are disabled. This conservative preflight is shared by the loader and rechecked before committing queued selections. It does not infer path/action permission, run a worker probe or call Native providers. Actual calls still enforce authority. A sandbox event drops pending selections; already loaded schemas can remain visible, but their invocation never bypasses current authority. Configuration reload, scope ownership change, presentation withdrawal, disposal and agent retirement refresh or remove the directory through the existing PTC lifecycle.

中文：[PTC SDK 按需加载](./PTC按需加载.md)。
