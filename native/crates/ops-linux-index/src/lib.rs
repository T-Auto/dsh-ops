#![forbid(unsafe_code)]
#![cfg(target_os = "linux")]
// Design informed by mustafaahci/goz (MIT).
//! Linux data source for `ops-index`: cold enumeration and freshness state.
//!
//! This crate is the Linux arm of the [`ops_index::source::FsDataSource`]
//! boundary. It turns the live directory tree into [`ops_index::Candidate`]
//! values without reading file contents, without following symlinks, and with
//! an explicit entry/depth/deadline budget.
//!
//! This crate currently delivers L1 (cold enumeration), L2 (incremental
//! watching) and L3 (file-system classification), deliberately:
//!
//! - cold enumeration (`walk`), kernel/polling watch sessions (`watch`), the
//!   watch-state machine (`state`) and the freshness state (`source`);
//! - inotify limits and the polling-degradation policy (`limits`); a session
//!   that cannot attribute events reports that a rescan is required instead of
//!   replaying them onto a stale snapshot;
//! - file-system classification (`fs`): roots on network file systems (NFS,
//!   FUSE, CIFS/SMB, 9p, Ceph, AFS) and kernel pseudo file systems (procfs,
//!   sysfs, debugfs, tracefs, securityfs, cgroup) report `Offline` and never
//!   back an index; a classification failure is `Offline` too (fail closed),
//!   because not being able to prove a root is local is not proof that it is.
//!
//! The crate is compiled only on Linux: the root attribute gates it, so a
//! non-Linux workspace build sees an empty library and builds no dependency.
//!
//! All offsets are not applicable here; the relevant invariants are: never
//! follow a symlink while walking, never read file content, and never report a
//! truncated or partially enumerated set as complete.

pub mod fs;
pub mod limits;
pub mod source;
pub mod state;
pub mod walk;
pub mod watch;
