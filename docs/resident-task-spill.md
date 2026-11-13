# Resident task output and retention

[中文](常驻任务输出与保留.md)

This #872 slice connects the shared [raw spill foundation](native-raw-spill.md)
to the native task queue and the existing host output/retention contracts. The
Windows kernel configures one allocation-only `SpillStore` before readiness and
advertises `task-v1` plus `task-spill-v1`. `task-v1` alone remains insufficient for
a production fresh-backend switch. This slice does not change the published
fresh executor, enable persistent sessions or qualify a shell runtime.

The kernel's fixed task workers clone the shared store into independently owned
process ranges. Each stream still retains the newest 64,000 raw bytes. Spill
initialization is lazy on the existing reader; failure degrades to a bounded
tail without failing kernel startup. A complete stream up to 64 MiB is exposed
through `spillPath`, `spillOrigin: ops-native-v1`, `spillPid`, `spillSealed` and
independent `spillError` on the existing correlated output receipt. Live paths
cover the receipt's entire observed prefix. Cap or storage failure withdraws
that path; it never turns a partial file into complete output.

`task.read` remains non-consuming and bounded. The host verifies the native PID
against the actual kernel and keeps separate live raw cursors for Jobs. Terminal
reads must agree with native stream totals and any returned spill must be sealed.
The public result remains the existing bounded `ShellStream` shape, with a full
spill path only when native still certifies it. No host output writer is added.

After both final reads and cleanup confirmation, task settlement records only
EOF-confirmed, error-free, sealed native streams in the existing ledger. The
entry carries the exact kernel PID, raw byte total and captured owner Session ID.
A command failure does not invalidate a separately complete stream, but a raw
capture error or unknown cleanup cannot establish settled ownership. Live paths
are never ledger entries. The shared retention scheduler is notified once per
command; ledger or scheduler failure cannot change an already executed result.
The original host subprocess path uses the same settlement helper and preserves
its legacy origin and output contract.

Task completion uses a bounded reader join. Any unconfirmed output cleanup
seals the task owner before publishing failure, retains the poisoned range, and
closes the independent control endpoint. The public host then retires the managed
kernel. Late output cannot restore EOF, a full path or independent cleanup after
poison. The normal targeted cancellation path still joins its own range and can
seal a stream whose complete observed bytes reached EOF; it does not terminate
an unrelated owner merely because a command was cancelled.

The Windows CI [task spill probe](../bench/probes/probe-872-task-spill.mjs) uses
the actual public Jobs registry, sandbox and resident provider. It proves the
memory boundary; exact full stdout/stderr recovery through the existing file
bridge; refused writes under workspace-write; live Jobs spill metadata versus
terminal ledger ownership; cap withdrawal; cancelled-job sealing; the existing
retention pass; and hard kernel crash cleanup without replay. It records its
worker hash, confinement, observed PIDs and cleanup, preserving failure samples.
This is an internal composition, not the production fresh authority bridge or
the separate official Jobs-tool/publication acceptance.

```console
cargo build --locked --manifest-path native/Cargo.toml --bin dsh-ops-worker
npm run build
node test/run.mjs resident-task-spill-settlement resident-task-execution
node bench/probes/probe-872-task-spill.mjs native/target/debug/dsh-ops-worker.exe task-spill-report.json
```

The first local integrated run passed seven checks with workspace-write/partial
confinement. Kernel PID 23044 was gone; no observed PID survived before emergency
cleanup. Worker SHA-256:
`51ec139dc8e7dbb9fe7881ee71aa25c691e070bfeb122f50e7520a6bfe7383e6`.
The retained `task-spill-first-report.json` SHA-256 is
`29a0f9ac4320a09f66b719302c3024f4069a954de64758acc817e0f02d2938dc`.
The native task regression run passed 11 tests, with one child fixture ignored
at discovery and explicitly invoked by its parent. The two poison-ordering tests
both failed when only the pre-publication owner seal was removed, then both
passed after restoration. Host settlement, execution and existing retention
checks passed 39 assertions across four suites; channel, Jobs and original
execution contracts passed another 26 across three suites.
Production fresh authority/runtime integration, persistent-channel spill, accepted
session runtime distribution and final performance acceptance remain pending.
