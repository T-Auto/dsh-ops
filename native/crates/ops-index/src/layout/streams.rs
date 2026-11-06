// Design informed by mustafaahci/goz (MIT).
//! The extra-info prefix (modification time) and the `STREAM_LAYOUT_ENTRY`
//! chain (logical size).
//!
//! Neither value lives in `FILE_LAYOUT_ENTRY` itself. The timestamps are in a
//! separate info entry reached through `ExtraInfoOffset`/`ExtraInfoLength`,
//! and a file's size is the `EndOfFile` of its unnamed `$DATA` stream, so it
//! only exists when the page was queried with streams included.
//!
//! The info entry's declared length is a gate, not a region to validate: a
//! pre-RS5 buffer stores 0 there ("reserved") but still guarantees every field
//! up to `Usn` ([`INFO_ENTRY_LEGACY_LEN`] bytes), RS5+ stores the accessible
//! length. A declared length below the prefix silently yields no timestamp
//! rather than reading past the contract; only the 24 prefix bytes actually
//! read are bounds-checked.

use super::walk::PageBudget;
use super::wire::{
    self, FILE_ENTRY_LEN, FileEntry, INFO_ENTRY_LEGACY_LEN, INFO_PREFIX_LEN, STREAM_ENTRY_LEN,
    StreamEntry,
};
use crate::{Error, Result};

/// UTF-16LE bytes of `"::$DATA"`. NTFS names the unnamed data stream either by
/// an empty identifier or by this exact spelling; there is no case folding and
/// no other alias.
pub(super) const UNNAMED_DATA_IDENTIFIER_UTF16LE: [u8; 14] = [
    0x3A, 0x00, // ':'
    0x3A, 0x00, // ':'
    0x24, 0x00, // '$'
    0x44, 0x00, // 'D'
    0x41, 0x00, // 'A'
    0x54, 0x00, // 'T'
    0x41, 0x00, // 'A'
];

/// Reads `LastWriteTime` when the info entry is present and declares at least
/// the fixed prefix.
///
/// The offset is followed even when the declared length is too small: the
/// cycle/bounds guard is part of following the chain, while the length only
/// decides whether the prefix is read at all.
pub(crate) fn parse_mtime(
    page: &[u8],
    file_offset: usize,
    entry: &FileEntry,
    budget: &mut PageBudget,
) -> Result<Option<i64>> {
    if entry.extra_info_offset == 0 {
        return Ok(None);
    }
    budget.spend_step("FILE_LAYOUT_INFO_ENTRY")?;
    let info_offset = wire::follow_offset(
        page,
        file_offset,
        entry.extra_info_offset,
        FILE_ENTRY_LEN,
        "FILE_LAYOUT_ENTRY.ExtraInfoOffset",
    )?;
    let declared = entry.extra_info_length as usize;
    let available = if declared == 0 {
        INFO_ENTRY_LEGACY_LEN
    } else {
        declared
    };
    if available < INFO_PREFIX_LEN {
        return Ok(None);
    }
    Ok(Some(wire::last_write_time(page, info_offset)?))
}

/// Size of the unnamed `$DATA` stream, or `None` when the page has no stream
/// chain, no unnamed stream, or the file is a directory.
///
/// Only the first unnamed stream counts and a negative `EndOfFile` clamps to
/// zero: a byte count cannot be negative, so the value is corrupt rather than
/// meaningful, but it is not worth rejecting the page over. The chain is walked
/// in full even for directories, so a structural defect in it still fails the
/// page.
pub(crate) fn parse_size(
    page: &[u8],
    file_offset: usize,
    entry: &FileEntry,
    is_dir: bool,
    budget: &mut PageBudget,
) -> Result<Option<u64>> {
    if entry.first_stream_offset == 0 {
        return Ok(None);
    }
    let mut size = None;
    let mut stream_offset = wire::follow_offset(
        page,
        file_offset,
        entry.first_stream_offset,
        FILE_ENTRY_LEN,
        "FILE_LAYOUT_ENTRY.FirstStreamOffset",
    )?;
    loop {
        budget.spend_step("STREAM_LAYOUT_ENTRY")?;
        let stream = StreamEntry::parse(page, stream_offset)?;
        if !stream.identifier_length.is_multiple_of(2) {
            return Err(Error::OddUtf16Length {
                what: "STREAM_LAYOUT_ENTRY.StreamIdentifierLength",
                offset: stream_offset,
                len: stream.identifier_length,
            });
        }
        budget.spend_payload(
            "STREAM_LAYOUT_ENTRY.StreamIdentifier",
            stream.identifier_length as usize,
        )?;
        let identifier = wire::read_bytes(
            page,
            stream_offset + STREAM_ENTRY_LEN,
            stream.identifier_length as usize,
            "STREAM_LAYOUT_ENTRY.StreamIdentifier",
        )?;
        if !is_dir && size.is_none() && is_unnamed_data_identifier(identifier) {
            size = Some(stream.end_of_file.max(0) as u64);
        }
        if stream.next_stream_offset == 0 {
            break;
        }
        stream_offset = wire::follow_offset(
            page,
            stream_offset,
            stream.next_stream_offset,
            STREAM_ENTRY_LEN,
            "STREAM_LAYOUT_ENTRY.NextStreamOffset",
        )?;
    }
    Ok(size)
}

/// `true` when raw UTF-16LE bytes are the unnamed data stream's identifier:
/// either empty, or exactly `"::$DATA"`.
fn is_unnamed_data_identifier(identifier: &[u8]) -> bool {
    identifier.is_empty() || identifier == UNNAMED_DATA_IDENTIFIER_UTF16LE
}
