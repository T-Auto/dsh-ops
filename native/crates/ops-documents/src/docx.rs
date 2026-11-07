//! DOCX main-body text observations. Paragraphs retain table coordinates, never rendered-layout claims.
use crate::{
    archive::{Archive, MAX_ARCHIVE},
    xml::{self, Token},
};
use ops_protocol::{Failure, Request, Result, capture::json_size};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path, time::Instant};
const WORD: [&str; 2] = [
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
];
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    path: String,
    #[serde(default = "super::one")]
    offset: usize,
    #[serde(default = "super::two_hundred")]
    limit: usize,
}
fn page_complete(failure: Option<&Failure>, observed: usize, offset: usize, limit: usize) -> bool {
    !failure.is_some_and(|error| error.code == "FILE_CHANGED")
        && (failure.is_none() || observed >= offset + limit - 1)
}
fn unsupported(name: &str) -> Failure {
    Failure::new(
        "UNSUPPORTED_DOCUMENT",
        format!(
            "Unsupported DOCX main-body content: {name}; preceding complete paragraphs remain observations"
        ),
    )
}
fn metadata(
    text: &str,
    started: Instant,
    namespace: &str,
    root: &str,
    mut visit: impl FnMut(xml::Tag) -> Result<()>,
) -> Result<()> {
    let mut depth = 0usize;
    xml::walk(text, started, |token| {
        match token {
            Token::Start(tag) => {
                if tag.ns != namespace || (depth == 0 && tag.name != root) || depth > 1 {
                    return Err(xml::bad("Invalid DOCX package XML structure"));
                }
                if depth == 1 {
                    visit(tag)?;
                }
                depth += 1;
            }
            Token::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| xml::bad("Invalid package XML nesting"))?;
            }
            Token::Text(text) => {
                if !text.trim().is_empty() {
                    return Err(xml::bad("Unexpected text in DOCX package XML"));
                }
            }
        }
        Ok(())
    })
}
fn package(archive: &mut Archive<'_>, started: Instant) -> Result<()> {
    let types = archive.xml("[Content_Types].xml", 1024 * 1024)?;
    let mut main = 0;
    metadata(
        &types,
        started,
        "http://schemas.openxmlformats.org/package/2006/content-types",
        "Types",
        |tag| {
            {
                if !matches!(tag.name.as_str(), "Override" | "Default") {
                    return Err(xml::bad("Unexpected content-type element"));
                }
                if tag.ns != "http://schemas.openxmlformats.org/package/2006/content-types" {
                    return Err(xml::bad("Invalid DOCX content-type namespace"));
                }
                if tag.attrs.get("ContentType").is_some_and(|t| {
                    t.to_ascii_lowercase().contains("macroenabled")
                        || t.to_ascii_lowercase().contains("vbaproject")
                }) {
                    return Err(unsupported("macro-enabled package"));
                }
                if tag.name == "Override"
                    && tag
                        .attrs
                        .get("PartName")
                        .is_some_and(|p| p == "/word/document.xml")
                {
                    if tag.attrs.get("ContentType").map(String::as_str)
                        != Some(
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                        )
                    {
                        return Err(unsupported("non-DOCX main content type"));
                    }
                    main += 1;
                }
            }
            Ok(())
        },
    )?;
    if main != 1 {
        return Err(xml::bad(
            "DOCX must declare exactly one word/document.xml main part",
        ));
    }
    let rels = archive.xml("_rels/.rels", 1024 * 1024)?;
    let mut main = 0;
    metadata(
        &rels,
        started,
        "http://schemas.openxmlformats.org/package/2006/relationships",
        "Relationships",
        |tag| {
            {
                if tag.name != "Relationship" {
                    return Err(xml::bad("Unexpected relationship element"));
                }
                if tag.ns != "http://schemas.openxmlformats.org/package/2006/relationships" {
                    return Err(xml::bad("Invalid package relationship namespace"));
                }
                if tag.name == "Relationship"
                && tag.attrs.get("Type").is_some_and(|t| {
                    t == "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
                        || t == "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument"
                })
            {
                if tag.attrs.get("Target").map(String::as_str) != Some("word/document.xml")
                    || tag.attrs.get("TargetMode").is_some_and(|m| m != "Internal")
                {
                    return Err(unsupported("external or nonstandard main-document relationship"));
                }
                main += 1;
            }
            }
            Ok(())
        },
    )?;
    if main != 1 {
        return Err(xml::bad(
            "DOCX must have exactly one internal main-document relationship",
        ));
    }
    Ok(())
}
struct Page<'a> {
    request: &'a Request,
    args: &'a Args,
    items: Vec<Value>,
    observed: usize,
    selected: usize,
    bytes: usize,
    cut: bool,
}
impl Page<'_> {
    fn push(&mut self, mut item: Value) -> Result<()> {
        if self.observed >= 100_000 {
            return Err(Failure::new(
                "OUTPUT_LIMIT",
                "DOCX exceeds 100000 observed paragraphs",
            ));
        }
        self.observed += 1;
        item["block"] = json!(self.observed);
        if self.observed < self.args.offset || self.observed >= self.args.offset + self.args.limit {
            return Ok(());
        }
        self.selected += 1;
        if let Some(sink) = self.request.output_sink.as_deref() {
            sink.push(&item);
        }
        let bytes = json_size(&item) + 1;
        if self.cut || self.bytes + bytes > 80 * 1024 {
            self.cut = true;
            if let Some(sink) = self.request.output_sink.as_deref() {
                sink.clipped();
            }
        } else {
            self.bytes += bytes;
            self.items.push(item);
        }
        Ok(())
    }
}
fn paragraphs(text: &str, started: Instant, page: &mut Page<'_>) -> Result<()> {
    let mut stack = Vec::<String>::new();
    let (mut body, mut document) = (0, 0);
    let (mut paragraph, mut content, mut table, mut row, mut cell) =
        (None::<Value>, String::new(), 0, 0, 0);
    let mut in_table = false;
    xml::walk(text, started, |token| {
        match token {
            Token::Start(tag) => {
                if !WORD.contains(&tag.ns.as_str()) {
                    return Err(unsupported(&format!("foreign namespace {}", tag.name)));
                }
                let parent = stack.last().map(String::as_str);
                let property = stack.iter().any(|n| {
                    matches!(
                        n.as_str(),
                        "pPr" | "rPr" | "tblPr" | "trPr" | "tcPr" | "sectPr" | "tblGrid" | "sdtPr"
                    )
                });
                if property {
                    if matches!(
                        tag.name.as_str(),
                        "document" | "body" | "p" | "r" | "t" | "tbl" | "tr" | "tc"
                    ) {
                        return Err(xml::bad("Content nested inside formatting properties"));
                    }
                    stack.push(tag.name);
                    return Ok(());
                }
                match tag.name.as_str() {
                    "document" if stack.is_empty() => document += 1,
                    "body" if parent == Some("document") => body += 1,
                    "tbl" => {
                        if in_table || paragraph.is_some() || !stack.iter().any(|n| n == "body") {
                            return Err(unsupported("nested table"));
                        }
                        in_table = true;
                        table += 1;
                        row = 0;
                        cell = 0;
                    }
                    "tr" => {
                        if !in_table || parent != Some("tbl") {
                            return Err(xml::bad("Table row outside table"));
                        }
                        row += 1;
                        cell = 0;
                    }
                    "tc" => {
                        if parent != Some("tr") {
                            return Err(xml::bad("Table cell outside row"));
                        }
                        cell += 1;
                    }
                    "p" => {
                        if paragraph.is_some()
                            || !stack.iter().any(|n| n == "body")
                            || !matches!(parent, Some("body" | "tc" | "sdtContent" | "customXml"))
                        {
                            return Err(unsupported("paragraph placement"));
                        }
                        let mut item = json!({"type":"paragraph","text":""});
                        if in_table {
                            item["table"] = json!(table);
                            item["row"] = json!(row);
                            item["cell"] = json!(cell);
                        }
                        paragraph = Some(item);
                        content.clear();
                    }
                    "t" => {
                        if paragraph.is_none() || parent != Some("r") {
                            return Err(xml::bad("Text outside a paragraph run"));
                        }
                    }
                    "tab" | "br" | "cr" => {
                        if paragraph.is_none() || parent != Some("r") {
                            return Err(xml::bad("Text control outside a paragraph run"));
                        }
                        content.push(if tag.name == "tab" { '\t' } else { '\n' });
                    }
                    "drawing" | "pict" | "object" | "fldSimple" | "fldChar" | "instrText"
                    | "altChunk" | "del" | "ins" | "moveFrom" | "moveTo" | "sym"
                    | "footnoteReference" | "endnoteReference" => {
                        return Err(unsupported(&tag.name));
                    }
                    "document" | "body" => return Err(xml::bad("Invalid document/body nesting")),
                    "r"
                    | "hyperlink"
                    | "bookmarkStart"
                    | "bookmarkEnd"
                    | "proofErr"
                    | "commentRangeStart"
                    | "commentRangeEnd"
                    | "commentReference"
                    | "pPr"
                    | "rPr"
                    | "tblPr"
                    | "trPr"
                    | "tcPr"
                    | "sectPr"
                    | "tblGrid"
                    | "sdt"
                    | "sdtPr"
                    | "sdtContent"
                    | "customXml"
                    | "lastRenderedPageBreak" => {}
                    "noBreakHyphen" | "softHyphen" => {
                        if paragraph.is_none() || parent != Some("r") {
                            return Err(xml::bad("Text control outside a paragraph run"));
                        }
                        content.push(if tag.name == "noBreakHyphen" {
                            '\u{2011}'
                        } else {
                            '\u{ad}'
                        });
                    }
                    _ => return Err(unsupported(&tag.name)),
                }
                if content.len() > 1024 * 1024 {
                    return Err(Failure::new(
                        "OUTPUT_LIMIT",
                        "One DOCX paragraph exceeds 1 MiB",
                    ));
                }
                stack.push(tag.name);
            }
            Token::End(name) => {
                if stack.pop().as_deref() != Some(&name) {
                    return Err(xml::bad("DOCX element nesting differs"));
                }
                if stack.iter().any(|n| {
                    matches!(
                        n.as_str(),
                        "pPr" | "rPr" | "tblPr" | "trPr" | "tcPr" | "sectPr" | "tblGrid" | "sdtPr"
                    )
                }) {
                    return Ok(());
                }
                if name == "p" {
                    let mut item = paragraph
                        .take()
                        .ok_or_else(|| xml::bad("Unmatched paragraph"))?;
                    item["text"] = json!(std::mem::take(&mut content));
                    page.push(item)?;
                }
                if name == "tbl" {
                    in_table = false;
                }
            }
            Token::Text(text) => {
                if stack.last().is_some_and(|n| n == "t") {
                    if content.len().saturating_add(text.len()) > 1024 * 1024 {
                        return Err(Failure::new(
                            "OUTPUT_LIMIT",
                            "One DOCX paragraph exceeds 1 MiB",
                        ));
                    }
                    content.push_str(&text);
                } else if !text.trim().is_empty() {
                    return Err(unsupported("text outside w:t"));
                }
            }
        }
        Ok(())
    })?;
    if document != 1 || body != 1 {
        return Err(xml::bad(
            "DOCX main part requires one document and one body",
        ));
    }
    Ok(())
}
pub fn read(request: &Request) -> Result<Value> {
    let args: Args = serde_json::from_value(request.args.clone())?;
    if args.offset == 0 || args.offset > 100_000 || args.limit == 0 || args.limit > 1000 {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "read_docx offset is 1-100000 paragraphs and limit is 1-1000",
        ));
    }
    request.authorize_path(Path::new(&args.path))?;
    let target = ops_files::file_path::checked(&args.path)?;
    request.authorize_path(&target.display)?;
    let mut file = ops_files::file_path::read_file(&target)?.into_std();
    let before = file.metadata()?;
    let started = Instant::now();
    if before.len() > MAX_ARCHIVE as u64 {
        return Err(Failure::new("OUTPUT_LIMIT", "DOCX archive exceeds 32 MiB"));
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_ARCHIVE as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_ARCHIVE {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            "DOCX archive grew beyond 32 MiB",
        ));
    }
    let mut archive = Archive::new(&bytes)?;
    package(&mut archive, started)?;
    let text = archive.xml("word/document.xml", 8 * 1024 * 1024)?;
    let mut page = Page {
        request,
        args: &args,
        items: Vec::new(),
        observed: 0,
        selected: 0,
        bytes: 0,
        cut: false,
    };
    let mut failure = paragraphs(&text, started, &mut page).err();
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        failure = Some(Failure::new(
            "FILE_CHANGED",
            "DOCX metadata changed while reading; observed paragraphs are not a stable snapshot",
        ));
    }
    let scan = failure.is_none();
    let next = args.offset + page.selected;
    let more = !scan || next <= page.observed;
    let cause = if let Some(error) = &failure {
        match error.code.as_str() {
            "DEADLINE_EXCEEDED" => "time",
            "FILE_CHANGED" => "changed",
            "OUTPUT_LIMIT" => "scan-budget",
            _ => "parse-error",
        }
    } else if more {
        "row-limit"
    } else {
        "none"
    };
    let mut output = json!({"status":if scan {"completed"} else {"partial"},"phase":"verify","changed":0,"effectState":"none","path":target.display,"format":"docx","scope":"main-body-paragraphs",
        "excludedContent":["formatting and rendered layout","headers and footers","footnotes and endnotes","comments","package metadata"],
        "bytes":before.len(),"blocksObserved":page.observed,"skipped":(args.offset-1).min(page.observed),"scanComplete":scan,"pageComplete":page_complete(failure.as_ref(), page.observed, args.offset, args.limit),
        "complete":scan&&!more,"truncated":more,"truncatedBy":cause,"nextOffset":next,"items":[]});
    if scan {
        output["total"] = json!(page.observed);
        output["omitted"] = json!(page.observed.saturating_sub(next - 1));
        output["revision"] = json!(format!("{:x}", Sha256::digest(&bytes)));
    }
    if let Some(mut error) = failure {
        error.next_action="Use a dedicated DOCX reader for unsupported content or parse limits; main-body paragraph paging cannot recover an unobserved suffix. Do not treat this scope as the full rendered document.".into();
        output["nextAction"] = json!(error.next_action);
        output["error"] = json!(error);
    }
    if let Some(sink) = request.output_sink.as_deref() {
        sink.source(output.clone());
    }
    if page.cut {
        output["complete"] = json!(false);
        output["pageComplete"] = json!(false);
        output["truncated"] = json!(true);
        output["nextOffset"] = json!(args.offset + page.items.len());
        if scan {
            output["truncatedBy"] = json!("output-budget");
            output["omitted"] = json!(
                page.observed
                    .saturating_sub(args.offset - 1 + page.items.len())
            );
        }
        if output.get("nextAction").is_none() {
            output["nextAction"] = json!(
                "Read the stored reference when available; otherwise reduce limit or use a dedicated DOCX reader for a large paragraph."
            );
        }
    }
    output["items"] = json!(page.items);
    Ok(output)
}

#[cfg(test)]
mod completeness_tests {
    #[test]
    fn changed_files_never_claim_the_requested_page_is_complete() {
        let changed = ops_protocol::Failure::new("FILE_CHANGED", "fixture");
        assert!(!super::page_complete(Some(&changed), 10, 1, 2));
        let gap = ops_protocol::Failure::new("UNSUPPORTED_DOCUMENT", "fixture");
        assert!(super::page_complete(Some(&gap), 10, 1, 2));
        assert!(!super::page_complete(Some(&gap), 1, 1, 2));
    }
}
