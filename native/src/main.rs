#![forbid(unsafe_code)]
use dsh_ops_core::{contract::{Failure, Request, envelope::{self, Budget}}, dispatch};
use serde_json::json;
use std::io::{Read, Write};

fn may_mutate(request: &Request) -> bool {
    !request.read_only && !matches!(request.tool.as_str(), "inspect_local_file" | "read_table" | "read_docx" | "read_pdf" | "glob" | "grep" | "diff" | "stat")
        && !(request.tool == "result" && request.args.get("action").and_then(serde_json::Value::as_str) == Some("page"))
}
fn main() {
    if std::env::args().any(|a| a == "--version") {
        println!("dsh-ops-worker {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let mut budget = Budget::default();
    let mut mutating = false;
    let value = (|| {
        let mut bytes = Vec::new();
        std::io::stdin().take((envelope::MAX_REQUEST_BYTES + 1) as u64)
            .read_to_end(&mut bytes).map_err(Failure::from)?;
        let mut decoded = envelope::decode(&bytes)?;
        budget = decoded.budget;
        decoded.request.output_budget = budget.max_bytes;
        mutating = may_mutate(&decoded.request);
        // The host also owns cancellation. This process-local deadline covers direct callers;
        // interruption exits nonzero so the bridge reports unknown effects, never completion.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(budget.timeout_ms));
            std::process::exit(124);
        });
        dispatch(decoded.request)
    })();
    let output = match value { Ok(value) => value, Err(error) => json!({"status":"error","error":error}) };
    let encoded = envelope::encode_result(&output, budget, mutating)
        .unwrap_or_else(|_| b"{\"status\":\"error\",\"error\":{\"code\":\"RESULT_UNKNOWN\",\"effectState\":\"unknown\"}}\n".to_vec());
    let _ = std::io::stdout().lock().write_all(&encoded);
}
