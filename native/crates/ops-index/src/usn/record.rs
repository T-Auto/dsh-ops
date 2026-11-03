// Design informed by mustafaahci/goz (MIT).
//! USN record parsing and buffer walking.
//!
//! A journal read returns a leading value followed by tightly packed,
//! eight-byte-aligned records. Version 2 and 3 records carry a name as
//! UTF-16LE; version 4 and unknown majors are skipped by their declared length
//! so a future format does not break the walk. The parser never trusts a record
//! length: zero, overrun, a header shorter than its version, and a name span
//! outside its own record are all rejected with the absolute offset.
//!
//! Field offsets follow the Windows `USN_RECORD_V2`/`USN_RECORD_V3` wire format
//! exactly; no `#[repr(C)]` view is defined, and every read is a bounds-checked
//! slice conversion.

use crate::ids::RecordId;
use crate::wtf8;
use std::fmt;

/// Size of the leading value that precedes every record buffer.
pub const LEADING_VALUE_LEN: usize = 8;
/// Size of the common header shared by every record version, and the alignment
/// quantum every record length is rounded up to.
///
/// This is deliberately a separate constant from [`LEADING_VALUE_LEN`]: the two
/// are both eight today, but one describes the leading value and the other the
/// record layout, and conflating them would hide a format error behind a
/// coincidence.
pub const USN_COMMON_HEADER_LEN: usize = 8;
/// Fixed header size of a version 2 record.
pub const USN_V2_HEADER_LEN: usize = 60;
/// Fixed header size of a version 3 record.
pub const USN_V3_HEADER_LEN: usize = 76;

/// `USN_REASON_DATA_OVERWRITE`: file data was overwritten.
pub const USN_REASON_DATA_OVERWRITE: u32 = 0x0000_0001;
/// `USN_REASON_DATA_EXTEND`: file data was appended to.
pub const USN_REASON_DATA_EXTEND: u32 = 0x0000_0002;
/// `USN_REASON_DATA_TRUNCATION`: file data was truncated.
pub const USN_REASON_DATA_TRUNCATION: u32 = 0x0000_0004;
/// `USN_REASON_FILE_CREATE`: a file or directory was created.
pub const USN_REASON_FILE_CREATE: u32 = 0x0000_0100;
/// `USN_REASON_FILE_DELETE`: the last hard link to an object was removed.
pub const USN_REASON_FILE_DELETE: u32 = 0x0000_0200;
/// `USN_REASON_RENAME_OLD_NAME`: the old name of a rename.
pub const USN_REASON_RENAME_OLD_NAME: u32 = 0x0000_1000;
/// `USN_REASON_RENAME_NEW_NAME`: the new (current) name of a rename.
pub const USN_REASON_RENAME_NEW_NAME: u32 = 0x0000_2000;
/// `USN_REASON_BASIC_INFO_CHANGE`: attributes or timestamps changed.
pub const USN_REASON_BASIC_INFO_CHANGE: u32 = 0x0000_8000;
/// `USN_REASON_HARD_LINK_CHANGE`: the set of hard links changed.
pub const USN_REASON_HARD_LINK_CHANGE: u32 = 0x0001_0000;
/// `USN_REASON_CLOSE`: the handle that produced this record was closed.
pub const USN_REASON_CLOSE: u32 = 0x8000_0000;

/// `FILE_ATTRIBUTE_DIRECTORY`: the entry is a directory.
pub const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;

/// One parsed version 2 or 3 record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedUsnRecord {
    /// Major version the record was parsed as (2 or 3).
    pub major_version: u16,
    /// File reference number (record number plus sequence).
    pub record: RecordId,
    /// Parent directory reference number.
    pub parent: RecordId,
    /// Journal offset of this record.
    pub usn: i64,
    /// `FILETIME` when the record was written, not the file's mtime.
    pub timestamp_ft: i64,
    /// Bitwise OR of every reason accumulated in the open/close window.
    pub reason: u32,
    /// Raw file attributes.
    pub attributes: u32,
    /// Name as WTF-8, so unpaired surrogates survive.
    pub name: Vec<u8>,
    /// Whether `name` is not valid UTF-8 because of an unpaired surrogate.
    pub name_lossy: bool,
}

impl ParsedUsnRecord {
    /// Whether the record describes a directory.
    pub fn is_dir(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_DIRECTORY != 0
    }
}

/// Records skipped because their major version is not parsed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SkipCounts {
    /// Version 4 records skipped by their declared length.
    pub v4: u32,
    /// Records with an unknown major version, skipped by their declared length.
    pub unknown_version: u32,
}

