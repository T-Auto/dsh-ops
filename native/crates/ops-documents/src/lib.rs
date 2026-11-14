//! Bounded table observations; cells stay strings, and incomplete traversals never invent totals.
#![forbid(unsafe_code)]
mod archive;
mod decode;
mod docx;
mod parse;
mod pdf;
pub mod pdf_container;
mod pdf_limits;
mod pdf_pages;
mod pdf_syntax;
mod pdf_text;
mod xml;
use decode::{Decoder, Encoding};
use ops_protocol::{Failure, Request, Result, capture::json_size};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::{File, Metadata},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
const MAX_ROWS: usize = 100_000;
const INLINE_BYTES: usize = 96 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Args {
    path: String,
    format: Option<String>,
    #[serde(default = "utf8")]
    encoding: String,
    #[serde(default = "yes")]
    header: bool,
    #[serde(default = "one")]
    offset: usize,
    #[serde(default = "two_hundred")]
    limit: usize,
}
fn utf8() -> String {
    "utf-8".into()
}
fn yes() -> bool {
    true
}
fn one() -> usize {
    1
}
fn two_hundred() -> usize {
    200
}
fn recovery(error: &mut Failure) {
    if error.code == "OUTPUT_LIMIT" {
        error.next_action = "Use a dedicated streaming table reader for this bounded scan/record limit; ordinary row paging does not bypass physical scan limits. Do not assume an unobserved suffix is empty.".into();
    } else if error.code == "TABLE_PARSE_ERROR" {
        error.next_action = "Inspect the reported record and correct quoting or column counts; preceding complete rows remain observations.".into();
    } else if error.code == "FILE_CHANGED" {
        error.next_action = "Acquire a new stable observation before relying on totals or revision; do not treat these rows as a complete snapshot.".into();
    } else if error.code == "DEADLINE_EXCEEDED" {
        error.next_action = "Use a dedicated streaming table reader for this scan deadline; the unobserved suffix is unknown.".into();
    }
}
struct Source {
    path: PathBuf,
    file: File,
    before: Metadata,
    started: Instant,
}
pub fn dispatch(request: &Request) -> Result<Value> {
    if request.tool == "read_pdf" {
        return pdf::read(request);
    }
    if request.tool == "read_docx" {
        return docx::read(request);
    }
    if request.tool != "read_table" {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "Unknown document capability",
        ));
    }
    let args: Args = serde_json::from_value(request.args.clone())?;
    if args.offset == 0 || args.offset > MAX_ROWS || args.limit == 0 || args.limit > 1000 {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "read_table offset is 1-100000 data rows and limit is 1-1000",
        ));
    }
    let encoding = Encoding::parse(&args.encoding)?;
    let format = args.format.as_deref().unwrap_or(
        if Path::new(&args.path)
            .extension()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("tsv"))
        {
            "tsv"
        } else {
            "csv"
        },
    );
    let delimiter = match format {
        "csv" => ',',
        "tsv" => '\t',
        _ => {
            return Err(Failure::new(
                "INVALID_ARGUMENT",
                "format must be csv or tsv",
            ));
        }
    };
    request.authorize_path(Path::new(&args.path))?;
    let target = ops_files::file_path::checked(&args.path)?;
    request.authorize_path(&target.display)?;
    let file = ops_files::file_path::read_file(&target)?.into_std();
    let before = file.metadata()?;
    observe(
        request,
        &args,
        format,
        encoding,
        delimiter,
        Source {
            path: target.display,
            file,
            before,
            started: Instant::now(),
        },
    )
}
fn observe(
    request: &Request,
    args: &Args,
    format: &str,
    encoding: Encoding,
    delimiter: char,
    source: Source,
) -> Result<Value> {
    let Source {
        path,
        file,
        before,
        started,
    } = source;
    let observer = file.try_clone()?;
    let mut input = Decoder::new(file, encoding)?;
    let sink = request.output_sink.as_deref();
    let (mut columns, mut items) = (Vec::<String>::new(), Vec::<Value>::new());
    let (mut rows, mut width, mut inline_bytes, mut selected) = (0usize, None, 0usize, 0usize);
    let (mut scan_complete, mut output_cut, mut first) = (false, false, true);
    let mut failure = None;
    loop {
        if started.elapsed() >= Duration::from_secs(30) {
            failure = Some(Failure::new(
                "DEADLINE_EXCEEDED",
                "Table scan reached its 30-second deadline",
            ));
            break;
        }
        // One bounded lookahead proves EOF for a file with exactly MAX_ROWS data rows.
        let record = match parse::next(&mut input, delimiter) {
            Ok(Some(record)) => record,
            Ok(None) => {
                scan_complete = true;
                break;
            }
            Err(error) => {
                failure = Some(error);
                break;
            }
        };
        if first && args.header {
            first = false;
            if json_size(&json!(record.cells)) > 8192 {
                failure = Some(Failure::new(
                    "OUTPUT_LIMIT",
                    "Table header exceeds the 8192-byte metadata limit",
                ));
                break;
            }
            width = Some(record.cells.len());
            columns = record.cells;
            continue;
        }
        first = false;
        if rows >= MAX_ROWS {
            failure = Some(Failure::new(
                "OUTPUT_LIMIT",
                "Table scan reached 100000 data records",
            ));
            break;
        }
        let expected = *width.get_or_insert(record.cells.len());
        if record.cells.len() != expected {
            failure = Some(Failure::new(
                "TABLE_PARSE_ERROR",
                format!(
                    "Data row {} has {} cells; expected {expected} at physical line {}",
                    rows + 1,
                    record.cells.len(),
                    record.first
                ),
            ));
            break;
        }
        rows += 1;
        if rows < args.offset || rows >= args.offset.saturating_add(args.limit) {
            continue;
        }
        let item =
            json!({"row":rows,"cells":record.cells,"lineStart":record.first,"lineEnd":record.last});
        selected += 1;
        if let Some(sink) = sink {
            sink.push(&item);
        }
        let cost = json_size(&item) + 1;
        if output_cut || inline_bytes + cost > INLINE_BYTES - 16384 {
            output_cut = true;
            if let Some(sink) = sink {
                sink.clipped();
            }
        } else {
            inline_bytes += cost;
            items.push(item);
        }
    }
    let after = observer.metadata()?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        scan_complete = false;
        failure = Some(Failure::new(
            "FILE_CHANGED",
            "Table metadata changed while reading; rows are observations, not a stable complete file",
        ));
    }
    if let Some(error) = &mut failure {
        recovery(error);
    }
    let next = args.offset.saturating_add(selected);
    let page_observed = failure
        .as_ref()
        .is_none_or(|error| error.code != "FILE_CHANGED")
        && (scan_complete || rows >= args.offset.saturating_add(args.limit).saturating_sub(1));
    let more = !scan_complete || next <= rows;
    let cause = if let Some(error) = &failure {
        match error.code.as_str() {
            "ERR_INVALID_ENCODING" => "encoding",
            "TABLE_PARSE_ERROR" => "parse-error",
            "DEADLINE_EXCEEDED" => "time",
            "FILE_CHANGED" => "changed",
            _ => "scan-budget",
        }
    } else if more {
        "row-limit"
    } else {
        "none"
    };
    let mut output = json!({"status":if failure.is_some() {"partial"} else {"completed"},"phase":"verify","changed":0,"effectState":"none",
        "path":path,"format":format,"encoding":encoding.name(),"header":args.header,"columns":columns,"columnCount":width.unwrap_or(0),
        "bytes":before.len(),"bytesRead":input.bytes_read(),"rowsObserved":rows,"skipped":(args.offset-1).min(rows),
        "scanComplete":scan_complete,"pageComplete":page_observed,"complete":scan_complete && !more,"truncated":more,
        "truncatedBy":cause,"nextOffset":next,"items":[]});
    if scan_complete {
        output["rowCount"] = json!(rows);
        output["total"] = json!(rows);
        output["omitted"] = json!(rows.saturating_sub(next.saturating_sub(1)));
        output["revision"] = json!(input.revision());
    }
    if let Some(error) = failure {
        output["nextAction"] = json!(error.next_action);
        output["error"] = json!(error);
    }
    if let Some(sink) = sink {
        sink.source(output.clone());
    }
    if output_cut {
        output["pageComplete"] = json!(false);
        output["complete"] = json!(false);
        output["truncated"] = json!(true);
        output["nextOffset"] = json!(args.offset + items.len());
        if scan_complete {
            output["truncatedBy"] = json!("output-budget");
            output["omitted"] = json!(rows.saturating_sub(args.offset - 1 + items.len()));
        }
        if output.get("nextAction").is_none() {
            output["nextAction"] = json!(
                "Use the stored reference when available; otherwise reduce the row limit or use bounded text/hex inspection for a very large record."
            );
        }
    }
    output["items"] = json!(items);
    Ok(output)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
