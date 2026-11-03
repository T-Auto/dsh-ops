// Design informed by mustafaahci/goz (MIT).
//! Snapshot byte format: header, name table, compact record table.
//!
//! Little-endian, no alignment requirement, every length checked against the
//! bytes that actually exist. The payload CRC covers the name and record
//! sections; the header CRC covers the first 72 bytes, so a version field cannot
//! be edited without noticing. [`decode`] is total over arbitrary bytes: it
//! returns an error, never panics and never allocates based on an unchecked
//! length.
//!
//! Wire layout (all integers little-endian):
//!
//! ```text
//! header (76 bytes)
//!   0..8    magic "DSHOPSIX"
//!   8..10   format version (u16)
//!  10..12   schema version, tied to the fold behaviour (u16)
//!  12..16   header length (u32, must be 76)
//!  16..20   reserved flags (u32, must be zero)
//!  20..28   volume id (u64)
//!  28..36   root dev (u64)
//!  36..44   root ino (u64)
//!  44..52   generation (u64)
//!  52..60   name section length (u64)
//!  60..68   record section length (u64)
//!  68..72   payload CRC32 (name + record sections)
//!  72..76   header CRC32 (bytes 0..72)
//! name section
//!   count (u32) then, per name, length (u32) + raw WTF-8 bytes
//! record section
//!   count (u32) then count * 32-byte records
//! record (32 bytes)
//!   0..8    record id (u64)
//!   8..12   parent record index or PARENT_NIL (u32)
//!  12..16   name index in the low 28 bits, RecordFlags in the high 4 bits
//!  16..24   size (u64, u64::MAX = unknown)
//!  24..32   mtime in nanoseconds (i64, i64::MIN = unknown)
//! ```

use crate::ids::{FileKey, RecordId, VolumeId};
use std::fmt;

/// Magic bytes at the start of every snapshot.
pub const MAGIC: &[u8; 8] = b"DSHOPSIX";
/// Format version. Bumped when the byte layout changes.
pub const FORMAT_VERSION: u16 = 1;
/// Schema version. Bumped when the fold behaviour changes, because folded
/// names are rebuilt on load instead of being stored.
pub const SCHEMA_VERSION: u16 = 1;
/// Header length in bytes.
pub const HEADER_LEN: usize = 76;
/// Wire length of one record.
pub const RECORD_LEN: usize = 32;
/// Parent value meaning "no parent" (a root).
pub const PARENT_NIL: u32 = u32::MAX;
/// Largest name index that fits next to the four flag bits.
pub const NAME_ID_MAX: u32 = 0x0FFF_FFFF;
/// Sentinel stored for an unknown size.
const SIZE_UNKNOWN: u64 = u64::MAX;
/// Sentinel stored for an unknown modification time.
const MTIME_UNKNOWN: i64 = i64::MIN;

/// Bit flags persisted for one record.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct RecordFlags(u8);

impl RecordFlags {
    /// No flags.
    pub const EMPTY: Self = Self(0);
    /// The entry is a directory.
    pub const DIR: Self = Self(1 << 0);
    /// The entry is the synthetic lost-and-found directory.
    pub const LOST_FOUND: Self = Self(1 << 1);
    /// The entry is an orphan placeholder waiting for its parent record.
    pub const PLACEHOLDER: Self = Self(1 << 2);
    /// The name is not valid UTF-8 (it contains an unpaired surrogate).
    pub const NON_UNICODE_NAME: Self = Self(1 << 3);

    /// Builds flags from raw bits, rejecting bits outside this format.
    pub fn from_bits(bits: u8) -> Option<Self> {
        (bits & !0x0F == 0).then_some(Self(bits))
    }

    /// Raw bit value.
    pub fn bits(self) -> u8 {
        self.0
    }

    /// Whether every flag in `other` is set.
    pub fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    /// Returns these flags with `other` turned on or off.
    pub fn with(self, other: Self, on: bool) -> Self {
        if on {
            Self(self.0 | other.0)
        } else {
            Self(self.0 & !other.0)
        }
    }
}

