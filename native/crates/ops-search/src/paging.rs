//! Stateless cursors revalidate one bounded snapshot; they never grant authority.
use super::*;
use super::scan::Scan;
use cap_fs_ext::MetadataExt;
use ops_protocol::search::{SearchCoverage, SearchExecutionReport, TruncatedBy};

fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub struct Cursor { pub offset: usize, binding: String, snapshot: Option<String> }
impl Cursor {
    pub fn new(request: &Request, offset: usize, token: Option<&str>) -> Result<Self> {
        let mut query = request.args.clone();
        if let Some(fields) = query.as_object_mut() { fields.remove("offset"); fields.remove("continuation"); }
        let root = file_path::checked(&request.root)?;
        let identity = root.parent.symlink_metadata(&root.name)?;
        let binding = digest(&serde_json::to_vec(&json!([request.tool, query, request.scope, request.root,
            identity.dev(), identity.ino(), request.read_only, request.write_roots, request.deny_roots, request.deny_credential_names]))?);
        let mut cursor = Self { offset, binding, snapshot: None };
        if let Some(token) = token {
            let parts: Vec<_> = token.split(':').collect();
            let valid = token.len() <= 256 && parts.len() == 5 && parts[0] == "s1"
                && parts[1] == cursor.binding && parts[2].len() == 64
                && parts[2].bytes().all(|byte| byte.is_ascii_hexdigit())
                && digest(parts[..4].join(":").as_bytes()) == parts[4];
            if !valid { return Err(stale()); }
            let next = parts[3].parse::<usize>().map_err(|_| stale())?;
            if offset != 0 && offset != next { return Err(stale()); }
            cursor.offset = next; cursor.snapshot = Some(parts[2].into());
        }
        Ok(cursor)
    }
    fn token(&self, snapshot: &str, next: usize) -> String {
        let body = format!("s1:{}:{snapshot}:{next}", self.binding);
        format!("{body}:{}", digest(body.as_bytes()))
    }
}
fn stale() -> Failure {
    let mut error = Failure::new("SEARCH_STALE", "Search continuation does not match the current query, authority or filesystem observation");
    error.next_action = "Discard the continuation and start a fresh bounded query; the cursor grants no authority.".into();
    error
}
pub struct Page {
    pub items: Vec<Value>, pub offset: usize, limit: usize, bytes: usize,
    pub output_cut: bool, partial_item: bool, capture: Option<std::rc::Rc<ops_protocol::capture::OutputSink>>,
}
impl Page {
    pub fn new(offset: usize, limit: usize, capture: Option<std::rc::Rc<ops_protocol::capture::OutputSink>>) -> Self {
        Self { items: Vec::new(), offset, limit, bytes: 0, output_cut: false, partial_item: false, capture }
    }
    pub fn wants(&self, ordinal: usize) -> bool {
        (!self.output_cut || self.capture.as_ref().is_some_and(|sink| !sink.exhausted())) && ordinal >= self.offset && ordinal < self.offset.saturating_add(self.limit)
    }
    pub fn push(&mut self, mut item: Value, ordinal: usize) -> Result<()> {
        if !self.wants(ordinal) { return Ok(()); }
        if let Some(sink) = &self.capture { sink.push(&item); }
        if self.output_cut { return Ok(()); }
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(8192 + self.bytes);
        let size = ops_protocol::capture::json_size(&item) + 1;
        if size <= remaining { self.items.push(item); self.bytes += size; return Ok(()); }
        self.output_cut = true;
        if let Some(sink) = &self.capture { sink.clipped(); }
        // Preserve a useful first prefix without pretending the remaining line was delivered.
        if let Some(text) = item.get("text").and_then(Value::as_str).map(str::to_owned) {
            let length = text.len(); let mut end = length.min(remaining);
            while end > 0 {
                while !text.is_char_boundary(end) { end -= 1; }
                item["text"] = json!(&text[..end]); item["truncatedInLine"] = json!(true);
                item["bytesTotal"] = json!(length); item["bytesOmitted"] = json!(length - end);
                if ops_protocol::capture::json_size(&item) + 1 <= remaining {
                    self.items.push(item); self.partial_item = true; break;
                }
                end /= 2;
            }
        }
        Ok(())
    }
}
pub fn finish(mut scan: Scan, cursor: Cursor, page: Page, observed: usize, item_total: usize, extra: Value) -> Result<Value> {
    scan.running(); // Account for time spent in the final read/match/output step too.
    let snapshot = format!("{:x}", scan.hash.clone().finalize());
    let complete = scan.complete();
    if cursor.snapshot.as_ref().is_some_and(|expected| !complete || *expected != snapshot) { return Err(stale()); }
    let next = page.offset.saturating_add(page.items.len()).saturating_sub(usize::from(page.partial_item));
    let more = next < item_total;
    let continuation = (complete && more && !page.partial_item && next > page.offset).then(|| cursor.token(&snapshot, next));
    let truncated_by = scan.stopped.unwrap_or(if page.output_cut { TruncatedBy::OutputBudget }
        else if more { TruncatedBy::RowLimit } else { TruncatedBy::None });
    let report = SearchExecutionReport { coverage: if complete { SearchCoverage::Complete { matched_total: observed } } else { SearchCoverage::Incomplete },
        page_complete: !page.output_cut, scanned_files: scan.scanned, skipped_files: scan.skipped,
        skip_reasons: scan.reasons, matched_observed: observed, truncated_by, continuation };
    let mut output = json!({"status":"completed","phase":"verify","changed":0,"matched":observed,
        "skipped":page.offset,"failed":scan.failed,"complete":complete && !more && !page.output_cut,
        "truncated":!complete || more || page.output_cut,"items":page.items,"nextOffset":next});
    if complete { output["total"] = json!(item_total); output["omitted"] = json!(item_total.saturating_sub(next)); }
    if !complete { output["nextAction"] = json!(if scan.stopped == Some(TruncatedBy::RowLimit) {
        "Stopped at the requested row limit (exactTotal=false). matchedObserved is a lower bound; no stable continuation is available. Start a fresh query with exactTotal=true for totals, resolving any reported scan gaps. If a line is only partly displayed, inspect its file with bounded text/hex ranges."
    } else { "Narrow path/glob or resolve the reported scan gaps, then start a fresh query. No stable continuation is available for an incomplete traversal." }); }
    else if page.partial_item { output["nextAction"] = json!("A matching line is only partially displayed. Inspect that file with bounded text/hex ranges; nextOffset does not skip the undisplayed suffix."); }
    output.as_object_mut().unwrap().extend(serde_json::to_value(report)?.as_object().unwrap().clone());
    if let Some(extra) = extra.as_object() { output.as_object_mut().unwrap().extend(extra.clone()); }
    if let Some(sink) = page.capture {
        let mut source = output.clone(); source.as_object_mut().unwrap().remove("items");
        let source_next = page.offset.saturating_add(page.limit).min(item_total).max(page.offset);
        let more = source_next < item_total;
        source["nextOffset"] = json!(source_next); source["pageComplete"] = json!(true);
        source["complete"] = json!(complete && !more); source["truncated"] = json!(!complete || more);
        source["truncatedBy"] = serde_json::to_value(scan.stopped.unwrap_or(if more { TruncatedBy::RowLimit } else { TruncatedBy::None }))?;
        source.as_object_mut().unwrap().remove("continuation");
        if complete {
            source["omitted"] = json!(item_total.saturating_sub(source_next));
            source.as_object_mut().unwrap().remove("nextAction");
            if more && source_next > page.offset { source["continuation"] = json!(cursor.token(&snapshot, source_next)); }
        }
        sink.source(source);
    }
    Ok(output)
}
