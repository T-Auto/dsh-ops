# Resident shell queue protocol

中文：[常驻 shell 队列协议](常驻-shell-队列协议.md).

This is the internal Windows queue implementation for [#872](https://github.com/T-Auto/dsh-ops/issues/872).
It is not the model-facing shell interface or the complete feature acceptance report. The existing
fresh-shell tools keep their published behavior. Background jobs, public projections, output spill
integration and complete application/performance acceptance remain separate required work.

## Ownership and admission

The activation-owned kernel advertises `shell-v1` on Windows. Its existing private connection
accepts `shell.execute`, assigning each request to one `sessionKey` FIFO. A session worker owns
its single shell range; different sessions run independently. Neither the queue nor the shell is
a second supervisor process. File requests keep their independently terminable execution leaves.

Only the head request receives `shell.admit`. The host supplies its current trusted policy,
approval and confinement result at that point. A live shell permits `reuse` or `retire`; a fresh
bootstrap permits `launch`. A rejected head never reaches command execution. The native layer
checks the IPC shape, sizes and OS results; it does not derive authority from command text.

There are two distinct retirement operations:

| Operation | Current head | Remaining queue |
| --- | --- | --- |
| Admission reply `decision: retire` | Remains the same unstarted request; receives fresh bootstrap endpoints after cleanup | Preserved |
| Owner control `shell.retire` | Cancelled; cleanup finishes before its terminal result | Preserved, admitted under current host authority |
| Owner control `shell.close` | Cancelled and joined | Cancelled without execution |

Each control has its own request ID and `shell.closed` acknowledgement. A temporary wider grant
uses `closeAfter`; that range is retired before its command result is published. The host must
never reuse the one-call grant for another queued request. Startup environment scripts are not
part of this bootstrap protocol; the host admission layer must reject configured startup-script
variables instead of enrolling their descendants into the bootstrap baseline.

## Request lifetime

The native timeout covers queueing, admission, launch and command execution. It is independent
for every request. A queued cancellation or expiry produces a terminal result immediately and
does not wait for the active command or an approval callback. Cancelling an active request wakes
admission or interrupts its owned shell; unsuccessful cooperative interruption ends that range.
Other sessions and file operations retain their own lifetimes.

`shell.started` is physically written before command bytes enter the shell. Waiting for that write
remains deadline- and cancellation-aware. A cancellation can intervene after the start notification
is queued or written but before any command bytes; the terminal result then correctly reports
`effectState: none`. The notification cannot retract an in-progress pipe write. Successful completion
requires the driver's private receipt, both output streams and the receipt writer reaching real
EOF, joined readers, and the exact held bootstrap process identities. Shell process exit, quiet
output, a visible echo marker or process-count equality alone cannot establish completion.

Failure after start has `effectState: unknown`. Failure before start has `effectState: none`.
`shellState: reset` means no reusable shell remains, including when cancellation discards its
state. It does not mean merely that this request initially created a shell. If an idle shell
loses its held identity or protocol, the next unstarted request fails explicitly; its state is
not silently recreated. There is no replay or automatic kernel restart.

All failure paths stop the owned range and join all request readers before the terminal result.
Unconfirmed cleanup poisons that owner identity: queued requests cannot open another range
under it. A later `shell.close` still reports the known cleanup outcome. Completed records remain
available for output collection until explicit `shell.release`.

## Bounded transport and output

The native and host boundaries admit at most 32 retained execution records, 32 session owners
and 64 outstanding owner controls. Commands are at most 1 MiB. Each request retains a prefix of
at most 128 KiB per output stream and continues draining/counting discarded bytes. This internal
protocol is not yet a replacement for the published shell's spill and paging contract.

`shell.read` returns a bounded snapshot of at most 65,536 decoded bytes, with the original offset,
next offset, canonical base64, loss and EOF facts. A next offset can skip discarded bytes only
when `lossy` is true. An active empty stream returns promptly with `eof: false`. A terminal read
must make progress, reach confirmed EOF or report an explicit output error. The command's
private framing bytes never consume its user-output budget.

One bounded 512-frame shared shell/task reply queue and one writer isolate physical output backpressure from
the control reader. The session worker waits for the physical `started` write; the control reader
can still process shutdown or disconnection while output is stalled. Protocol window overflow
fails the connection immediately, including an asynchronous completion after the final input
frame, rather than allocating unlimited threads or responses. Shutdown cancels
control I/O before joining output, request and session threads.

Windows named pipes do not provide an independent write-half EOF merely by calling Node's
`stream.end()` while retaining the peer. The stalled-consumer regression therefore sends the
supported `shutdown` control message with the read side paused. Actual connection destruction
is a separate disconnect test. POSIX does not advertise `shell-v1`; persistent range ownership
there remains explicitly unsupported until the public host can maintain the required guarantees.

## Reproduction and limits

The queue lifecycle assertions run without a shell executable:

```console
cargo test --locked --manifest-path native/Cargo.toml --bin dsh-ops-worker shell::
```

The driver and stalled-output probes use a normal Windows host, the public subprocess service,
an explicitly selected shell executable and its verified support payload. The nested host
sandbox remains enabled where each probe requests it. A tool sandbox that cannot create the
required pipe ACL is a different launch context; its failure must remain in the evidence.

```console
node bench/probes/probe-872-shell-driver.mjs <worker.exe> <niu.exe> <bootstrap.js> <stock-support-niu.exe>
node bench/probes/probe-872-shell-backpressure.mjs <worker.exe> <niu.exe> <bootstrap.js> <stock-support-niu.exe>
node bench/probes/probe-872-shell-started.mjs <shell_started_blocked.exe> <niu.exe> <stock-support-niu.exe>
```

The asynchronous descriptor tests currently use the explicitly hashed local Niubash IO backport
candidate. They do not change the shipped pin or establish a published runtime release. These
checks must be combined with the host admission tests, full three-instance lifecycle tests,
running quiet-task test, DSH jobs tests and interleaved performance/resource measurements before
#872 can be considered complete.
