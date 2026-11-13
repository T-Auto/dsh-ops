# Shared spill for private shell channels

中文：[私有 Shell 通道共享溢写](私有Shell通道共享溢写.md)

This internal #872 slice reuses the [native raw-spill foundation](native-raw-spill.md)
for per-command persistent-shell stdout and stderr. It adds no second writer,
store, ledger, cleanup service, or host scheduler. Public tools and runtime pins
are unchanged. POSIX owned-range support remains unavailable.

`Driver::prepare_with_spill(Some(store))` accepts a clone of the kernel owner's
`SpillStore`; the same instance can also be passed to task `Range::enable_spill`.
Ordinary `Driver::prepare()` uses no spill. Command, bootstrap, and completion
receipt pipes keep their small bounded prefix buffers. Only the two output
channels opt in, keeping their existing bounded prefix while the shared store
provides a complete raw file up to its 64 MiB cap.

The existing four-instance pipe bound, Job peer check, exact prefix selection,
and connect-arming barrier still apply. Empty metadata opens do not start a
capture, publish a spill, or mark output EOF. Only the authenticated prefix
winner owns `Output`. `OUT:<id>` / `ERR:<id>` are stripped before byte accounting
and never enter the file. Binary output, including invalid UTF-8, remains raw in
the file even when the small display prefix uses replacement characters.

`ChannelSnapshot` adds the same `spill` and `spill_error` metadata as task
capture. `writer_closed` records authenticated pipe EOF; `writer_eof` remains
false until capture sealing finishes. `storage_pending` reports actual reader
work, not a quiet-period heuristic. These facts let the Driver distinguish a
pending write/seal from a retained descriptor. Known storage work refreshes the
existing short descriptor-settlement grace; the independent request deadline
remains effective. Success still requires the private completion receipt,
physical output completion, and exact retained bootstrap identities.

Filesystem work stays on the existing channel reader and never under a snapshot
or coordinator lock. `Channel::close_until` cancels its file and pipe operations
and joins every reader. If the deadline expires or output is poisoned, it retains
the reader and sets `cleanup_unconfirmed`. `Call::cleanup_unconfirmed` aggregates
that fact; `Driver::cleanup_unconfirmed` covers its owned control/range resources.
The caller must stop admission and close the independent control transport before
dropping a poisoned owner, so the public host terminates the managed kernel.
`Drop` does not detach a still-owned I/O operation. A successful shell-range stop
alone does not certify that a separate per-call capture was joined.
The production session failure path now checks both owners and invokes the
Manager's fatal callback before either can be dropped. Admission closes first;
no terminal receipt is promised after transport loss. A deterministic held-reader
fixture proves this ordering and fails against the previous caller behavior.

The repository `shell_driver --spill` example exercises this boundary. The real
probe verifies the exact memory boundary, full 1 MiB binary stdout/stderr under
all three sandbox modes, retained cwd/environment/functions/options, one shared
store across shells, existing ledger retention, sibling usability, and no owned
survivors. The reviewed local Niubash backport also runs the external commands
as background jobs followed by `wait`. The stock CI invocation explicitly covers
foreground commands only; it does not establish stock async-output eligibility
or silently relax the eventual session feature contract.

Three deterministic native tests verify empty metadata opens versus the real
writer, live full-prefix coverage and framing removal, a stalled write with
responsive snapshots and retained poisoned ownership, and raw EOF while sealing
is still pending. Spill creation/cap/write/close semantics and irreversible poison
remain implemented and tested by the shared foundation. Production session
metadata transport, settled-ledger handoff, and eligible-runtime activation must
be completed before this optional storage is enabled for public sessions.
