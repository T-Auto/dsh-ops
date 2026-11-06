// Design informed by mustafaahci/goz (MIT).
//! The `FILE_LAYOUT_NAME_ENTRY` chain: one entry per hard link, plus a separate
//! entry for the 8.3 alias when NTFS keeps one.
//!
//! Names are UTF-16LE byte spans, not null-terminated strings, so the declared
//! byte length is authoritative. Two guards run before anything is allocated or
//! decoded, in this observable order:
//!
//! 1. the length must not exceed [`MAX_NAME_BYTES`] — the 255-code-unit NTFS
//!    component limit — because `FileNameLength` is a `u32` and name entries
//!    only need to advance 24 bytes, so overlapping over-long names could
//!    otherwise amplify one page into an unbounded allocation;
//! 2. the length must be even, because UTF-16 code units are two bytes.
//!
//! A 511-byte name therefore reports `NameTooLong`, not `OddUtf16Length`.

use super::walk::PageBudget;
use super::wire::{self, FILE_ENTRY_LEN, MAX_NAME_BYTES, NAME_ENTRY_HEADER_LEN, NameEntry};
use super::{FILE_LAYOUT_NAME_ENTRY_DOS, FILE_LAYOUT_NAME_ENTRY_PRIMARY, LayoutName};
use crate::ids::RecordId;
use crate::{Error, Result};

/// Walks the name chain that starts `first_name_offset` bytes after
/// `file_offset`.
///
/// Returns an empty vector when the file has no name chain. Names keep chain
/// order; duplicates are kept, and DOS aliases are returned like any other name
/// with [`LayoutName::dos_only`] set.
pub(crate) fn parse_names(
    page: &[u8],
    file_offset: usize,
    first_name_offset: u32,
    budget: &mut PageBudget,
) -> Result<Vec<LayoutName>> {
    if first_name_offset == 0 {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    let mut name_offset = wire::follow_offset(
        page,
        file_offset,
        first_name_offset,
        FILE_ENTRY_LEN,
        "FILE_LAYOUT_ENTRY.FirstNameOffset",
    )?;
    loop {
        budget.spend_step("FILE_LAYOUT_NAME_ENTRY")?;
        let entry = NameEntry::parse(page, name_offset)?;
        let name_length = entry.name_length;
        if name_length > MAX_NAME_BYTES {
            return Err(Error::NameTooLong {
                what: "FILE_LAYOUT_NAME_ENTRY.FileName",
                offset: name_offset,
                len: name_length,
                max: MAX_NAME_BYTES,
            });
        }
        if !name_length.is_multiple_of(2) {
            return Err(Error::OddUtf16Length {
                what: "FILE_LAYOUT_NAME_ENTRY.FileNameLength",
                offset: name_offset,
                len: name_length,
            });
        }
        budget.spend_payload("FILE_LAYOUT_NAME_ENTRY.FileName", name_length as usize)?;
        let raw = wire::read_bytes(
            page,
            name_offset + NAME_ENTRY_HEADER_LEN,
            name_length as usize,
            "FILE_LAYOUT_NAME_ENTRY.FileName",
        )?;
        let mut name = Vec::with_capacity(raw.len());
        let name_lossy = crate::wtf8::from_utf16_le(raw, &mut name);
        names.push(LayoutName {
            parent: RecordId::new(entry.parent_reference),
            name,
            name_lossy,
            dos_only: is_dos_only(entry.flags),
        });
        if entry.next_name_offset == 0 {
            break;
        }
        name_offset = wire::follow_offset(
            page,
            name_offset,
            entry.next_name_offset,
            NAME_ENTRY_HEADER_LEN,
            "FILE_LAYOUT_NAME_ENTRY.NextNameOffset",
        )?;
    }
    Ok(names)
}

/// `true` for an 8.3 alias: the DOS bit without the primary bit. A name that
/// carries both bits is the real name, even if it fits 8.3, and all other flag
/// bits are ignored.
fn is_dos_only(flags: u32) -> bool {
    flags & FILE_LAYOUT_NAME_ENTRY_DOS != 0 && flags & FILE_LAYOUT_NAME_ENTRY_PRIMARY == 0
}
