# Linux index limitations

Status: L3 (#608) of `ops-linux-index` (#588), 2026-11-04. The crate is a library and is not wired
into the worker yet; this page records the answers a future caller may rely on, so the fallback
contracts are not discovered in production.

## File systems that never back an index

The source classifies a root against the kernel mount table. These families are refused:

| family | mount-table type names | state |
| --- | --- | --- |
| NFS | `nfs`, `nfs4`, `nfsd` (all `nfs*`) | `Offline` |
| FUSE | `fuse`, `fuse.sshfs`, `fuse.rclone`, `fusectl` (all `fuse*`) | `Offline` |
| CIFS/SMB | `cifs`, `smb`, `smb3` | `Offline` |
| 9p | `9p` | `Offline` |
| Ceph | `ceph` | `Offline` |
| AFS | `afs` | `Offline` |
| procfs | `proc` | `Offline` |
| sysfs | `sysfs` | `Offline` |
| debugfs | `debugfs` | `Offline` |
| tracefs | `tracefs` | `Offline` |
| securityfs | `securityfs` | `Offline` |
| cgroup | `cgroup`, `cgroup2` | `Offline` |

`Offline` is `SourceState::Unavailable`: the source does not participate in queries, and the caller
runs the existing bounded walk instead. The output is byte-identical to a run without an index.

The root is classified by the mount point that owns it (longest matching prefix), so a bind mount
over an NFS tree is indexed as its local file system, and a path under `/proc` or `/sys` is
refused even when the volume root is elsewhere.

### Known gaps

The classification is a conservative name allowlist, not a proof of locality. Network or pseudo
file systems whose type name is not in the table above (for example `virtiofs`, `gpfs`,
`lustre`, `fuse.*` variants spelled differently by a vendor kernel, or an out-of-tree network
file system) pass through as indexable. Recognizing a local family as remote only costs the walk
the caller already had, so adding a name is cheap; forgetting one is the correctness risk. Extend
`UnsupportedFs::from_fs_type` and this table together when one is found.

### Why the mount table, not statfs(2)

The crate is `#![forbid(unsafe_code)]` and has no `libc`/`rustix` dependency, so it cannot issue
the `statfs` syscall directly. It reads `/proc/self/mounts` instead, which carries the same
file-system type name that `statfs` would return as `f_type`, plus the mount point needed to decide
which entry owns the root. Reading it is plain file I/O; the table logic is pure and unit-tested
with synthetic tables. A reviewed syscall wrapper could replace that one read later.

The table is read as **bytes**, and mount points keep their raw bytes (the kernel escapes only
space, tab, newline and backslash as `\040`, `\011`, `\012`, `\134`). A non-UTF-8 mount point
therefore neither fails the parse nor disables classification for every other root. The root is
canonicalized before matching, so a symlink pointing into `/proc` is classified as procfs.

### Fail closed

If the mount table cannot be read or the root cannot be canonicalized, the source reports
`Unavailable` (Offline) rather than falling back to its phase state: not being able to prove a root
is local is not proof that it is. The cost is the walk the caller already had.

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
