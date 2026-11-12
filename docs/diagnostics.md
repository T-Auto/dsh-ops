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

The explicit Windows cradle backend is described below. The host backend remains the default until
lifecycle/security and equivalent Windows/Linux performance acceptance is complete. No performance
claim follows from the timing implementation; the final comparison still needs interleaved rounds,
all workloads/permission modes/projections, ext4 for WSL, and equivalent containment and retention.

## Windows cradle and resident executor

Set `executionBackend: cradle` on the shell row or the relevant built-in mode section (for example
`ops-ptc`). The default is `host`; selecting `cradle` never silently falls back. Build/stage the
native worker with the existing `build:ptc` pipeline: the supervisor is a `--cradle` entry in the
same provenance-checked binary, not another downloaded runtime. Selecting it on non-Windows fails
explicitly; those systems keep their existing host executor.

Ownership is keyed by the Cordis kernel root, not process id, home or workspace. Component leases
share that root's lazy supervisor. Each generation has a random 128-bit nonce, private inherited
stdin/stdout, and an opened parent-process handle. No named endpoint, TCP listener, process-name
scan, per-command watchdog process or filesystem rendezvous is created. Closing the control
connection or signalling the parent handle closes every owned Job through process exit.

The native supervisor owns task Jobs, target handles, stdout/stderr pipe readers and settlement.
A resident scheduling thread validates launch data; it owns no Jobs and catches request panics
without replay. Accepted tasks pass a second host authority check before `commit`. Each launch uses
an explicit stdio handle allowlist and suspended creation → Job assignment → resume; Job creation
or nested assignment failure refuses the task. Jobs are unnamed, non-inheritable and kill-on-close,
without breakaway flags. Each command gets a fresh shell, environment and EOF stdin: resident
executor does not mean shared shell functions, traps, cwd, options or descriptors. Fixed-file
workers deliberately retain their existing per-request authority boundary, not a privileged pool.

Requests have strictly increasing ids and `accepted`, `prepared`, `started`, `targetExit`, `settled`
and acknowledgement boundaries. A broken submitted request is never replayed and reports unknown
effects. The host-facing command completes only after target exit, Job active-process-zero, both
output drains and result delivery. Thus a background descendant remains a live host job, including
when it closes its inherited output descriptors. `job_output` and `job_kill` remain the normal DSH
interfaces; no separate private job registry is exposed. Cancelling a Windows task terminates its
exact Job immediately (no reliable cooperative signal exists for these non-console tasks).
Deadlines remain in the existing executor; background promotion disables only that deadline.
Session disposal cancels that lease's session tasks; the final component lease shuts down its
supervisor, with a bounded exact-child shutdown escalation.

Running → Idle → Draining → Exited is driven by `Instant`, not output activity. The 300-second
countdown starts only when the task map is empty **after result acknowledgement**. Queued, running,
background and output-draining tasks prevent retirement indefinitely, including silent hour-long
commands. Retirement and admission are serialized by the supervisor event loop; a race is an
explicit connection failure, never transparent resubmission. The next independent invocation
creates a fresh generation. The scheduler retires with its supervisor.

Bounds: 32 admitted tasks, 1 MiB control frames, 256 queued output frames (8 KiB binary chunks,
hex-encoded separately from control), 2 MiB host outbound control backlog, 64,000-byte stream tails,
64 MiB per-stream spill and 256 MiB retained spill reservations per generation. Output reads pause
while spill IO completes; disk failure/quota exhaustion drops the complete spill claim but keeps
the bounded tail and loss flag. Spills are created only on overflow using the existing ledger's
private directory/file shape, so its configured retention remains authoritative. Empty instance
spill directories are removed on shutdown; retained result files are not deleted prematurely.
There are no polling timers for Jobs: a completion port observes tree settlement, blocking reads
observe output, and a handle wait observes the parent. The 15-second startup handshake deadline is
not a task lifetime or heartbeat policy.

All requests still pass existing argument validation, `sandboxPolicy.resolve`, approval, sandbox
confinement, session authority rechecks and host environment scrubbing. Confinement argv is executed
unchanged; unsupported host installation/scrub contracts refuse activation rather than substituting
raw unrestricted commands. The native module is an explicit platform boundary; protocol, ownership,
output accounting and DSH adaptation remain separate modules. Native/PTC publication and audit
continue through the existing tool entry.

Code delivery is not acceptance evidence: multi-kernel collision, nested Job restrictions,
parent/supervisor crashes, idle races, cancellation storms, policy changes, disk/pipe pressure,
actual Desktop/Web integration and the Windows/Linux performance matrix still require execution
by the operator. No runtime test or benchmark result is claimed.


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
