// Design informed by mustafaahci/goz (MIT).
//! One writer at a time, enforced by an advisory file lock.
//!
//! Snapshot publication is tmp+rename, so a reader never sees a partial image.
//! Two writers could still race (each rename is atomic, but the last one wins
//! with a generation that may be older), and garbage collection must not delete
//! another process's temporary file. Both are solved by taking an exclusive
//! advisory lock on a sibling lock file for the whole publish/collect section.
//!
//! The lock is released when the guard drops. A crashed process releases it too
//! (the OS closes the handle), which is exactly what makes residue collection
//! safe: if we hold the lock, no other writer is alive.
//!
//! This is an advisory lock: it serialises cooperating writers, it is not a
//! security boundary.

use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

/// File name of the lock inside the store directory.
pub const LOCK_FILE: &str = "index.lock";

/// Why the lock could not be taken or released.
#[derive(Debug)]
#[non_exhaustive]
pub enum LockError {
    /// A file-system operation failed.
    Io(io::Error),
}

impl LockError {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "INDEX_SNAPSHOT_LOCK_IO",
        }
    }
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "snapshot lock failed: {error}"),
        }
    }
}

impl std::error::Error for LockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
        }
    }
}

impl From<io::Error> for LockError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// An exclusive lock on one snapshot directory.
#[derive(Debug)]
pub struct SnapshotLock {
    directory: PathBuf,
    file: File,
}

impl SnapshotLock {
    /// Takes the lock, blocking until the current writer finishes.
    pub fn acquire(directory: &Path) -> Result<Self, LockError> {
        let file = open_lock_file(directory)?;
        file.lock_exclusive()?;
        Ok(Self {
            directory: directory.to_path_buf(),
            file,
        })
    }

    /// Takes the lock if it is free.
    ///
    /// `Ok(None)` means another writer holds it; that is a normal outcome, not
    /// an error.
    pub fn try_acquire(directory: &Path) -> Result<Option<Self>, LockError> {
        let file = open_lock_file(directory)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Some(Self {
                directory: directory.to_path_buf(),
                file,
            })),
            // Windows surfaces a lock violation as ERROR_LOCK_VIOLATION (33);
            // std normally maps it to WouldBlock, and the raw code keeps the
            // check independent of that mapping without naming a platform.
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.raw_os_error() == Some(33) =>
            {
                Ok(None)
            }
            Err(error) => Err(LockError::Io(error)),
        }
    }

    /// Directory this lock protects.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Path of the lock file.
    pub fn path(&self) -> PathBuf {
        self.directory.join(LOCK_FILE)
    }
}

impl Drop for SnapshotLock {
    fn drop(&mut self) {
        // Call the fs2 trait method explicitly: Rust 1.89 added an inherent
        // `File::unlock`, and the workspace MSRV is 1.88, so naming the trait
        // keeps this compiling on the floor version as well.
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

fn open_lock_file(directory: &Path) -> Result<File, LockError> {
    fs::create_dir_all(directory)?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(directory.join(LOCK_FILE))?;
    Ok(file)
}

#[cfg(test)]
#[path = "lock_tests.rs"]
mod lock_tests;