/// A structural defect that makes the whole buffer untrustworthy.
///
/// `offset` is absolute, including the eight-byte leading value; the first
/// record therefore starts at offset 8.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalkError {
    /// `RecordLength` was zero, which would never advance the walk.
    ZeroRecordLength {
        /// Absolute offset of the record.
        offset: usize,
    },
    /// `RecordLength` ran past the end of the buffer.
    RecordOverrun {
        /// Absolute offset of the record.
        offset: usize,
    },
    /// The record is shorter than the fixed header of its major version.
    TruncatedHeader {
        /// Absolute offset of the record.
        offset: usize,
    },
    /// The name length or span is invalid.
    MalformedName {
        /// Absolute offset of the record.
        offset: usize,
    },
}

impl WalkError {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(self) -> &'static str {
        match self {
            Self::ZeroRecordLength { .. } => "INDEX_USN_RECORD_LENGTH_ZERO",
            Self::RecordOverrun { .. } => "INDEX_USN_RECORD_OVERRUN",
            Self::TruncatedHeader { .. } => "INDEX_USN_TRUNCATED_HEADER",
            Self::MalformedName { .. } => "INDEX_USN_MALFORMED_NAME",
        }
    }

    /// Absolute offset of the record that failed.
    pub fn offset(self) -> usize {
        match self {
            Self::ZeroRecordLength { offset }
            | Self::RecordOverrun { offset }
            | Self::TruncatedHeader { offset }
            | Self::MalformedName { offset } => offset,
        }
    }
}

impl fmt::Display for WalkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroRecordLength { offset } => {
                write!(f, "usn record at offset {offset} has zero length")
            }
            Self::RecordOverrun { offset } => {
                write!(f, "usn record at offset {offset} runs past the buffer")
            }
            Self::TruncatedHeader { offset } => {
                write!(
                    f,
                    "usn record at offset {offset} is shorter than its header"
                )
            }
            Self::MalformedName { offset } => {
                write!(f, "usn record at offset {offset} has a malformed name span")
            }
        }
    }
}

impl std::error::Error for WalkError {}

/// One bounded enumeration buffer: a start record number plus its records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnumWalk {
    /// Next `StartFileReferenceNumber` the caller should pass to continue.
    pub next_start: u64,
    /// Records in buffer order (no sorting, no deduplication).
    pub records: Vec<ParsedUsnRecord>,
    /// Counts of records skipped by version.
    pub skipped: SkipCounts,
}

/// One journal read buffer: the next USN plus its records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalWalk {
    /// Next USN the caller should request to continue.
    pub next_usn: i64,
    /// Records in journal order (ascending USN for a read).
    pub records: Vec<ParsedUsnRecord>,
    /// Counts of records skipped by version.
    pub skipped: SkipCounts,
}

/// Parses one `FSCTL_ENUM_USN_DATA` output buffer.
pub fn walk_enum_buffer(buffer: &[u8]) -> Result<EnumWalk, WalkError> {
    let next_start = read_u64(buffer, 0).ok_or(WalkError::TruncatedHeader { offset: 0 })?;
    let (records, skipped) = walk_records(buffer)?;
    Ok(EnumWalk {
        next_start,
        records,
        skipped,
    })
}

/// Parses one `FSCTL_READ_USN_JOURNAL` output buffer.
pub fn walk_journal_buffer(buffer: &[u8]) -> Result<JournalWalk, WalkError> {
    let next_usn = read_i64(buffer, 0).ok_or(WalkError::TruncatedHeader { offset: 0 })?;
    let (records, skipped) = walk_records(buffer)?;
    Ok(JournalWalk {
        next_usn,
        records,
        skipped,
    })
}

/// Shared record walk. Both ioctls pack records identically; only the leading
/// value's interpretation differs.
fn walk_records(buffer: &[u8]) -> Result<(Vec<ParsedUsnRecord>, SkipCounts), WalkError> {
    let mut records = Vec::with_capacity((buffer.len() / USN_V2_HEADER_LEN).min(4096));
    let mut skipped = SkipCounts::default();
    let mut offset = LEADING_VALUE_LEN;
    while offset + USN_COMMON_HEADER_LEN <= buffer.len() {
        let length =
            read_u32(buffer, offset).ok_or(WalkError::TruncatedHeader { offset })? as usize;
        if length == 0 {
            return Err(WalkError::ZeroRecordLength { offset });
        }
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= buffer.len())
            .ok_or(WalkError::RecordOverrun { offset })?;
        let major = read_u16(buffer, offset + 4).ok_or(WalkError::TruncatedHeader { offset })?;
        match major {
            version @ (2 | 3) => records.push(parse_record(buffer, offset, end, version)?),
            4 => skipped.v4 = skipped.v4.saturating_add(1),
            _ => skipped.unknown_version = skipped.unknown_version.saturating_add(1),
        }
        // Records are eight-byte aligned; round the end up. An incomplete tail
        // (fewer than eight bytes) is a normal end of buffer, not an error.
        let Some(next) = end.checked_next_multiple_of(USN_COMMON_HEADER_LEN) else {
            break;
        };
        offset = next;
    }
    Ok((records, skipped))
}

