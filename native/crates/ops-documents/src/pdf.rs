//! Read-only, stable-scope PDF page observations. Unsupported content never becomes complete text.
use crate::{
    pdf_container::{self, MAX_FILE},
    pdf_pages::{self, MAX_PAGES, Streams},
    pdf_text,
};
use ops_protocol::{Failure, Request, Result, capture::json_size};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path, time::Instant};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    path: String,
    #[serde(default = "super::one")]
    offset: usize,
    #[serde(default = "ten")]
    limit: usize,
}
fn page_complete(failure: Option<&Failure>, observed: usize, offset: usize, limit: usize) -> bool {
    !failure.is_some_and(|error| error.code == "FILE_CHANGED")
        && (failure.is_none() || observed >= offset + limit - 1)
}
fn ten() -> usize {
    10
}
/// Recovery for a failure raised before any output exists; the call site names the step.
fn fail(mut error: Failure, next_action: &'static str) -> Failure {
    error.next_action = next_action.into();
    error
}
pub fn read(request: &Request) -> Result<Value> {
    let args: Args = serde_json::from_value(request.args.clone())?;
    if args.offset == 0 || args.offset > MAX_PAGES || args.limit == 0 || args.limit > MAX_PAGES {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "read_pdf offset and limit are 1-32 pages (defaults 1 and 10)",
        ));
    }
    request.authorize_path(Path::new(&args.path))?;
    let target = ops_files::file_path::checked(&args.path)?;
    request.authorize_path(&target.display)?;
    let mut file = ops_files::file_path::read_file(&target)?.into_std();
    let before = file.metadata()?;
    let started = Instant::now();
    if before.len() > MAX_FILE as u64 {
        return Err(fail(
            Failure::new("OUTPUT_LIMIT", "PDF input exceeds 16 MiB"),
            "This PDF is larger than the 16 MiB input limit, which bounds the whole file: reducing the page limit or offset cannot make it readable. Use a dedicated PDF reader for this file; no page text was read.",
        ));
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_FILE as u64 + 1)
        .read_to_end(&mut bytes)?;
    let document = pdf_container::parse(&bytes)?;
    if bytes[7] < b'3' {
        return Err(Failure::new(
            "UNSUPPORTED_DOCUMENT",
            "PDF text extraction supports PDF 1.3-1.7 encoding semantics",
        ));
    }
    let pages = pdf_pages::pages(&document, started)?;
    let mut streams = Streams::new();
    let (mut observed, mut selected, mut inline_bytes) = (0usize, 0usize, 0usize);
    let (mut items, mut failure, mut cut) = (Vec::new(), None, false);
    for (index, page) in pages.iter().enumerate() {
        let result = streams
            .content(&document, page, started)
            .and_then(|content| pdf_text::extract(&document, page.resources, &content, started));
        let runs = match result {
            Ok(runs) => runs,
            Err(error) => {
                failure = Some(error);
                break;
            }
        };
        observed += 1;
        let number = index + 1;
        if number < args.offset || number >= args.offset + args.limit {
            continue;
        }
        selected += 1;
        let item = json!({"page":number,"text":runs.join("\n"),"runs":runs});
        if let Some(sink) = request.output_sink.as_deref() {
            sink.push(&item)
        }
        let cost = json_size(&item) + 1;
        if cut || inline_bytes + cost > 80 * 1024 {
            cut = true;
            if let Some(sink) = request.output_sink.as_deref() {
                sink.clipped()
            }
        } else {
            inline_bytes += cost;
            items.push(item)
        }
    }
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        failure = Some(Failure::new(
            "FILE_CHANGED",
            "PDF metadata changed while reading; page observations are not a stable snapshot",
        ));
    }
    let scan = failure.is_none();
    let next = args.offset + selected;
    let more = !scan || next <= observed;
    let cause = if let Some(error) = &failure {
        match error.code.as_str() {
            "DEADLINE_EXCEEDED" => "time",
            "FILE_CHANGED" => "changed",
            "OUTPUT_LIMIT" => "scan-budget",
            "UNSUPPORTED_DOCUMENT" => "unsupported-content",
            _ => "parse-error",
        }
    } else if more {
        "row-limit"
    } else {
        "none"
    };
    let mut output = json!({"status":if scan{"completed"}else{"partial"},"phase":"verify","changed":0,"effectState":"none","path":target.display,"format":"pdf",
        "scope":"page-text-layer-content-order","excludedContent":["rendered layout and reading order","images and OCR","annotations and form fields","attachments and document metadata","structure-tree alternate text"],
        "bytes":before.len(),"decodedBytes":streams.decoded,"processedBytes":streams.processed,"pagesObserved":observed,"skipped":(args.offset-1).min(observed),
        "scanComplete":scan,"pageComplete":page_complete(failure.as_ref(),observed,args.offset,args.limit),"complete":scan&&!more,"truncated":more,"truncatedBy":cause,"nextOffset":next,"items":[]});
    if scan {
        output["total"] = json!(observed);
        output["omitted"] = json!(observed.saturating_sub(next - 1));
        output["revision"] = json!(format!("{:x}", Sha256::digest(&bytes)))
    }
    if let Some(mut error) = failure {
        error.next_action="Use a dedicated PDF reader for unsupported content or physical scan limits; page offsets do not bypass those gaps. OCR and rendered reading order are not provided.".into();
        output["nextAction"] = json!(error.next_action);
        output["error"] = json!(error);
    }
    if let Some(sink) = request.output_sink.as_deref() {
        sink.source(output.clone())
    }
    if cut {
        output["complete"] = json!(false);
        output["pageComplete"] = json!(false);
        output["truncated"] = json!(true);
        output["nextOffset"] = json!(args.offset + items.len());
        if scan {
            output["truncatedBy"] = json!("output-budget");
            output["omitted"] = json!(observed.saturating_sub(args.offset - 1 + items.len()))
        }
        if output.get("nextAction").is_none() {
            output["nextAction"] = json!(
                "Read the stored reference when available; otherwise reduce the page limit or use a dedicated reader for a large page."
            )
        }
    }
    output["items"] = json!(items);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coverage_invalidates_changed_pages_but_retains_completed_prefix_before_later_gaps() {
        let changed = Failure::new("FILE_CHANGED", "changed");
        let unsupported = Failure::new("UNSUPPORTED_DOCUMENT", "later page");
        assert!(!page_complete(Some(&changed), 12, 1, 10));
        assert!(page_complete(Some(&unsupported), 10, 1, 10));
        assert!(!page_complete(Some(&unsupported), 9, 1, 10));
        assert!(page_complete(None, 2, 30, 1));
    }
    #[test]
    fn expired_pdf_deadline_is_an_explicit_failure() {
        let expired = Instant::now() - std::time::Duration::from_secs(30);
        assert_eq!(
            pdf_text::deadline(expired).unwrap_err().code,
            "DEADLINE_EXCEEDED"
        );
    }
}
