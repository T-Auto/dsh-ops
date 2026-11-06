// Design informed by mustafaahci/goz (MIT).

//! Raw `FSCTL_*` fallback for the Windows USN source (W3).
//!
//! usn-journal-rs covers the ordinary path: it opens the volume, enumerates the
//! MFT and reads the journal. What it deliberately does not expose is the
//! control `ops-index` needs for a bounded, resumable scan — an explicit
//! `StartFileReferenceNumber` plus USN range for `FSCTL_ENUM_USN_DATA`, and an
//! explicit reason mask / `ReturnOnlyOnClose` / `BytesToWaitFor` / journal id
//! for `FSCTL_READ_USN_JOURNAL`, with the caller's own page buffer. This module
//! is that fallback. It is never the default: a caller tries the crate path
//! first and drops to [`VolumeHandle`] when the request cannot be expressed or
//! the crate fails.
//!
//! The split keeps every byte-level decision testable:
//!
//! - [`VolumeIo`] is the only thing that touches the kernel. Tests inject a
//!   fake, so request encoding, page decoding and error mapping are asserted on
//!   any machine that can build a Windows test binary.
//! - The output buffers are parsed by `ops_index::usn`, never here. This module
//!   produces bytes and page metadata; record parsing, structural validation
//!   and the "a malformed page must be rescanned, not skipped" rule stay in the
//!   platform-agnostic crate.
//! - Every failure maps to [`ops_index::SourceError`] through
//!   [`WinfsError::source_error`], so the caller falls back to its own
//!   traversal without inventing a second error vocabulary.
//!
//! ## Unsafe isolation
//!
//! The crate root denies `unsafe_code`; only `sys` and W4's `links` are
//! allowed to break it; `unsafe_op_in_unsafe_fn` is denied, so every raw call
//! sits in a block with a SAFETY comment naming its invariant. No other module
//! in this crate names a raw Win32 type, and `cfg(any(...))` branches stay
//! absent: the whole crate is `cfg(windows)`.
//! The crate root denies `unsafe_code`; only `sys` is allowed to break it;
//! `unsafe_op_in_unsafe_fn` is denied, so every raw call sits in a block with a
//! SAFETY comment naming its invariant. No other module in this crate names a
//! raw Win32 type, and `cfg(any(...))` branches stay absent: the whole crate is
//! `cfg(windows)`.

#[allow(unsafe_code)]
mod sys;

#[cfg(test)]
pub(crate) mod fixtures;

pub mod enum_data;
pub mod error;
pub mod journal;
pub mod volume_path;

/// W4 hard-link name enumeration (FindFirstFileNameW/FindNextFileNameW).
///
/// This submodule owns its own FFI bridge and carries a scoped
/// `allow(unsafe_code)` of its own, so a future reader can see exactly which
/// W4 code needs it even though the rest of `winfs` already has its own
/// islands.
#[allow(unsafe_code)]
pub mod links;

pub use enum_data::{EnumPage, EnumRequest, read_enum_page};

#[cfg(test)]
#[path = "unsafe_guard_tests.rs"]
mod unsafe_guard_tests;
pub use error::WinfsError;
pub use journal::{JournalPage, ReadJournalRequest, read_journal_page};
pub use sys::{PageOutcome, VolumeHandle, VolumeIo};
pub use volume_path::device_path;

/// `FSCTL_ENUM_USN_DATA`: enumerate the MFT between two USNs.
///
/// `CTL_CODE(FILE_DEVICE_FILE_SYSTEM = 9, 44, METHOD_NEITHER = 3, FILE_ANY_ACCESS = 0)`.
pub const FSCTL_ENUM_USN_DATA: u32 = 0x0009_00b3;

/// `FSCTL_READ_USN_JOURNAL`: read the journal from a USN up to the page size.
///
/// `CTL_CODE(FILE_DEVICE_FILE_SYSTEM = 9, 46, METHOD_NEITHER = 3, FILE_ANY_ACCESS = 0)`.
pub const FSCTL_READ_USN_JOURNAL: u32 = 0x0009_00bb;
