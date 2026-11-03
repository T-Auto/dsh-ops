// Design informed by mustafaahci/goz (MIT)
//! Durable, self-contained snapshot wire format.
//!
//! A snapshot is the persisted form of one consistent index state. It carries
//! the small per-entry records and the interned names the records point at, so
//! a new process can answer path questions without re-enumerating the volume.
//! It deliberately stores no file contents.
//!
//! Layout (all integers little-endian):
//!
//! | Offset | Size | Field |
//! | ---: | ---: | --- |
//! | 0 | 8 | magic "DSHOPIDX" |
//! | 8 | 4 | format version |
//! | 12 | 4 | record schema |
//! | 16 | 4 | header length (88) |
//! | 20 | 4 | record length (26) |
//! | 24 | 8 | volume id |
//! | 32 | 8 | root device |
//! | 40 | 8 | root inode |
//! | 48 | 8 | index generation |
//! | 56 | 4 | record count |
//! | 60 | 4 | name count |
//! | 64 | 8 | consistency timestamp (milliseconds since the Unix epoch) |
//! | 72 | 8 | name-section byte length |
//! | 80 | 4 | CRC-32 (IEEE) of the whole file with these four bytes zeroed |
//! | 84 | 4 | reserved, must be zero |
//! | 88 | - | records, then names |
//!
//! A record is 26 bytes: parent id (4), name id (4), flags (2), size (8) and
//! mtime (8). Names are stored as a u32 length plus their raw bytes in name-id
//! order. Raw bytes are used because WTF-8 names need not be valid UTF-8.
//!
//! Decoding is strict: a bad magic, version, schema, length, checksum, flag or
//! cross-reference rejects the whole snapshot. The caller discards it and
//! rebuilds; it must never treat a rejected snapshot as a complete answer.

use crate::ids::{EntryId, NameId, VolumeId};
use crate::source::EntryKind;
use std::fmt;

/// Magic at the start of every snapshot file.
pub const MAGIC: [u8; 8] = *b"DSHOPIDX";

/// Wire-format version. Bumped when the layout of this file changes.
pub const VERSION: u32 = 1;

/// Semantic record schema. Bumped when record fields change meaning.
pub const SCHEMA: u32 = 1;

/// Fixed size of the header in bytes.
pub const HEADER_LEN: usize = 88;

/// Size of one compact record in bytes.
pub const RECORD_LEN: usize = 26;

/// Largest size the compact record contract allows.
pub const MAX_RECORD_LEN: usize = 32;

const MAGIC_OFFSET: usize = 0;
const VERSION_OFFSET: usize = 8;
const SCHEMA_OFFSET: usize = 12;
const HEADER_LEN_OFFSET: usize = 16;
const RECORD_LEN_OFFSET: usize = 20;
const VOLUME_OFFSET: usize = 24;
const ROOT_DEV_OFFSET: usize = 32;
const ROOT_INO_OFFSET: usize = 40;
const GENERATION_OFFSET: usize = 48;
const RECORD_COUNT_OFFSET: usize = 56;
const NAME_COUNT_OFFSET: usize = 60;
const TIMESTAMP_OFFSET: usize = 64;
const NAME_BYTES_OFFSET: usize = 72;
const CRC_OFFSET: usize = 80;
const RESERVED_OFFSET: usize = 84;

const KIND_MASK: u16 = 0b0000_0011;
const HAS_MTIME: u16 = 0b0000_0100;
const KNOWN_FLAGS: u16 = KIND_MASK | HAS_MTIME;

/// CRC-32 (IEEE 802.3) table, built at compile time.
const CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut index = 0usize;
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
};

