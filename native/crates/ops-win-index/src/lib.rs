#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]
#![cfg(windows)]
//! Windows file-name index data source (W2: cold MFT plus journal tail; W3: raw
//! FSCTL fallback).
//!
//! This crate is the Windows member of the platform data-source crates designed
//! in #584. The cold half enumerates FSCTL_ENUM_USN_DATA through
//! usn-journal-rs and rebuilds relative paths in memory from parent file ids.
//! W2 adds the USN journal tail: a bounded catch-up makes one enumeration
//! consistent at a single instant, and a host-provided CursorStore plus the
//! pure cursor validation from ops-index decide whether a kept snapshot may be
//! replayed or the caller must rescan.
//!
//! W3 adds [`winfs`], the raw FSCTL fallback: paged
//! `FSCTL_ENUM_USN_DATA`/`FSCTL_READ_USN_JOURNAL` reads for the cases
//! usn-journal-rs does not express (explicit start file reference, reason mask,
//! `ReturnOnlyOnClose`, wait hints and caller-owned page buffers). Parsing stays
//! in `ops_index::usn`; the crate's only `unsafe` lives in that module, behind
//! a safe `VolumeHandle`/`VolumeIo` boundary, with `unsafe_op_in_unsafe_fn`
//! denied and a SAFETY comment on every block.
//!
//! The whole crate body is behind #![cfg(windows)], so every other target
//! compiles an empty library and the workspace stays green. The Windows-only
//! dependencies are target-gated for the same reason. usn-journal-rs keeps its
//! own unsafe in its own crate; `winfs` is the single, documented island here.
//! cap-std/cap-fs-ext are used only to read the volume root's metadata, which is
//! what makes Candidate.key match the integration's (dev, ino) exactly.
//!
//! What this crate does NOT claim:
//!
//! - No file size or modification time. FSCTL_ENUM_USN_DATA and the journal
//!   carry names, attributes and ids only, so Candidate.len is 0 and
//!   modified_ns is None until a later enrichment slice fills them.
//! - No ReFS. A 128-bit file id cannot become the 64-bit half of FileKey, so an
//!   extended id makes this slice answer Unsupported.
//! - No cross-volume trees. The root's file id is read through cap-fs-ext and
//!   the MFT is that volume's, so the root must live on one locally-mounted NTFS
//!   volume; reparse points are not followed.
//! - No journal creation and no silent completeness: a volume without an active
//!   journal is Unsupported, and a replay whose parent cannot be resolved marks
//!   the set as not complete (truncated) or counts the record as skipped.
//! - The raw FSCTL fallback is not wired into `WinFsSource` yet: W3 ships the
//!   paged API and its tests, and the source keeps using usn-journal-rs until a
//!   later slice needs the fallback.
//!
//! Design reference: goz v0.4.0 (8c6a7b1562bb1eea46dd67d462805b49b9a1f152,
//! MIT). Nothing was copied; this platform layer is written for dsh-ops.

pub mod changes;
pub mod journal;
pub mod mft;
pub mod source;
pub mod winfs;

pub use changes::ChangeReport;
pub use journal::{CursorStore, JournalCursor, MemoryCursorStore};
pub use mft::cold_candidates;
pub use source::WinFsSource;
