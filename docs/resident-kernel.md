# Resident OPS kernel: design and evidence

中文：[常驻内核](常驻内核.md).

This document tracks [#872](https://github.com/T-Auto/dsh-ops/issues/872), based on the
`e7244444` source audit. It describes the complete target and the evidence needed to reach it.
The explicit resident transport and its tests establish only the implementation described below.
Local Native/PTC file routing now uses it; persistent shells and the complete acceptance report
remain pending.

## Target and ownership

One running DSH instance owns one OPS kernel. Plugin activation starts it; successful handshake
precedes publication of its executable entry points. Unload or DSH exit stops admission, cancels
owned executions and releases resources. The kernel stays alive when idle. Its state belongs to
the plugin instance, never a module-global singleton keyed by user, home or workspace.

The kernel dispatches existing file operations, owns independent session shells, and owns explicit
background tasks registered with DSH jobs. Native and PTC share that execution path while keeping
their separate result projections. This replaces the proposed cradle/restartable-worker/idle-reaper
design; it does not add a supervisor, transparent reconnect, takeover, replay or crash recovery.
An explicit plugin restart creates a new instance after kernel failure; old shell state is lost.

DSH subprocess ownership is the outer process boundary. Private IPC belongs to that lifetime.
Windows Job ownership and host-disconnection cleanup must be demonstrated through public host
interfaces. Platform code needed for inner shell/task termination belongs in one process module;
breakaway and detach are excluded. A kernel process is not permission to run arbitrary session
shells with the kernel's own authority.

## Explicit serve transport

The worker now accepts an explicit `--serve` mode through the inherited private control pipe.
The scoped host client starts it once, waits for `ready`, correlates `started` and `completed`
events, and sends cancellation by request ID. It admits at most 32 active requests, bounds
request and response frames, and never reconnects or replays a failed invocation. The client
observes process exit before settling interrupted requests; inability to confirm cleanup is
reported as unknown. The main row starts the provider before publishing Native/PTC file tools;
local file requests reuse it. Conflicting enabled binary selections fail before startup.

The existing host file admission limit remains **two active and eight waiting calls per session**,
shared by Native and PTC. Its FIFO state belongs to that resident client, not a module-level host
map. Waiting calls have no native request or authority snapshot: their callback resolves current
policy only after a permit is available. This is host tool admission; accepted execution queues,
output and completion remain kernel-owned. Client stop/failure rejects waiting callbacks before
they run, while the existing lifecycle still joins active work and cache cleanup. A new client has
independent permits; unloading one provider cannot release another provider's waiting work.

File operations can block in operating-system I/O. Each admitted request therefore runs the
existing one-shot dispatch in a trusted child of the kernel, with its own termination handle.
Windows leaves have nested Jobs; POSIX leaves retain the host-owned process group and target
cancellation uses the unreaped child identity. These fixed file workers do not launch children.
The control loop remains responsive while a request runs, and a request deadline exits only its
worker. Output drains retain bounded tails with explicit loss information. EOF and shutdown
cancel and join admitted executions. No worker is detached or restarted.

This removes repeated **host runner** startup for local file dispatch; it still pays native
child startup per file request. Windows batch/result calls now retain exact public confinement
inside an owned native range; full-access calls reuse the fixed leaf. Restricted POSIX batch/result
calls and explicit WSL reads retain their platform runners; see [result and batch routing](resident-confined-workers.md).
The final A/B report must measure all of those costs. This transport is
not evidence that session shells, DSH jobs, complete multi-process cleanup or the performance
targets have been delivered.

Owned result-cache cleanup uses the same resident connection and existing typed `result/purge`
operation. It never starts a public one-shot worker. Session disposal stops its result work and
joins it before purge; provider teardown also seals new work and joins pending session cleanup
before shutting down the connection. This includes non-awaited host Session notifications and
standalone consumers sharing an explicitly mounted provider.
The existing per-owner lifecycle sequences cache purges even when many Session notifications arrive
together; ordinary file work and other owners remain independent. A forty-session regression exercises
the unchanged 32-request client limit, and a refused purge releases the next cleanup.

The provider retains public sandbox and policy dependencies only through this cleanup barrier.
Every purge resolves the current policy again, rejects read-only or changed authority, and checks
the current Windows private-temp grant against the original root and SID. Native storage validation,
no-follow directories, bounded cache names and the stable session lock are unchanged. Cleanup may
use the still-owned connection after ordinary admission closes, but only through a method that
constructs the fixed purge envelope. An absent/failed provider, changed grant or incomplete receipt
keeps the existing deferred-cleanup record; it never creates a replacement worker or replays
business operations.

`resident-result-cleanup.test.mjs` exercises actual Agent/Session, policy, sandbox and subprocess
services through package-root and shared standalone activation. Each keeps one public kernel spawn
through file calls and disposal, holds cleanup to prove teardown waits, and observes both owned
caches purged before kernel exit. It also replaces a cache session directory with a link and checks
that the native refusal preserves the external target. These are ownership/safety checks, not
performance measurements or evidence for the remaining #872 acceptance requirements.

The Windows verification ran 89 checks across ten affected suites with zero failures or skips.
Removing only the retained-authority hook from a separate compiled copy made the full-root check
fail with zero of two caches purged; standalone and no-follow checks still passed. The forty-session
test first completed only 32 purges, then passed after lifecycle sequencing. Removing only the
client's duplicate drain call did not fail, because the retained dependency disposers also join
cleanup. Fixture setup failures and that ineffective negative are retained separately from the
meaningful controls; they are not counted as production regressions.

Standalone integrations explicitly mount `residentKernel()` in their common owning activation
before mounting consumers; see the [integration setup](integration-api.md). Removing a consumer
does not dispose that shared provider. Removing the provider withdraws dependent file publication
and retained callers fail without starting a replacement. Pure external discovery retains its
independent lifetime and does not require an OPS kernel or file policy service.

## Requirement and evidence matrix

“Source audit” identifies current code, not an acceptance test for the new architecture. A pending
row remains a delivery requirement even if a smaller slice does not exercise it yet.

| Requirement from #872 | Current evidence or gap | Acceptance still needed |
| --- | --- | --- |
| One kernel per actual DSH instance; startup readiness; no idle exit | Real composition tests cover one startup across Native/official Node PTC file calls, pending-handshake reservation, publication gating, conflicting selections and independent consumer disposal. | Three complete host processes, long idle persistence and migration of remaining eligible paths. |
| Three instances, including identical home/workspace, remain isolated | Public-host probe creates three independent Context roots and kernel processes in one test host; 75 requests use three initial spawns. | Independent connections, shell state, permissions, output and cancellation in at least three full host processes. |
| Unload and normal DSH exit stop admission and clean descendants | Existing invocation owners cancel one-shot calls; they do not prove resident ownership. | Pending and running requests settle honestly; kernel, shells and owned tasks exit. |
| Forced DSH death, control disconnect and kernel crash clean the owned tree | Synthetic public-host probe: Windows six checks pass; WSL five pass, blocked-kernel host-death check fails. See platform evidence below. | Native kernel and shell trees must pass each failure separately; no detached descendants or effects replay; other instances survive. |
| Page disconnect, quiet work and late heartbeat do not imply host death | No resident liveness policy exists. | Quiet task exceeding five minutes survives; page/heartbeat signals cannot trigger process cleanup. |
| Cancellation/deadline belongs to one request | Serve mode targets an independently terminable file leaf. Native helper tests exercise cancellation after a child demonstrably blocks; client tests exercise pre-admission abort and correlated cancellation. | Tool-level deadline/effect mapping and session cancellation; persistent shells remain pending. |
| Private, bounded duplex protocol with request IDs | Explicit serve/client protocol implements readiness, started/completed receipts, targeted cancellation and bounded admission/frames. The earlier compatibility probe passed all four CI platforms. | Production tool routing, streamed command output, adversarial backpressure and final platform evidence. |
| Command bytes cannot forge control receipts; slow consumers exert backpressure | Existing file worker has no command execution or event stream. | Separate control from stdout/stderr; output limits and bounded buffering under a stalled reader. |
| File dispatch, pagination, spill and error contracts remain shared | Windows native probe performs 25 read-only text inspections through existing `dispatch` on one process and refuses writable execution. | Production Native/PTC parity, per-request budgets, path/no-follow/CAS, paging/spill and cancellation tests over the same implementation. |
| Host resolves authority once for each admitted execution | Existing file adapter resolves trusted policy/paths and rechecks after asynchronous preparation. | A single trusted context per admission, queued work re-admission, all three permission modes and credential boundaries. |
| Shell confinement matches current session authority | Current worker does not host shells. | Host confinement at shell creation; close mismatched shells before reuse; follow host revocation policy for active work. |
| Persistent shell is explicit; fresh-shell semantics remain available | No persistent shell is implemented by this audit. | Separate execution modes; cwd/env/functions/options persist only in the selected session shell. |
| Per-shell serial queue and independent concurrent executions | File requests have host-side limits; no kernel shell queue exists. | Ordered commands in one shell, isolation across sessions, bounded admission and independent parallel tasks. |
| Reliable per-command completion and output attribution | No resident shell protocol exists. | Completion without shell exit, silence heuristics or ordinary stdout markers; old background output cannot enter a later result. |
| stdin, exit, exec, redirection and control closure have explicit behavior | Pending shell protocol design and execution tests. | Exercise each case; lost synchronization ends that shell and never fabricates success. |
| Cancel first interrupts, then may reset only that shell tree | No inner process cancellation boundary exists. | Hard cancellation reports shell-reset/state loss; other sessions continue. |
| Explicit background tasks use DSH job_list/job_output/job_kill | Rust `Job` is a file-batch audit record, not the DSH process-job service. | Immediate jobId, independent output, atomic startup/publication handoff, job-tree kill, session/host cleanup. |
| Ordinary command descendants do not become implicit services | Pending shell/task ownership implementation. | Unregistered descendants cannot silently cross calls; published jobs are not killed merely because their startup request completed. |
| Migration leaves one execution architecture | Local files, result cleanup and Windows batch/result calls use the shared client without one-shot fallback. Restricted POSIX batch/result and explicit WSL reads retain their platform runners. | Complete remaining platform migrations without weakening their execution constraints. |
| End-to-end performance and resource evidence | Windows baseline: 824 calls, 0 failures, including 200 hot samples for each of four items. No resident benefit measured. | Resident A/B, Native/PTC, cold/warm, file/command/mixed/concurrent/long workloads; p50/p95/p99, CPU/RSS/handles and failures. |

## Rust reuse boundary

| Source | Existing behavior | Consequence for a serve entry point |
| --- | --- | --- |
| `native/src/main.rs::main` | Reads at most 2 MiB + 1 through stdin EOF, decodes once, then writes one newline-terminated JSON value. | Add explicit serve framing; do not put the current `main` body in a loop. Legacy one-shot input stays explicitly separate. |
| `native/src/main.rs::main` deadline thread | Sleeps for the decoded timeout then calls `process::exit(124)`. Its lifetime ends only with the one-shot process. | Remove this mechanism from serve execution. Old request timers must never kill later requests or the kernel. |
| `native/crates/ops-protocol/src/envelope.rs` | Validates version, requestId, component, storage and budgets. Request limit 2 MiB; response maxBytes 1–128 KiB; raw default timeout 300 seconds. | Reuse boundary validation and effect-aware encoding. Correlate response events explicitly and count framing overhead against output limits. Do not accept malformed serve input as legacy input. |
| `src/execution/protocol.ts::workerEnvelope` | Bridge requests cap timeout at 30 seconds and output at 128 KiB. | These are request budgets, not a five-minute kernel-idle rule. Preserve relevant budgets when replacing transport. |
| `native/src/lib.rs::dispatch` | Validates/canonicalizes the root, opens a request-local directory handle, computes root identity, routes existing capabilities and finishes spill. | Reuse this entry point after trusted admission; keep file behavior out of the transport layer. |
| `native/crates/ops-protocol/src/lib.rs::Request` | Holds authority fields, output budget, storage and `Rc<OutputSink>`; there is no cancellation/deadline context. | Add one typed execution context owned by the request. `Request` is not `Send`; decoding inside its execution thread avoids turning all local capture state into shared locks. |
| `native/crates/ops-protocol/src/capture.rs::OutputSink` | Request-local `RefCell` capture, bounded near 10 MiB. | Keep capture local. Add bounded transport buffering independently; capture quotas alone do not provide stream backpressure. |
| `native/crates/ops-search/src/scan.rs::Scan` | Checks its own 30-second deadline between scan/read steps; index enumeration receives the remaining scan time. | Compose the operation limit with the request deadline and cancellation; preserve partial coverage and no-cursor rules. It cannot interrupt an OS call already blocked. |
| `native/crates/ops-files/src/file.rs::read_bytes/stream_facts` | Text reads retain up to 32 MiB; hashing streams whole files without cancellation checkpoints. | Add checks around bounded chunks. `stat` hashes content and is not a cheap, size-bounded metadata operation. |
| `native/crates/ops-files/src/file_prefetch.rs::load` | Up to two scoped read threads, followed by joins. | A parent cancellation cannot stop a blocked child read today; no detached thread may outlive its owned execution. |
| `native/crates/ops-documents/src/lib.rs`, `xml.rs`, `pdf_text.rs` | Separate 30-second checks around table/XML/PDF work; parsing and I/O remain synchronous. | Propagate the same request cancellation/deadline, retaining each document's existing limits and partial-result facts. |
| `native/crates/ops-files/src/file_single.rs::authorize_write` | Applies read-only and write-root checks after no-follow path validation; mutation code keeps CAS/publication receipts. | Keep those checks and publication boundaries. Cancellation cannot turn a possibly published write into `effectState:none`. |
| `native/crates/ops-batch/src/lib.rs::execute` | Records `State::Unknown` before applying an operation; unresolved effects are verified, not blindly repeated. | Preserve this audit behavior. It is not a license for automatic request replay or a replacement for DSH jobs. |
| `native/crates/ops-results/src/spill.rs::finish` | Produces bounded output and may write private result storage, including for observation tools in writable sessions. | “Read-only tool” does not imply zero storage effects. The initial no-write probe must use read_only=true with storage absent. |

The fixed-file bridge in `src/execution/files.ts` deliberately uses the trusted data-only execution
model rather than an arbitrary-code sandbox runner. It obtains session policy, resolves paths,
sets read_only/write_roots/denied credential roots and validates authority after asynchronous
preparation. Model arguments do not supply that authority. The resident file path must preserve
this model; a shell path requires its own effective host confinement.

## Request lifetime design constraints

A control reader must remain able to receive cancellation while execution or output is blocked.
A bounded frame reader and bounded result writer can serve that purpose; unlimited thread spawning,
unbounded queues or buffering a whole session's stdout cannot. Request IDs need one terminal
receipt each, with explicit treatment of duplicate IDs, cancellation after settlement and incomplete
frames. The private connection carries trusted host context; command stdout/stderr is a separate
data plane. Exact frame schema and limits must be finalized in the implementation slice.

Within Rust, a deadline and cancellation flag should travel with one request execution context.
Check before execution, between bounded work units, and before publication where safe. Preserve
known applied/partial effects after a commit point; return unknown where publication cannot be
determined. Sending a cancel acknowledgement is not proof that work has stopped.

Cooperative checks cannot interrupt every filesystem syscall, parser or platform operation.
Unbounded/blocking units need an independently terminable execution boundary before migrating;
otherwise keep them outside the resident hot path explicitly. Killing the whole kernel for one
request, abandoning a thread, or returning “cancelled” while a write continues is not an acceptable
substitute. Existing process-scoped cancellation currently supplies a guarantee that a resident
dispatcher does not yet have.

Only authority boundaries, IPC, persisted data and OS outcomes require validation. Internal
execution should use typed contexts and direct calls, rather than adding parallel guard/lease/seal
systems. State should be request-, session- or instance-owned; immutable code constants and the
existing credential-pattern cache are not execution ownership.

## Public host capability questions

The host feasibility probe must answer these before a production transport is selected. The Rust
audit alone cannot establish them.

| Question | Status |
| --- | --- |
| Can public subprocess APIs start one process with a continuing duplex connection and usable streamed readers/writers? | Yes for the Node fixture on Windows/WSL and the Rust probe on Windows, using `stdio.control:'pipe'` and `SubprocessHandle.control`. Windows native fd-7 access passes six checks below; other native targets remain pending. |
| Can a private IPC endpoint be created once, kept private and tied to the host-owned process lifetime when stdio is unsuitable? | The public inherited control channel is separate from stdout/stderr; the fixture proves their separation and uses bounded frames/queues. No external socket service or per-call runner is required. |
| Does unload, forced host death, control disconnect and kernel crash reap descendants on Windows and POSIX without breakaway/detach? | Windows probe passes all six checks. WSL using the provider's process-group fallback passes five; host SIGKILL with a blocked kernel leaves two live sleeping processes. Native Linux systemd-scope ownership remains untested. |
| Can the host apply the required confinement to independently cancellable shell/task execution units from a resident parent? | Pending; must preserve actual sandbox guarantees. |
| Can explicit task publication/cleanup reuse public DSH jobs without duplicate ownership or a cancellation handoff gap? | Pending job integration slice. |

If a public interface cannot supply one of these guarantees, record the concrete gap and decision.
Do not bypass it with bare spawn, private host patches, relaxed confinement or an unrelated service.

### Public-host probe evidence

Run `node bench/probes/probe-872-host.mjs` after installing the pinned dependencies. This is a
synthetic Node kernel and ordinary non-detached child, not the Rust serve implementation. Every
kernel starts through public `ctx.subprocess.spawn`; raw spawning exists only in the disposable
test host and its synthetic shell child. The child inherits the one outer ownership range.

The pinned `@deepseek-ai/dsh-subprocess` version is `0.2.2-rc.1`. Its public types expose control
pipe creation, a Duplex endpoint, `terminate()` and `waitForExit()`. Cordis exposes `ctx.root`
(experimental) and async `ctx.effect` disposal. The fixture keeps ownership in each plugin's
closure and verifies that unloading one root leaves the other two operational. It also verifies
that ordinary stdout/stderr never enter control responses. Frames are capped at 64 KiB and the
receive queue at 16; this smoke probe does not replace adversarial protocol/backpressure tests.

| Platform | Observed result | Limits of the evidence |
| --- | --- | --- |
| Windows, Node `v26.12.1` | Six checks pass; 75 read-only fixture requests use three initial kernel spawns; no emergency cleanup needed. Consumer unload, responsive/blocked control loss, kernel hard crash, and responsive/blocked kernel after host SIGKILL clean their ordinary descendants. | No Rust kernel, persistent shell, breakaway child or create-to-Job-assignment crash race is tested. |
| WSL Ubuntu, Node `v24.11.1`, process-group fallback | Five checks pass. Host SIGKILL while the kernel event loop is blocked leaves kernel PID 641 and leaf PID 648 alive beyond the ten-second deadline; the observer performs explicit emergency cleanup. Both have `/proc` state `S`, process group/session 641, and cgroup `0::/init.scope`. | Every kernel in the instrumented run remained in `/init.scope`, proving this was not a native `dsh-subprocess-*.scope` launch. A reachable user manager alone did not cause native selection; the reason was not established. Native systemd-scope behavior is untested. |

Windows source explains its independent host-death path: the private Job runner's IPC
`onDisconnect` calls `releaseOwnedJob` (`dsh-subprocess-local/lib/runner.js`), and the Job uses
`KILL_ON_JOB_CLOSE` (`dsh-win32-process/lib/index.js`). This is host implementation evidence,
not a private interface OPS may call. Linux `scopeArgs` starts a user scope without a host-lifetime
binding; `terminateForHostExit` is invoked by a JavaScript `exit` listener. Provider selection can
fall back, and the public handle does not expose the selected containment capability.

A POSIX native kernel therefore needs a control-EOF watcher independent of dispatch and output,
with centralized cleanup of its owned processes. Prove that path while dispatch is blocked;
silence, heartbeats and UI disconnect are not death signals. The blocked Node fixture tests the
stronger host-only cleanup capability; its failure does not establish that #872 is impossible.
Windows native control access is now demonstrated below. Native cleanup while dispatch is blocked,
descendant cleanup, confinement and hard kernel crash still need separate runnable acceptance
evidence before selecting the production architecture.

### Native control and dispatch probe

Build `cargo build --locked --manifest-path native/Cargo.toml --example resident_probe`, then run
`node bench/probes/probe-872-native.mjs`. This example is an explicit compatibility probe, not the
production worker's serve entry point or plugin activation path. It accepts only read-only text
`inspect_local_file` requests with no storage/cache grant, and uses the existing dispatcher.

`native/crates/ops-process` isolates platform I/O from the unsafe-free core. POSIX duplicates the
inherited socket with close-on-exec; Windows resolves CRT descriptor 7, duplicates its OS handle
without inheritance, then closes the CRT-owned original. Windows reads/writes use overlapped I/O
and per-operation events, because the host pipe is asynchronous. The helper reuses the already
locked `libc 0.2.190` and `windows-sys 0.61.2`; it introduces no newly resolved external package.

The Windows run on Node `v26.12.1` passes six checks: 25 correlated inspections use one native
process; writable execution is refused; control EOF exits without a host terminate callback;
malformed JSON ends the probe; input exceeding the 64 KiB frame cap ends the probe; and startup
without an inherited control channel exits cleanly with an error and no handshake. Ordinary stdout
is separately asserted. Helper and example unit suites each pass one test; helper Clippy with all
targets and warnings denied passes. CI is configured to build and run this native probe on all
four shipped platforms; [PR #901 CI](https://github.com/T-Auto/dsh-ops/actions/runs/43429421444)
passed all four, including this compatibility probe.

The probe's dedicated reader receives control EOF independently of dispatch. Its one-slot pending
queue closes the probe on overload; this is not the production admission/backpressure protocol.
The handshake explicitly marks request cancellation and deadline enforcement unsupported. EOF
terminates this entire read-only probe, and is not a per-request cancellation implementation.
No blocked-dispatch, descendant, forced-host-death or plugin-unload claim follows from these six
checks. The newer explicit serve implementation and local file integration are described above;
persistent shells, task jobs and complete acceptance remain pending.

## Implementation slices and exit evidence

The deterministic isolation regression builds `native/examples/resident_blocked.rs` and runs
`node bench/probes/probe-872-isolation.mjs` after the normal plugin build. The example imports
the production `resident.rs` directly; its one-shot leaf writes a PID receipt only after stdin
EOF and then blocks for ten minutes. No test switch or environment hook enters the shipped worker.
The probe uses the production client and the pinned public subprocess provider. It proves that
one blocked request can be killed while another blocked leaf and fast requests remain alive,
and that disconnect, kernel crash and provider unload join their owned leaves without replay.
An observer records exact PIDs and checks survivors before emergency cleanup. The Windows run
passes all four checks with no survivors; CI runs the same checks on all four shipped platforms.
Reports remain under `bench/runs/blocked-resident-*`. This is controlled blocking in a test leaf,
not arbitrary filesystem cancellation, the production deadline path, three full DSH applications,
persistent-shell isolation, or the five-minute quiet-task acceptance requirement.

| Slice | Runnable delivery | Required evidence before accepting that slice |
| --- | --- | --- |
| A — resident vertical slice | Plugin-owned startup/handshake, one existing read-only dispatch on a small local fixture, unload and forced-host-exit handling. | Real public host interfaces; exactly one owned process; repeated request without EOF/per-call runner; bounded framing; lifecycle probe; full old-path call baseline. This is not completion of persistent shell or general file migration. |
| B — file hot path | Native/PTC share the accepted connection and existing dispatch with request budgets and cancellation. | Authority/no-follow/CAS, partial output and spill parity; queued admission; one request cancellation leaves another alive; blocking-unit limits explicitly resolved. Remove replaced file transport only after parity. |
| C — persistent shell | Explicit session-shell mode, persistent state, serial queue, reliable receipts/output attribution and reset after hard cancellation. | cwd/env/functions/options persistence, session isolation, stdin/exit/exec/redirection tests, cancellation/state-loss behavior and confinement equality. |
| D — background and integration | DSH job registration, startup handoff, permission-change handling, multi-instance ownership and crash cleanup. | Existing job_list/job_output/job_kill; published job survives its starter; unpublished cancelled start cannot leak; session/host/tree cleanup. |
| E — performance and cleanup | Full alternating A/B workload/resource report and removal of superseded orchestration. | Contract parity plus latency/resource/failure distributions; documentation/schema aligned with the implemented modes; no duplicate transport or recovery state. |

Slice A should exercise an explicit serve path and the existing dispatch, with read_only=true,
no storage grant and a small known fixture. No tool should be silently routed into a general
resident file service before request isolation and cancellation are proven. Even a tiny local
fixture does not prove arbitrary path I/O can always be cancelled promptly. Any pending ownership
or cancellation guarantee must remain visible in the slice's acceptance report.

For the final report, measure at least 200 warm samples per case across interleaved rounds and
report p50/p95/p99, CPU, RSS, handles and failed samples. Include cold startup, Native/PTC,
file/command/mixed tasks, concurrency and long quiet work. Linux/WSL comparisons must identify
containment and filesystem placement. Echo p50 ≤ 15 ms and p95 ≤ 40 ms are challenge targets,
not measured results or a claim of task-level improvement. No antivirus disabling, relaxed sandbox
or cross-drive mismatch is an acceptable way to reach them.

## Windows shell process substrate (C1)

`ops-process::shell` now provides a Windows-only ownership and I/O substrate. It is exercised
by `native/examples/shell_range.rs` and `bench/probes/probe-872-shell-range.mjs`; published shell
tools still use their existing execution path. This slice does not establish persistent command
completion, session queues, background jobs, permission readmission, or the final performance goal.

The caller supplies the public sandbox provider's exact argv and a complete explicit environment,
starting from public `scrubbedParentEnv()`. The native module does not resolve policy or inherit the
resident kernel's ambient environment. It rejects relative executables, invalid Windows arguments
and duplicate environment names, and removes the inherited control marker. `CreateProcessW` uses
`CREATE_SUSPENDED`, an explicit three-handle stdin/stdout/stderr list, and atomic
`PROC_THREAD_ATTRIBUTE_JOB_LIST` assignment before resuming the primary thread. Stdin is EOF.
The nested Job has kill-on-close and no breakaway; child creation, including a detached child,
remains inside this range. Its hidden private console is separate from sibling shell consoles.

Each private channel has a random name, at most four precreated pipe instances, fixed pipe buffers,
and a configurable retained prefix capped at 128 KiB. Observed-byte counts continue after the
retention cap. The protected ACL grants the owner/SYSTEM and current logon SID, with a Low
mandatory label; it does not grant Everyone write. The server verifies each actual pipe peer's Job
membership before accepting bytes and closes rejected or finished instances. A failed identity
observation is a channel error, not complete output. After confirmed Job emptiness, `drain()` seals
unused connects and waits for admitted writers' real EOF; a deadline is an error. `close()` is abort,
not a completion receipt. Ordinary process stdout/stderr are independently bounded and drained.

Soft interruption uses a fixed, trusted, cancellation-only executable entry point. The controller
is itself started through the atomic range launcher with an empty environment, a bounded receipt,
and a deadline, and is joined on success, timeout and failure. Only that disposable process calls
`AttachConsole` and `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)`; it exits without calling
`FreeConsole` after signalling. The resident kernel never changes its console or handlers.
This matters because Windows delivers console signals asynchronously and
[FreeConsole resets the handler table](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler).
An earlier in-kernel attempt reproducibly killed the kernel with `STATUS_CONTROL_C_EXIT` before
the next control request. The current probe retains the next-request and sibling checks that
exposed it. A successful signal receipt means attempted delivery, not cooperation: the actual
restricted wrappers retain their ignore-Ctrl+C behavior and require an owned range reset.

Reproduce on Windows with a complete verified Niubash payload:

```console
npm run build
cargo build --locked --manifest-path native/Cargo.toml --example shell_range --example shell_signal_fault
cargo build --locked --manifest-path native/Cargo.toml -p ops-process --example shell_signal_cooperative
cargo test --locked --manifest-path native/Cargo.toml -p ops-process
node bench/probes/probe-872-shell-range.mjs <shell_range.exe> <pinned-niu.exe>
```

The probe uses only a fresh temporary workspace for the real public sandbox policies. The installed
Windows backend reports `partial` enforcement for both restricted modes; the report preserves that
fact rather than claiming absolute confinement. The default pinned runtime and dependency versions
are unchanged; only existing `windows-sys` features are enabled. POSIX returns explicit unsupported
for this new substrate because a new process group can escape the host's fallback ownership.
Existing POSIX execution is unchanged. Native process-group/cgroup ownership needs separate proof.

Local Windows validation: the public-host probe passes **13 checks**, including two later
cooperative fixture shells trapping INT and exiting 42, restricted soft-attempt/hard-reset, helper timeout
and crash, sibling isolation, hard kernel death, EOF teardown, four independently drained 1 MiB
streams retaining 1024 bytes each, and no tracked survivors. The `ops-process` suite passes **17
tests**, with one existing child fixture ignored by the harness and explicitly invoked by its
lifecycle tests. The native workspace suite exits successfully. These are C1 results, not a
completed #872 acceptance report.

The positive INT fixture explicitly enables Ctrl+C before starting Niubash; its waiter uses a
non-inherited handler. Git Bash/CI can pass an inherited ignore flag, which caused this assertion
to fail despite a successful production signal attempt. The production launcher preserves that
baseline, and ignored signals still require range termination. Both PowerShell and Git Bash run
the same cooperative assertion; neither skips nor retries it.

## Validation record

- Source audit: `e7244444`, covering the paths above; no source behavior changed by this document.
- Public host feasibility: synthetic probe passes six checks on Windows; WSL process-group fallback passes five and fails blocked-kernel host-death cleanup. Cgroup and `/proc` diagnostics establish two live sleeping survivors, not zombies. Native Linux scope ownership remains untested.
- Current full-call baseline: 824 Windows calls passed; see the measured baseline below. No resident comparison exists yet.
- Resident dispatch/cancellation: pending implementation and tests.
- Persistent shell/background jobs: pending implementation and tests.
- Cross-platform cleanup, multi-instance isolation and full A/B report: pending.

### Current Windows full-call baseline

On 2026-11-13, [the baseline probe](../bench/probes/probe-872-baseline.mjs) measured source
`e7244444`, a freshly built worker, Node `v26.12.1` and the verified Niubash payload. The
[compact evidence](../bench/probes/872/baseline-summary.json) records build hashes, invocation,
cold calls, resources and raw-report hashes. The full 824-call report remains a local artifact;
its SHA-256 is `ff696c3154c0dc429cba6f56e748f213fcf7051bb722751d11f587de577048c1`.

The timer covers admission/prompt assembly through the real Native/PTC executor, validation and
rendering. PTC includes its Node runtime startup. No model API is called. Cases rotate each round:
4 first calls, 5 warmups per case and 200 hot calls per case total **824 calls, zero failures**.
They cause 1,236 public subprocess spawns, including 1,200 during the hot rounds. All cases use
one unchanged `danger-full-access` policy and a local E: fixture; this is not a confinement test.

| Case | First call ms | Hot p50 ms | Hot p95 ms | Hot p99 ms | Hot calls / host spawns |
| --- | ---: | ---: | ---: | ---: | ---: |
| Native file read | 404.5 | 357.1 | 474.2 | 578.1 | 200 / 200 |
| Native fresh command | 6254.9 | 325.7 | 444.0 | 629.5 | 200 / 200 |
| PTC file read | 865.5 | 745.0 | 1004.6 | 1130.6 | 200 / 400 |
| PTC fresh command | 775.4 | 711.6 | 967.7 | 1147.3 | 200 / 400 |

Percentiles use nearest rank and retain failures; the probe also reports successful-only values.
“First call” follows host setup, not application/OS cold startup; the first Native command includes
Niubash preparation and subsequent cases share warmed services. Host CPU across the hot calls is
9.687 s user / 29.109 s system. Host RSS is 74.2 MB before calls and 147.2 MB afterward, with a
148.6 MB process peak; Windows handle snapshots are 193 then 209, and remain 209 after teardown.
All observed top-level subprocess handles settled. These are host-only measurements, include
retained probe/session data and observer handles, and do not prove absence of leaks or descendants;
child CPU/RSS and whole-tree handles were not measured.

The initial 16-call smoke run retained **eight shell failures** (`EXECUTOR_UNAVAILABLE`,
`ENAMETOOLONG` during Niubash preparation under the sandbox's long temporary path); all eight file
calls passed. A separate short-TMP/TEMP smoke passed all 16 calls before the full run. Both reports'
hashes and failure counts remain in the compact evidence; no failed samples were removed. Reproduce
with a complete `--bash` payload and a short temporary directory, then run the probe with its default
`--samples 200 --warmup 5`. A separate WSL feasibility probe overlapped the first few full-run rounds;
no heavy Windows build overlapped. This is a current single-machine baseline, not a Windows/Linux
comparison, dedicated-idle-machine result, resident A/B result or performance improvement claim.

The archived baseline used the probe at `1fc5ba08`. The current probe explicitly mounts the
resident provider and labels new reports `resident-file-measurement`; fresh commands keep their
existing semantics. Its host spawn counter excludes native execution leaves, and its CPU/RSS
counters exclude child processes. A current run alone does not establish an A/B improvement or
the complete performance/resource acceptance required by #872.
