// Design informed by mustafaahci/goz (MIT).
//! Byte-level USN fixture builders, compiled for tests only.
//!
//! A fixture is a logical description; [`record_bytes`] renders the exact wire
//! format, including the deliberately non-zero [`PAD_BYTE`] in the alignment
//! tail. Reading past the name would therefore drag 0xCC into the name and a
//! test would see it.

use super::record::{FILE_ATTRIBUTE_DIRECTORY, USN_V2_HEADER_LEN, USN_V3_HEADER_LEN};
use crate::ids::RecordId;

/// Byte written into alignment padding. Non-zero on purpose.
pub const PAD_BYTE: u8 = 0xCC;

/// Description of one record to render.
#[derive(Clone, Debug)]
pub struct RecordFixture {
    /// Major version: 2 or 3.
    pub version: u16,
    /// File reference number.
    pub record: RecordId,
    /// Parent directory reference number.
    pub parent: RecordId,
    /// Journal offset.
    pub usn: i64,
    /// FILETIME of the record.
    pub timestamp: i64,
    /// Accumulated reason mask.
    pub reason: u32,
    /// Raw attributes.
    pub attributes: u32,
    /// Name as UTF-16 code units (an unpaired surrogate is allowed).
    pub name_units: Vec<u16>,
}

impl RecordFixture {
    /// A version 2 file record with a UTF-8 name.
    pub fn file(record: RecordId, parent: RecordId, name: &str) -> Self {
        Self {
            version: 2,
            record,
            parent,
            usn: 0,
            timestamp: 0,
            reason: 0,
            attributes: 0,
            name_units: name.encode_utf16().collect(),
        }
    }

    /// A version 2 directory record with a UTF-8 name.
    pub fn dir(record: RecordId, parent: RecordId, name: &str) -> Self {
        Self {
            attributes: FILE_ATTRIBUTE_DIRECTORY,
            ..Self::file(record, parent, name)
        }
    }

    /// Overrides the major version.
    pub fn with_version(mut self, version: u16) -> Self {
        self.version = version;
        self
    }

    /// Overrides the reason mask.
    pub fn with_reason(mut self, reason: u32) -> Self {
        self.reason = reason;
        self
    }

    /// Overrides the journal offset.
    pub fn with_usn(mut self, usn: i64) -> Self {
        self.usn = usn;
        self
    }

    /// Overrides the record timestamp.
    pub fn with_timestamp(mut self, timestamp: i64) -> Self {
        self.timestamp = timestamp;
        self
    }

    /// Overrides the raw attributes.
    pub fn with_attributes(mut self, attributes: u32) -> Self {
        self.attributes = attributes;
        self
    }

    /// Replaces the name code units.
    pub fn with_name_units(mut self, units: Vec<u16>) -> Self {
        self.name_units = units;
        self
    }
}

/// Renders one record exactly as the kernel would, padded to eight bytes.
pub fn record_bytes(fixture: &RecordFixture) -> Vec<u8> {
    let (major, header_len) = match fixture.version {
        2 => (2u16, USN_V2_HEADER_LEN),
        3 => (3u16, USN_V3_HEADER_LEN),
        other => panic!("fixture version {other} has no record builder"),
    };
    let name_len = fixture.name_units.len() * 2;
    let length = (header_len + name_len).next_multiple_of(8);
    let mut bytes = vec![0u8; length];
    bytes[0..4].copy_from_slice(&(length as u32).to_le_bytes());
    bytes[4..6].copy_from_slice(&major.to_le_bytes());
    if major == 2 {
        bytes[8..16].copy_from_slice(&fixture.record.get().to_le_bytes());
        bytes[16..24].copy_from_slice(&fixture.parent.get().to_le_bytes());
        bytes[24..32].copy_from_slice(&fixture.usn.to_le_bytes());
        bytes[32..40].copy_from_slice(&fixture.timestamp.to_le_bytes());
        bytes[40..44].copy_from_slice(&fixture.reason.to_le_bytes());
        bytes[52..56].copy_from_slice(&fixture.attributes.to_le_bytes());
        bytes[56..58].copy_from_slice(&(name_len as u16).to_le_bytes());
        bytes[58..60].copy_from_slice(&(header_len as u16).to_le_bytes());
    } else {
        // The high halves of the 128-bit ids stay a zero extension.
        bytes[8..16].copy_from_slice(&fixture.record.get().to_le_bytes());
        bytes[24..32].copy_from_slice(&fixture.parent.get().to_le_bytes());
        bytes[40..48].copy_from_slice(&fixture.usn.to_le_bytes());
        bytes[48..56].copy_from_slice(&fixture.timestamp.to_le_bytes());
        bytes[56..60].copy_from_slice(&fixture.reason.to_le_bytes());
        bytes[68..72].copy_from_slice(&fixture.attributes.to_le_bytes());
        bytes[72..74].copy_from_slice(&(name_len as u16).to_le_bytes());
        bytes[74..76].copy_from_slice(&(header_len as u16).to_le_bytes());
    }
    for (index, unit) in fixture.name_units.iter().enumerate() {
        let at = header_len + index * 2;
        bytes[at..at + 2].copy_from_slice(&unit.to_le_bytes());
    }
    for byte in &mut bytes[header_len + name_len..] {
        *byte = PAD_BYTE;
    }
    bytes
}

/// Builds an `FSCTL_ENUM_USN_DATA` buffer with a leading start value.
pub fn build_enum_buffer(next_start: u64, fixtures: &[RecordFixture]) -> Vec<u8> {
    let mut buffer = next_start.to_le_bytes().to_vec();
    for fixture in fixtures {
        debug_assert_eq!(buffer.len() % 8, 0, "records are eight-byte aligned");
        buffer.extend_from_slice(&record_bytes(fixture));
    }
    buffer
}

/// Builds an `FSCTL_READ_USN_JOURNAL` buffer with a leading next-USN value.
pub fn build_journal_buffer(next_usn: i64, fixtures: &[RecordFixture]) -> Vec<u8> {
    let mut buffer = next_usn.to_le_bytes().to_vec();
    for fixture in fixtures {
        debug_assert_eq!(buffer.len() % 8, 0, "records are eight-byte aligned");
        buffer.extend_from_slice(&record_bytes(fixture));
    }
    buffer
}

/// A hand-built 80-byte version 4 record: skipped, never parsed.
pub fn build_v4_record_bytes() -> Vec<u8> {
    let mut bytes = vec![0u8; 80];
    bytes[0..4].copy_from_slice(&80u32.to_le_bytes());
    bytes[4..6].copy_from_slice(&4u16.to_le_bytes());
    bytes
}
