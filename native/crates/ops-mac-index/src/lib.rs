#![forbid(unsafe_code)]
#![cfg(target_os = "macos")]
//! macOS file-name index data source (M1: cold enumeration).
//!
//! This crate is the macOS member of the platform data-source crates designed
//! in #584. It implements [`ops_index::source::FsDataSource`] over a directory
//! root. M1 covers the cold path only: one bounded `walkdir` traversal whose
//! per-entry `stat` is fanned out through `rayon` and mapped into
//! [`ops_index::Candidate`] values. FSEvents, replay and coalescing arrive in
//! M2/M3.
//!
//! The whole crate body is behind `#![cfg(target_os = "macos")]`, so on every
//! other target it compiles to an empty library: the workspace build stays
//! green and CI does not build code that cannot run there. Its dependencies sit
//! under `[target.'cfg(target_os = "macos")'.dependencies]` for the same
//! reason.
//!
//! What this crate does **not** claim (and must not be read as claiming):
//!
//! - No event stream and no journal replay yet. [`ops_index::FsDataSource::state`]
//!   therefore answers [`ops_index::SourceState::Unsupported`] for a readable directory: a
//!   cold walk finishes and then keeps missing changes, so it is not a
//!   caught-up snapshot. Callers gate on `state`, so in M1 they keep using
//!   their own traversal and produce exactly today's output.
//! - No content, no extended attributes, no resource forks: names, kinds, sizes
//!   and modification times only. This is a name index, not a text index.
//! - No skip rules. The source reports what the file system contains, hidden
//!   entries and `.git` included; what a search may see is decided by
//!   `ops-search`, which re-verifies every candidate anyway.
//!
//! References used while designing this crate are goz v0.4.0
//! (`8c6a7b1562bb1eea46dd67d462805b49b9a1f152`, MIT). Nothing was copied: the
//! crate is independently written for macOS, and goz's platform layer is
//! Windows-only.

pub mod source;
pub mod walk;

pub use source::MacFsSource;
pub use walk::walk_root;
