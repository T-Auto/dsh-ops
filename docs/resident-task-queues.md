# Internal resident task queue

[中文](常驻任务队列协议.md)

This #872 slice adds the internal Windows `task-v1` protocol to the existing
host-owned kernel. It executes fresh, independently owned tasks; it does not
publish a tool or switch the production fresh/Jobs adapter. POSIX advertises no
task capability because equivalent public-host ownership is not established.

The host sends `task.execute` with a unique `requestId`, exact private `ownerKey`,
`lifetime: foreground | job`, positive finite `graceMs`, optional `timeoutMs`, and
`output: { memoryBytes: 64000, spillBytes: 67108864 }`. Fractional milliseconds
retain the existing fresh timer contract. The timeout is an independent hard
execution cap, including queue time, and remains armed after promotion. A host
Jobs adapter must own its observation/handoff timer and omit this hard cap for
work intended to continue after that timer. The spill budget is validated but
recoverable spill is not implemented by this slice: output is currently a tail.

Eight fixed workers consume a FIFO queue. There are at most 32 retained task
records, 32 owners and 64 pending owner controls. Completed records occupy their
slot until `task.release`. Deadline waiters are bounded by those records and
joined on teardown. An owner can run independent fresh tasks concurrently.
Persistent shell commands retain their separate per-session FIFO semantics.

At each queue head, `task.admit` asks the host for current authority. The host
replies with `task.admission`, either `decision: launch` plus exact public-confined
`launch: { argv, cwd, env }`, or `decision: reject` plus a structured error. The
kernel never resolves policy or reuses approval. Cancellation and owner closure
can settle unstarted tasks while admission is pending; late replies cannot
revive a completed task. No child is launched for a rejected head.

Each launch uses an independent nested Windows Job inside the public host's
kernel ownership. Closed-pipe stdin, raw output capture and held root handles
come from the shared process substrate. `task.started` acknowledges successful
process creation; it is not a barrier before effects. Once launch is attempted,
lost acknowledgements cannot justify an `effectState: none` result.

An ordinary foreground root exit drains for the configured grace and then
terminates remaining descendants. `lifetime: job` explicitly retains descendants
after root exit. `task.promote` changes an existing running range to that lifetime
and receives `task.promoted { accepted }`; the same mutex arbitrates promotion
and entry into root-exit cleanup. Cleaning/completed tasks cannot be promoted,
and creating a host job record alone never changes native ownership. Promotion
does not clone or relaunch the task.

Existing `cancel { requestId }` targets only that range. A bounded owned console
signal attempt is followed by hard-stop confirmation. Completion waits for Job
emptiness, the held root handle and both output readers. `task.completed` includes
status, actual exit code, effect state, cleanup confirmation, stream totals and
any structured failure. Exit code 259 is valid. Capture failure preserves partial
output and reports `OUTPUT_INCOMPLETE`; it cannot become a successful EOF.

`task.read` supplies stream, raw byte offset and `maxBytes` (1–65536).
`task.output` echoes the requested offset and returns `retainedOffset`,
`nextOffset`, `bytesBase64`, `lossy`, `eof` and any error. The newest 64,000 bytes
per stream are retained, with all observed bytes counted. A smaller read cap
returns the newest suffix and explicitly reports the skipped bytes. Readers do
not consume one another's cursors. Empty live output is not EOF, and a cursor
beyond the observed total is an error. Text decoding belongs to the host.

`task.closeOwner` seals the owner before cancelling its requests. Its
`task.ownerClosed` reply follows every pending task's terminal publication and
reports confirmed cleanup or `CLEANUP_UNKNOWN`. Unconfirmed cleanup poisons the
owner and shuts down the private transport so the public host can retire its
managed kernel range. Poisoned process ownership is retained until teardown;
there is no detached cleanup or replacement kernel. Request IDs cannot collide
with shell or file operations on the same connection.

Shell and task replies share one bounded 512-frame writer. Saturation or physical
write failure shuts down the independently held control endpoint, including an
asynchronous terminal failure after the final input frame. The input reader is
never blocked sending a task output reply. Host teardown first interrupts the
control endpoint, then joins task workers, shell workers and file leaves.

The ordinary native workspace gate includes task assertions for queue saturation,
queue deadlines, owner-close ordering, stale admission, fractional timers,
structured cleanup failure, real closed stdin and exit 259, bounded two-stream
tails, ordinary descendant retirement, explicit/promoted job lifetime, targeted
cancellation, and hard deadlines surviving promotion. Its ignored child fixture
is explicitly invoked by the real lifecycle tests; it is not a skipped behavior.

Full production approval/runtime/script admission, Jobs handoff publication,
recoverable spill and interleaved cross-platform performance acceptance remain
separate work. This protocol slice does not complete #872.
