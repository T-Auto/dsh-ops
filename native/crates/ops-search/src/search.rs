//! Search execution streams bounded files and keeps only the requested output page.
use super::*;
use super::{scan::Scan, paging::{Cursor, Page, finish}};
use ops_protocol::search::TruncatedBy;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GlobArgs {
    path: String, pattern: Vec<String>,
    #[serde(default)] output_mode: String,
    #[serde(default)] sort: String,
    #[serde(default)] offset: usize,
    #[serde(default = "one_hundred")] limit: usize,
    continuation: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GrepArgs {
    path: String, pattern: String,
    #[serde(default)] glob: Vec<String>,
    #[serde(default)] output_mode: String,
    #[serde(default)] case_insensitive: bool,
    #[serde(default = "yes")] line_numbers: bool,
    #[serde(default)] before_context: usize,
    #[serde(default)] after_context: usize,
    #[serde(default)] multiline: bool,
    #[serde(default)] offset: usize,
    #[serde(default = "one_hundred")] limit: usize,
    #[serde(default = "yes")] exact_total: bool,
    continuation: Option<String>,
}

pub fn glob(request: &Request) -> Result<Value> {
    let args: GlobArgs = serde_json::from_value(request.args.clone())?;
    if args.limit == 0 || args.limit > 10_000 { return Err(Failure::new("INVALID_ARGUMENT", "glob limit is 1-10000")); }
    if args.pattern.is_empty() || args.pattern.iter().all(|pattern| pattern.starts_with('!')) { return Err(Failure::new("INVALID_ARGUMENT", "pattern requires a positive glob")); }
    if !matches!(args.sort.as_str(), "" | "path" | "modified") { return Err(Failure::new("INVALID_ARGUMENT", "sort must be path or modified")); }
    if !matches!(args.output_mode.as_str(), "" | "paths" | "details") { return Err(Failure::new("INVALID_ARGUMENT", "outputMode must be paths or details")); }
    let root = target(&args.path, false)?;
    if !root.is_dir() { return Err(Failure::new("INVALID_ARGUMENT", "glob path must be a directory")); }
    let cursor = Cursor::new(request, args.offset, args.continuation.as_deref())?;
    let mut scan = Scan::new(); let mut files = Vec::new();
    scan.walk(&root, &args.pattern, request, |file, metadata, _| {
        let modified = metadata.modified().ok().and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_millis());
        files.push((file.to_path_buf(), modified, metadata.len())); Ok(())
    })?;
    if args.sort == "modified" { files.sort_by_key(|(_, modified, _)| std::cmp::Reverse(*modified)); }
    let total = files.len(); let mut page = Page::new(cursor.offset, args.limit, request.output_sink.clone());
    for (ordinal, (file, modified, bytes)) in files.into_iter().enumerate() {
        if page.wants(ordinal) { page.push(if args.output_mode == "details" { json!({"path":file,"bytes":bytes,"modified":modified}) } else { json!(file) }, ordinal)?; }
    }
    finish(scan, cursor, page, total, total, json!({}))
}

