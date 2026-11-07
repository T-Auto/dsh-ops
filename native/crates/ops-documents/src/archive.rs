//! ZIP metadata is bounded before ZipArchive can allocate from attacker-controlled counts.
use ops_protocol::{Failure, Result};
use std::{
    collections::HashSet,
    io::{Cursor, Read},
};
use zip::ZipArchive;
pub const MAX_ARCHIVE: usize = 32 * 1024 * 1024;
fn error(message: impl Into<String>) -> Failure {
    Failure::new("DOCUMENT_PARSE_ERROR", message.into())
}
fn unsupported(message: &str) -> Failure {
    Failure::new("UNSUPPORTED_DOCUMENT", message)
}
fn u16le(data: &[u8], at: usize) -> usize {
    u16::from_le_bytes([data[at], data[at + 1]]) as usize
}
fn u32le(data: &[u8], at: usize) -> usize {
    u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize
}
fn extra(data: &[u8]) -> Result<()> {
    let mut at = 0;
    while at < data.len() {
        if data.len() - at < 4 {
            return Err(error("Truncated ZIP extra field"));
        }
        let kind = u16le(data, at);
        let size = u16le(data, at + 2);
        at += 4;
        if kind == 1 {
            return Err(unsupported(
                "ZIP64 documents are outside the bounded DOCX subset",
            ));
        }
        if size > data.len() - at {
            return Err(error("ZIP extra field exceeds its declared header"));
        }
        at += size;
    }
    Ok(())
}
fn preflight(data: &[u8]) -> Result<usize> {
    if data.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) {
        return Err(unsupported(
            "Legacy binary DOC is unsupported; supply DOCX or plain text",
        ));
    }
    if data.len() < 22 || data.len() > MAX_ARCHIVE {
        return Err(error("DOCX must be a ZIP archive of at most 32 MiB"));
    }
    let end = (data.len().saturating_sub(65557)..=data.len() - 22)
        .rev()
        .find(|&at| {
            &data[at..at + 4] == b"PK\x05\x06" && at + 22 + u16le(data, at + 20) == data.len()
        })
        .ok_or_else(|| error("ZIP end record is missing or has trailing data"))?;
    // zip retries earlier EOCDs after metadata errors. Forbid alternate footer interpretations
    // before its constructor can follow an unvalidated count or a ZIP64 allocation path.
    if data.windows(4).enumerate().any(|(at, magic)| {
        (magic == b"PK\x05\x06" && at != end) || magic == b"PK\x06\x06" || magic == b"PK\x06\x07"
    }) {
        return Err(unsupported(
            "Ambiguous ZIP footer signatures and ZIP64 structures are unsupported",
        ));
    }
    let count = u16le(data, end + 10);
    let size = u32le(data, end + 12);
    let start = u32le(data, end + 16);
    if u16le(data, end + 4) != 0
        || u16le(data, end + 6) != 0
        || u16le(data, end + 8) != count
        || count == 65535
        || size == u32::MAX as usize
        || start == u32::MAX as usize
    {
        return Err(unsupported(
            "Multi-disk and ZIP64 documents are unsupported",
        ));
    }
    if count > 4096 || size > 1024 * 1024 {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            "DOCX ZIP exceeds 4096 entries or 1 MiB central metadata",
        ));
    }
    if start.checked_add(size) != Some(end) {
        return Err(error("ZIP central-directory bounds are inconsistent"));
    }
    let mut at = start;
    let mut names = HashSet::new();
    let mut ranges = Vec::new();
    for _ in 0..count {
        if end - at < 46 || &data[at..at + 4] != b"PK\x01\x02" {
            return Err(error("Truncated ZIP central-directory entry"));
        }
        let (name, extras, comment) = (
            u16le(data, at + 28),
            u16le(data, at + 30),
            u16le(data, at + 32),
        );
        let next = at + 46 + name + extras + comment;
        if next > end || u16le(data, at + 34) != 0 {
            return Err(error("Invalid ZIP central-directory entry bounds"));
        }
        let filename = &data[at + 46..at + 46 + name];
        if !names.insert(filename.to_vec()) {
            return Err(error("Duplicate ZIP entry names are ambiguous"));
        }
        extra(&data[at + 46 + name..at + 46 + name + extras])?;
        let flags = u16le(data, at + 8);
        let method = u16le(data, at + 10);
        let compressed = u32le(data, at + 20);
        if flags & (1 | 64 | 8192) != 0 {
            return Err(unsupported("Encrypted ZIP entries are unsupported"));
        }
        if compressed == u32::MAX as usize || u32le(data, at + 24) == u32::MAX as usize {
            return Err(unsupported("ZIP64 entries are unsupported"));
        }
        let local = u32le(data, at + 42);
        if local > start || start - local < 30 || &data[local..local + 4] != b"PK\x03\x04" {
            return Err(error("ZIP local-header bounds are invalid"));
        }
        let (ln, le) = (u16le(data, local + 26), u16le(data, local + 28));
        let body = local + 30 + ln + le;
        if body > start
            || compressed > start - body
            || &data[local + 30..local + 30 + ln] != filename
            || u16le(data, local + 6) != flags
            || u16le(data, local + 8) != method
        {
            return Err(error("ZIP local and central entries disagree"));
        }
        extra(&data[local + 30 + ln..body])?;
        ranges.push((local, body + compressed));
        at = next;
    }
    if at != end {
        return Err(error(
            "ZIP entry count does not match central-directory bytes",
        ));
    }
    ranges.sort_unstable();
    if ranges.windows(2).any(|r| r[0].1 > r[1].0) {
        return Err(error("Overlapping ZIP entries are unsupported"));
    }
    Ok(count)
}
pub struct Archive<'a>(ZipArchive<Cursor<&'a [u8]>>);
impl<'a> Archive<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self> {
        let count = preflight(data)?;
        let archive = ZipArchive::with_config(
            zip::read::Config {
                archive_offset: zip::read::ArchiveOffset::Known(0),
            },
            Cursor::new(data),
        )
        .map_err(|e| error(format!("Invalid DOCX ZIP: {e}")))?;
        if archive.len() != count {
            return Err(error("ZIP entry identities differ from preflight"));
        }
        Ok(Self(archive))
    }
    pub fn xml(&mut self, name: &str, limit: usize) -> Result<String> {
        let mut file = self
            .0
            .by_name(name)
            .map_err(|_| error(format!("Required DOCX part is missing: {name}")))?;
        if !file.is_file()
            || file
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
        {
            return Err(unsupported("DOCX XML parts must be regular ZIP entries"));
        }
        if !matches!(
            file.compression(),
            zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
        ) {
            return Err(unsupported(
                "Only stored or deflated DOCX XML parts are supported",
            ));
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| {
                error(format!(
                    "DOCX part failed decompression or CRC validation: {e}"
                ))
            })?;
        if bytes.len() > limit {
            return Err(Failure::new(
                "OUTPUT_LIMIT",
                format!("DOCX part {name} exceeds its decoded byte limit"),
            ));
        }
        super::xml::decode(&bytes)
    }
}
