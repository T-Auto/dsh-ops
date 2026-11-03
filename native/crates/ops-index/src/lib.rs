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
//! - [`source`]: the [`source::FsDataSource`] trait plus [`source::NullSource`]
//!   (always `Unsupported`) and [`source::MemorySource`] (deterministic test
//!   injection). Sources report whether their snapshot may be trusted before a
//!   query touches it.
//! - [`query`]: deterministic name queries over a read-only name view:
//!   substring/prefix matching with a folded-arena prefilter, chunked parallel
//!   scanning, an exact total, and a total order before pagination.
//!
//! Every identifier is a newtype so a waypoint count and a name id cannot be
//! swapped by accident. The library is `#![forbid(unsafe_code)]`, contains no
//! `cfg` branches of its own, and never names a Windows or POSIX API: platform
//! knowledge stays in the crates that produce the bytes.
//!
//! ## Conformance and recorded deviations from #584
//!
//! The module map above is the delivered surface. These are the points where the
//! implementation deliberately differs from the reference design, so a later
//! reader does not treat them as drift:
//!
//! - **No unsafe, no cfg, no platform crate.** The whole crate is
//!   `#![forbid(unsafe_code)]` and contains no `cfg` branch; producers (Windows
//!   USN/FILE_LAYOUT, Linux/macOS sources) stay outside it.
//! - **No persistence here.** The snapshot format and its atomic store live in
//!   the persistence slice, not in this crate's modules; the index is an
//!   in-memory model with no daemon and no internal locking. A caller that
//!   shares an index must serialise writers itself.
//! - **Query is self-designed.** The reference scanner is serial and has no
//!   prefix mode; this crate adds [`query::MatchMode`] and a chunked parallel
//!   scan whose rows are ordered by a total order over (sort key, folded name,
//!   entry id). The result is identical for serial and parallel scans. The
//!   es.exe query parser is deliberately absent.
//! - **Fold is not full case folding.** The key is
//!   NFC(simple_lowercase(NFD(name))): `ς` stays `ς`, `SS` does not fold to
//!   `ß`, and `İ` folds to `i` + U+0307. Names are compared as WTF-8, so
//!   unpaired surrogates survive.
//! - **layout is the FSCTL walker, not the compact persistence layout.** The
//!   "24-byte name header" constants describe NTFS wire records; a snapshot
//!   record is a different, persistence-owned format.
//! - **Entry identities are 4 bytes, file keys are 16.** `EntryId`/`NameId`
//!   index this crate's arrays; [`FileKey`] stays 16 bytes so a ReFS 128-bit
//!   file id fits. A reference type that packs both is therefore 24 bytes, not
//!   the 16 bytes sketched for a 64-bit FRN.
//! - **Presentability has two layers.** The query layer filters on entry flags
//!   (`EntryFlags::is_presentable`): live, not synthetic, not chain-detached.
//!   [`index::VolumeIndex::is_presentable`] is the stricter policy wrapper that
//!   also requires the whole parent chain to reach the volume root; an orphan
//!   under lost-and-found has presentable flags but reports
//!   [`index::PathStatus::InLostFound`]. Query rows are the flag-level set, and
//!   `skipped` counts flag-unpresentable matches.
//! - **Name order is index-internal.** [`index::NameOrder`] owns folded-name
//!   ranks; the query layer consumes the order through the name source and does
//!   not expose a per-name rank.
//! - **No benchmark, no platform data source, no `ops_search` wiring** is part of
//!   this crate; the published surface is a library only.

pub mod error;
pub mod fold;
pub mod ids;
pub mod index;
pub mod layout;
pub mod query;
pub mod source;
pub mod usn;
pub mod wtf8;

pub use error::{Error, Result};
pub use ids::{EntryId, FileKey, NameId, RecordId, SnapshotId, VolumeId};
pub use source::{
    Candidate, CandidateSet, Change, ChangeAction, EntryKind, EnumBudget, FsDataSource,
    MemorySource, NullSource, SourceError, SourceState,
};
#[cfg(test)]
#[path = "contract_tests.rs"]
mod contract_tests;
