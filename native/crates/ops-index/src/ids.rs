//! Stable identifiers used across the index.
//!
//! Sizes are part of the contract and are asserted at compile time:
//! a 128-bit [`FileKey`] must stay 16 bytes, and the four-byte owner ids must
//! not silently widen when a field is added.

use std::fmt;

/// Index of one entry (one `(parent, name)` link) in an entry table.
///
/// Four bytes because it indexes an in-memory array, not the file system.
/// [`EntryId::NIL`] is the chain terminator inherited from the table design.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EntryId(u32);

impl EntryId {
    /// Chain terminator. No table ever allocates this slot.
    pub const NIL: Self = Self(u32::MAX);

    /// Wraps a raw table index.
    pub const fn new(raw: u32) -> Self {
        Self(raw)
    }

    /// Raw table index.
    pub const fn get(self) -> u32 {
        self.0
    }

    /// The same value as a `usize` for slice indexing.
    pub const fn index(self) -> usize {
        self.0 as usize
    }

    /// Whether this value is the chain terminator.
    pub const fn is_nil(self) -> bool {
        self.0 == u32::MAX
    }
}

impl fmt::Debug for EntryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_nil() {
            f.write_str("EntryId(NIL)")
        } else {
            write!(f, "EntryId({})", self.0)
        }
    }
}

/// Index of one interned name in a name store.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NameId(u32);

impl NameId {
    /// Wraps a raw name-arena index.
    pub const fn new(raw: u32) -> Self {
        Self(raw)
    }

    /// Raw name-arena index.
    pub const fn get(self) -> u32 {
        self.0
    }

    /// The same value as a `usize` for slice indexing.
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

impl fmt::Debug for NameId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "NameId({})", self.0)
    }
}

/// File-system record identifier.
///
/// On NTFS this is the `FRN` (48-bit record number plus 16-bit sequence); on
/// other file systems the platform crate stores its own stable number in the
/// low 48 bits and its generation counter in the high 16 bits. The generation
/// is what makes slot reuse detectable.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RecordId(u64);

impl RecordId {
    /// Bits holding the record number.
    const NUMBER_MASK: u64 = 0x0000_FFFF_FFFF_FFFF;

    /// Wraps a full identifier (record number plus generation).
    pub const fn new(raw: u64) -> Self {
        Self(raw)
    }

    /// Full identifier, generation included.
    pub const fn get(self) -> u64 {
        self.0
    }

    /// Low 48 bits identifying the record within a generation.
    pub const fn record_number(self) -> u64 {
        self.0 & Self::NUMBER_MASK
    }

    /// High 16 bits identifying the generation of the record.
    pub const fn sequence(self) -> u16 {
        (self.0 >> 48) as u16
    }

    /// Combines a record number and a generation.
    ///
    /// Only the low 48 bits of `record_number` are kept; the high bits cannot
    /// be represented and are masked rather than silently shifting.
    pub const fn from_parts(record_number: u64, sequence: u16) -> Self {
        Self((record_number & Self::NUMBER_MASK) | ((sequence as u64) << 48))
    }
}

impl fmt::Debug for RecordId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "RecordId(record={}, sequence={})",
            self.record_number(),
            self.sequence()
        )
    }
}

/// Identifier of the volume a source reads from.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct VolumeId(u64);

impl VolumeId {
    /// Wraps the platform's volume serial or device id.
    pub const fn new(raw: u64) -> Self {
        Self(raw)
    }

    /// Raw volume identifier.
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Debug for VolumeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "VolumeId({})", self.0)
    }
}

/// Identifier of one consistent enumeration of a root.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SnapshotId(u64);

impl SnapshotId {
    /// Wraps a source-defined snapshot counter.
    pub const fn new(raw: u64) -> Self {
        Self(raw)
    }

    /// Raw snapshot counter.
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Debug for SnapshotId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SnapshotId({})", self.0)
    }
}

/// Identity of one file-system object, independent of any name.
///
/// 16 bytes: two 64-bit halves so a ReFS 128-bit file id fits as
/// `volume`/`file` without loss. Sources that only have 64-bit ids leave the
/// other half zero and must report that to the caller.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FileKey {
    /// Volume serial or device number.
    pub volume: u64,
    /// File number within the volume.
    pub file: u64,
}

impl FileKey {
    /// Builds a key from its two halves.
    pub const fn new(volume: u64, file: u64) -> Self {
        Self { volume, file }
    }
}

impl fmt::Debug for FileKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "FileKey({:#x}:{:#x})", self.volume, self.file)
    }
}

const _: () = assert!(size_of::<EntryId>() == 4);
const _: () = assert!(size_of::<NameId>() == 4);
const _: () = assert!(size_of::<RecordId>() == 8);
const _: () = assert!(size_of::<VolumeId>() == 8);
const _: () = assert!(size_of::<SnapshotId>() == 8);
const _: () = assert!(size_of::<FileKey>() == 16);
#[cfg(test)]
#[path = "ids_tests.rs"]
mod ids_tests;
