// Design informed by mustafaahci/goz (MIT)
//! Atomic on-disk storage for one snapshot.
//!
//! Publication is write-temp, fsync, rename: a reader sees either the previous
//! complete file or the new complete file, never a mixture. Directory fsync is
//! attempted after the rename and is best-effort because some platforms cannot
//! open a directory for syncing; the rename itself is still atomic.
//!
//! Crash residue is a temporary file that never became visible. It is ignored
//! by load and removed by cleanup_temp, which the writer calls at startup or
//! before its next save. A save also truncates a stale temporary file, so a
//! crash between temp fsync and rename cannot poison later writes.
//!
//! The store assumes one writer at a time; the PS2 lock supplies that
//! serialisation. Readers need no lock: load either reads the old file or the
//! new one. Load never deletes anything, so a reader cannot race a writer's
//! temporary file.

use crate::snapshot::format::{FormatError, Snapshot};
use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

/// File name of the published snapshot inside its cache directory.
pub const SNAPSHOT_FILE_NAME: &str = "snapshot.bin";

/// File name used while a snapshot is being written.
pub const SNAPSHOT_TEMP_FILE_NAME: &str = "snapshot.bin.tmp";

/// A storage operation failed.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum StoreError {
    /// The in-memory snapshot could not be encoded.
    Format(FormatError),
    /// The file system refused an operation.
    Io {
        /// What the store was doing.
        action: &'static str,
        /// The underlying I/O error kind.
        kind: ErrorKind,
    },
}

impl StoreError {
    fn io(action: &'static str, error: std::io::Error) -> Self {
        Self::Io {
            action,
            kind: error.kind(),
        }
    }

    /// Stable, machine-readable code for host error mapping.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Format(_) => "INDEX_SNAPSHOT_FORMAT",
            Self::Io { .. } => "INDEX_SNAPSHOT_IO",
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Format(error) => write!(f, "snapshot encoding failed: {error}"),
            Self::Io { action, kind } => write!(f, "snapshot store failed to {action}: {kind:?}"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Format(error) => Some(error),
            Self::Io { .. } => None,
        }
    }
}

impl From<FormatError> for StoreError {
    fn from(error: FormatError) -> Self {
        Self::Format(error)
    }
}

/// Result of trying to load a snapshot.
#[derive(Debug)]
pub enum LoadOutcome {
    /// No snapshot file exists.
    Missing,
    /// A complete, valid snapshot was decoded.
    Loaded(Snapshot),
    /// A file exists but failed validation; the caller must rebuild.
    Discarded(FormatError),
}

impl LoadOutcome {
    /// The snapshot when one loaded, otherwise none.
    pub fn into_snapshot(self) -> Option<Snapshot> {
        match self {
            Self::Loaded(snapshot) => Some(snapshot),
            Self::Missing | Self::Discarded(_) => None,
        }
    }
}

/// One snapshot file in one cache directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotStore {
    dir: PathBuf,
}

impl SnapshotStore {
    /// Creates a store rooted at dir. The directory may not exist yet; save
    /// creates it.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Cache directory this store manages.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Path of the published snapshot.
    pub fn path(&self) -> PathBuf {
        self.dir.join(SNAPSHOT_FILE_NAME)
    }

    /// Path of the temporary file used during publication.
    pub fn temp_path(&self) -> PathBuf {
        self.dir.join(SNAPSHOT_TEMP_FILE_NAME)
    }

    /// Reads and validates the published snapshot.
    ///
    /// A missing file and a rejected file are both ordinary outcomes, not I/O
    /// errors: the caller rebuilds in either case. Only a read failure other
    /// than not-found is an error. Nothing is deleted.
    pub fn load(&self) -> Result<LoadOutcome, StoreError> {
        match fs::read(self.path()) {
            Ok(bytes) => match Snapshot::decode(&bytes) {
                Ok(snapshot) => Ok(LoadOutcome::Loaded(snapshot)),
                Err(error) => Ok(LoadOutcome::Discarded(error)),
            },
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(LoadOutcome::Missing),
            Err(error) => Err(StoreError::io("read the snapshot", error)),
        }
    }

    /// Publishes snapshot atomically, replacing the previous file if any.
    ///
    /// The sequence is: create the directory, write the temporary file,
    /// fsync it, rename it over the published name, then try to fsync the
    /// directory. On any failure before the rename, the temporary file is
    /// removed and the previous snapshot is untouched.
    pub fn save(&self, snapshot: &Snapshot) -> Result<(), StoreError> {
        let bytes = snapshot.encode()?;
        fs::create_dir_all(&self.dir)
            .map_err(|error| StoreError::io("create the snapshot cache directory", error))?;
        let temporary = self.temp_path();
        match self.publish(&temporary, &bytes) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                Err(error)
            }
        }
    }

    fn publish(&self, temporary: &Path, bytes: &[u8]) -> Result<(), StoreError> {
        let mut file = File::create(temporary)
            .map_err(|error| StoreError::io("create the temporary snapshot", error))?;
        file.write_all(bytes)
            .map_err(|error| StoreError::io("write the temporary snapshot", error))?;
        file.sync_all()
            .map_err(|error| StoreError::io("sync the temporary snapshot", error))?;
        drop(file);
        fs::rename(temporary, self.path())
            .map_err(|error| StoreError::io("publish the snapshot", error))?;
        sync_directory(&self.dir);
        Ok(())
    }

    /// Removes a temporary file left by a crashed writer.
    ///
    /// Returns true when a file was removed and false when none existed. Call
    /// this at startup, or before a save, never in a reader path that may run
    /// while a writer is active.
    pub fn cleanup_temp(&self) -> Result<bool, StoreError> {
        match fs::remove_file(self.temp_path()) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(StoreError::io("remove the temporary snapshot", error)),
        }
    }
}

fn sync_directory(dir: &Path) {
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod store_tests;
