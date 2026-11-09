# Progressive PTC SDK loading

The PTC row owns its file APIs independently of the Native file row. A PTC-only agent normally starts with `ops_inspect_local_file` and `ops_load_sdk`. Load `result` on demand with `tools.ops_load_sdk({ tools: ['result'] })` before paging or releasing a returned reference; it remains selectable even with `allowedTools: []`. The host generates the typed SDK from the registered argument and Outcome output schemas. Native presentations receive no SDK loader.

Call `tools.ops_load_sdk({ tools: ['grep', 'read_files'] })` inside `run_code`. A completed Outcome contains `data.tools` and `data.nextTurn: true`. Finish the current tool round; the owning session's committed `step/end` makes the requested APIs visible in the immediately following provider request. They are absent from the current frozen SDK snapshot. Prompt and diagnostic assembly before that boundary, and registry notifications, never activate queued names. Assembly waits for owned publication and obtains a fresh public snapshot when needed; internal presentation probes bypass that barrier to avoid recursion.

PTC and discovery probe independent root sessions separately. Related ancestors and descendants still publish together because their tool overlays depend on one another. If a host prompt hook never returns, that family cannot gain newly verified tools, but another root can create, assemble, change authority and dispose. Superseded probes receive cancellation; disposal and unload release OPS's wait even when the hook ignores its signal, and late responses cannot publish. This isolates the shared-queue failure class; it does not establish the cause or recovery of the multi-plugin Desktop freeze reported in [#359](https://github.com/T-Auto/dsh-ops/issues/359).

The PTC row accepts these settings through central config validation:

| Key | Default | Meaning |
| --- | --- | --- |
| `allowedTools` | All implemented advanced file APIs and batch | Exact raw names the loader may request. An empty list disables configured advanced selections; `result` remains an implicit selection exception regardless of resident publication. |
| `alwaysLoaded` | `[]` | Implemented advanced names published immediately in every PTC agent covered by this row; independent of the allowed pool. |
| `binaryPath` | Packaged worker | Optional absolute worker executable selection. |
| `required` | `false` | Fail component startup when the worker is unavailable. |

Advanced names are `grep, glob, replace, write_file, edit_file, diff, stat, copy, move, remove, read_files, read_table, read_docx, read_pdf, batch, result`. Requests accept 1–5 names atomically. Unknown keys, public-prefixed names, resident names and unimplemented APIs are rejected. The built-in PTC row form edits these validated arrays, plus required and binaryPath, and persists them through the host. Optional custom browser pages currently cover discovery, replacement and shell, not PTC. Fresh profiles derive all implemented advanced APIs; saved explicit allowedTools arrays remain authoritative. The full SDK has 18 APIs, including its two initial entries and on-demand `result`. See [configuration](configuration-reference.md) and [document limits](native-kernel.md).

Selections belong to the exact live agent and persist until its component or agent unloads. Siblings and descendants do not inherit another agent's loaded SDK. A sandbox mode change drops pending selections and cancels active calls; every worker call independently rechecks current authority. Disposal withdraws owned registrations and rejects retained callbacks. Switching to Native removes the PTC surface and restores only the file row's previously visible Native definitions. For overlapping configured PTC rows, the nearest row owns its descendant scopes; a later row wins within the same scope, and unload restores the earlier row. The shared registry is never patched.

Read Outcome status before data. A partial result retains coverage and a continuation; failures retain code, effect state and retry policy. The loader performs no file work and grants no filesystem permission. No token benchmark or IO speedup is claimed here.

## Compact loader guidance

The scoped OPS prompt section contains only a one-line pointer to the actual visible `ops_load_sdk`, not an always-resident task directory. The loader description lists configured raw names plus the implicit `result` exception. This is a configured pool, not proof of current execution authority: selection and commit recheck current authority, and actual calls enforce it again. Use callable SDK APIs first; otherwise select 1–5 exact raw names and wait for the next model step. There is no keyword-search SDK API.

With resident publication disabled, the loader still uses configured `allowedTools` plus `result` only; it does not implicitly restore `inspect_local_file`, or `read_files` absent from that pool. `result` remains loadable with `allowedTools: []` whenever the loader is enabled and available, including for read-only page/release. Disabling dynamic loading removes the loader; an eligibility exception does not create an unavailable loader.

Unavailable workers/services, non-owning rows and Native/both presentation advertise no PTC loader guidance. Selection rejects mutations and batch under read-only authority. It does not infer path/action permission, probe the worker or call Native providers. A sandbox event drops pending selections; already loaded schemas can remain visible, but invocation never bypasses current authority. Configuration reload, scope ownership change, presentation withdrawal, disposal and agent retirement refresh or remove the pointer and loader through the existing PTC lifecycle.

中文：[PTC SDK 按需加载](./PTC按需加载.md)。
