// Design informed by mustafaahci/goz (MIT).
//! Byte-level page builders for layout tests, compiled for tests only.
//!
//! A fixture describes a page in terms of names, timestamps and streams; the
//! builder renders the exact wire format and backfills every offset field.
//! Records are packed with no padding between them, which is what the format
//! actually is: offsets are absolute byte positions, so no alignment rule
//! exists to violate.
//!
//! A [`Page`] also reports the offset of every record it wrote, so a test that
//! corrupts one field patches four bytes at a documented position instead of
//! hard-coding a layout that a later change would silently invalidate.

use super::wire::{
    FILE_ATTRIBUTES_OFFSET, FILE_ENTRY_LEN, FILE_EXTRA_INFO_LENGTH_OFFSET, FILE_EXTRA_INFO_OFFSET,
    FILE_FIRST_NAME_OFFSET, FILE_FIRST_STREAM_OFFSET, FILE_NEXT_FILE_OFFSET, FILE_REFERENCE_OFFSET,
    INFO_LAST_WRITE_OFFSET, NAME_FILE_NAME_LENGTH_OFFSET, NAME_FLAGS_OFFSET, NAME_NEXT_NAME_OFFSET,
    NAME_PARENT_REFERENCE_OFFSET, STREAM_END_OF_FILE_OFFSET, STREAM_IDENTIFIER_LENGTH_OFFSET,
    STREAM_NEXT_STREAM_OFFSET,
};
use super::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_LAYOUT_NAME_ENTRY_DOS, FILE_LAYOUT_NAME_ENTRY_PRIMARY,
    INFO_ENTRY_LEGACY_LEN, INFO_PREFIX_LEN, LayoutFile, LayoutName, NAME_ENTRY_HEADER_LEN,
    OUTPUT_HEADER_LEN, STREAM_ENTRY_LEN,
};
use crate::ids::RecordId;

/// One `FILE_LAYOUT_NAME_ENTRY` to render.
#[derive(Clone, Debug)]
pub struct NameFixture {
    /// Directory that holds the link.
    pub parent: RecordId,
    /// Name as UTF-16 code units, unpaired surrogates allowed.
    pub units: Vec<u16>,
    /// Raw `FILE_LAYOUT_NAME_ENTRY.Flags` bits.
    pub flags: u32,
}

impl NameFixture {
    /// A primary name with a UTF-8 spelling.
    pub fn primary(parent: RecordId, name: &str) -> Self {
        Self::from_parts(
            parent,
            name.encode_utf16().collect(),
            FILE_LAYOUT_NAME_ENTRY_PRIMARY,
        )
    }

    /// A primary name from raw code units.
    pub fn primary_units(parent: RecordId, units: Vec<u16>) -> Self {
        Self::from_parts(parent, units, FILE_LAYOUT_NAME_ENTRY_PRIMARY)
    }

    /// An 8.3 DOS-only alias.
    pub fn dos_alias(parent: RecordId, name: &str) -> Self {
        Self::from_parts(
            parent,
            name.encode_utf16().collect(),
            FILE_LAYOUT_NAME_ENTRY_DOS,
        )
    }

    /// A name entry with arbitrary flags.
    pub fn from_parts(parent: RecordId, units: Vec<u16>, flags: u32) -> Self {
        Self {
            parent,
            units,
            flags,
        }
    }

    /// Replaces the raw flag bits.
    pub fn with_flags(mut self, flags: u32) -> Self {
        self.flags = flags;
        self
    }

    /// What the parser must report for this name.
    pub fn expected(&self) -> LayoutName {
        let mut name = Vec::new();
        let name_lossy = crate::wtf8::from_utf16(&self.units, &mut name);
        LayoutName {
            parent: self.parent,
            name,
            name_lossy,
            dos_only: self.flags & FILE_LAYOUT_NAME_ENTRY_DOS != 0
                && self.flags & FILE_LAYOUT_NAME_ENTRY_PRIMARY == 0,
        }
    }
}

