//! Multiple read-only file observations in one process, with one aggregate byte cap.
use super::*;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadManyArgs {
    files: Vec<ReadRange>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadRange {
    path: String,
    #[serde(default = "one")]
    offset: usize,
    #[serde(default = "two_hundred")]
    limit: usize,
}
const NEXT_ACTION: &str = "Resume remaining files from nextIndex. Follow each file's nextOffset for more lines; for truncatedInLine use that file's hex inspection guidance.";

pub(super) fn read_files(request: &Request) -> Result<Value> {
    let args: ReadManyArgs = serde_json::from_value(request.args.clone())?;
    if args.files.is_empty() || args.files.len() > 32 {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "read_files accepts 1-32 files",
        ));
    }
    if args
        .files
        .iter()
        .any(|file| file.offset == 0 || file.limit == 0 || file.limit > 10_000)
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "read_files offset starts at 1 and limit is 1-10000",
        ));
    }
    let total = args.files.len();
    // Keep the longest possible aggregate fields reserved before reading any file.
    let mut value = json!({"status":"completed","phase":"verify","changed":0,"matched":total,"failed":total,"complete":false,"truncated":false,"effectState":"none","items":[],"total":total,"nextIndex":total,"pending":total,"nextAction":NEXT_ACTION});
    let mut room = MAX_OUTPUT_BYTES.saturating_sub(output::size(&value) + 1);
    let mut items = Vec::new();
    let mut failed = 0;
    let mut complete = true;
    let mut truncated = false;
    let sink = request.output_sink.as_deref();
    let (mut observed_count, mut source_failed, mut source_complete) = (0, 0, true);
    let mut inline_closed = false;
    'ranges: for group in args.files.chunks(prefetch::WIDTH) {
        if sink.is_some_and(|sink| sink.exhausted()) || (room < 1024 && sink.is_none()) {
            break;
        }
        let authorized = group
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    request.authorize_path(Path::new(&file.path)),
                )
            })
            .collect();
        let prepared = prefetch::load(authorized, &load_inspection);
        for (file, prepared) in group.iter().zip(prepared) {
            // Once inline output fills, only a bounded capture may observe further files.
            if sink.is_some_and(|sink| sink.exhausted()) {
                break 'ranges;
            }
            if room < 1024 {
                if sink.is_none() {
                    break 'ranges;
                }
                inline_closed = true;
            }
            let observed = prepared.and_then(|prepared| {
                inspect_prepared(
                    InspectArgs {
                        path: file.path.clone(),
                        offset: file.offset,
                        limit: file.limit,
                        encoding: utf8(),
                        view: text(),
                    },
                    prepared,
                    room.saturating_sub(1),
                    true,
                    sink.map(|sink| (sink, true)),
                )
            });
            let item = match observed {
                Ok(item) => item,
                Err(error) => {
                    let item = json!({"path":file.path,"status":"error","complete":false,"items":[],"error":error});
                    if let Some(sink) = sink {
                        sink.push(&item);
                        sink.source(item.clone());
                    }
                    item
                }
            };
            observed_count += 1;
            let facts = sink.map_or_else(|| item.clone(), |sink| sink.last_source());
            source_failed += usize::from(facts.get("error").is_some());
            source_complete &= facts["complete"] == true;
            let size = output::size(&item) + 1;
            if inline_closed || size > room {
                if let Some(sink) = sink {
                    sink.clipped();
                    inline_closed = true;
                    continue;
                }
                break 'ranges;
            }
            room -= size;
            if item.get("error").is_some() {
                failed += 1;
            }
            complete &= item["complete"] == true;
            truncated |= item["truncated"] == true;
            items.push(item);
        }
    }
    if let Some(sink) = sink {
        let full = source_complete && observed_count == total;
        let mut source = value.clone();
        source["status"] = json!(if full { "completed" } else { "partial" });
        source["complete"] = json!(full);
        source["truncated"] = json!(!full);
        source["matched"] = json!(observed_count - source_failed);
        source["failed"] = json!(source_failed);
        source["nextIndex"] = json!(observed_count);
        source["pending"] = json!(total - observed_count);
        if full {
            source.as_object_mut().unwrap().remove("nextAction");
        }
        sink.source(source);
    }
    let returned = items.len();
    complete &= returned == total;
    value["status"] = json!(if complete { "completed" } else { "partial" });
    value["complete"] = json!(complete);
    value["truncated"] = json!(truncated || returned < total);
    value["matched"] = json!(returned - failed);
    value["failed"] = json!(failed);
    value["nextIndex"] = json!(returned);
    value["pending"] = json!(total - returned);
    value["items"] = json!(items);
    if complete {
        value
            .as_object_mut()
            .expect("result object")
            .remove("nextAction");
    }
    Ok(value)
}