/// One persisted record: identity, parent, name index, flags and metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotRecord {
    /// File identity (record number plus generation).
    pub record: RecordId,
    /// Index of the parent record in this snapshot, or [`PARENT_NIL`].
    pub parent: u32,
    /// Index into [`Snapshot::names`].
    pub name: u32,
    /// Persisted flags.
    pub flags: RecordFlags,
    /// Size in bytes; `None` means unknown.
    pub size: Option<u64>,
    /// Modification time in nanoseconds since the Unix epoch; `None` means
    /// unknown.
    pub mtime_ns: Option<i64>,
}

/// One self-contained snapshot of a root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    /// Volume the root lives on.
    pub volume: VolumeId,
    /// Root identity as `(dev, ino)` or `(volume serial, file id)`.
    pub root: FileKey,
    /// Monotonic generation; a load compares it with the source before trusting
    /// the image.
    pub generation: u64,
    /// Unique names, raw WTF-8. A name index is a position in this vector.
    pub names: Vec<Vec<u8>>,
    /// Entries in table order.
    pub records: Vec<SnapshotRecord>,
}

/// Why a snapshot could not be encoded or decoded.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum SnapshotError {
    /// The buffer ended before a required field could be read.
    Truncated {
        /// Name of the section or field.
        what: &'static str,
        /// Absolute offset where decoding stopped.
        offset: usize,
        /// Bytes required.
        need: usize,
        /// Bytes available from `offset`.
        len: usize,
    },
    /// The magic bytes did not match.
    BadMagic,
    /// The layout version is not supported.
    UnsupportedFormat {
        /// Version found in the header.
        found: u16,
        /// Version this build writes.
        expected: u16,
    },
    /// The schema version (fold behaviour) is not supported.
    UnsupportedSchema {
        /// Schema version found in the header.
        found: u16,
        /// Schema version this build writes.
        expected: u16,
    },
    /// A fixed header field had an invalid value.
    BadHeader {
        /// Name of the field.
        what: &'static str,
    },
    /// The header CRC did not match.
    HeaderCrcMismatch {
        /// CRC stored in the header.
        found: u32,
        /// CRC computed over the header bytes.
        expected: u32,
    },
    /// The payload CRC did not match.
    PayloadCrcMismatch {
        /// CRC stored in the header.
        found: u32,
        /// CRC computed over the payload bytes.
        expected: u32,
    },
    /// A section was internally inconsistent.
    Malformed {
        /// Name of the section or field.
        what: &'static str,
        /// Absolute offset where the defect was detected.
        offset: usize,
    },
    /// Bytes followed the declared sections.
    TrailingData {
        /// Offset of the first trailing byte.
        offset: usize,
        /// Number of trailing bytes.
        len: usize,
    },
    /// A value cannot be represented by this format.
    OutOfRange {
        /// Name of the field.
        what: &'static str,
    },
}

impl SnapshotError {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Truncated { .. } => "INDEX_SNAPSHOT_TRUNCATED",
            Self::BadMagic => "INDEX_SNAPSHOT_BAD_MAGIC",
            Self::UnsupportedFormat { .. } => "INDEX_SNAPSHOT_FORMAT_VERSION",
            Self::UnsupportedSchema { .. } => "INDEX_SNAPSHOT_SCHEMA_VERSION",
            Self::BadHeader { .. } => "INDEX_SNAPSHOT_BAD_HEADER",
            Self::HeaderCrcMismatch { .. } => "INDEX_SNAPSHOT_HEADER_CRC",
            Self::PayloadCrcMismatch { .. } => "INDEX_SNAPSHOT_PAYLOAD_CRC",
            Self::Malformed { .. } => "INDEX_SNAPSHOT_MALFORMED",
            Self::TrailingData { .. } => "INDEX_SNAPSHOT_TRAILING_DATA",
            Self::OutOfRange { .. } => "INDEX_SNAPSHOT_OUT_OF_RANGE",
        }
    }
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated {
                what,
                offset,
                need,
                len,
            } => write!(
                f,
                "snapshot {what} truncated at offset {offset}: need {need} bytes, have {len}"
            ),
            Self::BadMagic => f.write_str("snapshot magic does not match"),
            Self::UnsupportedFormat { found, expected } => {
                write!(f, "snapshot format version {found} is not {expected}")
            }
            Self::UnsupportedSchema { found, expected } => write!(
                f,
                "snapshot schema version {found} does not match fold schema {expected}"
            ),
            Self::BadHeader { what } => write!(f, "snapshot header field {what} is invalid"),
            Self::HeaderCrcMismatch { found, expected } => {
                write!(
                    f,
                    "snapshot header CRC {found:#010X} is not {expected:#010X}"
                )
            }
            Self::PayloadCrcMismatch { found, expected } => {
                write!(
                    f,
                    "snapshot payload CRC {found:#010X} is not {expected:#010X}"
                )
            }
            Self::Malformed { what, offset } => {
                write!(f, "snapshot {what} is malformed at offset {offset}")
            }
            Self::TrailingData { offset, len } => {
                write!(f, "snapshot has {len} trailing bytes at offset {offset}")
            }
            Self::OutOfRange { what } => write!(f, "snapshot value {what} is out of range"),
        }
    }
}

