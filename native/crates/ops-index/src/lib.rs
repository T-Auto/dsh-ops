#![forbid(unsafe_code)]
//! Platform-agnostic building blocks for a file-name index.
//!
//! This crate is deliberately a library only: it does not open files, walk a
//! volume, start a daemon, or change `ops_glob`/`ops_grep`. It is **not** a
//! full-text index. It holds names, sizes and modification times and nothing
//! about file contents. A platform crate produces raw bytes (USN records,
//! FILE_LAYOUT pages, native directory entries); this crate turns them into a
//! deterministic in-memory model, and the caller decides whether using that
//! model is safe for a given request.
//!
//! Module map:
//!
//! - [`error`]: byte-buffer decoding errors carrying the offset that failed.
//! - [`ids`]: stable identifiers and the 128-bit `FileKey` (NTFS FRN or
//!   POSIX `(dev, ino)`). `FileKey` is 16 bytes so ReFS' 128-bit file ids
//!   fit; `EntryId`/`NameId` stay 4 bytes because they index this crate's
//!   own arrays, not the file system.
//! - [`source`]: the [`source::FsDataSource`] trait plus [`source::NullSource`]
//!   (always `Unsupported`) and [`source::MemorySource`] (deterministic test
//!   injection). Sources report whether their snapshot may be trusted before a
//!   query touches it.
//! - [`snapshot`]: the self-contained on-disk snapshot format and its atomic
//!   store. Persisting a snapshot does not itself make an index trusted.
//!
//! Every identifier is a newtype so a waypoint count and a name id cannot be
//! swapped by accident. The library is `#![forbid(unsafe_code)]`, contains no
//! `cfg` branches of its own, and never names a Windows or POSIX API: platform
//! knowledge stays in the crates that produce the bytes.

pub mod error;
pub mod ids;
pub mod source;

/// Durable snapshot format and its atomic store.
///
/// The format is self-contained: it stores the compact entry records and the
/// interned name bytes, so a snapshot means the same thing in a new process.
/// Loading a structurally valid snapshot is not evidence that it still
/// describes the current tree; the caller must also match its identity.
pub mod snapshot {
    pub mod format;
    pub mod store;
}

pub use error::{Error, Result};
pub use ids::{EntryId, FileKey, NameId, RecordId, SnapshotId, VolumeId};
pub use source::{
    Candidate, CandidateSet, Change, ChangeAction, EntryKind, EnumBudget, FsDataSource,
    MemorySource, NullSource, SourceError, SourceState,
};