/// A snapshot file failed validation. Every variant names the field or offset
/// that failed so a host can map it onto a stable diagnostic.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum FormatError {
    /// The first eight bytes are not MAGIC.
    BadMagic,
    /// The format version is not VERSION.
    UnsupportedVersion {
        /// Version found in the file.
        found: u32,
    },
    /// The record schema is not SCHEMA.
    UnsupportedSchema {
        /// Schema found in the file.
        found: u32,
    },
    /// The header length field is not HEADER_LEN.
    BadHeaderLength {
        /// Length found in the file.
        found: u32,
    },
    /// The record length field is not RECORD_LEN.
    BadRecordLength {
        /// Length found in the file.
        found: u32,
    },
    /// The reserved header word is non-zero.
    BadReserved {
        /// Reserved value found in the file.
        found: u32,
    },
    /// A structure or payload ran past the end of the buffer.
    ///
    /// len is the total buffer length, matching the crate's other decoding
    /// errors; need is the number of bytes required from offset.
    Truncated {
        /// Name of the structure being decoded.
        what: &'static str,
        /// Absolute offset where decoding stopped.
        offset: usize,
        /// Bytes required to continue from offset.
        need: usize,
        /// Total length of the buffer.
        len: usize,
    },
    /// The declared payload length does not match the buffer.
    LengthMismatch {
        /// Length the header and sections require.
        expected: usize,
        /// Length actually present.
        found: usize,
    },
    /// The stored checksum does not match the computed one.
    BadCrc {
        /// Checksum computed from the bytes.
        expected: u32,
        /// Checksum stored in the header.
        found: u32,
    },
    /// A record carries flag bits this version does not define.
    BadFlags {
        /// Index of the record in the snapshot.
        record: u32,
        /// Raw flags value.
        flags: u16,
    },
    /// A record has no mtime flag but stores a non-zero timestamp.
    UnexpectedTimestamp {
        /// Index of the record in the snapshot.
        record: u32,
    },
    /// A record points at a name id outside the name table.
    BadNameId {
        /// Index of the record in the snapshot.
        record: u32,
        /// Referenced name id.
        name_id: u32,
        /// Number of names stored.
        names: u32,
    },
    /// A record points at a parent id outside the record table.
    BadParent {
        /// Index of the record in the snapshot.
        record: u32,
        /// Referenced parent id.
        parent: u32,
        /// Number of records stored.
        records: u32,
    },
    /// A count, name length or encoded size does not fit its field.
    TooLarge {
        /// Name of the field or section.
        what: &'static str,
        /// Observed size.
        len: u64,
        /// Largest representable size.
        max: u64,
    },
}