/// One `FILE_LAYOUT_INFO_ENTRY` to render. The builder always writes the
/// legacy 56 bytes; `declared_length` is the field value the parser gates on.
#[derive(Clone, Debug)]
pub struct InfoFixture {
    /// `LastWriteTime` in 100 ns ticks since 1601.
    pub last_write_time: i64,
    /// Value written to `ExtraInfoLength`; 0 means a pre-RS5 buffer.
    pub declared_length: u32,
}

impl InfoFixture {
    /// A pre-RS5 info entry (`ExtraInfoLength` = 0, 56 bytes guaranteed).
    pub fn legacy(last_write_time: i64) -> Self {
        Self {
            last_write_time,
            declared_length: 0,
        }
    }

    /// An RS5+ info entry that declares exactly the readable prefix.
    pub fn rs5(last_write_time: i64) -> Self {
        Self {
            last_write_time,
            declared_length: INFO_PREFIX_LEN as u32,
        }
    }

    /// Overrides the declared accessible length.
    pub fn with_declared_length(mut self, declared_length: u32) -> Self {
        self.declared_length = declared_length;
        self
    }
}

/// One `STREAM_LAYOUT_ENTRY` to render.
#[derive(Clone, Debug)]
pub struct StreamFixture {
    /// Stream identifier as UTF-16 code units; empty means unnamed.
    pub identifier_units: Vec<u16>,
    /// `EndOfFile`: the logical size.
    pub end_of_file: i64,
    /// `AllocationSize`: physically allocated bytes, ignored by the parser.
    pub allocation_size: i64,
}

impl StreamFixture {
    /// The unnamed `$DATA` stream, identified by an empty identifier.
    pub fn unnamed(end_of_file: i64) -> Self {
        Self::from_parts(Vec::new(), end_of_file, 0)
    }

    /// The unnamed `$DATA` stream, identified by the literal `"::$DATA"`.
    pub fn unnamed_explicit(end_of_file: i64) -> Self {
        Self::from_parts("::$DATA".encode_utf16().collect(), end_of_file, 0)
    }

    /// A named stream such as `:Zone.Identifier:$DATA`.
    pub fn named(identifier: &str, end_of_file: i64) -> Self {
        Self::from_parts(identifier.encode_utf16().collect(), end_of_file, 0)
    }

    /// A stream with arbitrary fields.
    pub fn from_parts(identifier_units: Vec<u16>, end_of_file: i64, allocation_size: i64) -> Self {
        Self {
            identifier_units,
            end_of_file,
            allocation_size,
        }
    }

    /// Overrides `AllocationSize` so a test can prove it is not the size.
    pub fn with_allocation_size(mut self, allocation_size: i64) -> Self {
        self.allocation_size = allocation_size;
        self
    }

    /// Whether this stream is the unnamed `$DATA` stream.
    pub fn is_unnamed(&self) -> bool {
        const EXPLICIT: [u16; 7] = [0x3A, 0x3A, 0x24, 0x44, 0x41, 0x54, 0x41];
        self.identifier_units.is_empty() || self.identifier_units == EXPLICIT
    }
}

/// One file entry and its satellites.
#[derive(Clone, Debug)]
pub struct FileFixture {
    /// File reference number.
    pub reference: RecordId,
    /// Raw `FileAttributes` bits.
    pub attributes: u32,
    /// Name chain, in order.
    pub names: Vec<NameFixture>,
    /// Extra-info entry, when present.
    pub info: Option<InfoFixture>,
    /// Stream chain, in order.
    pub streams: Vec<StreamFixture>,
}

impl FileFixture {
    /// A regular file with one primary name and no metadata.
    pub fn file(reference: RecordId, parent: RecordId, name: &str) -> Self {
        Self {
            reference,
            attributes: 0,
            names: vec![NameFixture::primary(parent, name)],
            info: None,
            streams: Vec::new(),
        }
    }

