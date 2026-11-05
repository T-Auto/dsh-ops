# Host integration troubleshooting

English | [中文](宿主集成.md)

These checks separate plugin configuration from host presentation and provider
transport failures. They do not establish that an unobserved Desktop freeze or
an old conversation has been repaired.

## DSH 0.2.2 publication migration

All file reads/mutations and result share one scope-owned canonical source, not separate Native/PTC shadow definitions. Native retains its renderer and context-read evidence; values are Outcome.data. File operations retain the existing authoritative cwd, credential, CAS and sandbox bridge. PTC-only jobs and load_sdk remain separate.

Conditions and prompt assembly never change registration. Pending selection commits at step/end. Unchanged entitlement preserves definition identity. A real grant/source change conservatively replaces the shared registration: **other agents sharing that source also lose their previously captured toolSet**. The host reports UNKNOWN_TOOL before dispatch; fresh resolve restores eligible agents. Distinct sources remain independent. This is an availability limit, not per-agent snapshot isolation. An old step never acquires a new grant. Never replay automatically.

Late foreign ancestor sources retain their exact definitions, conditions and restrictions; fallback retires without copying into a child-owned layer. Cancellation vetoes any captured grant revoked during work. If a provider ignores abort, the bounded return is RESULT_UNKNOWN with unknown effects; inspect effects, never replay automatically. See [result budgets](result-budgets.md) for the shared result schema and PTC-only put fence.


In 0.5, enabling official-tool replacement does not guarantee that a conditional official tool disappears from the model's tool table. When the OPS counterpart has conditional admission, OPS keeps the official registration visible and guards its dispatch only when the same captured step toolSet admits the counterpart and the consumer still has current authority. An absent, revoked or not-yet-ready counterpart cannot disable the official tool as well. Safe unconditional resident replacements may still use host restrictions. OPS never wraps official definitions or hides tools from inside admission conditions or prompt assembly.

## Source ownership

`src/presets/` owns built-in preset defaults. `src/consumer/` assembles built-in and external
consumers through one pipeline. Scoped publication lives in `src/publication/`, Native and typed
PTC projections in `src/projections/`, and shared worker execution in `src/execution/`. These are
internal paths, not public plugin-author imports. See [internal architecture](internal-architecture.md).

## A whitelist does not hide `ops_bash` (#380)

In the pinned DSH tools API, `tools.restrict()` masks inherited registrations.
An agent's own registrations are resolved separately. OPS publishes Bash in the
agent's scope so its definition follows that session's authority and services;
an inherited-tool whitelist therefore cannot be assumed to remove `ops_bash`.
The fact that the same whitelist hides a globally registered file tool does not
prove it also hides the session's shell. A read-only sandbox is also a filesystem
permission mode, not a promise that every command tool is absent.

To stop OPS Bash publication, set `bash: false` in the built-in section of the single `dsh-ops`
row, or `shell: false` in an explicit consumer. Keep the other saved keys:

```yaml
standard:
  bash: false
```

Check every enabled mode row in the effective configuration: another row can
still publish its own tool for sessions of its preset. Apply the change through
the host settings or profile lifecycle, then verify a new session's tool list.
This switch controls OPS Bash; it does not disable independently installed
command tools.

Per-preset command denial requires a host execution policy that covers owned
tools, or a verified scoped mounting arrangement. Merely enabling a mode
row is not established as an isolation guarantee: the row also enumerates
already live agents when mounted. Before relying on such an arrangement,
verify both allowed and disallowed presets, existing and newly created sessions,
and actual invocation rejection. OPS does not rewrite the shared tool registry
to make inherited restrictions act on owned tools.

## A provider rejects `tool_addition` in an old conversation (#367)

OPS publishes tool definitions through the host registry. DSH records changes
to the available tool set and serializes provider messages; OPS does not construct
`tool_addition` blocks or choose their wire-message roles. The reported
`tool_addition blocks can only be in system messages` error is therefore a
host/provider serialization boundary, even when an OPS discovery change triggers it.

For a bounded diagnostic, choose the intended configuration before creating a
fresh session, then keep the tool set stable during that run. Configure any
`alwaysLoaded` discovery capabilities before session creation and avoid changing
selections or component settings mid-conversation. Disabling discovery removes
that progressive-publication trigger but also removes access to capabilities
that were available only through discovery. This does not repair retained history
or guarantee compatibility with every provider.

If the rejection persists, retain the exact host/plugin versions, provider/model,
request ID, added/removed tool names, and the smallest redacted message-role
fragment that demonstrates the invalid block. The host/provider adapter needs
that evidence; changing OPS tool names or editing historical message roles is
not a plugin-side serializer fix. [Issue #367](https://github.com/T-Auto/dsh-ops/issues/367)
tracks the reported trigger.

## `ops_discover_tools` is missing (#346)

First inspect the profile actually used by the application, using its own CLI.
Desktop uses its bundled CLI; the ordinary CLI does not manage the reserved
Desktop profile. For a non-Desktop test profile:

```console
dsh plugin --profile ops-test add dsh-ops@latest
dsh --profile ops-test --dump-config
dsh --profile ops-test --dump-config-schema
```

Replace `@latest` with the intended version or packed checkout when testing an
unpublished fix. Put `--profile` before `add` and package-manager arguments. The
effective configuration should contain the enabled single `dsh-ops` row, with global and
matching preset dynamic switches on (or an explicit integration with discovery enabled). Inspect
saved custom `presets`, overrides and duplicate bindings before adding another row. A stale profile missing discovery is a different
case from an enabled row whose publication stalls.

Presentation matters: ordinary Native scopes use `ops_discover_tools`; PTC scopes
use the PTC SDK loader under the host's `run_code` presentation. Check the scoped
assembled tools and presentation, not just a global registry or a prompt section
name. An empty discovery section alone does not identify the cause.

The 0.5 adapter targets DSH `>=0.2.2-rc.1 <0.2.3-0`; earlier hosts are not supported. Host imports remain centralized in `src/adapter/dsh`, with type-only declarations and lazy runtime loading. The 0.2.2 host owns executor selection and captures a `ResolvedToolSet` before prompt assembly and pre-step. Stable conditional registrations expose committed discovery/PTC selection on the next step; prompt callbacks never publish tools. Request guidance and replacement guards read the captured set, while registry diagnostics use public `definitions()` without schema cloning. A missing live working-directory service is an infrastructure error, not permission to use the original session header as an execution directory. Runtime evidence must name the tested dependency graph and actual checks; version strings alone do not establish compatibility.

The original #346 report also describes an enabled row and a stalled publication
chain. The profile checks above do not prove that failure fixed. If the row is
enabled and the expected scoped tool remains absent, capture a minimal profile,
exact versions, Native/PTC mode, affected scoped schemas, and a timed lifecycle
trace showing the pending publication. Restart/new-session results are useful
comparisons, not proof that an indefinite hot-mount stall cannot recur.
