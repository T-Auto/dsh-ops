//! Bounded PDF container: classic xref tables and indirect object references.
use crate::pdf_syntax::{Dict, Lexer, MAX_NODES, Value, bad, limit, unsupported, white};
use ops_protocol::{Failure, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};
pub const MAX_FILE: usize = 16 * 1024 * 1024;
pub const MAX_OBJECTS: usize = 10_000;
pub const MAX_STREAM: usize = 1024 * 1024;
/// Objects one indirect `/Length` chain may keep in flight.
const MAX_NESTED_OBJECT_READS: usize = 64;
const CONTAINER_DEADLINE: Duration = Duration::from_secs(20);
pub type ObjectId = (u32, u16);
/// One cross-reference entry from a classic table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum XrefEntry {
    /// Type 0: the object number is not in use.
    Free { generation: u16 },
    /// Type 1: an object header at a byte offset.
    Offset { offset: usize, generation: u16 },
}
#[derive(Debug)]
pub struct Object<'a> {
    pub value: Value,
    pub stream: Option<&'a [u8]>,
}
#[derive(Debug)]
pub struct Document<'a> {
    pub objects: BTreeMap<ObjectId, Object<'a>>,
    pub root: ObjectId,
}
impl<'a> Document<'a> {
    pub fn object(&self, id: ObjectId) -> Result<&Object<'a>> {
        self.objects
            .get(&id)
            .ok_or_else(|| bad("PDF reference does not name an active object"))
    }
    pub fn resolve<'b>(&'b self, value: &'b Value) -> Result<&'b Value> {
        let mut current = value;
        let mut seen = BTreeSet::new();
        while let Value::Ref(number, generation) = current {
            if seen.len() >= 64 {
                return Err(limit("PDF reference chain exceeds 64"));
            }
            if !seen.insert((*number, *generation)) {
                return Err(bad("Cyclic PDF reference"));
            }
            let object = self.object((*number, *generation))?;
            if object.stream.is_some() {
                return Err(bad("A PDF stream cannot be used as a plain value"));
            }
            current = &object.value;
        }
        Ok(current)
    }
}
pub fn get<'a>(dict: &'a Dict, key: &[u8]) -> Result<&'a Value> {
    dict.get(key)
        .ok_or_else(|| bad(format!("Missing PDF {}", String::from_utf8_lossy(key))))
}
fn trim_end(mut data: &[u8]) -> &[u8] {
    while data.last().is_some_and(|b| white(*b)) {
        data = &data[..data.len() - 1];
    }
    data
}
fn footer(data: &[u8]) -> Result<(usize, usize)> {
    let end = trim_end(data);
    let Some(before_eof) = end.strip_suffix(b"%%EOF") else {
        return Err(bad("PDF must end with %%EOF"));
    };
    if !before_eof.last().is_some_and(|b| white(*b)) {
        return Err(bad("Missing PDF EOF separator"));
    }
    let before_eof = trim_end(before_eof);
    let number_start = before_eof
        .iter()
        .rposition(|b| !b.is_ascii_digit())
        .map_or(0, |n| n + 1);
    if number_start == 0 || !white(before_eof[number_start - 1]) {
        return Err(bad("Missing PDF xref number separator"));
    }
    let mut number = Lexer::new(&before_eof[number_start..]);
    let xref = number.unsigned()?;
    let prefix = trim_end(&before_eof[..number_start]);
    let Some(before_start) = prefix.strip_suffix(b"startxref") else {
        return Err(bad("Missing final PDF startxref"));
    };
    if !before_start.last().is_some_and(|b| white(*b)) {
        return Err(bad("Missing PDF startxref separator"));
    }
    let footer_start = before_start.len();
    if xref >= footer_start {
        return Err(bad("PDF xref offset points outside object section"));
    }
    Ok((xref, footer_start))
}
fn check_deadline(started: Instant) -> Result<()> {
    if started.elapsed() >= CONTAINER_DEADLINE {
        return Err(Failure::new(
            "DEADLINE_EXCEEDED",
            "PDF container scan reached its 20-second deadline",
        ));
    }
    Ok(())
}
/// One parsed object, its value, and (for a stream) its exact encoded bytes.
#[derive(Debug)]
pub(crate) struct Raw<'a> {
    pub(crate) value: Value,
    pub(crate) stream: Option<&'a [u8]>,
    /// Where the object header starts.
    pub(crate) start: usize,
    pub(crate) end: usize,
    nodes: usize,
}
/// Read the object at offset; /Length is the only value read before the object is complete.
pub(crate) fn read_object<'a>(
    data: &'a [u8],
    offset: usize,
    expected: Option<ObjectId>,
    length: &mut dyn FnMut(&Value) -> Result<usize>,
) -> Result<Raw<'a>> {
    if !data.get(offset).is_some_and(u8::is_ascii_digit) {
        return Err(bad("PDF xref must point exactly to an object header"));
    }
    if offset == 0 {
        return Err(bad("PDF object header must follow whitespace"));
    }
    if !white(data[offset - 1]) {
        return Err(bad("PDF object header must follow whitespace"));
    }
    let mut lexer = Lexer {
        data,
        at: offset,
        nodes: 0,
    };
    let number = lexer.unsigned()?;
    let generation = lexer.unsigned()?;
    if number > u32::MAX as usize || generation > u16::MAX as usize {
        return Err(bad("PDF object header is not a bounded object identity"));
    }
    let id = (number as u32, generation as u16);
    if expected.is_some_and(|expected| expected != id) {
        return Err(bad("PDF xref object identity mismatch"));
    }
    lexer.keyword(b"obj")?;
    let value = lexer.value(0)?;
    let mut stream = None;
    let token = lexer.word()?;
    if token == b"stream" {
        let length_value = get(value.dict()?, b"Length")?.clone();
        let length = length(&length_value)?;
        if length > MAX_STREAM {
            return Err(limit("PDF encoded stream exceeds 1 MiB"));
        }
        // The length fixes the stream extent; endstream is verified, never searched for.
        if lexer.data.get(lexer.at..lexer.at + 2) == Some(b"\r\n") {
            lexer.at += 2;
        } else if lexer.data.get(lexer.at) == Some(&b'\n') {
            lexer.at += 1;
        } else {
            return Err(bad("PDF stream keyword must be followed by LF or CRLF"));
        }
        let end = lexer
            .at
            .checked_add(length)
            .filter(|n| *n <= data.len())
            .ok_or_else(|| bad("PDF stream length exceeds its object"))?;
        stream = Some(&data[lexer.at..end]);
        lexer.at = end;
        lexer.keyword(b"endstream")?;
        lexer.keyword(b"endobj")?;
    } else if token != b"endobj" {
        return Err(bad("Unexpected token after PDF object"));
    }
    Ok(Raw {
        value,
        stream,
        start: offset,
        end: lexer.at,
        nodes: lexer.nodes,
    })
}
/// The one cross-reference section the file names from its footer.
struct Section {
    entries: BTreeMap<usize, XrefEntry>,
    trailer: Dict,
    /// Values the section and trailer consumed; the file-wide budget starts here.
    nodes: usize,
}
/// Refuse a trailer that names `/Prev` or `/XRefStm`; both mark an incremental update.
fn reject_incremental_trailer(trailer: &Dict) -> Result<()> {
    for key in [b"Prev".as_slice(), b"XRefStm"] {
        if trailer.contains_key(key) {
            return Err(unsupported(
                "Incremental PDF updates with a trailer /Prev or /XRefStm are unsupported",
            ));
        }
    }
    Ok(())
}
fn read_section(
    data: &[u8],
    offset: usize,
    footer_start: usize,
    started: Instant,
) -> Result<Section> {
    if offset < 9 || offset >= footer_start {
        return Err(bad("PDF xref offset points outside the object section"));
    }
    if !white(data[offset - 1]) {
        return Err(bad("PDF xref section must follow whitespace"));
    }
    if !data[offset..].starts_with(b"xref") {
        return Err(unsupported(
            "PDF requires a classic xref table; xref streams are unsupported",
        ));
    }
    classic_section(data, offset, footer_start, started)
}
fn classic_section(
    data: &[u8],
    offset: usize,
    footer_start: usize,
    started: Instant,
) -> Result<Section> {
    let mut lexer = Lexer {
        data,
        at: offset,
        nodes: 0,
    };
    lexer.keyword(b"xref")?;
    let mut entries: BTreeMap<usize, XrefEntry> = BTreeMap::new();
    loop {
        check_deadline(started)?;
        lexer.skip();
        if data[lexer.at..].starts_with(b"trailer") {
            lexer.keyword(b"trailer")?;
            break;
        }
        let start = lexer.unsigned()?;
        let count = lexer.unsigned()?;
        // Every incremental update starts with an empty subsection; declaring nothing is not a
        // section of this container, and skipping it is not recovery.
        if count == 0 {
            return Err(bad("PDF xref subsection cannot be empty"));
        }
        if start >= MAX_OBJECTS
            || count > MAX_OBJECTS - start
            || entries.len() + count > MAX_OBJECTS
        {
            return Err(limit("PDF xref exceeds 10000 entries"));
        }
        for id in start..start + count {
            let offset = lexer.unsigned()?;
            let generation = lexer.unsigned()?;
            let flag = lexer.word()?;
            if generation > u16::MAX as usize
                || (flag == b"n" && generation == u16::MAX as usize)
                || !matches!(flag, b"n" | b"f")
            {
                return Err(bad("Invalid PDF xref entry"));
            }
            let entry = if flag == b"n" {
                XrefEntry::Offset {
                    offset,
                    generation: generation as u16,
                }
            } else {
                XrefEntry::Free {
                    generation: generation as u16,
                }
            };
            if entries.insert(id, entry).is_some() {
                return Err(bad("Duplicate PDF xref object number"));
            }
        }
    }
    let Value::Dict(trailer) = lexer.value(0)? else {
        return Err(bad("Expected a PDF dictionary"));
    };
    reject_incremental_trailer(&trailer)?;
    finish_section(&mut lexer, footer_start)?;
    Ok(Section {
        entries,
        trailer,
        nodes: lexer.nodes,
    })
}
/// Verify that the section ends at the final footer: nothing follows the only revision.
fn finish_section(lexer: &mut Lexer<'_>, footer_start: usize) -> Result<()> {
    lexer.skip();
    if lexer.at != footer_start {
        return Err(bad("Unexpected PDF data between trailer and final footer"));
    }
    Ok(())
}
/// Parsed object values plus their resolution budgets.
struct Loader<'a> {
    data: &'a [u8],
    entries: BTreeMap<usize, XrefEntry>,
    objects: BTreeMap<ObjectId, Object<'a>>,
    ranges: Vec<(usize, usize)>,
    resolving: BTreeSet<ObjectId>,
    nodes: usize,
    started: Instant,
}
impl<'a> Loader<'a> {
    fn charge(&mut self, nodes: usize) -> Result<()> {
        self.nodes = self.nodes.saturating_add(nodes);
        if self.nodes > MAX_NODES {
            return Err(limit("PDF metadata exceeds 100000 values"));
        }
        Ok(())
    }
    fn entry(&self, id: ObjectId) -> Result<XrefEntry> {
        let entry = *self
            .entries
            .get(&(id.0 as usize))
            .ok_or_else(|| bad("PDF reference does not name an active xref object"))?;
        if let XrefEntry::Offset { generation, .. } = entry
            && generation != id.1
        {
            return Err(bad("PDF reference generation is not the active xref entry"));
        }
        Ok(entry)
    }
    /// Resolve a value that `/Length`, `/N`, `/First` and `/Size` may write as a reference chain.
    fn length_of(&mut self, value: &Value) -> Result<usize> {
        if !matches!(value, Value::Ref(..)) {
            return value.integer();
        }
        let mut current = value.clone();
        let mut seen = BTreeSet::new();
        loop {
            check_deadline(self.started)?;
            match &current {
                Value::Integer(_) => return current.integer(),
                Value::Ref(number, generation) => {
                    let id = (*number, *generation);
                    if seen.len() >= 64 {
                        return Err(limit("PDF reference chain exceeds 64"));
                    }
                    if !seen.insert(id) {
                        return Err(bad("Cyclic PDF reference"));
                    }
                    current = self.value_of(id)?;
                }
                _ => {
                    return Err(bad(
                        "PDF indirect integer must reference a direct integer object",
                    ));
                }
            }
        }
    }
    fn value_of(&mut self, id: ObjectId) -> Result<Value> {
        match self.entry(id)? {
            XrefEntry::Offset { offset, .. } => {
                self.object_at(id, offset)?;
                Ok(self.objects[&id].value.clone())
            }
            XrefEntry::Free { .. } => Err(bad("PDF reference does not name an active xref object")),
        }
    }
    fn object_at(&mut self, id: ObjectId, offset: usize) -> Result<()> {
        if self.objects.contains_key(&id) {
            return Ok(());
        }
        check_deadline(self.started)?;
        if self.resolving.len() >= MAX_NESTED_OBJECT_READS {
            return Err(limit("PDF object reads nest more than 64 deep"));
        }
        if !self.resolving.insert(id) {
            return Err(bad("PDF streams cannot resolve each other's length"));
        }
        let data = self.data;
        let raw = {
            let mut length = |value: &Value| self.length_of(value);
            read_object(data, offset, Some(id), &mut length)
        };
        let raw = raw?;
        self.resolving.remove(&id);
        self.charge(raw.nodes)?;
        // The range starts at the header, so a tolerated leading whitespace byte cannot make the
        // first object look unindexed or overlap the construct before it.
        self.ranges.push((raw.start, raw.end));
        self.objects.insert(
            id,
            Object {
                value: raw.value,
                stream: raw.stream,
            },
        );
        Ok(())
    }
}
/// Reject overlapping ranges and unindexed bytes: every gap may hold only whitespace or comments.
fn verify_ranges(data: &[u8], mut ranges: Vec<(usize, usize)>, footer_start: usize) -> Result<()> {
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        if start < 9 || end > footer_start || end <= start {
            return Err(bad("PDF construct range is outside the object section"));
        }
        match merged.last_mut() {
            Some(last) if last.0 == start => last.1 = last.1.max(end),
            Some(last) if last.1 > start => return Err(bad("PDF object ranges overlap")),
            _ => merged.push((start, end)),
        }
    }
    // An xref offset may point into a comment, and an unindexed construct may sit in any gap, so
    // every gap is lexed from the previous construct to the next: only whitespace and % comments
    // may be skipped. The ranges include the xref section, so the trailing gap is covered too.
    let mut previous = 0;
    for (start, end) in merged {
        let mut gap = Lexer {
            data,
            at: previous,
            nodes: 0,
        };
        gap.skip();
        if gap.at != start {
            return Err(bad(
                "Unindexed data or overlapping comments in PDF object section",
            ));
        }
        previous = end;
    }
    Ok(())
}
pub fn parse(data: &[u8]) -> Result<Document<'_>> {
    if data.len() > MAX_FILE {
        return Err(limit("PDF file exceeds 16 MiB"));
    }
    if data.len() < 9
        || &data[..7] != b"%PDF-1."
        || !matches!(data[7], b'0'..=b'7')
        || !matches!(data[8], 10 | 13)
    {
        return Err(unsupported(
            "Only PDF 1.0-1.7 with an exact header is supported",
        ));
    }
    let (startxref, footer_start) = footer(data)?;
    let started = Instant::now();
    check_deadline(started)?;
    let Section {
        entries,
        trailer,
        nodes,
    } = read_section(data, startxref, footer_start, started)?;
    let mut ranges = vec![(startxref, footer_start)];
    let mut loader = Loader {
        data,
        entries,
        objects: BTreeMap::new(),
        ranges: Vec::new(),
        resolving: BTreeSet::new(),
        nodes,
        started,
    };
    loader.charge(0)?;
    let size = {
        let size = get(&trailer, b"Size")?.clone();
        loader.length_of(&size)?
    };
    if size == 0 {
        return Err(bad("PDF Size must name at least object zero"));
    }
    if size > MAX_OBJECTS {
        return Err(limit("PDF Size exceeds 10000 objects"));
    }
    if loader.entries.keys().any(|number| *number >= size) {
        return Err(bad("PDF xref declares an object number at or above Size"));
    }
    // A classic table must declare every object number below Size.
    if loader.entries.len() != size {
        return Err(bad(
            "PDF classic xref must declare every object number below Size",
        ));
    }
    if loader.entries.get(&0).copied().is_none_or(|entry| {
        entry
            != XrefEntry::Free {
                generation: u16::MAX,
            }
    }) {
        return Err(bad("PDF object zero must be free with generation 65535"));
    }
    let root = trailer
        .get(b"Root".as_slice())
        .ok_or_else(|| bad("Missing PDF Root"))?;
    let root = match root {
        Value::Ref(a, b) => (*a, *b),
        _ => return Err(bad("PDF Root must be an indirect reference")),
    };
    let pending: Vec<(usize, XrefEntry)> = loader
        .entries
        .iter()
        .map(|(number, entry)| (*number, *entry))
        .collect();
    for (number, entry) in &pending {
        check_deadline(started)?;
        match entry {
            XrefEntry::Free { .. } => {}
            XrefEntry::Offset { offset, generation } => {
                if *offset < 9 || *offset >= footer_start {
                    return Err(bad(
                        "Active PDF object offset is outside the object section",
                    ));
                }
                loader.object_at((*number as u32, *generation), *offset)?;
            }
        }
    }
    let objects = loader.objects;
    ranges.append(&mut loader.ranges);
    verify_ranges(data, ranges, footer_start)?;
    let document = Document { objects, root };
    let root_object = document.object(root)?;
    if root_object.stream.is_some() {
        return Err(bad("PDF Root cannot be a stream"));
    }
    root_object.value.dict()?;
    Ok(document)
}
// Decode one bounded stream; verify the zlib terminator and complete input consumption.
pub fn decode(object: &Object<'_>) -> Result<Vec<u8>> {
    let raw = object.stream.ok_or_else(|| bad("Expected a PDF stream"))?;
    if raw.len() > MAX_STREAM {
        return Err(limit("PDF encoded stream exceeds 1 MiB"));
    }
    let dict = object.value.dict()?;
    if dict.contains_key(b"DecodeParms".as_slice()) || dict.contains_key(b"F".as_slice()) {
        return Err(unsupported(
            "PDF stream predictors, decode parameters and external data are unsupported",
        ));
    }
    let Some(filter) = dict.get(b"Filter".as_slice()) else {
        return Ok(raw.to_vec());
    };
    let filter = match filter {
        Value::Array(filters) if filters.len() == 1 => &filters[0],
        value => value,
    };
    if filter.name()? != b"FlateDecode" {
        return Err(unsupported(
            "Only unfiltered or single FlateDecode PDF streams are supported",
        ));
    }
    let mut decoder = flate2::Decompress::new(true);
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let before_in = decoder.total_in() as usize;
        let before_out = decoder.total_out() as usize;
        let room = (MAX_STREAM + 1 - output.len()).min(buffer.len());
        let status = decoder
            .decompress(
                &raw[before_in..],
                &mut buffer[..room],
                flate2::FlushDecompress::None,
            )
            .map_err(|_| bad("Invalid PDF zlib stream or checksum"))?;
        let written = decoder.total_out() as usize - before_out;
        output.extend_from_slice(&buffer[..written]);
        if output.len() > MAX_STREAM {
            return Err(limit("PDF decoded stream exceeds 1 MiB"));
        }
        if status == flate2::Status::StreamEnd {
            if decoder.total_in() as usize != raw.len() {
                return Err(bad("Trailing data after PDF zlib stream"));
            }
            return Ok(output);
        }
        if decoder.total_in() as usize == before_in && written == 0 {
            return Err(bad("Truncated PDF zlib stream"));
        }
    }
}
#[cfg(test)]
#[path = "pdf_container_tests.rs"]
mod tests;
