# Linux index limitations

Status: L3 (#608) of `ops-linux-index` (#588), 2026-11-04. The crate is a library and is not wired
into the worker yet; this page records the answers a future caller may rely on, so the fallback
contracts are not discovered in production.

## File systems that never back an index

The source classifies a root against the kernel mount table and refuses four families:

| family | mount-table type names (prefix match) | state |
| --- | --- | --- |
| NFS | `nfs`, `nfs4`, `nfsd` | `Offline` |
| FUSE | `fuse`, `fuse.sshfs`, `fuse.rclone`, `fusectl` | `Offline` |
| procfs | `proc` | `Offline` |
| sysfs | `sysfs` | `Offline` |

`Offline` is `SourceState::Unavailable`: the source does not participate in queries, and the caller
runs the existing bounded walk instead. The output is byte-identical to a run without an index.

The root is classified by the mount point that owns it (longest matching prefix), so a bind mount
over an NFS tree is indexed as its local file system, and a path under `/proc` or `/sys` is
refused even when the volume root is elsewhere.

### Why the mount table, not statfs(2)

The crate is `#![forbid(unsafe_code)]` and has no `libc`/`rustix` dependency, so it cannot issue
the `statfs` syscall directly. It reads `/proc/self/mounts` instead, which carries the same
file-system type name that `statfs` would return as `f_type`, plus the mount point needed to decide
which entry owns the root. Reading it is plain file I/O; the table logic is pure and unit-tested
with synthetic tables. The classification is deliberately conservative: a false `Offline` costs
only the walk the caller already had, while a wrong index-backed answer would be a correctness bug.
Other local file systems stay indexable.

## inotify cannot replay events across processes

- inotify watches are per-process kernel state. The event queue belongs to one process's inotify
  descriptor; another process cannot address it, and it cannot be stored in a snapshot.
- Every `dsh_ops` tool call is a new worker process. A snapshot built by one call cannot be brought
  up to date by the next call's watcher: there is no cursor to replay events from. The next call
  either rebuilds cold or starts unwatched.
- A restarted worker (crash, timeout, host restart) always rebuilds cold; there is no fast path.
- A kernel queue overflow invalidates the snapshot and reports that a rescan is required. The
  session never replays a truncated queue onto a stale snapshot.
- Changes made while no watcher exists are missed outright; the state reports `Unsupported` or
  `Unavailable` rather than claiming `Ready`.
- A persistent snapshot (#586) can cache a cold build, but it does not add replay: the events that
  happened while the process was gone are unobtainable. Cross-call freshness on Linux therefore
  needs a source with its own durable journal (the Windows USN path has one); Linux offers no
  unprivileged equivalent, so a Linux snapshot is only usable when the caller accepts a
  revalidation/rescan step.