/// Extract physical LF-delimited context without allocating a line table for the whole file.
fn excerpt(text: &str, first: usize, last: usize, before: usize, after: usize) -> String {
    let bytes = text.as_bytes();
    let mut start = bytes[..first].iter().rposition(|byte| *byte == b'\n').map_or(0, |index| index + 1);
    for _ in 0..before { if start == 0 { break; } start = bytes[..start - 1].iter().rposition(|byte| *byte == b'\n').map_or(0, |index| index + 1); }
    let mut end = bytes[last..].iter().position(|byte| *byte == b'\n').map_or(bytes.len(), |index| last + index + 1);
    for _ in 0..after { if end == bytes.len() { break; } end = bytes[end..].iter().position(|byte| *byte == b'\n').map_or(bytes.len(), |index| end + index + 1); }
    let mut output = String::new();
    for (index, raw) in text[start..end].split_inclusive('\n').enumerate() {
        if index > 0 { output.push('\n'); }
        output.push_str(raw.strip_suffix('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).unwrap_or(raw));
    }
    output
}
pub fn grep(request: &Request) -> Result<Value> {
    let args: GrepArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.limit == 0 || args.limit > 10_000 { return Err(Failure::new("INVALID_ARGUMENT", "pattern and bounded limit are required")); }
    if args.before_context > 32 || args.after_context > 32 { return Err(Failure::new("INVALID_ARGUMENT", "context is limited to 32 lines")); }
    if !matches!(args.output_mode.as_str(), "" | "content" | "files_with_matches" | "count" | "summary") { return Err(Failure::new("INVALID_ARGUMENT", "invalid grep outputMode")); }
    let regex = RegexBuilder::new(&args.pattern).case_insensitive(args.case_insensitive).multi_line(args.multiline).build().map_err(|error| Failure::new("INVALID_ARGUMENT", error))?;
    let root = target(&args.path, false)?;
    let cursor = Cursor::new(request, args.offset, args.continuation.as_deref())?;
    let mut scan = Scan::new(); let mut page = Page::new(cursor.offset, args.limit, request.output_sink.clone());
    let mut file_count = 0; let mut match_count = 0;
    let content = matches!(args.output_mode.as_str(), "" | "content");
    // Cursors must revalidate a complete snapshot; summaries always need every match.
    let early = !args.exact_total && args.continuation.is_none() && args.output_mode != "summary";
    let wanted = cursor.offset.saturating_add(args.limit);
    scan.walk(&root, &args.glob, request, |file, _, scan| {
        let Some(bytes) = scan.read(file) else { return Ok(()); };
        let text = match String::from_utf8(bytes) { Ok(text) => text, Err(_) => { scan.skip("invalid-encoding", true, true); return Ok(()); } };
        if text.is_empty() { return Ok(()); }
        let mut hits = 0;
        let mut hit = |first: usize, last: usize, line: usize| -> Result<bool> {
            let ordinal = match_count + hits; hits += 1;
            if content && page.wants(ordinal) {
                page.push(json!({"path":file,"line":if args.line_numbers {line} else {0},
                    "text":excerpt(&text, first, last, args.before_context, args.after_context)}), ordinal)?;
            }
            Ok(early && content && ordinal.saturating_add(1) >= wanted)
        };
        if args.multiline {
            let mut previous = 0; let mut line = 1;
            for found in regex.find_iter(&text) {
                if !scan.running() { break; }
                if found.start() >= text.len() && text.ends_with('\n') { continue; }
                line += text[previous..found.start()].bytes().filter(|byte| *byte == b'\n').count(); previous = found.start();
                if hit(found.start(), found.end().saturating_sub(1).max(found.start()), line)? {
                    if content { scan.stopped = Some(TruncatedBy::RowLimit); }
                    break;
                }
            }
        } else {
            let mut start = 0;
            for (index, raw) in text.split_inclusive('\n').enumerate() {
                if !scan.running() { break; }
                let line = raw.strip_suffix('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).unwrap_or(raw);
                if regex.is_match(line) && hit(start, start + line.len().saturating_sub(1), index + 1)? {
                    if content { scan.stopped = Some(TruncatedBy::RowLimit); }
                    break;
                }
                start += raw.len();
            }
        }
        if hits > 0 {
            let ordinal = file_count; file_count += 1; match_count += hits;
            if !content && args.output_mode != "summary" {
                page.push(if args.output_mode == "count" { json!({"path":file,"count":hits}) } else { json!({"path":file}) }, ordinal)?;
            }
            if early && !content && file_count >= wanted { scan.stopped = Some(TruncatedBy::RowLimit); }
        }
        Ok(())
    })?;
    let total = if args.output_mode == "summary" { 0 } else if content { match_count } else { file_count };
    let extra = if args.output_mode == "summary" { json!({"files":file_count,"matches":match_count}) } else { json!({}) };
    finish(scan, cursor, page, match_count, total, extra)
}
