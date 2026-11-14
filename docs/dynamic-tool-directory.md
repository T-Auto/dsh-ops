# Dynamic tool directory

中文版：[动态工具目录](动态工具目录.md)。

## Native discovery

The discovery controller contributes one OPS-owned, scope-aware prompt section with a one-line
pointer to the actual visible `ops_discover_tools` entry, not an always-resident directory of
unloaded capabilities. Search results derive built-in names, search terms and contracts from the
existing capability catalog, and external entries from registered Native providers. There is no
additional tool registry. Standard and Cordis initially publish `ops_inspect_local_file`, `ops_glob`
and `ops_grep`; `ops_read_files` and `ops_result` use discovery when needed.

- **Callable** means a tool schema is currently visible in this agent. Prefer a resident/callable
  tool if it already handles the task; do not load a duplicate.
- **Discoverable** means a capability is eligible for selection, not that it is callable or that an
  execution is authorized. Ask `ops_discover_tools` with task keywords, or use
  `{"query":"select:ops_read_pdf"}` for an exact built-in name and
  `{"query":"select:acme_lookup"}` for a provider's exact name.
- Selection performs no tool action. Newly selected tools appear on the **next model step**; use
  them only after their schema appears. Arguments and defaults come from that schema, not a hint.
- A no-match result covers only the current eligible pool. Do not repeat an unchanged query, guess
  tools/formats, or use another executor to bypass a permission denial.

Queries search the full eligible pool and return bounded results on demand; the prompt no longer
lists up to 20 unloaded entries on every request. Hints are data, never permissions or instructions.
Provider-owned prompt sections are not overwritten, and literal braces are not interpolated by OPS.

The pool excludes disallowed built-ins, tools already resident in the current mode, mutating
built-ins in read-only mode, inactive/uninstalled providers, providers outside the operator's
allowed list, disabled providers and providers that are unavailable or hidden for this agent.
Native directory text is absent when its loader is not visible, guidance is disabled, ownership is
withdrawn, or the assembly is PTC-only. Unloading removes only this controller's tools and text.
Rendering reads the pool without spawning workers or assembling prompts recursively. Existing
presentation checks still run at lifecycle/execution boundaries; this is not a process probe.

## Provider visibility is not authorization

`registerNativeCapability()` accepts the backward-compatible optional hook:

```ts
discoverable?(agent: Agent): boolean
```

This synchronous hook must be side-effect-free and return exactly the boolean `true` to expose an
entry. `false`, `undefined`, `null`, `0`, objects, promises (including a resolved `true` or `false`),
or an exception hide the entry. If an accidental Promise rejects, OPS consumes the rejection and
still fails closed; asynchronous eligibility is not supported. `available(agent)` describes provider
readiness; `discoverable(agent)` describes directory/search visibility. Omitting `discoverable`
preserves existing readiness-based discovery. Use it to hide entries that the current agent should
not discover. A provider that needs permission-aware visibility must implement this check from its
own authoritative state; OPS cannot infer execution permissions from descriptions. Changing visibility
does not itself revoke execution authorization.

Both hooks are read again for lookup, rather than caching a discovery permission. Provider changes
must use the existing disposer and re-registration lifecycle to notify controllers and invalidate
publication; reloading gets a new selection token. The execution-only `authorize(exec)` hook is
**never called to build or search the directory**, and is rechecked with the real execution context
immediately before every provider action. Directory inclusion cannot grant authority. Providers
must enforce revocation in `authorize` even when a tool is already loaded.

## Native and PTC are different projections

`src/discovery/catalog.ts` exports the pure `nativeCatalog()` view and `NativeCatalogEntry` type;
`src/discovery/prompt.ts` exports `renderNativeDirectory()`. Their inputs are already filtered Native
candidates, and the view never registers or authorizes tools. They are **not** PTC SDK APIs.
External Native providers must not be advertised as SDK functions. PTC-only agents use their actual
`ops_load_sdk` contract and typed APIs, not `ops_discover_tools`; the Native directory is suppressed
for those agents. PTC likewise keeps only a one-line loader pointer. Its loader description lists configured raw
names (including on-demand `result`), independently of Native providers; selection and commit
recheck current authority rather than treating that configured list as authorization.

## ops-ptc and the progressive-disclosure switches

A PTC presentation never publishes the Native `ops_discover_tools` entry: that is by design, not a fault.
PTC-only agents load typed APIs exclusively through `ops_load_sdk`, and the Native directory is suppressed.
Under the `ops-ptc` mode, therefore, the SDK loader is the only progressive-disclosure entry:
`ops_load_sdk` is published only while both `ops-ptc.dynamicTools` and the bundle-level
`global.dynamicTools` are on (an AND gate; the plugin page renders the bundle switch as the master switch).
See the OPS PTC mode section of the [configuration reference](configuration-reference.md) for every key.

- Turning `dynamicTools` off removes the loader, so no on-demand API can be newly loaded. Resident and
  explicitly published APIs are untouched (`ops_inspect_local_file` and any `alwaysLoaded` API stay visible),
  and APIs already loaded in this session keep working.
- `result` is the loader's implicit selection exception (loadable even with `allowedTools: []`), but without a
  loader there is no entry point. If result references must survive the switch, put `result` in that section's
  `alwaysLoaded`.
- **Loaded APIs appear on the next turn.** `ops_load_sdk` only queues names; they are absent from the currently
  frozen SDK snapshot and become visible only after the owning session commits `step/end` and the next model step
  re-assembles. Do not call an API you just loaded in the same `run_code` — it always fails; `return` first and
  call it next turn. Prompt assembly, diagnostic assembly and registry notifications never activate queued names.
- The switch does not affect Native discovery in `standard`/`cordis`: `discovery.enabled` and each mode's
  `dynamicTools` are independent publication choices, and a PTC presentation never brings the Native directory
  back.
- The `ops-ptc` preset itself is registered at plugin runtime: disabling the `dsh-ops` row removes the preset
  together with the SDK loader. The default preset is never forced: the detail page's button sets it once, and a
  preset chosen on the settings page stays the default across restarts, remounts and the row being disabled (see
  [Presets and the default mode](presets.md)).

## Focused verification

```console
npm run build
node test/run.mjs discovery-catalog
```

The suite uses real Cordis scopes, system-prompt assembly and tool dispatch, with no native worker
execution. It checks pre-load loader pointers, next-step activation, no matches, provider visibility and
readiness, permission downgrade, execution authorization/revocation, two agents, provider reload,
PTC-only suppression, cancellation, unload and stable repeated assembly. Native execution and the
full cross-platform release gate remain separate checks.
