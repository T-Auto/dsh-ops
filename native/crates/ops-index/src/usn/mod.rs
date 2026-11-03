// Design informed by mustafaahci/goz (MIT).
//! Parsers and normalizers for the byte streams a platform source produces.
//!
//! The USN journal format is a Windows file-system ABI, but everything here is
//! pure byte and integer work: no OS call, no `unsafe`, no `cfg`. A platform
//! crate hands in the exact bytes the kernel returned; `record` turns them into
//! records and reports every structural defect with the offset that failed. A
//! malformed buffer makes the whole page untrustworthy: the caller must rescan,
//! never skip a bad record and continue.
//!
//! Two pure layers sit on top of the records. `ops` normalizes an accumulated
//! reason mask into idempotent index operations, and `cursor` decides whether a
//! saved journal cursor may be replayed or the volume needs a full rescan.
//! Neither layer performs IO nor knows about a platform.
//!
//! `fixtures` is compiled for tests only and builds those buffers from
//! descriptive values, so record-layout assertions run on every OS.

pub mod cursor;
pub mod ops;
pub mod record;

#[cfg(test)]
pub mod fixtures;

pub use cursor::{JournalInfo, RescanReason, Resync, SavedCursor, validate_cursor};
pub use ops::{MAX_OPS_PER_RECORD, OpList, REASON_MASK, UsnOp, ops_for};
pub use record::{
    EnumWalk, FILE_ATTRIBUTE_DIRECTORY, JournalWalk, LEADING_VALUE_LEN, ParsedUsnRecord,
    SkipCounts, USN_COMMON_HEADER_LEN, USN_REASON_BASIC_INFO_CHANGE, USN_REASON_CLOSE,
    USN_REASON_DATA_EXTEND, USN_REASON_DATA_OVERWRITE, USN_REASON_DATA_TRUNCATION,
    USN_REASON_FILE_CREATE, USN_REASON_FILE_DELETE, USN_REASON_HARD_LINK_CHANGE,
    USN_REASON_RENAME_NEW_NAME, USN_REASON_RENAME_OLD_NAME, USN_V2_HEADER_LEN, USN_V3_HEADER_LEN,
    WalkError, walk_enum_buffer, walk_journal_buffer,
};
