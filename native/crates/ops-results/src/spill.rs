//! Preserve operation facts independently of cache effects and bounded inline presentation.
use crate::{contract::*, references};
use ops_protocol::capture::{OutputSink, json_size};
use serde_json::{Value, json};
const RECOVERY: &str = "Page reference.refId with root=referenceRoot. Reconstruct tagged-json-v1 records in index/chunk order; page.complete describes stored records only. Check source.captureComplete and original coverage; narrow the query if capture is incomplete.";
fn clipped(value: &Value) -> bool {
    value.get("truncatedInLine") == Some(&json!(true))
        || value.get("truncatedBy") == Some(&json!("output-budget"))
        || value
            .get("items")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(clipped))
}
fn storage_error(error: &Failure) -> Value {
    json!({"code":error.code,"message":error.message.chars().take(256).collect::<String>(),"effectState":error.effect_state})
}
fn mark_head(request: &Request, value: &mut Value) {
    value["complete"] = json!(false);
    value["truncated"] = json!(true);
    if value.get("pageComplete").is_some() {
        value["pageComplete"] = json!(false);
        if value["scanComplete"] == true {
            value["truncatedBy"] = json!("output-budget");
        }
    }
    let skipped = if request.tool == "replace" {
        0
    } else {
        value["skipped"].as_u64().unwrap_or(0)
    };
    if let Some(total) = value["total"].as_u64() {
        value["omitted"] = json!(total.saturating_sub(skipped));
    }
    if value.get("nextOffset").is_some() {
        value["nextOffset"] = json!(if matches!(
            request.tool.as_str(),
            "read_table" | "read_docx" | "read_pdf"
        ) {
            skipped + 1
        } else if request.tool == "inspect_local_file" {
            if request.args["view"] == "hex" {
                skipped / 16 + 1
            } else {
                skipped + 1
            }
        } else {
            skipped
        });
    }
    if value.get("nextIndex").is_some() {
        value["nextIndex"] = json!(0);
        value["pending"] = value["total"].clone();
    }
    value.as_object_mut().unwrap().remove("continuation");
}
/// Reduce a useful first item only. Its suffix remains recoverable from the snapshot.
fn shrink(value: &mut Value) -> bool {
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        if text.is_empty() {
            return false;
        }
        let original = value
            .get("bytesTotal")
            .and_then(Value::as_u64)
            .unwrap_or(text.len() as u64);
        let mut end = text.len() / 2;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let prefix = text[..end].to_owned();
        value["text"] = json!(prefix);
        value["truncatedInLine"] = json!(true);
        value["bytesTotal"] = json!(original);
        value["bytesOmitted"] = json!(original - end as u64);
        return true;
    }
    if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
        if items.len() > 1 {
            items.pop();
        } else if !items.is_empty() && shrink(&mut items[0]) {
        } else {
            return false;
        }
        value["complete"] = json!(false);
        value["truncated"] = json!(true);
        let start = value["skipped"].as_u64().unwrap_or(0) + 1;
        if value.get("nextOffset").is_some() {
            value["nextOffset"] = json!(start);
        }
        return true;
    }
    false
}
fn fit(value: &mut Value, budget: usize) {
    let candidates = value
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .unwrap_or_default();
    let mut kept = Vec::new();
    for mut item in candidates {
        value["items"] = json!(&kept);
        let room = budget.saturating_sub(json_size(value) + 2);
        let mut partial = false;
        while kept.is_empty() && json_size(&item) > room && shrink(&mut item) {
            partial = true;
        }
        if json_size(&item) > room {
            break;
        }
        kept.push(item);
        if partial {
            break;
        }
    }
    value["items"] = json!(kept);
}
pub fn finish(request: &Request, mut value: Value) -> Value {
    // A reference page/handle never recursively becomes another reference. Legacy callers retain their transport.
    if request.tool == "result" || request.storage.is_none() || value.get("reference").is_some() {
        return value;
    }
    let local = OutputSink::default();
    let sink = request.output_sink.as_deref().unwrap_or(&local);
    let mut capture = sink.take();
    let fallback_clipped = capture.observed_items == 0 && clipped(&value);
    if capture.observed_items == 0 && !request.read_only {
        if let Some(items) = value.get("items").and_then(Value::as_array) {
            for item in items {
                sink.push(item);
            }
        }
        capture = sink.take();
    }
    let budget = if request.output_budget == 0 {
        ops_protocol::envelope::MAX_OUTPUT_BYTES
    } else {
        request.output_budget
    };
    let needs_spill = capture.clipped
        || capture.error.is_some()
        || clipped(&value)
        || json_size(&value) + 1 > budget
        || (request.tool == "read_files" && value["pending"].as_u64().unwrap_or(0) > 0);
    if !needs_spill {
        return value;
    }
    let mut source = value.clone();
    source.as_object_mut().unwrap().remove("items");
    // Only presentation fields are restored; post-execution mutation receipts remain authoritative.
    for key in [
        "complete",
        "truncated",
        "nextOffset",
        "nextIndex",
        "pending",
        "omitted",
        "total",
        "matched",
        "failed",
        "pageComplete",
        "truncatedBy",
        "continuation",
        "nextAction",
    ] {
        if let Some(field) = capture.source.get(key) {
            source[key] = field.clone();
        } else if matches!(key, "continuation" | "nextAction") && capture.source.is_object() {
            source.as_object_mut().unwrap().remove(key);
        }
    }
    if request.tool == "read_files" && capture.source.is_object() {
        source["status"] = capture.source["status"].clone();
        for key in ["status", "matched", "failed"] {
            value[key] = source[key].clone();
        }
    }
    source["root"] = json!(request.root);
    source["itemEncoding"] = json!("tagged-json-v1");
    source["capturedItems"] = json!(capture.logical_items);
    source["captureComplete"] =
        json!(capture.error.is_none() && !request.read_only && !fallback_clipped);
    mark_head(request, &mut value);
    value["nextAction"] = json!(RECOVERY);
    let mut error = capture.error;
    // Bound the initial handle before creating any persistent blob, including long root/session metadata.
    let mut probe = value.clone();
    probe["items"] = json!([]);
    probe["referenceRoot"] = json!(request.root);
    probe["reference"] = json!({"refId":format!("ref://{}/{}/00000000-0000-0000-0000-000000000000", request.scope.as_bytes().iter().map(|b| format!("%{b:02X}")).collect::<String>(), request.tool),"createdAt":u64::MAX,"ttlMs":0,"schemaVersion":"1","producerTool":request.tool,"totalItems":usize::MAX,"totalBytes":10485760,"preview":""});
    if let Some(error) = &error {
        probe["storageError"] = storage_error(error);
    }
    if request.read_only {
        error = Some(Failure::policy(
            "read-only",
            "Read-only observation cannot spill into reference storage",
        ));
    } else if json_size(&probe) + 1 > budget {
        error = Some(Failure::new(
            "OUTPUT_LIMIT",
            "Reference metadata exceeds maxBytes; narrow the query or increase the output budget",
        ));
    } else if !capture.records.is_empty() {
        match references::store_snapshot(request, capture.records, source) {
            Ok(mut reference) => {
                reference.preview.clear(); // The bounded head already supplies the preview.
                value["reference"] = json!(reference);
                value["referenceRoot"] = json!(request.root);
                if let Some(error) = &mut error {
                    error.effect_state = "applied".into();
                }
            }
            Err(failure) => error = Some(failure),
        }
    }
    if value.get("reference").is_none() && error.is_none() {
        error = Some(Failure::new(
            "OUTPUT_LIMIT",
            "No complete logical output item could be captured",
        ));
    }
    if let Some(error) = error {
        value["storageError"] = storage_error(&error);
    }
    if value.get("reference").is_none() {
        value["nextAction"] = json!(
            "Output is incomplete and has no stored continuation. Narrow the requested range or use bounded hex inspection for a long line; do not repeat mutations; inspect postconditions. storageError describes cache effects only."
        );
    }
    fit(&mut value, budget);
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fallback_capture_never_promotes_an_already_clipped_item_to_complete() {
        let root = std::env::temp_dir().join(format!("dsh-ops-spill-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        // macOS temporary paths can contain /var -> /private/var; cache authority requires canonical roots.
        let root = std::fs::canonicalize(root).unwrap();
        let mut request: Request = serde_json::from_value(
            json!({"root":root,"scope":"fallback-test","tool":"future_tool","args":{}}),
        )
        .unwrap();
        request.storage = Some(serde_json::from_value(json!({"root":root,"authorityId":"a".repeat(64),"allowedTools":["future_tool","result"]})).unwrap());
        let head = finish(
            &request,
            json!({"status":"completed","complete":false,"items":[{"text":"prefix","truncatedInLine":true}]}),
        );
        let id = head["reference"]["refId"]
            .as_str()
            .unwrap_or_else(|| panic!("bounded fallback reference: {head}"));
        request.tool = "result".into();
        request.args = json!({"action":"page","id":id});
        let page = references::run(&request).unwrap();
        assert_eq!(page["source"]["captureComplete"], false);
        assert_eq!(page["items"][0]["value"]["text"], "prefix");
        assert_eq!(page["source"]["complete"], false);
        std::fs::remove_dir_all(root).unwrap();
    }
}