impl FormatError {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(&self) -> &'static str {
        match self {
            Self::BadMagic => "INDEX_SNAPSHOT_MAGIC",
            Self::UnsupportedVersion { .. } => "INDEX_SNAPSHOT_VERSION",
            Self::UnsupportedSchema { .. } => "INDEX_SNAPSHOT_SCHEMA",
            Self::BadHeaderLength { .. }
            | Self::BadRecordLength { .. }
            | Self::BadReserved { .. } => "INDEX_SNAPSHOT_HEADER",
            Self::Truncated { .. } => "INDEX_SNAPSHOT_TRUNCATED",
            Self::LengthMismatch { .. } => "INDEX_SNAPSHOT_LENGTH",
            Self::BadCrc { .. } => "INDEX_SNAPSHOT_CRC",
            Self::BadFlags { .. } | Self::UnexpectedTimestamp { .. } => "INDEX_SNAPSHOT_RECORD",
            Self::BadNameId { .. } => "INDEX_SNAPSHOT_NAME_ID",
            Self::BadParent { .. } => "INDEX_SNAPSHOT_PARENT",
            Self::TooLarge { .. } => "INDEX_SNAPSHOT_TOO_LARGE",
        }
    }
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadMagic => f.write_str("snapshot magic does not match"),
            Self::UnsupportedVersion { found } => {
                write!(
                    f,
                    "unsupported snapshot version {found}, expected {VERSION}"
                )
            }
            Self::UnsupportedSchema { found } => {
                write!(f, "unsupported snapshot schema {found}, expected {SCHEMA}")
            }
            Self::BadHeaderLength { found } => {
                write!(f, "snapshot header length {found}, expected {HEADER_LEN}")
            }
            Self::BadRecordLength { found } => {
                write!(f, "snapshot record length {found}, expected {RECORD_LEN}")
            }
            Self::BadReserved { found } => {
                write!(
                    f,
                    "snapshot header reserved word is {found:#010x}, expected zero"
                )
            }
            Self::Truncated {
                what,
                offset,
                need,
                len,
            } => write!(
                f,
                "{what} truncated at offset {offset}: need {need} bytes, buffer is {len} bytes"
            ),
            Self::LengthMismatch { expected, found } => {
                write!(
                    f,
                    "snapshot length mismatch: expected {expected} bytes, found {found}"
                )
            }
            Self::BadCrc { expected, found } => write!(
                f,
                "snapshot CRC mismatch: computed {expected:#010x}, stored {found:#010x}"
            ),
            Self::BadFlags { record, flags } => {
                write!(
                    f,
                    "snapshot record {record} has unsupported flags {flags:#06x}"
                )
            }
            Self::UnexpectedTimestamp { record } => write!(
                f,
                "snapshot record {record} stores a timestamp without the present flag"
            ),
            Self::BadNameId {
                record,
                name_id,
                names,
            } => write!(
                f,
                "snapshot record {record} references name {name_id}, but only {names} names are stored"
            ),
            Self::BadParent {
                record,
                parent,
                records,
            } => write!(
                f,
                "snapshot record {record} references parent {parent}, but only {records} records are stored"
            ),
            Self::TooLarge { what, len, max } => {
                write!(f, "snapshot {what} is {len}, above the maximum of {max}")
            }
        }
    }
}

impl std::error::Error for FormatError {}

/// Identity of the volume and root a snapshot describes.
///
/// A loader must compare these fields before using a snapshot: a cache
/// directory can outlive the root it was created for, and a snapshot for a
/// different (dev, ino) is not evidence about the current tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotIdentity {
    /// Volume serial or device identifier.
    pub volume_id: VolumeId,
    /// Device number of the root.
    pub root_dev: u64,
    /// Inode number of the root.
    pub root_ino: u64,
}

/// Metadata shared by every record in a snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotHeader {
    /// Volume and root identity.
    pub identity: SnapshotIdentity,
    /// Index generation this snapshot was taken from.
    pub generation: u64,
    /// Wall-clock milliseconds when the snapshot was known to be consistent.
    pub consistent_at_ms: i64,
}

/// One compact persisted entry.
///
/// The wire form is 26 bytes. The Rust value rounds up to 32 bytes, which is
/// the contract limit; parent and name ids index the snapshot's own tables.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotRecord {
    parent: EntryId,
    name_id: NameId,
    flags: u16,
    size: u64,
    mtime_ns: i64,
}

impl SnapshotRecord {
    /// Builds a canonical record.
    ///
    /// modified_ns is stored only when present; the mtime field is zero
    /// otherwise so encode/decode round-trips are byte-identical.
    pub const fn new(
        parent: EntryId,
        name_id: NameId,
        kind: EntryKind,
        size: u64,
        modified_ns: Option<i64>,
    ) -> Self {
        let flags = kind_code(kind) | if modified_ns.is_some() { HAS_MTIME } else { 0 };
        let mtime_ns = match modified_ns {
            Some(value) => value,
            None => 0,
        };
        Self {
            parent,
            name_id,
            flags,
            size,
            mtime_ns,
        }
    }

    /// Parent entry id; EntryId::NIL for the root.
    pub const fn parent(self) -> EntryId {
        self.parent
    }

    /// Interned name id.
    pub const fn name_id(self) -> NameId {
        self.name_id
    }

