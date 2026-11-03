// Design informed by mustafaahci/goz (MIT).
//! Atomic publication and reading of a snapshot image.
//!
//! A write creates a private temporary file next to the target, fills it,
//! calls `sync_all`, renames it over the target, and then best-effort syncs the
//! containing directory so the rename itself is durable on file systems that
//! require it. A reader therefore sees either the previous complete image or the
//! new complete image, never a half-written one.
//!
//! Deliberately not in this slice: cross-process locking, cursor replay and
//! garbage collection (#600), and the host cache-directory field (#601). A
//! reader never deletes temporary files: another writer may own them, and
//! cleanup is a locking concern.
//!
//! A corrupt image is reported, never silently repaired. The caller discards it
//! and rebuilds; a stale snapshot must never be presented as current.

use super::format::{self, Snapshot, SnapshotError};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// File name of the published snapshot inside the store directory.
pub const SNAPSHOT_FILE: &str = "index.snapshot";

/// Why a snapshot file could not be read or published.
#[derive(Debug)]
#[non_exhaustive]
pub enum StoreError {
    /// A file-system operation failed.
    Io(io::Error),
    /// The image exists but failed validation.
    Corrupt(SnapshotError),
}

impl StoreError {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "INDEX_SNAPSHOT_IO",
            Self::Corrupt(_) => "INDEX_SNAPSHOT_CORRUPT",
        }
    }

    /// The underlying format error, when the image was read but rejected.
    pub fn corrupt(&self) -> Option<&SnapshotError> {
        match self {
            Self::Corrupt(error) => Some(error),
            Self::Io(_) => None,
        }
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "snapshot store I/O failed: {error}"),
            Self::Corrupt(error) => write!(f, "snapshot image is corrupt: {error}"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Corrupt(error) => Some(error),
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<SnapshotError> for StoreError {
    fn from(error: SnapshotError) -> Self {
        Self::Corrupt(error)
    }
}

/// A directory that holds one published snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotStore {
    directory: PathBuf,
}

impl SnapshotStore {
    /// Creates a store rooted at `directory`; nothing is touched until a save.
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    /// Directory this store writes into.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Path of the published image.
    pub fn path(&self) -> PathBuf {
        self.directory.join(SNAPSHOT_FILE)
    }

    /// Loads the published snapshot.
    ///
    /// `Ok(None)` means no image exists yet. `Err(Corrupt(..))` means an image
    /// exists but must be discarded; the caller rebuilds instead of claiming a
    /// stale result is current.
    pub fn load(&self) -> Result<Option<Snapshot>, StoreError> {
        let path = self.path();
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(StoreError::Io(error)),
        };
        format::decode(&bytes)
            .map(Some)
            .map_err(StoreError::Corrupt)
    }

    /// Publishes `snapshot` atomically.
    ///
    /// The temporary file is removed on failure; on success it has been renamed
    /// away. The containing directory is synced best-effort after the rename.
    pub fn save(&self, snapshot: &Snapshot) -> Result<(), StoreError> {
        fs::create_dir_all(&self.directory)?;
        let image = format::encode(snapshot)?;
        let temporary = self.write_temporary(&image)?;
        match self.commit(&temporary) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                Err(error)
            }
        }
    }

    /// Writes `image` to a fresh temporary file and syncs its contents.
    ///
    /// Kept separate from [`Self::save`] so a test can observe a published old
    /// image while a new one is still only in a temporary file.
    fn write_temporary(&self, image: &[u8]) -> Result<PathBuf, StoreError> {
        let temporary = self.next_temporary_path();
        let mut file = File::create(&temporary)?;
        file.write_all(image)?;
        file.sync_all()?;
        Ok(temporary)
    }

    /// Renames a synced temporary file over the published image.
    fn commit(&self, temporary: &Path) -> Result<(), StoreError> {
        fs::rename(temporary, self.path())?;
        let _ = sync_directory(&self.directory);
        Ok(())
    }

    fn next_temporary_path(&self) -> PathBuf {
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
        self.directory.join(format!(
            "{SNAPSHOT_FILE}.tmp.{}.{serial}",
            std::process::id()
        ))
    }
}

/// Best-effort directory sync after a rename.
///
/// On platforms where a directory cannot be opened as a file this returns
/// `false`; the caller treats durability as best-effort there rather than
/// branching on a platform.
fn sync_directory(directory: &Path) -> bool {
    match File::open(directory) {
        Ok(file) => file.sync_all().is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod store_tests;
