#![forbid(unsafe_code)]
pub use ops_protocol as contract;
use cap_std::{ambient_authority, fs::Dir};
use contract::*;
use serde_json::Value;

pub fn dispatch(request: Request) -> Result<Value> {
    if request.scope.is_empty()
        || request.scope.len() > 256
        || !std::path::Path::new(&request.root).is_absolute()
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "An absolute workspace root and a bounded scope identity are required",
        ));
    }
    let root = std::fs::canonicalize(&request.root)?;
    let mut request = Request {
        root: root
            .to_str()
            .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 root"))?
            .into(),
        ..request
    };
    let dir = Dir::open_ambient_dir(&root, ambient_authority())?;
    use cap_fs_ext::MetadataExt;
    let metadata = dir.dir_metadata()?;
    request.root_identity = format!("{}:{}", metadata.dev(), metadata.ino());
    if request.tool != "result" && request.storage.is_some() && !request.read_only {
        request.output_sink = Some(std::rc::Rc::new(contract::capture::OutputSink::default()));
    }
    let value = execute(&dir, &request)?;
    Ok(ops_results::spill::finish(&request, value))
}
fn execute(dir: &Dir, request: &Request) -> Result<Value> {
    if matches!(request.tool.as_str(), "read_table" | "read_docx" | "read_pdf") { return ops_documents::dispatch(request); }
    // File reads/searches do not create or consult the durable audit store.
    // This is important for read-only sessions and keeps observation separate
    // from mutation audit records.
    if matches!(request.tool.as_str(), "inspect_local_file" | "glob" | "grep" | "replace" | "write_file" | "edit_file" | "diff" | "stat" | "copy" | "move" | "remove") {
        return if matches!(request.tool.as_str(), "glob" | "grep" | "replace") {
            ops_search::dispatch(&request)
        } else {
            ops_files::dispatch(&request)
        };
    }
    if request.tool == "result" && ((request.storage.is_some() && request.args.get("action").and_then(Value::as_str) == Some("put"))
        || request.args.get("action").and_then(Value::as_str) == Some("purge")
        || request.args.get("id").and_then(Value::as_str).is_some_and(|id| id.starts_with("ref://"))) {
        return ops_results::references::run(&request);
    }
    if request.read_only
        && !(request.tool == "result"
            && request.args.get("action").and_then(Value::as_str) == Some("page"))
    {
        return Err(Failure::policy(
            "read-only",
            "Read-only requests cannot mutate audit or result storage",
        ));
    }
    let store = ops_results::store::Store::open(&dir, request.read_only)?;
    match request.tool.as_str() {
        "batch" => ops_batch::run(&dir, &store, &request),
        "result" => ops_results::run(&store, &request),
        _ => Err(Failure::new("INVALID_ARGUMENT", "Unknown capability")),
    }
}
