// Design informed by mustafaahci/goz (MIT).

//! Which platform data source a request may try, chosen by build target.
//!
//! #584 keeps OS knowledge out of `ops-index`: the pure crate owns the
//! [`FsDataSource`] trait and the candidate types, each platform crate owns its
//! own read, and this module is the one place that names them. It is wiring
//! only — no unsafe code, no platform API, and no policy:
//!
//! - the source's own [`ops_index::SourceState`] decides whether an indexed
//!   answer may be used; anything that is not `Ready` makes
//!   [`crate::scan::Scan::walk_indexed`] fall back to the live walk, so output
//!   is exactly what it is without this module;
//! - `cache_dir` only decides *whether* a source is tried at all. G3 performs
//!   no snapshot persistence, so every platform source answers
//!   `Unsupported`/`Unavailable` until its watcher slice lands.
//!
//! G3 wires this for `glob` only: `grep` reads file content and keeps the
//! live traversal until its own integration slice.
//!
//! The crates are `#![cfg(target_os = ...)]` libraries: only the matching one
//! is compiled, and the dependencies are target-gated in `Cargo.toml`, so a
//! Linux build never compiles the Windows or macOS crate.
//!
//! Windows is also feature-gated (#718). `ops-win-index` depends on
//! `usn-journal-rs`, whose COM calls make the linked worker import OLEAUT32;
//! that is a startup regression for a default install, so the source is opt-in
//! (`--features win-index`). Without the feature the Windows arm answers with
//! `NullSource`, exactly like an unsupported target: every request walks.

use ops_index::FsDataSource;

/// The data source for this build target.
///
/// Constructing it is cheap and stateless; the caller keeps it for one request
/// and never re-creates it per candidate.
pub fn platform_source() -> Box<dyn FsDataSource> {
    target_source()
}

#[cfg(all(windows, feature = "win-index"))]
fn target_source() -> Box<dyn FsDataSource> {
    Box::new(ops_win_index::WinFsSource::new())
}

/// A default Windows build: no MFT/USN source, so no OLEAUT32/COM imports from
/// `usn-journal-rs` reach the worker (#718). Behaves like an unsupported
/// target, which `walk_indexed` turns into the live walk.
#[cfg(all(windows, not(feature = "win-index")))]
fn target_source() -> Box<dyn FsDataSource> {
    Box::new(ops_index::NullSource)
}

#[cfg(target_os = "linux")]
fn target_source() -> Box<dyn FsDataSource> {
    Box::new(ops_linux_index::source::LinuxSource::new())
}

#[cfg(target_os = "macos")]
fn target_source() -> Box<dyn FsDataSource> {
    Box::new(ops_mac_index::MacFsSource::new())
}

/// A target with no platform crate: the default source never serves an indexed
/// answer, so the caller walks exactly as it did before this module existed.
#[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
fn target_source() -> Box<dyn FsDataSource> {
    Box::new(ops_index::NullSource)
}
