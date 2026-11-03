// Design informed by mustafaahci/goz (MIT).
//! Parsers for the byte streams a platform source produces.
//!
//! The USN journal format is a Windows file-system ABI, but the parser here is
//! pure byte work: no OS call, no `unsafe`, no `cfg`. A platform crate hands in
//! the exact bytes the kernel returned; this module turns them into records and
//! reports every structural defect with the offset that failed. A malformed
//! buffer makes the whole page untrustworthy: the caller must rescan, never skip
//! a bad record and continue.
//!
//! `fixtures` is compiled for tests only and builds those buffers from
//! descriptive values, so record-layout assertions run on every OS.

pub mod record;

#[cfg(test)]
pub mod fixtures;

pub use record::{
    EnumWalk, FILE_ATTRIBUTE_DIRECTORY, JournalWalk, LEADING_VALUE_LEN, ParsedUsnRecord,
    SkipCounts, USN_REASON_BASIC_INFO_CHANGE, USN_REASON_CLOSE, USN_REASON_DATA_EXTEND,
    USN_REASON_DATA_OVERWRITE, USN_REASON_DATA_TRUNCATION, USN_REASON_FILE_CREATE,
    USN_REASON_FILE_DELETE, USN_REASON_HARD_LINK_CHANGE, USN_REASON_RENAME_NEW_NAME,
    USN_REASON_RENAME_OLD_NAME, USN_V2_HEADER_LEN, USN_V3_HEADER_LEN, WalkError, walk_enum_buffer,
    walk_journal_buffer,
};
