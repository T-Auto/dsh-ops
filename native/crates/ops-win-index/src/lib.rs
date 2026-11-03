#![forbid(unsafe_code)]
#![cfg(windows)]
//! Windows file-name index data source (W2: cold MFT plus journal tail).
//!
//! This crate is the Windows member of the platform data-source crates designed
//! in #584. The cold half enumerates FSCTL_ENUM_USN_DATA through
//! usn-journal-rs and rebuilds relative paths in memory from parent file ids.
//! W2 adds the USN journal tail: a bounded catch-up makes one enumeration
//! consistent at a single instant, and a host-provided CursorStore plus the
//! pure cursor validation from ops-index decide whether a kept snapshot may be
//! replayed or the caller must rescan.
//!
//! The whole crate body is behind #![cfg(windows)], so every other target
//! compiles an empty library and the workspace stays green. The Windows-only
//! dependencies are target-gated for the same reason. usn-journal-rs keeps its
//! unsafe in its own crate: nothing here uses unsafe, names a raw Win32 type, or
//! writes a platform cfg branch. cap-std/cap-fs-ext are used only to read the
//! volume root's metadata, which is what makes Candidate.key match the
//! integration's (dev, ino) exactly.
//!
//! What this slice still does NOT claim:
//!
//! - No file size or modification time. FSCTL_ENUM_USN_DATA and the journal
//!   carry names, attributes and ids only, so Candidate.len is 0 and
//!   modified_ns is None until a later enrichment slice fills them.
//! - No ReFS. A 128-bit file id cannot become the 64-bit half of FileKey, so an
//!   extended id makes this slice answer Unsupported.
//! - No roots below a mounted-volume directory. The root is located by walking
//!   from the volume root through the path components, so it must live on a
//!   volume mounted at its drive or UNC root.
//! - No journal creation and no silent completeness: a volume without an active
//!   journal is Unsupported, and a replay whose parent cannot be resolved marks
//!   the set as not complete (truncated) or counts the record as skipped.
//!
//! Design reference: goz v0.4.0 (8c6a7b1562bb1eea46dd67d462805b49b9a1f152,
//! MIT). Nothing was copied; this platform layer is written for dsh-ops.

pub mod changes;
pub mod journal;
pub mod mft;
pub mod source;

pub use changes::ChangeReport;
pub use journal::{CursorStore, JournalCursor, MemoryCursorStore};
pub use mft::cold_candidates;
pub use source::WinFsSource;