    /// Entry kind encoded in the flags.
    pub const fn kind(self) -> EntryKind {
        kind_from_code(self.flags & KIND_MASK)
    }

    /// Size in bytes.
    pub const fn size(self) -> u64 {
        self.size
    }

    /// Modification time in nanoseconds since the Unix epoch, when present.
    pub const fn modified_ns(self) -> Option<i64> {
        if self.flags & HAS_MTIME != 0 {
            Some(self.mtime_ns)
        } else {
            None
        }
    }

    fn from_wire(
        record: u32,
        parent: EntryId,
        name_id: NameId,
        flags: u16,
        size: u64,
        mtime_ns: i64,
    ) -> Result<Self, FormatError> {
        if flags & !KNOWN_FLAGS != 0 {
            return Err(FormatError::BadFlags { record, flags });
        }
        if flags & HAS_MTIME == 0 && mtime_ns != 0 {
            return Err(FormatError::UnexpectedTimestamp { record });
        }
        Ok(Self {
            parent,
            name_id,
            flags,
            size,
            mtime_ns,
        })
    }
}

const fn kind_code(kind: EntryKind) -> u16 {
    match kind {
        EntryKind::File => 0,
        EntryKind::Dir => 1,
        EntryKind::Link => 2,
        EntryKind::Other => 3,
    }
}

const fn kind_from_code(code: u16) -> EntryKind {
    match code & KIND_MASK {
        0 => EntryKind::File,
        1 => EntryKind::Dir,
        2 => EntryKind::Link,
        _ => EntryKind::Other,
    }
}

/// One complete, self-contained snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    header: SnapshotHeader,
    records: Vec<SnapshotRecord>,
    names: Vec<Vec<u8>>,
}

impl Snapshot {
    /// Builds a snapshot, checking that every record references a stored name
    /// and that non-root parents reference a stored record.
    pub fn new(
        header: SnapshotHeader,
        records: Vec<SnapshotRecord>,
        names: Vec<Vec<u8>>,
    ) -> Result<Self, FormatError> {
        let layout = measure(&records, &names)?;
        validate_references(&records, layout.records, layout.names)?;
        Ok(Self {
            header,
            records,
            names,
        })
    }

    /// Header shared by all records.
    pub const fn header(&self) -> SnapshotHeader {
        self.header
    }

    /// Records in storage order.
    pub fn records(&self) -> &[SnapshotRecord] {
        &self.records
    }

    /// Raw interned names in name-id order.
    pub fn names(&self) -> &[Vec<u8>] {
        &self.names
    }

    /// Number of records.
    pub fn record_count(&self) -> usize {
        self.records.len()
    }

    /// Number of interned names.
    pub fn name_count(&self) -> usize {
        self.names.len()
    }

