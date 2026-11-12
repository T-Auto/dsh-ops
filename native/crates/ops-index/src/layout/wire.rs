// Design informed by mustafaahci/goz (MIT).
//! Wire sizes, field offsets, readers and offset following for layout pages.
//!
//! Every structure is decoded field by field from little-endian bytes at fixed
//! offsets taken from `winioctl.h`, so no Rust struct layout, alignment or
//! `repr(C)` is involved and a page that starts at an odd address parses like
//! any other. The sizes below are on-wire sizes; they are asserted at compile
//! time and again in tests because they are the NTFS contract, not an
//! implementation detail.
//!
//! Offset bases differ, which is the main trap in this format:
//!
//! - `QUERY_FILE_LAYOUT_OUTPUT.FirstFileOffset` is relative to the page start.
//! - Every other offset — `NextFileOffset`, `FirstNameOffset`,
//!   `FirstStreamOffset`, `ExtraInfoOffset`, `NextNameOffset`,
//!   `NextStreamOffset` — is relative to the start of the structure that
//!   carries it, and `0` terminates the chain or marks the structure absent.
//!
//! [`follow_offset`] enforces the base and the cycle guard together: a relative
//! offset below the size of the containing structure would not advance, so the
//! walk rejects it instead of looping.
//!
//! `Error::Truncated.len` follows the crate-wide convention — the number of
//! bytes left in the buffer from the failing offset — so a 84-byte page whose
//! name payload starts at 80 and needs 20 bytes reports `len: 4`.

use crate::{Error, Result};

/// Wire size of `QUERY_FILE_LAYOUT_OUTPUT`: entry count, first-file offset and
/// two layout flags at the start of every page.
pub const OUTPUT_HEADER_LEN: usize = 16;

/// Wire size of the fixed part of `FILE_LAYOUT_ENTRY`; satellite offsets follow.
pub const FILE_ENTRY_LEN: usize = 40;

/// Wire size of the fixed part of `FILE_LAYOUT_NAME_ENTRY`; the UTF-16 name
/// follows and is not null-terminated.
pub const NAME_ENTRY_HEADER_LEN: usize = 24;

/// Prefix of `FILE_LAYOUT_INFO_ENTRY.BasicInformation` through
/// `LastWriteTime`, the only part this parser reads.
pub const INFO_PREFIX_LEN: usize = 24;

/// Wire size of the fixed part of `STREAM_LAYOUT_ENTRY`; the UTF-16 stream
/// identifier follows and is not null-terminated.
pub const STREAM_ENTRY_LEN: usize = 48;

/// Bytes of `FILE_LAYOUT_INFO_ENTRY` a pre-RS5 buffer guarantees when
/// `ExtraInfoLength` is zero: `BasicInformation` (40), `OwnerId` (4),
/// `SecurityId` (4) and `Usn` (8), which is "all fields up to `Usn`".
pub const INFO_ENTRY_LEGACY_LEN: usize = 56;

/// Largest UTF-16 name NTFS stores in one path component: 255 code units.
pub const MAX_NAME_BYTES: u32 = (255 * 2) as u32;

/// `QUERY_FILE_LAYOUT_RESTART`: reset the driver's enumeration cursor for a new
/// pass. Belongs to the caller that drives the ioctl, not to the parser.
pub const QUERY_FILE_LAYOUT_RESTART: u32 = 0x0000_0001;

/// `QUERY_FILE_LAYOUT_INCLUDE_NAMES`: emit a name chain per file.
pub const QUERY_FILE_LAYOUT_INCLUDE_NAMES: u32 = 0x0000_0002;

/// `QUERY_FILE_LAYOUT_INCLUDE_STREAMS`: emit a stream chain per file. Required
/// for sizes: the size of a file is the unnamed `$DATA` stream's `EndOfFile`.
pub const QUERY_FILE_LAYOUT_INCLUDE_STREAMS: u32 = 0x0000_0004;

/// `QUERY_FILE_LAYOUT_INCLUDE_EXTRA_INFO`: emit the info entry per file,
/// which carries the timestamps, attributes and USN.
pub const QUERY_FILE_LAYOUT_INCLUDE_EXTRA_INFO: u32 = 0x0000_0010;

