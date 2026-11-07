//! Serialized-byte accounting shared by inspection, search, and batched reads.
use super::*;
const HEX_RECOVERY: &str = "A line was cut by the output budget. Inspect this file with view=hex and page its 16-byte rows; nextOffset retains the incomplete line, so text paging alone cannot recover its suffix.";

fn encoded_cost(character: char) -> usize {
    match character {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}
fn prefix(text: &str, budget: usize) -> &str {
    let mut used = 0;
    for (index, character) in text.char_indices() {
        used += encoded_cost(character);
        if used > budget {
            return &text[..index];
        }
    }
    text
}
pub(super) fn size(value: &Value) -> usize {
    ops_protocol::capture::json_size(value)
}
/// `offset` counts skipped units; `next_base` is the caller's resumption base.
/// The envelope reserves its longest possible flags, counters, and recovery advice.
/// Each candidate includes its actual escaped path and truncation metadata before
/// text receives any room. No fixed estimate for a path/header can overflow this cap.
#[allow(clippy::too_many_arguments)]
pub(super) fn bounded(
    items: Vec<Value>,
    total: usize,
    offset: usize,
    next_base: usize,
    matched: usize,
    truncated: bool,
    facts: Value,
    budget: usize,
    capture: Option<(&ops_protocol::capture::OutputSink, bool)>,
) -> Value {
    let mut value = json!({"status":"completed","phase":"verify","changed":0,"matched":matched,"skipped":offset,"failed":0,"complete":false,"truncated":false,"omitted":total,"items":[],"total":total,"nextOffset":next_base.saturating_add(items.len()),"nextAction":HEX_RECOVERY});
    value
        .as_object_mut()
        .expect("result object")
        .extend(facts.as_object().expect("facts object").clone());
    let mut items = items;
    if let Some((sink, whole_file)) = capture {
        let mut source = value.clone();
        source["complete"] = json!(!truncated && offset.saturating_add(items.len()) >= total);
        source["truncated"] = json!(truncated);
        source["omitted"] = json!(total.saturating_sub(offset.saturating_add(items.len())));
        source.as_object_mut().unwrap().remove("nextAction");
        if whole_file {
            source["items"] = Value::Array(items);
            sink.push(&source);
            items = match source.as_object_mut().unwrap().remove("items").unwrap() {
                Value::Array(items) => items,
                _ => unreachable!(),
            };
        } else {
            for item in &items {
                sink.push(item);
            }
        }
        sink.source(source);
    }
    let mut room = budget.saturating_sub(size(&value) + 1); // trailing worker newline
    let mut kept = Vec::new();
    let mut stopped = false;
    let mut incomplete_line = false;
    for mut item in items {
        let cost = size(&item) + 1; // array comma (also reserved for the first item)
        if cost <= room {
            room -= cost;
            kept.push(item);
            continue;
        }
        if let Some(whole) = item.get("text").and_then(Value::as_str).map(str::to_owned) {
            item["text"] = json!("");
            item["bytesTotal"] = json!(whole.len());
            item["bytesOmitted"] = json!(whole.len());
            item["truncatedInLine"] = json!(true);
            let header = size(&item) + 1;
            let text = prefix(&whole, room.saturating_sub(header));
            if !text.is_empty() && header <= room {
                item["bytesOmitted"] = json!(whole.len() - text.len());
                item["text"] = json!(text);
                kept.push(item);
                incomplete_line = true;
            }
        }
        stopped = true;
        break;
    }
    let consumed = kept.len().saturating_sub(usize::from(incomplete_line));
    if stopped && let Some((sink, _)) = capture {
        sink.clipped();
    }
    let cut = truncated || stopped;
    value["complete"] = json!(!cut && offset.saturating_add(consumed) >= total);
    value["truncated"] = json!(cut);
    value["omitted"] = json!(total.saturating_sub(offset.saturating_add(consumed)));
    value["nextOffset"] = json!(next_base.saturating_add(consumed));
    value["items"] = json!(kept);
    if !incomplete_line {
        value
            .as_object_mut()
            .expect("result object")
            .remove("nextAction");
    }
    value
}
