//! Public-host compatibility probe only; no production tool routing or request cancellation.
#![forbid(unsafe_code)]
use dsh_ops_core::{
    contract::{Failure, envelope},
    dispatch,
};
use ops_process::{ControlPipe, MAX_FRAME_BYTES, read_frame};
use serde_json::{Value, json};
use std::{
    io::{self, BufReader, Write},
    sync::mpsc,
};

fn fail(message: &str) -> Value {
    json!({"status":"error","error":Failure::new("INVALID_ARGUMENT", message)})
}
fn execute(frame: &[u8]) -> io::Result<Vec<u8>> {
    let mut decoded = envelope::decode(frame).map_err(|error| io::Error::other(error.message))?;
    let id = decoded
        .request_id
        .ok_or_else(|| io::Error::other("probe requires a v1 envelope"))?;
    let request = &decoded.request;
    let result = if !request.read_only
        || request.storage.is_some()
        || request.cache_dir.is_some()
        || request.tool != "inspect_local_file"
        || request.args.get("view").is_some_and(|v| v != "text")
    {
        fail("probe permits only read_only text inspect_local_file without storage/cache")
    } else {
        decoded.request.output_budget = decoded.budget.max_bytes;
        dispatch(decoded.request).unwrap_or_else(|error| json!({"status":"error","error":error}))
    };
    let encoded = envelope::encode_result(&result, decoded.budget, false)
        .map_err(|error| io::Error::other(error.message))?;
    let result: Value = serde_json::from_slice(&encoded)?;
    let mut output =
        serde_json::to_vec(&json!({"type":"completed","requestId":id,"result":result}))?;
    if output.len() + 1 > decoded.budget.max_bytes.min(MAX_FRAME_BYTES) {
        output = serde_json::to_vec(&json!({"type":"completed","requestId":id,"result":{
            "status":"error","error":Failure::new("OUTPUT_LIMIT", "framed probe result exceeds maxBytes")
        }}))?;
    }
    output.push(b'\n');
    Ok(output)
}
fn main() -> io::Result<()> {
    let mut writer = ControlPipe::inherited()?;
    let reader = writer.try_clone()?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        loop {
            match read_frame(&mut reader) {
                Ok(Some(frame)) if serde_json::from_slice::<Value>(&frame).is_ok() => {
                    if sender.try_send(frame).is_err() {
                        std::process::exit(2);
                    }
                }
                // Connection shutdown owns this entire read-only probe. This is
                // not per-request cancellation, and never runs for mere idleness.
                Ok(None) => std::process::exit(0),
                _ => std::process::exit(2),
            }
        }
    });
    writeln!(
        writer,
        "{}",
        json!({"type":"hello","pid":std::process::id(),"requestCancellation":"unsupported","requestDeadline":"unsupported"})
    )?;
    println!("resident probe stdout is separate");
    for frame in receiver {
        writer.write_all(&execute(&frame)?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mutations_are_rejected_and_receipts_are_correlated() {
        let frame = serde_json::to_vec(
            &json!({"version":1,"requestId":"probe-1","component":"file",
            "budget":{"timeoutMs":1000,"maxBytes":1024},"request":{
                "root":"/","scope":"probe","tool":"write_file","read_only":true,"args":{}
            }}),
        )
        .unwrap();
        let output: Value = serde_json::from_slice(&execute(&frame).unwrap()).unwrap();
        assert_eq!(output["requestId"], "probe-1");
        assert_eq!(output["result"]["error"]["code"], "INVALID_ARGUMENT");
    }
}