/// `QUERY_FILE_LAYOUT_INCLUDE_STREAMS_WITH_NO_CLUSTERS_ALLOCATED`: also emit
/// streams with no physical allocation — resident, empty and sparse-only
/// streams. Without it most small files report no unnamed `$DATA` stream at
/// all, so their size is unknowable.
pub const QUERY_FILE_LAYOUT_INCLUDE_STREAMS_WITH_NO_CLUSTERS_ALLOCATED: u32 = 0x0000_0020;

/// `QUERY_FILE_LAYOUT_SINGLE_INSTANCED`, an output-header flag: one
/// `FILE_LAYOUT_ENTRY` per file and one `STREAM_LAYOUT_ENTRY` per stream.
pub const QUERY_FILE_LAYOUT_SINGLE_INSTANCED: u32 = 0x0000_0001;

/// The `QUERY_FILE_LAYOUT_INPUT.Flags` a caller must pass so that a page
/// contains everything this parser reports. `QUERY_FILE_LAYOUT_RESTART` is the
/// caller's per-pass concern and is deliberately not part of it.
pub const RECOMMENDED_LAYOUT_FLAGS: u32 = QUERY_FILE_LAYOUT_INCLUDE_NAMES
    | QUERY_FILE_LAYOUT_INCLUDE_STREAMS
    | QUERY_FILE_LAYOUT_INCLUDE_EXTRA_INFO
    | QUERY_FILE_LAYOUT_INCLUDE_STREAMS_WITH_NO_CLUSTERS_ALLOCATED;

/// `FILE_LAYOUT_NAME_ENTRY.Flags` bit: this name is the file's primary (long)
/// name.
pub const FILE_LAYOUT_NAME_ENTRY_PRIMARY: u32 = 0x0000_0001;

/// `FILE_LAYOUT_NAME_ENTRY.Flags` bit: this name is an 8.3 DOS name. With
/// [`FILE_LAYOUT_NAME_ENTRY_PRIMARY`] it is the real name (which happens to
/// fit 8.3); alone it is a DOS-only alias that index builders normally skip.
pub const FILE_LAYOUT_NAME_ENTRY_DOS: u32 = 0x0000_0002;

/// `FILE_ATTRIBUTE_DIRECTORY`: directories report no size, whatever their
/// streams say.
pub const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;

// Field offsets inside each fixed structure. The compile-time assertions below
// keep every field range inside the wire size, so the slice reads in the
// decoders cannot panic on a wrongly sized buffer.
const HEADER_ENTRY_COUNT_OFFSET: usize = 0;
const HEADER_FIRST_FILE_OFFSET: usize = 4;

pub(crate) const FILE_NEXT_FILE_OFFSET: usize = 4;
pub(crate) const FILE_ATTRIBUTES_OFFSET: usize = 12;
pub(crate) const FILE_REFERENCE_OFFSET: usize = 16;
pub(crate) const FILE_FIRST_NAME_OFFSET: usize = 24;
pub(crate) const FILE_FIRST_STREAM_OFFSET: usize = 28;
pub(crate) const FILE_EXTRA_INFO_OFFSET: usize = 32;
pub(crate) const FILE_EXTRA_INFO_LENGTH_OFFSET: usize = 36;

pub(crate) const NAME_NEXT_NAME_OFFSET: usize = 0;
pub(crate) const NAME_FLAGS_OFFSET: usize = 4;
pub(crate) const NAME_PARENT_REFERENCE_OFFSET: usize = 8;
pub(crate) const NAME_FILE_NAME_LENGTH_OFFSET: usize = 16;

pub(crate) const INFO_LAST_WRITE_OFFSET: usize = 16;

pub(crate) const STREAM_NEXT_STREAM_OFFSET: usize = 4;
pub(crate) const STREAM_END_OF_FILE_OFFSET: usize = 24;
pub(crate) const STREAM_IDENTIFIER_LENGTH_OFFSET: usize = 44;

