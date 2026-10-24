# Host integration troubleshooting

English | [中文](宿主集成.md)

These checks separate plugin configuration from host presentation and provider
transport failures. They do not establish that an unobserved Desktop freeze or
an old conversation has been repaired.

## A whitelist does not hide `ops_bash` (#380)

In the pinned DSH tools API, `tools.restrict()` masks inherited registrations.
An agent's own registrations are resolved separately. OPS publishes Bash in the
agent's scope so its definition follows that session's authority and services;
an inherited-tool whitelist therefore cannot be assumed to remove `ops_bash`.
The fact that the same whitelist hides a globally registered file tool does not
prove it also hides the session's shell. A read-only sandbox is also a filesystem
permission mode, not a promise that every command tool is absent.

To stop OPS Bash publication, set `publishBashTool: false` in its owning shell
row. Merge this setting into the existing config, preserving other keys:

```yaml
- id: dsh-ops-shell
  name: dsh-ops/shell
  config:
    publishBashTool: false
```

Check every `dsh-ops/shell` row in the effective configuration: another enabled
row can still publish its own tool. Apply the change through the host settings
or profile lifecycle, then verify a new session's tool list. This switch controls
OPS Bash; it does not disable independently installed command tools.

Per-preset command denial requires a host execution policy that covers owned
tools, or a verified scoped mounting arrangement. Merely moving a shell row into
a preset is not established as an isolation guarantee: the component also
enumerates already live agents when mounted. Before relying on such an arrangement,
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
effective configuration should contain an enabled `dsh-ops-discovery` row named
`dsh-ops/discovery`, with `enabled: true`. Inspect saved overrides and duplicate
rows before adding another row. A stale profile missing discovery is a different
case from an enabled row whose publication stalls.

Presentation matters: ordinary Native scopes use `ops_discover_tools`; PTC scopes
use the PTC SDK loader under the host's `run_code` presentation. Check the scoped
assembled tools and presentation, not just a global registry or a prompt section
name. An empty discovery section alone does not identify the cause.

Host support declarations and component resource exports are addressed in
[PR #395](https://github.com/T-Auto/dsh-ops/pull/395), with explicit 0.2.0-rc.2 and
0.2.1-rc.2 coverage. The text-only PTC hook adaptation in
[PR #390](https://github.com/T-Auto/dsh-ops/pull/390) is not full 0.2.1-rc.3 support.
[PR #383](https://github.com/T-Auto/dsh-ops/pull/383) and #390 address unnecessary
session work and append-time Bash publication. Check whether the installed version
actually contains these changes before attributing its behavior to them.

The original #346 report also describes an enabled row and a stalled publication
chain. The profile checks above do not prove that failure fixed. If the row is
enabled and the expected scoped tool remains absent, capture a minimal profile,
exact versions, Native/PTC mode, affected scoped schemas, and a timed lifecycle
trace showing the pending publication. Restart/new-session results are useful
comparisons, not proof that an indefinite hot-mount stall cannot recur.