    /// Encodes the snapshot into its canonical wire form.
    ///
    /// The result is deterministic: the same value always produces the same
    /// bytes, including the checksum.
    pub fn encode(&self) -> Result<Vec<u8>, FormatError> {
        let layout = measure(&self.records, &self.names)?;
        let records_len = usize::try_from(u64::from(layout.records) * RECORD_LEN as u64)
            .map_err(|_| too_large("SNAPSHOT", u64::MAX, usize::MAX as u64))?;
        let names_len = usize::try_from(layout.name_bytes)
            .map_err(|_| too_large("SNAPSHOT", layout.name_bytes, usize::MAX as u64))?;
        let total = HEADER_LEN
            .checked_add(records_len)
            .and_then(|value| value.checked_add(names_len))
            .ok_or_else(|| too_large("SNAPSHOT", layout.name_bytes, usize::MAX as u64))?;
        let mut bytes = vec![0u8; total];

        bytes[MAGIC_OFFSET..MAGIC_OFFSET + MAGIC.len()].copy_from_slice(&MAGIC);
        write_u32(&mut bytes, VERSION_OFFSET, VERSION);
        write_u32(&mut bytes, SCHEMA_OFFSET, SCHEMA);
        write_u32(&mut bytes, HEADER_LEN_OFFSET, HEADER_LEN as u32);
        write_u32(&mut bytes, RECORD_LEN_OFFSET, RECORD_LEN as u32);
        write_u64(
            &mut bytes,
            VOLUME_OFFSET,
            self.header.identity.volume_id.get(),
        );
        write_u64(&mut bytes, ROOT_DEV_OFFSET, self.header.identity.root_dev);
        write_u64(&mut bytes, ROOT_INO_OFFSET, self.header.identity.root_ino);
        write_u64(&mut bytes, GENERATION_OFFSET, self.header.generation);
        write_u32(&mut bytes, RECORD_COUNT_OFFSET, layout.records);
        write_u32(&mut bytes, NAME_COUNT_OFFSET, layout.names);
        bytes[TIMESTAMP_OFFSET..TIMESTAMP_OFFSET + 8]
            .copy_from_slice(&self.header.consistent_at_ms.to_le_bytes());
        write_u64(&mut bytes, NAME_BYTES_OFFSET, layout.name_bytes);
        write_u32(&mut bytes, CRC_OFFSET, 0);
        write_u32(&mut bytes, RESERVED_OFFSET, 0);

        let mut offset = HEADER_LEN;
        for record in &self.records {
            write_u32(&mut bytes, offset, record.parent.get());
            write_u32(&mut bytes, offset + 4, record.name_id.get());
            write_u16(&mut bytes, offset + 8, record.flags);
            write_u64(&mut bytes, offset + 10, record.size);
            bytes[offset + 18..offset + RECORD_LEN].copy_from_slice(&record.mtime_ns.to_le_bytes());
            offset += RECORD_LEN;
        }
        for name in &self.names {
            write_u32(&mut bytes, offset, name.len() as u32);
            offset += 4;
            bytes[offset..offset + name.len()].copy_from_slice(name);
            offset += name.len();
        }
        debug_assert_eq!(offset, total);

        let checksum = checksum(&bytes);
        write_u32(&mut bytes, CRC_OFFSET, checksum);
        Ok(bytes)
    }