impl std::error::Error for SnapshotError {}

/// CRC-32 (IEEE, reflected, polynomial 0xEDB88320). No dependency: the format
/// only needs a stable checksum, and a compile-time table keeps it fast.
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes {
        crc = CRC_TABLE[((crc ^ byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

const CRC_TABLE: [u32; 256] = build_crc_table();

const fn build_crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut index = 0;
    while index < 256 {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = if value & 1 != 0 {
                0xEDB8_8320 ^ (value >> 1)
            } else {
                value >> 1
            };
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
}

/// Encodes a snapshot into its wire image.
///
/// Validates every cross-reference first, so a saved image can be decoded
/// without guessing. The image is deterministic: equal snapshots produce equal
/// bytes.
pub fn encode(snapshot: &Snapshot) -> Result<Vec<u8>, SnapshotError> {
    let names_len = encode_names_len(&snapshot.names)?;
    let records_len = 4usize
        .checked_add(record_section_records(snapshot)?)
        .ok_or(SnapshotError::OutOfRange {
            what: "record section",
        })?;
    let mut payload = Vec::with_capacity(names_len + records_len);
    encode_names(&snapshot.names, &mut payload);
    encode_records(snapshot, &mut payload)?;
    let payload_crc = crc32(&payload);
    let mut image = Vec::with_capacity(HEADER_LEN + payload.len());
    image.extend_from_slice(MAGIC);
    push_u16(&mut image, FORMAT_VERSION);
    push_u16(&mut image, SCHEMA_VERSION);
    push_u32(&mut image, HEADER_LEN as u32);
    push_u32(&mut image, 0);
    push_u64(&mut image, snapshot.volume.get());
    push_u64(&mut image, snapshot.root.volume);
    push_u64(&mut image, snapshot.root.file);
    push_u64(&mut image, snapshot.generation);
    push_u64(&mut image, names_len as u64);
    push_u64(&mut image, records_len as u64);
    push_u32(&mut image, payload_crc);
    let header_crc = crc32(&image);
    push_u32(&mut image, header_crc);
    image.extend_from_slice(&payload);
    Ok(image)
}

/// Validates and decodes a snapshot image.
pub fn decode(bytes: &[u8]) -> Result<Snapshot, SnapshotError> {
    if bytes.len() < HEADER_LEN {
        return Err(SnapshotError::Truncated {
            what: "header",
            offset: 0,
            need: HEADER_LEN,
            len: bytes.len(),
        });
    }
    let header = &bytes[..HEADER_LEN];
    if &header[..8] != MAGIC {
        return Err(SnapshotError::BadMagic);
    }
    let format_version = read_u16(header, 8);
    let schema_version = read_u16(header, 10);
    let header_len = read_u32(header, 12) as usize;
    let reserved = read_u32(header, 16);
    if header_len != HEADER_LEN {
        return Err(SnapshotError::BadHeader {
            what: "header length",
        });
    }
    if reserved != 0 {
        return Err(SnapshotError::BadHeader {
            what: "reserved flags",
        });
    }
    if format_version != FORMAT_VERSION {
        return Err(SnapshotError::UnsupportedFormat {
            found: format_version,
            expected: FORMAT_VERSION,
        });
    }
    if schema_version != SCHEMA_VERSION {
        return Err(SnapshotError::UnsupportedSchema {
            found: schema_version,
            expected: SCHEMA_VERSION,
        });
    }
    let stored_header_crc = read_u32(header, HEADER_LEN - 4);
    let computed_header_crc = crc32(&header[..HEADER_LEN - 4]);
    if stored_header_crc != computed_header_crc {
        return Err(SnapshotError::HeaderCrcMismatch {
            found: stored_header_crc,
            expected: computed_header_crc,
        });
    }
    let volume = VolumeId::new(read_u64(header, 20));
    let root = FileKey::new(read_u64(header, 28), read_u64(header, 36));
    let generation = read_u64(header, 44);
    let names_len = read_u64(header, 52);
    let records_len = read_u64(header, 60);
    let stored_payload_crc = read_u32(header, 68);
    let names_start = HEADER_LEN;
    let names_end = section_end(names_start, names_len, bytes.len(), "name section")?;
    let records_end = section_end(names_end, records_len, bytes.len(), "record section")?;
    if records_end < bytes.len() {
        return Err(SnapshotError::TrailingData {
            offset: records_end,
            len: bytes.len() - records_end,
        });
    }
    let payload = &bytes[HEADER_LEN..records_end];
    let computed_payload_crc = crc32(payload);
    if stored_payload_crc != computed_payload_crc {
        return Err(SnapshotError::PayloadCrcMismatch {
            found: stored_payload_crc,
            expected: computed_payload_crc,
        });
    }
    if names_end - names_start < 4 {
        return Err(SnapshotError::Truncated {
            what: "name count",
            offset: names_start,
            need: 4,
            len: names_end - names_start,
        });
    }
    if records_end - names_end < 4 {
        return Err(SnapshotError::Truncated {
            what: "record count",
            offset: names_end,
            need: 4,
            len: records_end - names_end,
        });
    }
    let names = decode_names(&bytes[names_start..names_end])?;
    let records = decode_records(&bytes[names_end..records_end], names.len())?;
    Ok(Snapshot {
        volume,
        root,
        generation,
        names,
        records,
    })
}

/// End offset of one section, rejecting lengths that do not fit the buffer.
fn section_end(
    start: usize,
    len: u64,
    buffer_len: usize,
    what: &'static str,
) -> Result<usize, SnapshotError> {
    let len = usize::try_from(len).map_err(|_| SnapshotError::OutOfRange { what })?;
    let end = start
        .checked_add(len)
        .ok_or(SnapshotError::OutOfRange { what })?;
    if end > buffer_len {
        return Err(SnapshotError::Truncated {
            what,
            offset: start,
            need: len,
            len: buffer_len - start,
        });
    }
    Ok(end)
}

fn encode_names_len(names: &[Vec<u8>]) -> Result<usize, SnapshotError> {
    let mut total = 4usize;
    for name in names {
        total = total
            .checked_add(4)
            .and_then(|total| total.checked_add(name.len()))
            .ok_or(SnapshotError::OutOfRange { what: "name" })?;
        if u32::try_from(name.len()).is_err() {
            return Err(SnapshotError::OutOfRange {
                what: "name length",
            });
        }
    }
    if u32::try_from(names.len()).is_err() {
        return Err(SnapshotError::OutOfRange { what: "name count" });
    }
    Ok(total)
}

fn encode_names(names: &[Vec<u8>], out: &mut Vec<u8>) {
    push_u32(out, names.len() as u32);
    for name in names {
        push_u32(out, name.len() as u32);
        out.extend_from_slice(name);
    }
}

fn record_section_records(snapshot: &Snapshot) -> Result<usize, SnapshotError> {
    if u32::try_from(snapshot.records.len()).is_err() {
        return Err(SnapshotError::OutOfRange {
            what: "record count",
        });
    }
    snapshot
        .records
        .len()
        .checked_mul(RECORD_LEN)
        .ok_or(SnapshotError::OutOfRange {
            what: "record section",
        })
}

fn encode_records(snapshot: &Snapshot, out: &mut Vec<u8>) -> Result<(), SnapshotError> {
    push_u32(out, snapshot.records.len() as u32);
    let count = snapshot.records.len() as u32;
    for record in &snapshot.records {
        if record.parent != PARENT_NIL && record.parent >= count {
            return Err(SnapshotError::OutOfRange { what: "parent" });
        }
        if record.name as usize >= snapshot.names.len() || record.name > NAME_ID_MAX {
            return Err(SnapshotError::OutOfRange { what: "name index" });
        }
        push_u64(out, record.record.get());
        push_u32(out, record.parent);
        push_u32(
            out,
            ((record.flags.bits() as u32) << 28) | (record.name & NAME_ID_MAX),
        );
        push_u64(out, record.size.unwrap_or(SIZE_UNKNOWN));
        push_u64(out, record.mtime_ns.unwrap_or(MTIME_UNKNOWN) as u64);
    }
    Ok(())
}

fn decode_names(bytes: &[u8]) -> Result<Vec<Vec<u8>>, SnapshotError> {
    let count = read_u32(bytes, 0) as usize;
    let mut names = Vec::with_capacity(count.min(4096));
    let mut offset = 4usize;
    for _ in 0..count {
        if offset + 4 > bytes.len() {
            return Err(SnapshotError::Truncated {
                what: "name length",
                offset,
                need: 4,
                len: bytes.len() - offset,
            });
        }
        let len = read_u32(bytes, offset) as usize;
        offset += 4;
        let end = offset
            .checked_add(len)
            .filter(|end| *end <= bytes.len())
            .ok_or(SnapshotError::Malformed {
                what: "name bytes",
                offset,
            })?;
        names.push(bytes[offset..end].to_vec());
        offset = end;
    }
    if offset != bytes.len() {
        return Err(SnapshotError::Malformed {
            what: "name section",
            offset,
        });
    }
    Ok(names)
}

fn decode_records(bytes: &[u8], name_count: usize) -> Result<Vec<SnapshotRecord>, SnapshotError> {
    let count = read_u32(bytes, 0) as usize;
    let expected = count
        .checked_mul(RECORD_LEN)
        .and_then(|body| body.checked_add(4))
        .ok_or(SnapshotError::OutOfRange {
            what: "record count",
        })?;
    if expected > bytes.len() {
        return Err(SnapshotError::Truncated {
            what: "record section",
            offset: 4,
            need: expected - 4,
            len: bytes.len() - 4,
        });
    }
    if expected < bytes.len() {
        return Err(SnapshotError::Malformed {
            what: "record section",
            offset: expected,
        });
    }
    let mut records = Vec::with_capacity(count.min(4096));
    for index in 0..count {
        let offset = 4 + index * RECORD_LEN;
        let record = SnapshotRecord {
            record: RecordId::new(read_u64(bytes, offset)),
            parent: read_u32(bytes, offset + 8),
            name: read_u32(bytes, offset + 12) & NAME_ID_MAX,
            flags: RecordFlags::from_bits((read_u32(bytes, offset + 12) >> 28) as u8).ok_or(
                SnapshotError::Malformed {
                    what: "record flags",
                    offset,
                },
            )?,
            size: match read_u64(bytes, offset + 16) {
                SIZE_UNKNOWN => None,
                value => Some(value),
            },
            mtime_ns: match read_u64(bytes, offset + 24) as i64 {
                MTIME_UNKNOWN => None,
                value => Some(value),
            },
        };
        if record.parent != PARENT_NIL && record.parent as usize >= count {
            return Err(SnapshotError::Malformed {
                what: "record parent",
                offset,
            });
        }
        if record.name as usize >= name_count {
            return Err(SnapshotError::Malformed {
                what: "record name",
                offset,
            });
        }
        records.push(record);
    }
    Ok(records)
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
    ])
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

const _: () = assert!(HEADER_LEN == 76);
const _: () = assert!(RECORD_LEN <= 32);
const _: () = assert!(RECORD_LEN == 32);

#[cfg(test)]
#[path = "format_tests.rs"]
mod format_tests;
