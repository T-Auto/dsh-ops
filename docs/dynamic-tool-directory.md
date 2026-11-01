# Dynamic tool directory

中文版：[动态工具目录](动态工具目录.md)。

## Native discovery

The discovery controller contributes one OPS-owned, scope-aware prompt section. Before a tool is
loaded, a compact task directory points to the actual visible `ops_discover_tools` entry. It derives
its names, built-in search terms and contracts from the existing capability catalog, and external
entries from the existing registered Native providers. There is no additional tool registry.

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

The directory shows at most 20 unloaded entries, with bounded, quoted task hints; queries still
search the full eligible pool. Hints are data, never permissions or instructions. Provider-owned
prompt sections are not overwritten, and literal braces are not interpolated by OPS.

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
for those agents. PTC directory integration must use the existing PTC catalog and loader's real
allowed pool, independently of Native provider registrations.

## Focused verification

```console
npm run build
node test/run.mjs discovery-catalog
```

The suite uses real Cordis scopes, system-prompt assembly and tool dispatch, with no native worker
execution. It checks pre-load hints, next-step activation, no matches, provider visibility and
readiness, permission downgrade, execution authorization/revocation, two agents, provider reload,
PTC-only suppression, cancellation, unload and stable repeated assembly. Native execution and the
full cross-platform release gate remain separate checks.
