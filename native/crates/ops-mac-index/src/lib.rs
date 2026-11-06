#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]
#![cfg(target_os = "macos")]
//! macOS file-name index data source (M1 cold walk, M2 FSEvents FFI).
//!
//! This crate is the macOS member of the platform data-source crates designed
//! in #584. It implements [`ops_index::source::FsDataSource`] over a directory
//! root. M1 covers the cold path: a bounded `std::fs::read_dir` recursion
//! (sibling directories visited in parallel through `rayon`) whose per-entry
//! `stat` is also fanned out through `rayon`, mapped into
//! [`ops_index::Candidate`] values. M2 adds the event primitives: the FSEvents
//! bindings and a safe stream that watches every root through one kernel
//! stream, replays from a persisted event id, and drains a bounded batch.
//!
//! The whole crate body is behind `#![cfg(target_os = "macos")]`, so on every
//! other target it compiles to an empty library: the workspace build stays
//! green and CI does not build code that cannot run there. The dependencies
//! (`rayon`, and the `objc2` FSEvents bindings) are declared under
//! `[target.'cfg(target_os = "macos")'.dependencies]` for the same reason; the
//! traversal itself is `std::fs` only.
//!
//! ## Unsafe boundary
//!
//! The crate denies `unsafe` at the root and re-allows it for exactly one
//! module, `ffi`, which owns every pointer and every framework call. That
//! module documents each block with a SAFETY comment and is the only place
//! where an Apple ABI is named. `unsafe_op_in_unsafe_fn` is denied too, so an
//! `unsafe fn` body is still checked unless it opts in block by block.
//!
//! Module map:
//!
//! - [`source`]: [`ops_index::FsDataSource`] over one root (the cold path).
//! - [`walk`]: bounded `read_dir` recursion with `rayon` stat fan-out.
//! - [`fsevents`]: safe FSEvents stream — one stream over many roots, replay
//!   from a persisted event id, bounded batch drain, dropped-event reporting.
//! - `ffi`: the `unsafe` island behind [`fsevents`].
//!
//! What this crate does **not** claim (and must not be read as claiming):
//!
//! - The event stream is not wired into [`ops_index::FsDataSource::state`] yet.
//!   The source still answers [`ops_index::SourceState::Unsupported`] for a
//!   readable directory, because a cold walk finishes and then keeps missing
//!   changes. Callers gate on `state`, so today they keep using their own
//!   traversal and produce exactly today's output. Coalescing and the
//!   rescan policy are M3's work; the integration that flips `state` is a
//!   later slice.
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

#[allow(unsafe_code)]
mod ffi;

pub mod fsevents;
pub mod source;
pub mod walk;

pub use fsevents::{Batch, Event, EventError, EventFlags, EventId, EventStream, relative_path};
pub use source::MacFsSource;
pub use walk::walk_root;
