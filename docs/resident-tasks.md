# Internal resident task adapter

This #872 slice connects the existing resident control channel to fresh native tasks and the public
DSH Jobs lifecycle. It is internal: the published fresh Bash executor, its defaults and its host
subprocess path are unchanged. Native output spill parity and the production fresh authority/runtime
bridge are prerequisites for switching that path. This is not persistent-shell eligibility evidence.

`ResidentClient.task` negotiates `task-v1`; absent capability refuses task admission. The same scoped
kernel remains responsible for file and shell traffic. A bounded correlation map in TypeScript tracks
promises, not scheduling: native owns task admission, deadlines, promotion, process ranges and terminal
receipts. Both capabilities together reserve 609 outbound frames, including control/output slots for
accepted requests. Task and exact Agent/Session owner tables each cap at 32; completed native records
remain reserved until their final reads and explicit release.

The internal `createTaskExecutionHost()` factory belongs to one owning activation. Its caller supplies
an asynchronous per-head `admit(signal)` callback that must obtain current public confinement. The
adapter rechecks exact Agent/Session ownership around that callback and ignores late answers after
cancellation. This callback is an integration seam, not a model-facing arbitrary-argv API. Production
fresh argument/cwd/script validation, approval-before-background-publication, environment preparation,
policy-change handling and result classification must be connected before publication changes.

Each accepted execution implements the existing `ShellExecution` contract plus explicit effect and
cleanup facts and native `promote()`. `started` means observed physical launch. Accepted traffic with
no start receipt still has unknown effects unless a native receipt proves none. Cancellation requests
stop but does not settle the result until native cleanup and both output readers finish. Transport loss
waits for the outer owned range; uncertain cleanup remains uncertain. No failed request is replayed.

The native task lifetime starts as `foreground` or explicit `job`. DSH registers foreground work in
Jobs too, so mere registration does not authorize descendants to outlive a fresh root. Foreground
expiry before physical start cancels and joins preparation; after start, native arbitrates promotion
against root exit. An accepted promotion keeps the original process and public job ID. A refused
promotion collects the original terminal result. No replacement process is spawned.
An optional wire `timeoutMs` is an independent hard execution cap and remains armed after promotion.
The Jobs strategy constructs executions with `onExpiry: "none"`, omitting that native cap; its public
foreground wait timer governs handoff only. Direct calls without Jobs retain their execution cap.

Explicit background handoff occurs at the public Jobs registration commit. A reentrant registered
listener may run before `jobs.start()` returns: caller cancellation checks the actual committed record,
while registry cancellation already controls the producer. Published jobs survive their starter's
disposal. Exact Agent, Jobs service or common kernel ownership still governs cleanup. A foreground
caller abort during promotion cancels and joins before returning; an observation-only Jobs wait timeout
does not cancel a published job. Native and PTC can later share this adapter without changing Jobs IDs.

Native owns raw capture and spill. The host holds at most 64000 raw bytes per stream to serve the public
synchronous `readFrom` API; it pulls a non-consuming snapshot at a bounded cadence and performs final
reads before producer completion. Offsets count raw bytes. Empty live output is not EOF. Capture error
with `eof:false` fails the producer explicitly while preserving observed bytes and joining the sibling
stream. After Jobs performs its final pump and settles, published jobs retain its existing ring and
spill metadata, not another retained pair of adapter tails. No host spill writer is added.

Live `spillPath` is withdrawn when native no longer advertises an intact stream. At this stage the
adapter does not establish recoverable-spill or native-origin ledger parity. The full retention,
paging and budget contract remains a release prerequisite. Public fractional positive `graceMs` and
timeout values remain valid within the host timer range; the public wrapper's existing limits remain
its responsibility.

The targeted suites distinguish evidence: `resident-task-channel` exercises the bounded scripted
transport; `resident-task-execution` combines that boundary with real Agent/Cordis ownership;
`resident-task-jobs` uses the real public Jobs registry with instrumented producers for deterministic
registration, promotion and cancellation races. None establishes physical process cleanup alone.
The separate [task host probe](../bench/probes/probe-872-task-host.mjs) requires an explicitly selected
native worker and official Jobs controller module, records their concrete outcome, and uses actual
public sandbox confinement. Optional `--bash` adds fresh command/script fixture checks. It makes no
performance, public-default migration or persistent-state claim.

The 2026-11-14 local build passed, with 30 new targeted checks and 14 existing shell-channel checks
passing without skips. A first ownership-test assertion expected Cordis fiber disposal to reject;
Cordis contains that error, so the assertion was corrected to observe the adapter's explicit disposal
promise. The separate real probe passed seven checks across nine enqueued tasks, including fresh
stock Bash command/stdin and a script path containing spaces and Chinese characters. Eight launches
used actual public `workspace-write` confinement, which reported **partial** enforcement.
Worker SHA-256 was `5a2e34d8174244271abf14fcd653a9c2c49463fd81f103afe14725607cbdfcbc`;
fresh Bash SHA-256 was `7ec3ec04ce91bae64c23d7150e6b16574e9d91df8fcf0df997006e2b37bf2f1e`.
The local `task-host-final-d2.json` report has SHA-256
`d78bf4068e5521cc0d89b133d961bec27320434e39bd89023ea4df69c0b81850`.
The earlier Node-only and fresh-Bash reports are retained separately. Cleanup completed and the
observed kernel PID 11580 was gone. This worker retained tails only;
the probe observed no spill path and establishes no complete-spill retention or production approval
bridge. Passing stock Bash fresh execution does not qualify that runtime for persistent sessions.

After the base serialized owner sealing with admission publication, the same real probe passed
7/7 again against worker `2fcf7f1d608b71fe53d121c892465bd58bf0bb04765d7ee260c441c1c58c3b2e`.
The `task-host-owner-order-final.json` report hash is
`3d0c4e3831abf1e462a5838d5e1959281593a8a090a829943fb4005cc1eef1e8`;
kernel PID 15456 was gone and cleanup was confirmed. The preceding report remains separate.