const _: () = {
    // On-wire sizes (golden: the Windows SDK contract).
    assert!(OUTPUT_HEADER_LEN == 16);
    assert!(FILE_ENTRY_LEN == 40);
    assert!(NAME_ENTRY_HEADER_LEN == 24);
    assert!(INFO_PREFIX_LEN == 24);
    assert!(STREAM_ENTRY_LEN == 48);
    assert!(INFO_ENTRY_LEGACY_LEN >= INFO_PREFIX_LEN);
    // Every field range lies inside the structure that carries it.
    assert!(HEADER_ENTRY_COUNT_OFFSET + 4 <= OUTPUT_HEADER_LEN);
    assert!(HEADER_FIRST_FILE_OFFSET + 4 <= OUTPUT_HEADER_LEN);
    assert!(FILE_NEXT_FILE_OFFSET + 4 <= FILE_ENTRY_LEN);
    assert!(FILE_ATTRIBUTES_OFFSET + 4 <= FILE_ENTRY_LEN);
    assert!(FILE_REFERENCE_OFFSET + 8 <= FILE_ENTRY_LEN);
    assert!(FILE_FIRST_NAME_OFFSET + 4 <= FILE_ENTRY_LEN);
    assert!(FILE_FIRST_STREAM_OFFSET + 4 <= FILE_ENTRY_LEN);
    assert!(FILE_EXTRA_INFO_OFFSET + 4 <= FILE_ENTRY_LEN);
    assert!(FILE_EXTRA_INFO_LENGTH_OFFSET + 4 <= FILE_ENTRY_LEN);
    assert!(NAME_FLAGS_OFFSET + 4 <= NAME_ENTRY_HEADER_LEN);
    assert!(NAME_PARENT_REFERENCE_OFFSET + 8 <= NAME_ENTRY_HEADER_LEN);
    assert!(NAME_FILE_NAME_LENGTH_OFFSET + 4 <= NAME_ENTRY_HEADER_LEN);
    assert!(INFO_LAST_WRITE_OFFSET + 8 <= INFO_PREFIX_LEN);
    assert!(STREAM_NEXT_STREAM_OFFSET + 4 <= STREAM_ENTRY_LEN);
    assert!(STREAM_END_OF_FILE_OFFSET + 8 <= STREAM_ENTRY_LEN);
    assert!(STREAM_IDENTIFIER_LENGTH_OFFSET + 4 <= STREAM_ENTRY_LEN);
};

/// Decoded `QUERY_FILE_LAYOUT_OUTPUT`.
pub(crate) struct OutputHeader {
    pub(crate) entry_count: u32,
    pub(crate) first_file_offset: u32,
}

impl OutputHeader {
    /// Reads the page header at offset zero.
    pub(crate) fn parse(page: &[u8]) -> Result<Self> {
        let raw = read_bytes(page, 0, OUTPUT_HEADER_LEN, "QUERY_FILE_LAYOUT_OUTPUT")?;
        Ok(Self {
            entry_count: u32_at(raw, HEADER_ENTRY_COUNT_OFFSET),
            first_file_offset: u32_at(raw, HEADER_FIRST_FILE_OFFSET),
        })
    }
}

/// Decoded `FILE_LAYOUT_ENTRY` fixed part. Layout flags, the version and the
/// name flags are not read: nothing in this parser branches on them.
pub(crate) struct FileEntry {
    pub(crate) attributes: u32,
    pub(crate) file_reference: u64,
    pub(crate) next_file_offset: u32,
    pub(crate) first_name_offset: u32,
    pub(crate) first_stream_offset: u32,
    pub(crate) extra_info_offset: u32,
    pub(crate) extra_info_length: u32,
}

impl FileEntry {
    /// Reads one file entry starting at `offset`.
    pub(crate) fn parse(page: &[u8], offset: usize) -> Result<Self> {
        let raw = read_bytes(page, offset, FILE_ENTRY_LEN, "FILE_LAYOUT_ENTRY")?;
        Ok(Self {
            attributes: u32_at(raw, FILE_ATTRIBUTES_OFFSET),
            file_reference: u64_at(raw, FILE_REFERENCE_OFFSET),
            next_file_offset: u32_at(raw, FILE_NEXT_FILE_OFFSET),
            first_name_offset: u32_at(raw, FILE_FIRST_NAME_OFFSET),
            first_stream_offset: u32_at(raw, FILE_FIRST_STREAM_OFFSET),
            extra_info_offset: u32_at(raw, FILE_EXTRA_INFO_OFFSET),
            extra_info_length: u32_at(raw, FILE_EXTRA_INFO_LENGTH_OFFSET),
        })
    }
}

/// Decoded `FILE_LAYOUT_NAME_ENTRY` fixed part.
pub(crate) struct NameEntry {
    pub(crate) next_name_offset: u32,
    pub(crate) flags: u32,
    pub(crate) parent_reference: u64,
    pub(crate) name_length: u32,
}

