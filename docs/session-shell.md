# Explicit session Bash execution

This is the unpublished #872 integration slice. Its release prerequisites include the accepted
native shell transport and runtime, recoverable native output spill/paging, explicit kernel-owned
jobs, and the remaining lifecycle/performance acceptance. The current prefix capture is a known
gap, not a replacement for the existing full spill contract.

`ops_bash` continues to use `execution: "fresh"` by default. Fresh calls retain their existing
working-directory resolution, approval, script-file support, output spill and host Jobs behavior.
The current production runtime pin remains fresh-only: no complete package has yet been accepted
for persistent protocol ownership, and there is no configuration override. After an accepted
package, a kernel advertising `shell-v1` and ready authority services are all present, the same tool
can also accept `execution: "session"`. Native callers and PTC's `tools.ops_bash()` reach the same
root-owned admission service; there is no separate PTC shell or implicit fallback to fresh.

The stock runtime has a reproduced completion gap: in an external reader-gated copy of the
driver, its original stdout reader had already read 23 bytes but had not updated capture accounting.
The driver returned exit 0, private-stream EOF and `reset: false` before those bytes were accounted
for; releasing the gate made the next live-state check reject. Private receipts and diagnostic
counters therefore do not establish that the stock runtime's original streams are quiescent.
Memory ordering, coherent snapshots or a quiet interval do not repair that ownership gap. The local
report `diagnostic-reader-gate-b96dc2350db54d7aaeb0c0d31b7173db/report.json` has SHA-256
`5861867d320b6c33280b28cff19c74a499d001b9709425faafb75c766b4e6ea3`.
This is one concrete reason the complete production package remains ineligible for session mode.

```js
await tools.ops_bash({
  execution: "session", description: "Remember the package directory and build flag",
  command: "cd packages/core; export BUILD_FLAVOR=debug; build_label() { printf '%s' \"$BUILD_FLAVOR\"; }"
});
const result = await tools.ops_bash({
  execution: "session", description: "Print the remembered directory and build flag",
  command: "pwd; build_label"
});
```

State belongs to the exact host Agent/Session. The native kernel serializes that session's
requests; independent sessions can overlap. Omitted or blank `workdir` preserves the shell's cwd
after its initial directory is established. Explicit `workdir` resolves under the current host
directory rules and changes the persistent cwd before the command. Exports, functions and shell
options persist. Each command starts with stdin at EOF. File descriptors and traps that interfere
with the reserved protocol are not a supported persistence contract.

Current authority, host environment and the selected Bash runtime are checked at the queue head
and again after asynchronous preparation/approval. A changed authority, environment baseline or
runtime retires the old shell; later queued calls receive fresh admission. One-time widening is
for that command only and its shell closes afterward. Disposing an Agent closes its owned shell
and pending calls; disposing the common provider joins every owner. There is no replay of a
started command after a reset, crash or connection failure.

| Session result | Meaning |
| --- | --- |
| `shellState: "preserved"` | A reusable shell remains after this command. Check `stateLost` separately. |
| `shellState: "reset"` | The shell is gone; the next admitted call starts new state. |
| `shellState: "unchanged"` | Local validation/admission refused before enqueue; this attempt did not alter shell state. |
| `shellState: "unknown"` | An unexpected adapter failure did not establish shell state or cleanup. |
| `stateLost` | Prior state was discarded due to authority, environment, runtime change or an earlier reset, even if a replacement shell now remains. |
| `cleanupConfirmed` | The native receipt confirmed the required cleanup; false must not be treated as clean completion. |
| `failure.effectState` | `none` proves this command was not applied; `unknown` requires inspecting effects before another attempt. |
| `denialObservation` | A denial was `detected`, `not-observed`, or detection is `incomplete` because stderr was truncated. Missing signatures do not prove no denial. |

Session `timeoutMs` defaults to 120000 and is capped at 600000; it must be a positive integer.
The deadline includes queue and admission time. A started command's timeout/cancellation stops
its owned shell and reports state loss. A queued expiration does not prove an unrelated active
command stopped. Session calls never automatically become background jobs.

Session mode currently accepts `command` only. `script_path`, custom `graceMs`, and enabled
`includeDiagnostics` are refused before execution with a fresh-mode remedy. `run_in_background:
true` is refused: use fresh execution for an independent host job. That job does not inherit a
persistent shell's functions or cwd changes. A command that leaves implicit background processes
or private descriptors alive cannot be treated as completed; the kernel resets its owned range.
An explicitly waited command remains ordinary foreground work.

Output has separate stdout/stderr streams and `retention: "prefix"`. At most 128 KiB per stream
is retained; `bytesTotal` counts observed bytes and `truncated` marks loss. No `spillPath` is
fabricated, no discarded bytes can be paged back, and no JSON digest claims the prefix is full
output. Native text renders this limitation and state changes; PTC receives the typed fields.
Fresh output spill remains unchanged. The existing budget/paging/spill requirement is still open
for session mode and must be satisfied before release acceptance.

For standalone integrations, mount the common owners once before their consumers:

```js
import { residentKernel, residentSessionShells, integration } from 'dsh-ops/integration';
await ctx.plugin(residentKernel());
await ctx.plugin(residentSessionShells());
await ctx.plugin(integration({ preset: 'my-preset', shell: true }));
```

The main package row performs this composition, but the current package gate leaves it fresh-only.
A kernel without `shell-v1` likewise exposes the old fresh-only definition. Kernel/provider loss never causes a session request to fall back to fresh.
The focused tests use actual Cordis/Agent ownership with scripted transport, so they establish
publication, schema and authority behavior; physical runtime and full Native/PTC execution require
the separate real-kernel probe. Repository-only candidate proofs mount the existing internal
admission seam under the actual root activation with exact binary hashes and prepared support;
they do not establish production runtime selection. None of these focused checks establish a performance improvement.

The 2026-11-14 local validation passed 23 new checks and 92 existing targeted checks (115 total).
The initial Bash-session suite lacked a fixture and skipped; supplying the existing verified
legacy Bash fixture then passed all six of its checks. This was not the full release gate.
The real [public routing probe](../bench/probes/probe-872-session-public.mjs) passed six checks
covering 12 calls, using worker SHA-256
`21d3e339830e9fdee9eadd91e51d7bf99e14ecb030213aac3711ca0fabd9530d` and candidate SHA-256
`7c4332044ac5fd1b789f30b29c155a62f12f07f8dd3495244bda3ce4e0e84664`.
Cleanup completed and observed kernel PID 31592 was gone. The local report
`c2-session-public-final.json` has SHA-256
`1463e2ba3900e07fcf3bf7533abe66f97f8e206ff5b779316de51d6386f5aca3`.
The first report retains its one failed background-guidance assertion; after correcting that
specific validation order, the corrected run and final-worker run both passed all six checks.
