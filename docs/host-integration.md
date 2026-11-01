# Host integration troubleshooting

English | [中文](宿主集成.md)

These checks separate plugin configuration from host presentation and provider
transport failures. They do not establish that an unobserved Desktop freeze or
an old conversation has been repaired.

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

Host support declarations and component resource exports are covered by the current adapter boundary. The package declares and tests the bounded range `>=0.2.0-rc.2 <0.2.2-0`, including rc2, rc3, rc4 and the 0.2.1 stable line; the isolated host matrix compares the rc4 graph against the locked rc2 control. The text-only PTC hook adaptation is not used as the sole compatibility proof.

The original #346 report also describes an enabled row and a stalled publication
chain. The profile checks above do not prove that failure fixed. If the row is
enabled and the expected scoped tool remains absent, capture a minimal profile,
exact versions, Native/PTC mode, affected scoped schemas, and a timed lifecycle
trace showing the pending publication. Restart/new-session results are useful
comparisons, not proof that an indefinite hot-mount stall cannot recur.