    /// A directory with one primary name.
    pub fn dir(reference: RecordId, parent: RecordId, name: &str) -> Self {
        Self {
            attributes: FILE_ATTRIBUTE_DIRECTORY,
            ..Self::file(reference, parent, name)
        }
    }

    /// Replaces the name chain.
    pub fn with_names(mut self, names: Vec<NameFixture>) -> Self {
        self.names = names;
        self
    }

    /// Attaches an info entry.
    pub fn with_info(mut self, info: InfoFixture) -> Self {
        self.info = Some(info);
        self
    }

    /// Replaces the stream chain.
    pub fn with_streams(mut self, streams: Vec<StreamFixture>) -> Self {
        self.streams = streams;
        self
    }

    /// Overrides the raw attributes.
    pub fn with_attributes(mut self, attributes: u32) -> Self {
        self.attributes = attributes;
        self
    }

    /// What the parser must report for this file.
    pub fn expected(&self) -> LayoutFile {
        let is_dir = self.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        let size = if is_dir {
            None
        } else {
            self.streams
                .iter()
                .find(|stream| stream.is_unnamed())
                .map(|stream| stream.end_of_file.max(0) as u64)
        };
        let mtime_ft = self.info.as_ref().and_then(|info| {
            let available = if info.declared_length == 0 {
                INFO_ENTRY_LEGACY_LEN
            } else {
                info.declared_length as usize
            };
            (available >= INFO_PREFIX_LEN).then_some(info.last_write_time)
        });
        LayoutFile {
            reference: self.reference,
            attributes: self.attributes,
            size,
            mtime_ft,
            names: self.names.iter().map(NameFixture::expected).collect(),
        }
    }
}

/// Offsets of the records rendered for one file.
#[derive(Clone, Debug, Default)]
pub struct FileOffsets {
    /// Offset of the `FILE_LAYOUT_ENTRY`.
    pub file: usize,
    /// Offsets of the name entries, in chain order.
    pub names: Vec<usize>,
    /// Offset of the info entry, when present.
    pub info: Option<usize>,
    /// Offsets of the stream entries, in chain order.
    pub streams: Vec<usize>,
}

/// A rendered page and the offsets of the records in it.
#[derive(Clone, Debug)]
pub struct Page {
    /// The rendered bytes.
    pub bytes: Vec<u8>,
    /// Offsets of the rendered records.
    pub files: Vec<FileOffsets>,
}

impl Page {
    /// Offset of the first `FILE_LAYOUT_ENTRY`.
    pub fn first_file(&self) -> usize {
        self.files[0].file
    }
}

/// Renders a page holding exactly one file.
pub fn build_single(fixture: &FileFixture) -> Page {
    build_page(std::slice::from_ref(fixture))
}

