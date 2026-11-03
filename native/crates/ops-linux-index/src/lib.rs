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
//! L1 scope, deliberately:
//!
//! - cold enumeration (`walk`), kernel/polling watch sessions (`watch`) and the
//!   freshness state machine (`source`);
//! - inotify limits and the polling-degradation policy (`limits`); a session
//!   that cannot attribute events reports that a rescan is required instead of
//!   replaying them onto a stale snapshot;
//! - no file-system classification yet (L3 adds statfs and `Offline`).
//!
//! The crate is compiled only on Linux: the root attribute gates it, so a
//! non-Linux workspace build sees an empty library and builds no dependency.
//!
//! All offsets are not applicable here; the relevant invariants are: never
//! follow a symlink while walking, never read file content, and never report a
//! truncated or partially enumerated set as complete.

pub mod limits;
pub mod source;
pub mod walk;
pub mod watch;