impl NameEntry {
    /// Reads one name entry starting at `offset`.
    pub(crate) fn parse(page: &[u8], offset: usize) -> Result<Self> {
        let raw = read_bytes(
            page,
            offset,
            NAME_ENTRY_HEADER_LEN,
            "FILE_LAYOUT_NAME_ENTRY",
        )?;
        Ok(Self {
            next_name_offset: u32_at(raw, NAME_NEXT_NAME_OFFSET),
            flags: u32_at(raw, NAME_FLAGS_OFFSET),
            parent_reference: u64_at(raw, NAME_PARENT_REFERENCE_OFFSET),
            name_length: u32_at(raw, NAME_FILE_NAME_LENGTH_OFFSET),
        })
    }
}

/// Decoded `STREAM_LAYOUT_ENTRY` fixed part. `AllocationSize` is not read: the
/// logical size is what a name index reports.
pub(crate) struct StreamEntry {
    pub(crate) next_stream_offset: u32,
    pub(crate) end_of_file: i64,
    pub(crate) identifier_length: u32,
}

impl StreamEntry {
    /// Reads one stream entry starting at `offset`.
    pub(crate) fn parse(page: &[u8], offset: usize) -> Result<Self> {
        let raw = read_bytes(page, offset, STREAM_ENTRY_LEN, "STREAM_LAYOUT_ENTRY")?;
        Ok(Self {
            next_stream_offset: u32_at(raw, STREAM_NEXT_STREAM_OFFSET),
            end_of_file: i64_at(raw, STREAM_END_OF_FILE_OFFSET),
            identifier_length: u32_at(raw, STREAM_IDENTIFIER_LENGTH_OFFSET),
        })
    }
}

/// Reads `LastWriteTime` from the info entry at `offset`.
///
/// The entry is longer than the prefix (56 bytes on pre-RS5 buffers, more on
/// RS5+), so only the fixed prefix is bounds-checked; the caller has already
/// decided from `ExtraInfoLength` that at least that much is accessible.
pub(crate) fn last_write_time(page: &[u8], offset: usize) -> Result<i64> {
    let raw = read_bytes(page, offset, INFO_PREFIX_LEN, "FILE_LAYOUT_INFO_ENTRY")?;
    Ok(i64_at(raw, INFO_LAST_WRITE_OFFSET))
}

/// Resolves one relative offset field against the structure that contains it.
///
/// Guards, in order: `rel` must clear the containing structure, so every hop
/// strictly advances and a chain terminates within `len / min_rel` steps; then
/// the resolved absolute offset must land inside the page.
pub(crate) fn follow_offset(
    page: &[u8],
    base: usize,
    rel: u32,
    min_rel: usize,
    what: &'static str,
) -> Result<usize> {
    if (rel as usize) < min_rel {
        return Err(Error::OffsetCycle {
            what,
            offset: base,
            rel,
            min: min_rel,
        });
    }
    let Some(abs) = base.checked_add(rel as usize) else {
        return Err(Error::OffsetOutOfBounds {
            what,
            offset: usize::MAX,
            len: page.len(),
        });
    };
    if abs >= page.len() {
        return Err(Error::OffsetOutOfBounds {
            what,
            offset: abs,
            len: page.len(),
        });
    }
    Ok(abs)
}

/// Borrows `need` bytes at `offset`.
///
/// A zero-length read is always fine and never looks at `offset`; otherwise an
/// offset at or past the end is [`Error::OffsetOutOfBounds`] (the page is
/// short), while a read that starts inside but runs past the end is
/// [`Error::Truncated`] (the structure is cut in half).
pub(crate) fn read_bytes<'a>(
    page: &'a [u8],
    offset: usize,
    need: usize,
    what: &'static str,
) -> Result<&'a [u8]> {
    if need == 0 {
        return Ok(&[]);
    }
    if offset >= page.len() {
        return Err(Error::OffsetOutOfBounds {
            what,
            offset,
            len: page.len(),
        });
    }
    let available = page.len() - offset;
    let Some(end) = offset.checked_add(need) else {
        return Err(truncated(what, offset, need, available));
    };
    if end > page.len() {
        return Err(truncated(what, offset, need, available));
    }
    Ok(&page[offset..end])
}

fn truncated(what: &'static str, offset: usize, need: usize, available: usize) -> Error {
    Error::Truncated {
        what,
        offset,
        need,
        len: available,
    }
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    let mut raw = [0u8; 4];
    raw.copy_from_slice(&bytes[at..at + 4]);
    u32::from_le_bytes(raw)
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(raw)
}

fn i64_at(bytes: &[u8], at: usize) -> i64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&bytes[at..at + 8]);
    i64::from_le_bytes(raw)
}