    /// Decodes and validates a snapshot.
    ///
    /// Any error means the buffer is unusable as a complete snapshot; callers
    /// discard it and rebuild rather than serving a partial result.
    pub fn decode(bytes: &[u8]) -> Result<Self, FormatError> {
        if bytes.len() < MAGIC.len() {
            return Err(FormatError::Truncated {
                what: "SNAPSHOT_MAGIC",
                offset: 0,
                need: MAGIC.len(),
                len: bytes.len(),
            });
        }
        if bytes[..MAGIC.len()] != MAGIC[..] {
            return Err(FormatError::BadMagic);
        }
        if bytes.len() < VERSION_OFFSET + 4 {
            return Err(FormatError::Truncated {
                what: "SNAPSHOT_VERSION",
                offset: VERSION_OFFSET,
                need: 4,
                len: bytes.len(),
            });
        }
        let version = read_u32(bytes, VERSION_OFFSET);
        if version != VERSION {
            return Err(FormatError::UnsupportedVersion { found: version });
        }
        if bytes.len() < HEADER_LEN {
            return Err(FormatError::Truncated {
                what: "SNAPSHOT_HEADER",
                offset: 0,
                need: HEADER_LEN,
                len: bytes.len(),
            });
        }
        let schema = read_u32(bytes, SCHEMA_OFFSET);
        if schema != SCHEMA {
            return Err(FormatError::UnsupportedSchema { found: schema });
        }
        let header_len = read_u32(bytes, HEADER_LEN_OFFSET);
        if header_len != HEADER_LEN as u32 {
            return Err(FormatError::BadHeaderLength { found: header_len });
        }
        let record_len = read_u32(bytes, RECORD_LEN_OFFSET);
        if record_len != RECORD_LEN as u32 {
            return Err(FormatError::BadRecordLength { found: record_len });
        }
        let reserved = read_u32(bytes, RESERVED_OFFSET);
        if reserved != 0 {
            return Err(FormatError::BadReserved { found: reserved });
        }

        let record_count = read_u32(bytes, RECORD_COUNT_OFFSET);
        let name_count = read_u32(bytes, NAME_COUNT_OFFSET);
        let name_bytes = read_u64(bytes, NAME_BYTES_OFFSET);
        let expected = expected_len(record_count, name_bytes)?;
        if bytes.len() < expected {
            return Err(FormatError::Truncated {
                what: "SNAPSHOT_PAYLOAD",
                offset: HEADER_LEN,
                need: expected - HEADER_LEN,
                len: bytes.len(),
            });
        }
        if bytes.len() > expected {
            return Err(FormatError::LengthMismatch {
                expected,
                found: bytes.len(),
            });
        }

        let found_checksum = read_u32(bytes, CRC_OFFSET);
        let expected_checksum = checksum(bytes);
        if found_checksum != expected_checksum {
            return Err(FormatError::BadCrc {
                expected: expected_checksum,
                found: found_checksum,
            });
        }

        let mut records = Vec::with_capacity(record_count as usize);
        let mut offset = HEADER_LEN;
        for index in 0..record_count {
            let end = offset + RECORD_LEN;
            let raw = &bytes[offset..end];
            let parent = EntryId::new(read_u32(raw, 0));
            let name_id = NameId::new(read_u32(raw, 4));
            let flags = read_u16(raw, 8);
            let size = read_u64(raw, 10);
            let mtime_ns = read_i64(raw, 18);
            records.push(SnapshotRecord::from_wire(
                index, parent, name_id, flags, size, mtime_ns,
            )?);
            offset = end;
        }

        // name_count is attacker-controlled and must not size an allocation on
        // its own: every name costs at least a four-byte length prefix, so
        // name_bytes bounds the real entry count.
        let name_capacity = usize::try_from(name_bytes / 4)
            .unwrap_or(usize::MAX)
            .min(name_count as usize);
        let mut names = Vec::with_capacity(name_capacity);
        for _ in 0..name_count {
            let remaining = bytes.len() - offset;
            if remaining < 4 {
                return Err(FormatError::Truncated {
                    what: "SNAPSHOT_NAME_LENGTH",
                    offset,
                    need: 4,
                    len: bytes.len(),
                });
            }
            let name_len = read_u32(bytes, offset) as usize;
            offset += 4;
            let remaining = bytes.len() - offset;
            if name_len > remaining {
                return Err(FormatError::Truncated {
                    what: "SNAPSHOT_NAME",
                    offset,
                    need: name_len,
                    len: bytes.len(),
                });
            }
            names.push(bytes[offset..offset + name_len].to_vec());
            offset += name_len;
        }
        if offset != expected {
            return Err(FormatError::LengthMismatch {
                expected,
                found: offset,
            });
        }

        let header = SnapshotHeader {
            identity: SnapshotIdentity {
                volume_id: VolumeId::new(read_u64(bytes, VOLUME_OFFSET)),
                root_dev: read_u64(bytes, ROOT_DEV_OFFSET),
                root_ino: read_u64(bytes, ROOT_INO_OFFSET),
            },
            generation: read_u64(bytes, GENERATION_OFFSET),
            consistent_at_ms: read_i64(bytes, TIMESTAMP_OFFSET),
        };
        Self::new(header, records, names)
    }
}

struct Layout {
    records: u32,
    names: u32,
    name_bytes: u64,
}

