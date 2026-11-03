// Design informed by mustafaahci/goz (MIT).
//! Crash residue, capacity and uninstall cleanup.
//!
//! A writer publishes through a private temporary file; a reader never deletes
//! one because another writer may own it. If a writer crashes, that temporary
//! file is dead weight. Collecting it is safe only while holding the writer lock
//! ([`crate::snapshot::lock::SnapshotLock`]): the lock proves no other writer is
//! alive, so every temporary file is residue.
//!
//! [`collect`] also enforces a size cap on the published image. A snapshot over
//! the cap is removed rather than loaded, which keeps the cache directory from
//! growing without bound; the caller rebuilds. [`remove_all`] is the uninstall
//! path: it removes the published image, temporary files and the lock file, then
//! removes the directory if it became empty.
//!
//! Nothing here touches unrelated files: a cache directory may be shared with
//! other names, and deleting by "anything that looks stale" is how a plugin
//! deletes someone else's data.

use super::lock::{LOCK_FILE, SnapshotLock};
use super::store::SNAPSHOT_FILE;
use std::fs;
use std::io;
use std::path::Path;

/// Default cap on the published image.
///
/// Re-exported from [`super::store`] so the read cap and the garbage-collection
/// cap can never diverge; a snapshot larger than this is removed before it is
/// loaded.
pub use super::store::MAX_SNAPSHOT_BYTES;

/// What a collection pass removed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GcReport {
    /// Number of temporary files removed (crash residue).
    pub removed_temporary: usize,
    /// Number of published images removed because they exceeded the cap.
    pub removed_published: usize,
    /// Whether the lock file was removed by [`remove_all`].
    pub removed_lock: bool,
    /// Bytes reclaimed across every removed file.
    pub bytes_reclaimed: u64,
}

impl GcReport {
    /// Total number of files removed.
    pub fn removed_files(&self) -> usize {
        self.removed_temporary + self.removed_published + usize::from(self.removed_lock)
    }
}

/// Why cleanup failed.
#[derive(Debug)]
#[non_exhaustive]
pub enum GcError {
    /// A file-system operation failed.
    Io(io::Error),
}

impl GcError {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "INDEX_SNAPSHOT_GC_IO",
        }
    }
}

impl std::fmt::Display for GcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "snapshot cleanup failed: {error}"),
        }
    }
}

impl std::error::Error for GcError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
        }
    }
}

impl From<io::Error> for GcError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Collects crash residue and enforces the size cap.
///
/// `max_bytes` is the cap for the published image; pass [`MAX_SNAPSHOT_BYTES`].
/// This is crate-private on purpose: without the writer lock a collector could
/// delete a live writer's temporary file. [`collect_locked`] is the public form
/// and makes the proof impossible to forget.
fn collect_unlocked(directory: &Path, max_bytes: u64) -> Result<GcReport, GcError> {
    let mut report = GcReport::default();
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(report),
        Err(error) => return Err(GcError::Io(error)),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        if is_temporary(&name) {
            fs::remove_file(entry.path())?;
            report.removed_temporary += 1;
            report.bytes_reclaimed += size;
        } else if name == SNAPSHOT_FILE && size > max_bytes {
            fs::remove_file(entry.path())?;
            report.removed_published += 1;
            report.bytes_reclaimed += size;
        }
    }
    Ok(report)
}

/// [`collect_unlocked`], taking the writer lock as proof of exclusivity.
pub fn collect_locked(lock: &SnapshotLock, max_bytes: u64) -> Result<GcReport, GcError> {
    collect_unlocked(lock.directory(), max_bytes)
}

/// Removes the snapshot store: published image, temporary files and lock file.
///
/// This is the uninstall path. It must only be used when no writer is active
/// (uninstall has no lock to take); [`collect`] is the safe online variant.
pub fn remove_all(directory: &Path) -> Result<GcReport, GcError> {
    let mut report = GcReport::default();
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(report),
        Err(error) => return Err(GcError::Io(error)),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        let recognized = name == SNAPSHOT_FILE || name == LOCK_FILE || is_temporary(&name);
        if !recognized {
            continue;
        }
        fs::remove_file(entry.path())?;
        report.bytes_reclaimed += size;
        if name == SNAPSHOT_FILE {
            report.removed_published += 1;
        } else if name == LOCK_FILE {
            report.removed_lock = true;
        } else {
            report.removed_temporary += 1;
        }
    }
    // Remove the directory only if this pass emptied it; an unrelated file means
    // the directory is not ours to delete.
    match fs::remove_dir(directory) {
        Ok(()) => {}
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound
                    | io::ErrorKind::DirectoryNotEmpty
                    | io::ErrorKind::PermissionDenied
            ) => {}
        Err(error) => return Err(GcError::Io(error)),
    }
    Ok(report)
}

/// Whether a file name is one of this store's temporary files.
///
/// The naming is owned by [`super::store`] (`index.snapshot.tmp.<pid>.<serial>`);
/// the check is derived from [`SNAPSHOT_FILE`] so a rename cannot silently
/// orphan residue.
fn is_temporary(name: &str) -> bool {
    name.strip_prefix(SNAPSHOT_FILE)
        .is_some_and(|suffix| suffix.starts_with(".tmp."))
}

#[cfg(test)]
#[path = "gc_tests.rs"]
mod gc_tests;
