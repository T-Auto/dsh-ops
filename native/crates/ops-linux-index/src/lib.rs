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
//! - cold enumeration (`walk`) and the freshness state machine (`source`);
//! - no incremental watcher yet (L2 adds notify/inotify), so the production
//!   source reports `Unsupported` and every caller falls back to the existing
//!   walk — identical output to today;
//! - no file-system classification yet (L3 adds statfs and `Offline`).
//!
//! The crate is compiled only on Linux: the root attribute gates it, so a
//! non-Linux workspace build sees an empty library and builds no dependency.
//!
//! All offsets are not applicable here; the relevant invariants are: never
//! follow a symlink while walking, never read file content, and never report a
//! truncated or partially enumerated set as complete.

pub mod source;
pub mod walk;
