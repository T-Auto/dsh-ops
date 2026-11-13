# Native raw output spill foundation

中文：[原生原始输出溢写基础](原生原始输出溢写基础.md)

This internal #872 slice adds recoverable raw output to Windows process ranges.
The repository example is runnable through the public subprocess and sandbox
providers. It does not enable a public task tool, replace the existing shell
runner, or advertise complete persistent-session output. POSIX range support
remains explicitly unavailable; existing POSIX execution is unchanged.

## Storage and observation

One `SpillStore` is configured per native owner and cloned into its ranges.
Construction only validates the absolute root and byte cap; no filesystem work
runs on the coordinator. The first stream exceeding its memory budget creates
the shared private directory on its existing output reader. Directory creation
failure is cached for that store and degrades streams to their bounded memory
tail, with `spillError`. It does not fail kernel startup or file operations.

The task example keeps 64,000 raw bytes per stream in memory. Once exceeded, its
lazy file contains the complete stream from byte zero, capped at 64 MiB. Each
bounded write finishes before the corresponding observed counter, tail, and
path are committed together. Snapshot/read locks never cover filesystem I/O.
While a write is pending, the previous snapshot remains accessible. A published
live path covers every byte in that snapshot, but `spillSealed` is still false.

The optional wire fields are `spillPath`, `spillOrigin: "ops-native-v1"`,
`spillPid`, `spillSealed`, and independent `spillError`. The adapter must verify
`spillPid` against the actual resident kernel, not the Node host PID. A raw read
error leaves raw EOF false; spill degradation alone does not fabricate a raw
read error. Exceeding the cap, write failure, or sealing failure withdraws and
discards the complete file while the bounded tail continues draining.

Files use owner/SYSTEM ACLs, unpredictable names, exclusive creation, and
no-follow checks on every ancestor and the opened directory/file. The held
directory cannot be renamed. Unsealed files are delete-on-close; checked sealing
clears that disposition only after raw EOF. Abrupt kernel death therefore
removes unfinished files in the tested path. Sealed files remain recoverable.

## Cancellation and the failure boundary

The existing output reader owns each file, operation, buffer, and completion
event. Writes use at most 8 KiB per operation. Cancellation addresses the exact
writer thread and file; a pending OVERLAPPED buffer is retained until its
completion is observed. No reader is detached on a failed or expired join.

Windows cancellation is a request, not proof that a filesystem driver stopped.
The [Windows cancellation contract](https://learn.microsoft.com/en-us/windows/win32/fileio/canceling-pending-i-o-operations)
requires observing completion before releasing an operation's resources.
If `captures_until(deadline)` cannot join, or checked discard cannot complete,
`cleanup_unconfirmed()` becomes true. Admission must close for that native
owner. It retains its Range/readers and independently shuts down the control
pipe so the public host terminates and joins the whole managed kernel range.
It must not report an independently cleaned task, reuse that Range, or launch
another range under the poisoned owner. `Drop` retains unjoined readers; it is
not a substitute for that fatal transport callback. A close/disposition failure
is cleanup uncertainty, not a claim that every file was removed.
Poisoning is irreversible: late bytes may update the bounded diagnostic tail,
but cannot clear the raw error, restore EOF, or republish a complete path. A
reader that observes poison discards instead of sealing. A seal already in
progress can still finish after poison; its path remains withdrawn and the
owner still requires fatal teardown, without claiming file cleanup succeeded.

## Recovery and retention

The existing spill ledger accepts an optional native origin. Native paths must
match `<real temp>/dsh-ops-native-<kernel PID>-<32 hex>/`
`{stdout,stderr}-<32 hex>.log`, with the recorded PID matching the directory and
the complete byte count within 64 MiB. Legacy host-provider entries are
unchanged. Only joined, sealed files enter the settled ledger. Retention refuses
symlink/junction ancestors and non-regular files, retains the existing ownership
checks, and unlinks individual files through the same bounded pass. No second
ledger or background cleanup service is introduced.

Settled files use the existing absolute-path file-reading permission path.
Credential fences and native no-follow checks still apply; workspace-write
authority does not gain permission to modify these files. The real probe reads
a spilled header with `inspect_local_file` and verifies the corresponding write
is rejected. No arbitrary temporary-directory write grant is added.

## Verification and remaining work

Windows CI runs `probe-872-spill.mjs` and `probe-872-spill-fatal.mjs`. The former
checks the exact memory boundary, live/sealed recovery, the exact 64 MiB cap,
cancelled-stream sealing, shared retention, and hard-kernel-death cleanup. The
latter explicitly invokes a test-only unresponsive writer, observes cleanup
uncertainty and retained ownership, then joins public-host teardown and proves
the host can run another independently owned process. Native tests also cover
real pending-I/O cancellation, lazy-store failure, reparse refusal, and write/
seal failure. Ignored native child fixtures are explicitly executed by these
tests/probes; they are not feature skips.

The [task integration](resident-task-spill.md) now configures this same store
before readiness, carries complete native metadata and settles sealed files in
the existing ledger. Persistent private channels still use their existing prefix
retention; their store and session-adapter integration remain pending. `task-v1`
alone does not imply spill parity; production activation must also require the
completed `task-spill-v1` capability.
