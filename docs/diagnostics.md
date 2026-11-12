# Diagnosing an OPS integration

English | [中文](集成诊断.md)

Mounting `dsh-ops/integration` also publishes the scoped `ops_status` read-only diagnostic tool.
It reports the current preset, visible tools, selected/degraded state, external provider states and
operator-actionable issue codes. It does not execute a file/shell/provider action and does not
activate discovery capabilities.

On demand it also returns `runtimeVersion` and, when known, `runtimeVersionSource`.
The adapter calls `getDshRuntimeVersion()` from the `app-boot` package selected by
the host's installation-scope `pluginPackages.resolution`. Prerelease and build
metadata are preserved. Missing or ambiguous authority returns `unknown`; OPS
does not infer the running version from its dependencies, npm, executable metadata
or inherited `DSH_VERSION`. No version, package list or configuration path is added
to prompts, SDK declarations or ordinary tool results. Hosts without this
installation resolution need a host-owned version service before they can report
a known value through this adapter.

Important states:

- `not-selected`: this agent has no explicit OPS integration or enabled built-in mode.
- `ready`: the selected integration is mounted and its declared host/runtime checks pass.
- `degraded`: a selected integration has a missing host service, runtime, shell, presentation or
  publication. This is distinct from a user not selecting OPS.
- external `available`: provider is allowed and alive but on-demand; `pending`: selected for the next
  model step; `active`: visible in this scope; `disabled` and `unavailable` are explicit causes.

For `PRESENTATION_MISMATCH`, inspect the actual assembled surface. PTC requires `run_code` plus a
non-empty `tools:ptc-only` section; a preset name or prompt recommendation is not proof. For
`PUBLICATION_UNAVAILABLE`, verify the mode row/binding lifetime and registration errors before
changing user permissions. If an official tool was hidden while its OPS counterpart is absent, the
replacement controller is defective and must be fixed rather than asking the user to retry.
