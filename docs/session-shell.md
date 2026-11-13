# Explicit session Bash execution

This #872 integration connects the explicit session projection to the shared native
[output and retention contract](session-spill.md) and production fresh task path. Accepted
runtime distribution and final lifecycle/performance acceptance remain release prerequisites.

`ops_bash` continues to use `execution: "fresh"` by default. Fresh calls retain their existing
working-directory resolution, approval, script-file support, output spill and host Jobs behavior.
The current production runtime pin remains fresh-only: no complete package has yet been accepted
for persistent protocol ownership, and there is no configuration override. After an accepted
package, a kernel advertising both `shell-v1` and `shell-spill-v1`, and ready authority services are all present, the same tool
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

DSH's public tool pipeline joins a caller-cancelled body, then returns its standard `ABORTED`
envelope instead of the typed tool value. That envelope does not include `shellState`. The next
admitted session call reports `stateLost: "shell-reset"`; callers must not assume prior state
survived cancellation. A tool deadline without caller cancellation retains the typed reset result.

Session mode currently accepts `command` only. `script_path`, custom `graceMs`, and enabled
`includeDiagnostics` are refused before execution with a fresh-mode remedy. `run_in_background:
true` is refused: use fresh execution for an independent host job. That job does not inherit a
persistent shell's functions or cwd changes. A command that leaves implicit background processes
or private descriptors alive cannot be treated as completed; the kernel resets its owned range.
An explicitly waited command remains ordinary foreground work.

Output has separate stdout/stderr streams and `retention: "prefix"`. At most 128 KiB per stream
is retained inline; `bytesTotal` counts observed bytes and `truncated` marks an incomplete inline
view. An available `spillPath` identifies the sealed complete stream, up to 64 MiB, recoverable
through existing file tools and their permissions. Storage failure, cap overflow, raw capture
error or unconfirmed cleanup cannot publish a full recovery path. Native text distinguishes
recoverable streams from prefix-only degradation; PTC receives the same typed fields. No JSON
digest claims a prefix is complete. Native file ownership remains internal; existing retention
records the exact kernel and Session only after confirmed terminal capture.

For standalone integrations, mount the common owners once before their consumers:

```js
import { residentKernel, residentFreshTasks, residentSessionShells, integration } from 'dsh-ops/integration';
await ctx.plugin(residentKernel());
await ctx.plugin(residentFreshTasks());
await ctx.plugin(residentSessionShells());
await ctx.plugin(integration({ preset: 'my-preset', shell: true }));
```

The main package row performs this composition, but the current package gate leaves it fresh-only.
A kernel without both `shell-v1` and `shell-spill-v1` likewise exposes only fresh execution.
Kernel/provider loss never causes a session request to fall back to fresh.
The focused tests use actual Cordis/Agent ownership with scripted transport, so they establish
publication, schema and authority behavior; physical runtime and full Native/PTC execution require
the separate real-kernel probe. The current [public routing probe](../bench/probes/probe-872-session-public.mjs)
requires normal compiled package eligibility and complete payload verification. Supply explicit
`--worker`, `--bash`, `--shell-env`, `--controller` and `--report` paths. It uses the package root
without an injected admission service and checks Native/PTC state plus complete output recovery
in all three sandbox modes. Until a complete runtime is qualified, that probe must refuse startup.
None of these focused checks establish a performance improvement.

An isolated source-built candidate passed all nine normal-root probe checks, including Native/PTC
state, independent fresh calls, explicit refusals/reset, and waited background stdout/stderr recovery
in all three sandbox modes. Only the complete runtime manifest and its accepted inventory digest
differed from source `d0aa842c`; no admission service was injected. Worker SHA-256 was
`9b25fceacb73ab1abe53b64b291b89d8ee8896cb9d8df6cfa7a1983f993715c0`; runtime inventory was
`24bd2f20fea7e6358aa9f75f1fa4d1896ee3b4962d42042bfd2f5e4ca8317068`.
Cleanup was confirmed and the observed kernel exited. The local report `c5-qualification-public.json`
has SHA-256 `4fc90c521b1850aa88c800b5e006ea10cf1bae8b828372f6e8f924a6f245b063`;
`c5-qualification-receipt.json` records the exact source patch and complete payload. The candidate
archive remains unpublished, and the shipped runtime pin and accepted inventory set are unchanged.

Four actual DSH CLI instances then used that same qualified build with a shared temporary home
and workspace. Each retained distinct cwd/environment/functions/options. Targeted public
cancellation stopped only its session child; sibling commands remained live, and the next call
reported state loss. Public control loss, hard kernel crash, normal SDK shutdown and forced host
death stopped the relevant persistent children and explicit Jobs without replay. Another instance
continued and retained its shell state. The corrected report `1794600220094-report.json` records
54 events and 41 observed Windows PID/creation-time identities, all gone before emergency cleanup;
there were no cleanup errors. SHA-256:
`c7488c1ddecb4849e5ff8d5df740ae4afdbe4e6f43935614b8a0546e26aa4041`.
The first report is retained: it passed state isolation but incorrectly expected the inner typed
cancel result rather than DSH's `ABORTED` envelope. This corrected run used a short quiet workload;
the earlier fresh-task proof separately covers a quiet interval over five minutes.

After integration with fresh tasks and session spill, 92 checks across six focused suites passed.
The exact publishing Agent is checked before submission and again during queued admission.
Removing only that equality in an isolated compiled copy makes the retained-definition sibling
test fail (13 passed, one failed); the unchanged implementation passes all 14 publication checks.

Historical validation of the earlier frozen C2 revision passed 23 new checks and 92 existing targeted checks (115 total).
The initial Bash-session suite lacked a fixture and skipped; supplying the existing verified
legacy Bash fixture then passed all six of its checks. This was not the full release gate.
That revision's probe used the internal admission seam and passed six checks
covering 12 calls, using worker SHA-256
`21d3e339830e9fdee9eadd91e51d7bf99e14ecb030213aac3711ca0fabd9530d` and candidate SHA-256
`7c4332044ac5fd1b789f30b29c155a62f12f07f8dd3495244bda3ce4e0e84664`.
Cleanup completed and observed kernel PID 31592 was gone. The local report
`c2-session-public-final.json` has SHA-256
`1463e2ba3900e07fcf3bf7533abe66f97f8e206ff5b779316de51d6386f5aca3`.
The first report retains its one failed background-guidance assertion; after correcting that
specific validation order, the corrected run and final-worker run both passed all six checks.
