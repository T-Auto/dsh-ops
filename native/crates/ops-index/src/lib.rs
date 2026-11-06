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
//! - [`wtf8`]: reversible UTF-16/WTF-8 codec for names, including unpaired surrogates.
//! - [`fold`]: normalization + one-to-one lowercase key for case-insensitive matching.
//! - [`layout`]: decoding of NTFS `FSCTL_QUERY_FILE_LAYOUT` output pages into
//!   file records (names, sizes, modification times).
//! - [`usn`]: pure byte parsers for USN enumeration and journal buffers.
//! - [`index`]: interned name arenas, the struct-of-arrays entry table, and
//!   record maps.
//! - [`ids`]: stable identifiers and the 128-bit `FileKey` (NTFS FRN or
//!   POSIX `(dev, ino)`). `FileKey` is 16 bytes so ReFS' 128-bit file ids
//!   fit; `EntryId`/`NameId` stay 4 bytes because they index this crate's
//!   own arrays, not the file system.
//! - [`snapshot`]: self-contained on-disk image of a root and its atomic store.
//! - [`source`]: the [`source::FsDataSource`] trait plus [`source::NullSource`]
//!   (always `Unsupported`) and [`source::MemorySource`] (deterministic test
//!   injection). Sources report whether their snapshot may be trusted before a
//!   query touches it.
//!
//! Every identifier is a newtype so a waypoint count and a name id cannot be
//! swapped by accident. The library is `#![forbid(unsafe_code)]`, contains no
//! `cfg` branches of its own, and never names a Windows or POSIX API: platform
//! knowledge stays in the crates that produce the bytes.

pub mod error;
pub mod fold;
pub mod ids;
pub mod snapshot;
pub mod index;
pub mod layout;
pub mod source;
pub mod usn;
pub mod wtf8;

pub use error::{Error, Result};
pub use ids::{EntryId, FileKey, NameId, RecordId, SnapshotId, VolumeId};
pub use source::{
    Candidate, CandidateSet, Change, ChangeAction, EntryKind, EnumBudget, FsDataSource,
    MemorySource, NullSource, SourceError, SourceState,
};
