// Design informed by mustafaahci/goz (MIT).
//! Decoding of NTFS `FSCTL_QUERY_FILE_LAYOUT` output pages.
//!
//! A Windows index source pages the `FSCTL_QUERY_FILE_LAYOUT` ioctl and gets
//! back buffers in a kernel-defined layout: a header per page, then a chain of
//! file entries, and each file carries its own chains of names, extra info and
//! streams. This module turns one page into [`LayoutFile`] values. The format is
//! NTFS ABI, but the code is pure byte work — no OS call, no `unsafe`, no
//! `cfg` — so every assertion here runs on every platform while the only
//! producer stays the Windows index crate. Nothing in this module opens a file,
//! issues an ioctl, or keeps state between pages.
//!
//! Three properties are the contract:
//!
//! - **One page at a time.** Chains never cross a page boundary; the caller
//!   hands the next ioctl buffer to the next call and nothing accumulates here.
//! - **Whole-page failure.** A single structural defect rejects the page. The
//!   walk never skips a bad record and continues, because the caller's fallback
//!   is a fresh traversal, not a half-indexed page.
//! - **Bounded work.** Every chain must advance past the structure that carries
//!   the offset ([`crate::Error::OffsetCycle`]), names are capped at
//!   [`MAX_NAME_BYTES`] before any allocation, and `FileEntryCount` is only a
//!   capacity hint — the offset chain decides what is parsed.
//! - **Page-wide budget.** Every decoded file, name, stream and info structure
//!   costs one step, and every name or stream-identifier byte costs one payload
//!   byte; both allowances equal the page length and are shared by the whole
//!   page. Well-formed pages stay far below them because each structure
//!   occupies at least its own header bytes; the budget only trips when several
//!   files point at the same satellite chain, which would otherwise decode one
//!   small page into quadratic work and allocation. Exceeding either budget
//!   rejects the page like a structural defect.
//!
//! Field offsets are read from bytes, never from a Rust struct layout, so a
//! page may start at any address and records need no alignment padding between
//! them (the reference consumers emit none).
//!
//! Module map:
//!
//! - `wire`: wire sizes, field offsets, little-endian readers and offset
//!   following.
//! - `names`: the `FILE_LAYOUT_NAME_ENTRY` chain and its WTF-8 names.
//! - `streams`: the extra-info prefix (modification time) and the
//!   `STREAM_LAYOUT_ENTRY` chain (size of the unnamed `$DATA` stream).
//! - `walk`: the page header and the `FILE_LAYOUT_ENTRY` chain that ties the
//!   satellites together.
//! - `fixtures` (tests only): byte-level page builders.

mod names;
mod streams;
mod walk;
mod wire;

use crate::ids::RecordId;

pub use walk::walk_layout_buffer;
pub use wire::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ENTRY_LEN, FILE_LAYOUT_NAME_ENTRY_DOS,
    FILE_LAYOUT_NAME_ENTRY_PRIMARY, INFO_ENTRY_LEGACY_LEN, INFO_PREFIX_LEN, MAX_NAME_BYTES,
    NAME_ENTRY_HEADER_LEN, OUTPUT_HEADER_LEN, QUERY_FILE_LAYOUT_INCLUDE_EXTRA_INFO,
    QUERY_FILE_LAYOUT_INCLUDE_NAMES, QUERY_FILE_LAYOUT_INCLUDE_STREAMS,
    QUERY_FILE_LAYOUT_INCLUDE_STREAMS_WITH_NO_CLUSTERS_ALLOCATED, QUERY_FILE_LAYOUT_RESTART,
    QUERY_FILE_LAYOUT_SINGLE_INSTANCED, RECOMMENDED_LAYOUT_FLAGS, STREAM_ENTRY_LEN,
};

/// One hard-link name of a file, from a `FILE_LAYOUT_NAME_ENTRY`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutName {
    /// Directory that holds this link, as a full file reference: an NTFS `FRN`
    /// (record number plus sequence) is never masked or split here.
    pub parent: RecordId,
    /// The link name as WTF-8: reversible for arbitrary UTF-16, including
    /// unpaired surrogates, so it is not necessarily valid UTF-8.
    pub name: Vec<u8>,
    /// `true` when the original UTF-16 held at least one unpaired surrogate, so
    /// `name` is WTF-8 rather than UTF-8.
    pub name_lossy: bool,
    /// `true` when this entry is an 8.3 DOS alias: its flags carry
    /// [`FILE_LAYOUT_NAME_ENTRY_DOS`] without [`FILE_LAYOUT_NAME_ENTRY_PRIMARY`].
    pub dos_only: bool,
}

/// One file from a page: identity, metadata and every hard-link name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutFile {
    /// File reference: an NTFS `FRN` (record number plus sequence) in full.
    pub reference: RecordId,
    /// Raw `FILE_LAYOUT_ENTRY.FileAttributes` bits; only
    /// [`FILE_ATTRIBUTE_DIRECTORY`] changes what this parser reports.
    pub attributes: u32,
    /// Logical size (`EndOfFile`) of the unnamed `$DATA` stream. `None` for
    /// directories, for files whose page carries no stream entries (queried
    /// without streams), and for files that only have named streams.
    pub size: Option<u64>,
    /// `LastWriteTime` from the extra-info entry as a Windows `FILETIME`
    /// (100 ns ticks since 1601-01-01 UTC), unconverted. `None` when the entry
    /// is absent or declares fewer than [`INFO_PREFIX_LEN`] accessible bytes.
    pub mtime_ft: Option<i64>,
    /// Every hard-link name in chain order, DOS aliases included (marked by
    /// [`LayoutName::dos_only`]). Names are neither sorted nor de-duplicated.
    pub names: Vec<LayoutName>,
}

impl LayoutFile {
    /// Whether the raw attributes carry the directory bit.
    pub fn is_dir(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_DIRECTORY != 0
    }
}

#[cfg(test)]
pub mod fixtures;

#[cfg(test)]
#[path = "names_tests.rs"]
mod names_tests;
#[cfg(test)]
#[path = "streams_tests.rs"]
mod streams_tests;
#[cfg(test)]
#[path = "walk_tests.rs"]
mod walk_tests;
#[cfg(test)]
#[path = "wire_tests.rs"]
mod wire_tests;
