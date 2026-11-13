# Internal native task capture

[中文](常驻任务输出基础层.md)

This #872 slice adds live bounded process output views and held-handle root-exit
observation to the Windows owned process range. It does not publish a task tool,
replace fresh execution, implement the host jobs adapter, or enable persistent
shells on the incompatible stock Niubash runtime.

`Range::spawn_with_retention(launch, Retention::Tail)` retains the newest bytes for
fresh/task readers. Existing `Range::spawn` and private shell channels keep their
bounded prefix. Both use the same raw `Capture` buffer implementation. The cap is
1–128 KiB per stream; the repository task fixture uses the existing 64,000-byte
fresh memory default unless its test specifies a smaller cap. Every byte continues
to drain and contributes to the observed total after retention reaches its cap.

`Range::output_views()` returns independent, non-consuming views. A snapshot reads
the retained bytes, their whole-stream byte offset, observed total, truncation,
EOF and any read error under one lock. `read_from(offset)` returns the available
suffix and advances `next_offset` to the observed total. Loss is relative to that
reader's requested offset, so a tail reader already inside the retained window
does not inherit another reader's earlier loss. Prefix reads report missing bytes
after the retained prefix. Offsets are raw bytes, including inside a UTF-8 unit;
text decoding belongs to the projection. A cursor beyond the observed total is
rejected. Empty live output is not EOF, and a failed read preserves partial bytes
and its error without claiming EOF. Cloned views hold capture storage only, not
the process or Job ownership.

The inherited stdin is a pipe whose writer is closed, preserving the existing
fresh host execution contract without rewriting argv. The launch still uses the
exact host-confined executable/argv, explicit environment and handle list, and
atomic nested Job assignment before the first instruction runs.

`root_exit()` polls the retained process handle. A signalled handle can return any
actual exit code, including 259; the numeric `STILL_ACTIVE` value alone is never
used to classify liveness. `wait_root_exit(deadline)` provides a bounded wait on
that same identity. Windows can report Job active count zero just before the root
handle signals, so callers must not substitute Job emptiness for root exit.
Conversely, root exit does not imply that descendants or output writers are gone.
A task completion requires confirmed range cleanup, observed root exit and joined
output readers. Stream EOF alone also does not certify process completion.

The repository-only `task_capture` owner exercises two explicitly selected
lifetimes. An ordinary fresh root exit gets a bounded drain grace and then retires
remaining descendants. A task explicitly registered as background retains its
owned descendants until they finish or the task/owner is closed. This fixture is
not a production scheduler or an automatic promotion rule. Cancellation attempts
the owned console signal for a live root, then terminates and joins only that
task's range. Control EOF closes all tasks, while a sibling task remains usable
after targeted cancellation.

The Windows public-host probe asserts 10 cases: all three confinement modes,
closed-stdin EOF, exit 259, independent live cursors and terminal EOF, two 1 MiB
streams with 64-byte retention, fresh descendant retirement, explicit background
descendant lifetime, targeted cancellation and owner EOF. It checks observed PIDs
are gone before emergency cleanup. Unit tests additionally cover raw UTF-8 byte
offsets, prefix loss, read failure after partial output, the actual Windows pipe
handle type, and joining later readers after an earlier error or panic.

```console
cargo test --locked --manifest-path native/Cargo.toml -p ops-process
cargo build --locked --manifest-path native/Cargo.toml --example task_capture
node bench/probes/probe-872-task-capture.mjs native/target/debug/examples/task_capture.exe
```

Recoverable spill, the bounded native task scheduler and wire, exact Jobs startup
handoff, and settled spill retention remain separate work. The existing raw spill
contract is a 64 MiB complete-stream file with the shared settled-spill ledger;
this bounded-memory slice does not claim that parity. Structured PTC result
references are not a substitute raw output store. POSIX process ranges remain
explicitly unsupported because the public host fallback does not establish
ownership for newly created process groups.
