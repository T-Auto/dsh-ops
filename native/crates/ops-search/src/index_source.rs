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
//! The crates are `#![cfg(target_os = ...)]` libraries: only the matching one
//! is compiled, and the dependencies are target-gated in `Cargo.toml`, so a
//! Linux build never compiles the Windows or macOS crate.

use ops_index::FsDataSource;

/// The data source for this build target.
///
/// Constructing it is cheap and stateless; the caller keeps it for one request
/// and never re-creates it per candidate.
pub fn platform_source() -> Box<dyn FsDataSource> {
    target_source()
}

#[cfg(windows)]
fn target_source() -> Box<dyn FsDataSource> {
    Box::new(ops_win_index::WinFsSource::new())
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