/// Renders a page holding `fixtures` in the given chain order.
pub fn build_page(fixtures: &[FileFixture]) -> Page {
    let mut bytes = vec![0u8; OUTPUT_HEADER_LEN];
    put_u32(&mut bytes, 0, fixtures.len() as u32);
    if !fixtures.is_empty() {
        put_u32(&mut bytes, 4, OUTPUT_HEADER_LEN as u32);
    }
    let mut page = Page {
        bytes,
        files: Vec::with_capacity(fixtures.len()),
    };
    let mut previous_file: Option<usize> = None;
    for fixture in fixtures {
        let file_offset = page.bytes.len();
        page.bytes.resize(file_offset + FILE_ENTRY_LEN, 0);
        if let Some(previous) = previous_file {
            put_u32(
                &mut page.bytes,
                previous + FILE_NEXT_FILE_OFFSET,
                (file_offset - previous) as u32,
            );
        }
        put_u32(
            &mut page.bytes,
            file_offset + FILE_ATTRIBUTES_OFFSET,
            fixture.attributes,
        );
        put_u64(
            &mut page.bytes,
            file_offset + FILE_REFERENCE_OFFSET,
            fixture.reference.get(),
        );

        let mut name_offsets = Vec::with_capacity(fixture.names.len());
        for name in &fixture.names {
            let name_offset = page.bytes.len();
            page.bytes.resize(name_offset + NAME_ENTRY_HEADER_LEN, 0);
            if let Some(previous) = name_offsets.last() {
                put_u32(
                    &mut page.bytes,
                    previous + NAME_NEXT_NAME_OFFSET,
                    (name_offset - previous) as u32,
                );
            }
            put_u32(&mut page.bytes, name_offset + NAME_FLAGS_OFFSET, name.flags);
            put_u64(
                &mut page.bytes,
                name_offset + NAME_PARENT_REFERENCE_OFFSET,
                name.parent.get(),
            );
            put_u32(
                &mut page.bytes,
                name_offset + NAME_FILE_NAME_LENGTH_OFFSET,
                (name.units.len() * 2) as u32,
            );
            for unit in &name.units {
                page.bytes.extend_from_slice(&unit.to_le_bytes());
            }
            name_offsets.push(name_offset);
        }
        if let Some(first) = name_offsets.first() {
            put_u32(
                &mut page.bytes,
                file_offset + FILE_FIRST_NAME_OFFSET,
                (first - file_offset) as u32,
            );
        }

        let info_offset = fixture.info.as_ref().map(|info| {
            let offset = page.bytes.len();
            page.bytes.resize(offset + INFO_ENTRY_LEGACY_LEN, 0);
            put_i64(
                &mut page.bytes,
                offset + INFO_LAST_WRITE_OFFSET,
                info.last_write_time,
            );
            put_u32(
                &mut page.bytes,
                file_offset + FILE_EXTRA_INFO_OFFSET,
                (offset - file_offset) as u32,
            );
            put_u32(
                &mut page.bytes,
                file_offset + FILE_EXTRA_INFO_LENGTH_OFFSET,
                info.declared_length,
            );
            offset
        });

        let mut stream_offsets = Vec::with_capacity(fixture.streams.len());
        for stream in &fixture.streams {
            let offset = page.bytes.len();
            page.bytes.resize(offset + STREAM_ENTRY_LEN, 0);
            if let Some(previous) = stream_offsets.last() {
                put_u32(
                    &mut page.bytes,
                    previous + STREAM_NEXT_STREAM_OFFSET,
                    (offset - previous) as u32,
                );
            }
            // AllocationSize sits at offset 16; the parser deliberately ignores it.
            put_i64(&mut page.bytes, offset + 16, stream.allocation_size);
            put_i64(
                &mut page.bytes,
                offset + STREAM_END_OF_FILE_OFFSET,
                stream.end_of_file,
            );
            put_u32(
                &mut page.bytes,
                offset + STREAM_IDENTIFIER_LENGTH_OFFSET,
                (stream.identifier_units.len() * 2) as u32,
            );
            for unit in &stream.identifier_units {
                page.bytes.extend_from_slice(&unit.to_le_bytes());
            }
            stream_offsets.push(offset);
        }
        if let Some(first) = stream_offsets.first() {
            put_u32(
                &mut page.bytes,
                file_offset + FILE_FIRST_STREAM_OFFSET,
                (first - file_offset) as u32,
            );
        }

        page.files.push(FileOffsets {
            file: file_offset,
            names: name_offsets,
            info: info_offset,
            streams: stream_offsets,
        });
        previous_file = Some(file_offset);
    }
    page
}

/// Writes a little-endian `u32` at an absolute page offset.
pub fn put_u32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

/// Writes a little-endian `u64` at an absolute page offset.
pub fn put_u64(bytes: &mut [u8], at: usize, value: u64) {
    bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

/// Writes a little-endian `i64` at an absolute page offset.
pub fn put_i64(bytes: &mut [u8], at: usize, value: i64) {
    bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
}