/// Parses one version 2 or 3 record whose declared length is already bounded.
fn parse_record(
    buffer: &[u8],
    offset: usize,
    end: usize,
    version: u16,
) -> Result<ParsedUsnRecord, WalkError> {
    let header_len = match version {
        2 => USN_V2_HEADER_LEN,
        3 => USN_V3_HEADER_LEN,
        _ => return Err(WalkError::TruncatedHeader { offset }),
    };
    if end - offset < header_len {
        return Err(WalkError::TruncatedHeader { offset });
    }
    // The fixed header is inside the declared record and the record is inside
    // the buffer, so these reads cannot fail; the `?` keeps that explicit
    // rather than indexing.
    let fail = WalkError::TruncatedHeader { offset };
    let u16_at = |at: usize| read_u16(buffer, offset + at).ok_or(fail);
    let u32_at = |at: usize| read_u32(buffer, offset + at).ok_or(fail);
    let i64_at = |at: usize| read_i64(buffer, offset + at).ok_or(fail);
    let record_at = |at: usize| read_u64(buffer, offset + at).map(RecordId::new).ok_or(fail);
    let (record, parent, usn, timestamp_ft, reason, attributes, name_length, name_offset) =
        if version == 2 {
            (
                record_at(8)?,
                record_at(16)?,
                i64_at(24)?,
                i64_at(32)?,
                u32_at(40)?,
                u32_at(52)?,
                u16_at(56)?,
                u16_at(58)?,
            )
        } else {
            // V3 ids are 128 bits; only the low 64 bits enter the index. The
            // high half is read and discarded, never treated as an error.
            let _frn_high = read_u64(buffer, offset + 16);
            let _parent_high = read_u64(buffer, offset + 32);
            (
                record_at(8)?,
                record_at(24)?,
                i64_at(40)?,
                i64_at(48)?,
                u32_at(56)?,
                u32_at(68)?,
                u16_at(72)?,
                u16_at(74)?,
            )
        };
    extract_name(
        buffer,
        offset,
        end,
        header_len,
        record,
        parent,
        usn,
        timestamp_ft,
        reason,
        attributes,
        UsnName {
            length: name_length,
            offset: name_offset,
        },
        version,
    )
}

/// Declared name span of one record, relative to the record start.
#[derive(Clone, Copy)]
struct UsnName {
    length: u16,
    offset: u16,
}

/// Bounds-checks and decodes the variable-length name of one record.
#[allow(clippy::too_many_arguments)]
fn extract_name(
    buffer: &[u8],
    offset: usize,
    end: usize,
    header_len: usize,
    record: RecordId,
    parent: RecordId,
    usn: i64,
    timestamp_ft: i64,
    reason: u32,
    attributes: u32,
    name: UsnName,
    version: u16,
) -> Result<ParsedUsnRecord, WalkError> {
    let name_length = name.length as usize;
    let name_offset = name.offset as usize;
    if !name_length.is_multiple_of(2) || name_offset < header_len {
        return Err(WalkError::MalformedName { offset });
    }
    let record_len = end - offset;
    let name_end = name_offset
        .checked_add(name_length)
        .filter(|name_end| *name_end <= record_len)
        .ok_or(WalkError::MalformedName { offset })?;
    let start = offset + name_offset;
    let mut name = Vec::with_capacity(name_length);
    let name_lossy = wtf8::from_utf16_le(&buffer[start..offset + name_end], &mut name);
    Ok(ParsedUsnRecord {
        major_version: version,
        record,
        parent,
        usn,
        timestamp_ft,
        reason,
        attributes,
        name,
        name_lossy,
    })
}

fn read_u16(buffer: &[u8], offset: usize) -> Option<u16> {
    let bytes = buffer.get(offset..)?.get(..2)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(buffer: &[u8], offset: usize) -> Option<u32> {
    let bytes = buffer.get(offset..)?.get(..4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_u64(buffer: &[u8], offset: usize) -> Option<u64> {
    let bytes = buffer.get(offset..)?.get(..8)?;
    Some(u64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]))
}

fn read_i64(buffer: &[u8], offset: usize) -> Option<i64> {
    read_u64(buffer, offset).map(|value| value as i64)
}

#[cfg(test)]
#[path = "record_tests.rs"]
mod record_tests;
