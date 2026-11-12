# Diagnosing an OPS integration

## Execution timing (issue #872, slice A)

Pass `includeDiagnostics: true` to `ops_bash`. The default remains off. The tool returns
`executionTiming` on foreground, background, promoted and rejected calls; a settled execution also
has `diagnostics.timing`. These are independent snapshots, not a global telemetry buffer.

- `wallMs`: monotonic time from the OPS tool entry to its return boundary. Host dispatch before
  entry, serialization and caller delivery are outside this scope; measure the full call externally.
- `admission`: argument validation and working-directory resolution.
- `policy`: session policy, approval and environment collection (includes human approval time).
- `queue`: host job admission until its execution callback starts; absent without a host job.
- `prepare`: runtime preparation, authority recheck and sandbox confinement.
- `launch`: synchronous `subprocess.spawn` call, **not** proof of target process startup.
- `hostWait`: awaiting the host's `done`, including its runner/output handling, not pure command CPU.
- `outputFinalize`: retained output collection, spill accounting and executor result projection.
- `resultReturn`: tool result projection before returning to the host.

Each observed phase has an origin-relative `startMs`, fractional `durationMs` and a status.
`not-observed` uses nulls, never fabricated zeroes; `running` is a partial interval. Background and
promoted responses are handoff snapshots, not task completion. `diagnostics.durationMs` retains its
executor-local meaning; it must not be labelled full tool latency. The executor snapshot precedes
host result projection; use the outer `executionTiming` for foreground tool totals.

The current public collect-mode subprocess API has no first-byte event or separate target-exit
notification. `done` is not tree settlement. `unavailable` reports those three limits explicitly,
and `hostDoneMs` records only a successful `done` observation. This instrumentation neither polls
output nor calls `waitForExit` just to manufacture a metric, since that would change lifecycle
semantics. It creates no extra process, timer, listener, log or disk artifact, and keeps at most
one fixed-size phase record per invocation. No command text, environment or paths enter the trace.

The opt-in repository helper `bench/probes/execution-timing.mjs` exports `sampleExecution`:

```js
const report = await sampleExecution({
  invoke: ({ signal }) => callMountedTool({ ...args, includeDiagnostics: true }, { signal }),
  validate: result => result.kind === 'foreground' && result.status === 'completed'
    && result.exitCode === 0 && result.stdout.text === expectedOutput,
  metadata: {
    system: 'record OS/build/CPU/load', host: 'record actual DSH version',
    plugin: 'record revision', runtime: 'record shell/worker version',
    permission: 'workspace-write', projection: 'Native', workload: 'record fixture identity',
    storage: 'record filesystem', cache: 'record preparation/cache state',
  },
  samples: 200, warmup: 10, signal,
})
```

Bind `callMountedTool` to the actual mounted Native/PTC entry, not raw spawn or a mock. It must await
result delivery and forward cancellation. The helper performs no setup or automatic invocation;
it writes nothing and runs serially, retaining only timing rows (maximum 10,000 hot samples).
It keeps the first call, warmups, failed calls, p50/p95/p99 and error rate; phase percentiles count
only completed observations and include their sample counts. First-call is **not** proof of cold
cache. Resource numbers cover the sampler process only; child CPU/RSS, handles and temporary disk
are explicitly unknown. Capture them externally for the eventual performance gate. Output must be
validated per workload; an exit code alone is not equivalence evidence.

This slice does **not** install a cradle, persistent worker or replacement process backend. The
existing per-request policy, host sandbox/jobs, deadlines, cancellation, spills and shell isolation
are unchanged. B–F require measured bottlenecks and independent lifecycle/security evidence before
backend selection. No Windows/Linux performance claim follows from this implementation. The final
comparison still needs interleaved rounds, all workloads/permission modes/projections, ext4 for WSL,
and equivalent containment and retention. No benchmark or regression run is implied by these docs.

## Integration status

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
