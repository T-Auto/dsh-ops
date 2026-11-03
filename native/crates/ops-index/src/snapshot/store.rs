// Design informed by mustafaahci/goz (MIT).
//! Atomic publication and reading of a snapshot image.
//!
//! A write creates a private temporary file next to the target with
//! `create_new` (never through a pre-created link), fills it, calls `sync_all`,
//! renames it over the target, and then best-effort syncs the containing
//! directory so the rename itself is durable on file systems that require it.
//! Any failure before the rename removes the temporary file, so a disk-full or
//! sync error cannot leak a half-written image. A reader therefore sees either
//! the previous complete image or the new complete image, never a partial one.
//!
//! The published file is [`SNAPSHOT_FILE`] (`index.snapshot`). A read is capped
//! at [`MAX_SNAPSHOT_FILE_BYTES`]: a corrupt or sparse multi-gigabyte file is
//! rejected before it is loaded into memory.
//!
//! The store does not set directory permissions (this crate is
//! platform-agnostic). The host must create the cache directory private (0700 on
//! POSIX) because a snapshot carries every file name under the root.
//!
//! Deliberately not in this slice: cross-process locking, cursor replay and
//! garbage collection (#600), and the host cache-directory field (#601). A
//! reader never deletes temporary files: another writer may own them, and
//! cleanup is a locking concern.

use super::format::{self, Snapshot, SnapshotError};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// File name of the published snapshot inside the store directory.
pub const SNAPSHOT_FILE: &str = "index.snapshot";

/// Upper bound on a snapshot image read from disk.
///
/// 256 MiB is far above a realistic name+record image and far below anything
/// that would exhaust the worker's memory budget; a larger file is treated as
/// corrupt so the caller rebuilds.
pub const MAX_SNAPSHOT_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// Why a snapshot file could not be read or published.
#[derive(Debug)]
#[non_exhaustive]
pub enum StoreError {
    /// A file-system operation failed.
    Io(io::Error),
    /// The image exists but failed validation.
    Corrupt(SnapshotError),
    /// The image is larger than [`MAX_SNAPSHOT_FILE_BYTES`].
    TooLarge {
        /// Size reported by the file system.
        size: u64,
        /// Maximum accepted size.
        max: u64,
    },
}

impl StoreError {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "INDEX_SNAPSHOT_IO",
            Self::Corrupt(_) => "INDEX_SNAPSHOT_CORRUPT",
            Self::TooLarge { .. } => "INDEX_SNAPSHOT_TOO_LARGE",
        }
    }

    /// The underlying format error, when the image was read but rejected.
    pub fn corrupt(&self) -> Option<&SnapshotError> {
        match self {
            Self::Corrupt(error) => Some(error),
            Self::Io(_) | Self::TooLarge { .. } => None,
        }
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "snapshot store I/O failed: {error}"),
            Self::Corrupt(error) => write!(f, "snapshot image is corrupt: {error}"),
            Self::TooLarge { size, max } => {
                write!(
                    f,
                    "snapshot image is {size} bytes, above the {max}-byte cap"
                )
            }
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Corrupt(error) => Some(error),
            Self::TooLarge { .. } => None,
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
        self.load_with_limit(MAX_SNAPSHOT_FILE_BYTES)
    }

    /// [`Self::load`] with an explicit size cap; used by tests to exercise the
    /// rejection path without writing a 256 MiB file.
    fn load_with_limit(&self, max: u64) -> Result<Option<Snapshot>, StoreError> {
        let path = self.path();
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(StoreError::Io(error)),
        };
        let size = file.metadata()?.len();
        if size > max {
            return Err(StoreError::TooLarge { size, max });
        }
        let mut bytes = Vec::new();
        // Read at most one byte past the cap: a file that grew between the
        // metadata check and the read cannot make this allocation unbounded.
        (&file)
            .take(max.saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > max {
            return Err(StoreError::TooLarge {
                size: bytes.len() as u64,
                max,
            });
        }
        format::decode(&bytes)
            .map(Some)
            .map_err(StoreError::Corrupt)
    }

    /// Publishes `snapshot` atomically.
    ///
    /// The temporary file is removed on every failure path, including a failed
    /// write or sync; on success it has been renamed away. The containing
    /// directory is synced best-effort after the rename.
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
    /// `create_new` guarantees the write cannot follow or overwrite an entry
    /// someone pre-placed under a predictable temporary name. A collision with a
    /// concurrent writer's file is retried with a new name; any other failure,
    /// including a partial `write_all` or a failed `sync_all`, removes the file
    /// before returning.
    ///
    /// Kept separate from [`Self::save`] so a test can observe a published old
    /// image while a new one is still only in a temporary file.
    fn write_temporary(&self, image: &[u8]) -> Result<PathBuf, StoreError> {
        for _ in 0..16 {
            let temporary = self.next_temporary_path();
            let mut file = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
            {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(StoreError::Io(error)),
            };
            let written = fill_temporary(&mut file, image);
            drop(file);
            match written {
                Ok(()) => return Ok(temporary),
                Err(error) => {
                    let _ = fs::remove_file(&temporary);
                    return Err(StoreError::Io(error));
                }
            }
        }
        Err(StoreError::Io(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not create a temporary snapshot file",
        )))
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

/// Writes and syncs one temporary file.
///
/// The test build can inject a short write right after the file is created, so
/// the failure-cleanup path in [`SnapshotStore::write_temporary`] is exercised
/// without relying on a full disk.
fn fill_temporary(file: &mut File, image: &[u8]) -> io::Result<()> {
    #[cfg(test)]
    if FAIL_AFTER_CREATE.swap(false, Ordering::Relaxed) {
        file.write_all(&image[..image.len() / 2])?;
        return Err(io::Error::other("injected write failure"));
    }
    file.write_all(image)?;
    file.sync_all()
}

#[cfg(test)]
static FAIL_AFTER_CREATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