fn measure(records: &[SnapshotRecord], names: &[Vec<u8>]) -> Result<Layout, FormatError> {
    let record_count = u32::try_from(records.len()).map_err(|_| {
        too_large(
            "RECORD_COUNT",
            u64::try_from(records.len()).unwrap_or(u64::MAX),
            u64::from(u32::MAX),
        )
    })?;
    let name_count = u32::try_from(names.len()).map_err(|_| {
        too_large(
            "NAME_COUNT",
            u64::try_from(names.len()).unwrap_or(u64::MAX),
            u64::from(u32::MAX),
        )
    })?;
    let mut name_bytes = 0u64;
    for name in names {
        let length = u32::try_from(name.len()).map_err(|_| {
            too_large(
                "NAME_LENGTH",
                u64::try_from(name.len()).unwrap_or(u64::MAX),
                u64::from(u32::MAX),
            )
        })?;
        let added = u64::from(length) + 4;
        name_bytes = name_bytes
            .checked_add(added)
            .ok_or_else(|| too_large("NAME_BYTES", name_bytes.saturating_add(added), u64::MAX))?;
    }
    Ok(Layout {
        records: record_count,
        names: name_count,
        name_bytes,
    })
}

fn validate_references(
    records: &[SnapshotRecord],
    record_count: u32,
    name_count: u32,
) -> Result<(), FormatError> {
    for (index, record) in records.iter().enumerate() {
        let record_index = index as u32;
        let parent = record.parent();
        if !parent.is_nil() && parent.get() >= record_count {
            return Err(FormatError::BadParent {
                record: record_index,
                parent: parent.get(),
                records: record_count,
            });
        }
        if record.name_id().get() >= name_count {
            return Err(FormatError::BadNameId {
                record: record_index,
                name_id: record.name_id().get(),
                names: name_count,
            });
        }
    }
    Ok(())
}

fn expected_len(record_count: u32, name_bytes: u64) -> Result<usize, FormatError> {
    let records_len = u64::from(record_count) * RECORD_LEN as u64;
    let total = (HEADER_LEN as u64)
        .checked_add(records_len)
        .and_then(|value| value.checked_add(name_bytes))
        .ok_or_else(|| too_large("SNAPSHOT", u64::MAX, usize::MAX as u64))?;
    usize::try_from(total).map_err(|_| too_large("SNAPSHOT", total, usize::MAX as u64))
}

fn too_large(what: &'static str, len: u64, max: u64) -> FormatError {
    FormatError::TooLarge { what, len, max }
}

fn checksum(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFF;
    crc = crc32_update(crc, &bytes[..CRC_OFFSET]);
    crc = crc32_update(crc, &[0u8; 4]);
    crc = crc32_update(crc, &bytes[CRC_OFFSET + 4..]);
    !crc
}

#[cfg(test)]
fn crc32(bytes: &[u8]) -> u32 {
    !crc32_update(0xFFFF_FFFF, bytes)
}

fn crc32_update(mut crc: u32, bytes: &[u8]) -> u32 {
    for &byte in bytes {
        let index = ((crc ^ u32::from(byte)) & 0xFF) as usize;
        crc = (crc >> 8) ^ CRC_TABLE[index];
    }
    crc
}

fn write_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    let mut raw = [0u8; 2];
    raw.copy_from_slice(&bytes[offset..offset + 2]);
    u16::from_le_bytes(raw)
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    let mut raw = [0u8; 4];
    raw.copy_from_slice(&bytes[offset..offset + 4]);
    u32::from_le_bytes(raw)
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&bytes[offset..offset + 8]);
    u64::from_le_bytes(raw)
}

fn read_i64(bytes: &[u8], offset: usize) -> i64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&bytes[offset..offset + 8]);
    i64::from_le_bytes(raw)
}

const _: () = assert!(HEADER_LEN == 88);
const _: () = assert!(RECORD_LEN == 26);
const _: () = assert!(RECORD_LEN <= MAX_RECORD_LEN);
const _: () = assert!(size_of::<SnapshotRecord>() <= MAX_RECORD_LEN);

#[cfg(test)]
#[path = "format_tests.rs"]
mod format_tests;
