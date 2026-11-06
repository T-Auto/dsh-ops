// Design informed by mustafaahci/goz (MIT).
//! Page header and `FILE_LAYOUT_ENTRY` chain: the entry point of the module.
//!
//! One call decodes one `FSCTL_QUERY_FILE_LAYOUT` output buffer. The header's
//! `FileEntryCount` is only a capacity hint; the `FirstFileOffset` and
//! `NextFileOffset` chain is authoritative and a zero `NextFileOffset`
//! terminates it. Inside a file the satellites are read in a fixed order —
//! names, then extra info, then streams — so when a page carries several
//! defects the first one reported is stable and observable in tests.
//!
//! Any error abandons the whole page: entries already decoded are dropped with
//! the returned `Err`, never handed back as a partial answer.

use super::names;
use super::streams;
use super::wire::{self, FILE_ENTRY_LEN, FileEntry, OUTPUT_HEADER_LEN, OutputHeader};
use super::{FILE_ATTRIBUTE_DIRECTORY, LayoutFile};
use crate::Result;
use crate::ids::RecordId;

/// Largest capacity pre-reserved from `FileEntryCount`.
///
/// The count is attacker-controlled, so it only ever reserves memory up to this
/// bound; the offset chain, not the count, determines how many files are
/// actually returned.
const MAX_ENTRY_CAPACITY: u32 = 4096;

/// Decodes one `FSCTL_QUERY_FILE_LAYOUT` output page.
///
/// An empty buffer and a header whose `FileEntryCount` is zero both yield an
/// empty vector, without looking at `FirstFileOffset`: an empty page is normal
/// at the end of a pass, and a zero count means the kernel found nothing.
/// Otherwise the offset chain is walked. Pages are independent — a chain never
/// spans two buffers — so callers simply feed the next ioctl result to the next
/// call.
///
/// Every structural defect is an error carrying the offset that failed: a
/// truncated structure, an offset outside the page, a chain that would not
/// advance, an odd UTF-16 length, or a name above the 255-code-unit limit. A
/// bad page is discarded as a whole and the caller falls back to a fresh
/// traversal; see the module docs for why partial results are not an option.
pub fn walk_layout_buffer(page: &[u8]) -> Result<Vec<LayoutFile>> {
    if page.is_empty() {
        return Ok(Vec::new());
    }
    let header = OutputHeader::parse(page)?;
    if header.entry_count == 0 {
        return Ok(Vec::new());
    }
    let mut files = Vec::with_capacity(header.entry_count.min(MAX_ENTRY_CAPACITY) as usize);
    let mut file_offset = wire::follow_offset(
        page,
        0,
        header.first_file_offset,
        OUTPUT_HEADER_LEN,
        "QUERY_FILE_LAYOUT_OUTPUT.FirstFileOffset",
    )?;
    loop {
        let entry = FileEntry::parse(page, file_offset)?;
        files.push(parse_file(page, file_offset, &entry)?);
        if entry.next_file_offset == 0 {
            break;
        }
        file_offset = wire::follow_offset(
            page,
            file_offset,
            entry.next_file_offset,
            FILE_ENTRY_LEN,
            "FILE_LAYOUT_ENTRY.NextFileOffset",
        )?;
    }
    Ok(files)
}

/// Decodes one file entry and its three satellite chains, in chain order:
/// names, extra info, streams.
fn parse_file(page: &[u8], file_offset: usize, entry: &FileEntry) -> Result<LayoutFile> {
    let attributes = entry.attributes;
    let is_dir = attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    let names = names::parse_names(page, file_offset, entry.first_name_offset)?;
    let mtime_ft = streams::parse_mtime(page, file_offset, entry)?;
    let size = streams::parse_size(page, file_offset, entry, is_dir)?;
    Ok(LayoutFile {
        reference: RecordId::new(entry.file_reference),
        attributes,
        size,
        mtime_ft,
        names,
    })
}
