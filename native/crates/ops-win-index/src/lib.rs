#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]
#![cfg(windows)]
//! Windows file-name index data source (W1 cold MFT enumeration, W3 raw FSCTL
//! fallback, W4 hard-link reconciliation).
//!
//! This crate is the Windows member of the platform data-source crates designed
//! in #584. W1 delivers the cold half: FSCTL_ENUM_USN_DATA through
//! usn-journal-rs, assembled into ops-index Candidate values with relative
//! paths rebuilt in memory from parent file ids. There is no journal replay,
//! no event stream and no daemon; W2 wires the USN journal and turns a cold
//! enumeration into a caught-up snapshot.
//!
//! W3 adds [`winfs`], the raw FSCTL fallback: paged
//! `FSCTL_ENUM_USN_DATA`/`FSCTL_READ_USN_JOURNAL` reads for the cases
//! usn-journal-rs does not express (explicit start file reference, reason mask,
//! `ReturnOnlyOnClose`, wait hints and caller-owned page buffers). Parsing stays
//! in `ops_index::usn`. The crate's `unsafe` lives in two allowed islands
//! inside `winfs`: `winfs::sys` for `FSCTL_*` and `winfs::links` for W4's
//! `FindFirstFileNameW`/`FindNextFileNameW`; each sits behind a safe boundary
//! with `unsafe_op_in_unsafe_fn` denied and a SAFETY comment on every block.
//!
//! The whole crate body is behind #![cfg(windows)], so every other target
//! compiles an empty library and the workspace stays green. The Windows-only
//! dependencies are target-gated for the same reason. usn-journal-rs keeps its
//! own unsafe in its own crate; `winfs` is the single, documented island here.
//!
//! What this crate does NOT claim:
//!
//! - No caught-up snapshot. state never answers Ready yet; callers keep
//!   falling back to their own traversal until W2 can replay the journal.
//! - No file size or modification time. FSCTL_ENUM_USN_DATA carries names,
//!   attributes and file ids only, so Candidate.len is 0 and modified_ns is
//!   None until a later enrichment slice fills them.
//! - No volume serial. usn-journal-rs exposes none, so FileKey.volume is 0 and
//!   a key is volume-local for now.
//! - No ReFS. A 128-bit file id cannot become the 64-bit half of FileKey, so
//!   an extended id makes this slice answer Unsupported.
//! - No roots below a mounted-volume directory. W1 locates the root by walking
//!   from the volume root through the path components, so the root must live
//!   on a volume mounted at its drive or UNC root.
//! - The raw FSCTL fallback is not wired into `WinFsSource` yet: W3 ships the
//!   paged API and its tests, and the source keeps using usn-journal-rs until a
//!   later slice needs the fallback.
//! - W4 does not apply a link set. It enumerates a file's current hard-link
//!   names and classifies an incomplete walk; joining that set to index entries
//!   (W2's HARD_LINK_CHANGE) stays with the caller. An incomplete walk is
//!   skipped and counted, never applied as an empty set.
//!
//! Design reference: goz v0.4.0 (8c6a7b1562bb1eea46dd67d462805b49b9a1f152,
//! MIT). Nothing was copied; this platform layer is written for dsh-ops.

pub mod links;
pub mod mft;
pub mod source;
pub mod winfs;

pub use links::{
    LinkFailure, LinkFailureKind, LinkOutcome, LinkSet, LinkWalkStats, MAX_LINKS, enumerate,
};
pub use mft::cold_candidates;
pub use source::WinFsSource;
