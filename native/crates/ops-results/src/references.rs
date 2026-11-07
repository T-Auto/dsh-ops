//! Session reference wire protocol. Handles identify snapshots and grant no authority.
use crate::{cache::Cache, contract::*};
use ops_protocol::storage::StorageReference;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Record {
    #[serde(skip)]
    stored_bytes: usize,
    version: u32,
    scope: String,
    root: String,
    root_identity: String,
    authority_id: String,
    producer_tool: String,
    created_at: u64,
    ttl_ms: u64,
    items: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<Value>,
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn segment(text: &str) -> String {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
fn parse(request: &Request, reference: &str) -> Result<(String, String)> {
    let parts: Vec<_> = reference
        .strip_prefix("ref://")
        .unwrap_or("")
        .split('/')
        .collect();
    if parts.len() != 3
        || !ops_protocol::storage::valid_tool(parts[1])
        || uuid::Uuid::parse_str(parts[2]).is_err()
        || parts[2] != uuid::Uuid::parse_str(parts[2]).unwrap().to_string()
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "Expected ref://session/tool/uuid",
        ));
    }
    if parts[0] != segment(&request.scope) {
        return Err(Failure::new(
            "POLICY_DENIED",
            "Reference belongs to another session",
        ));
    }
    let context = request
        .storage
        .as_ref()
        .ok_or_else(|| Failure::new("POLICY_DENIED", "Trusted storage context is required"))?;
    context.authorize(parts[1])?;
    Ok((parts[1].into(), parts[2].into()))
}
fn nested_reference(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            object
                .get("refId")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("ref://"))
                || object.values().any(nested_reference)
        }
        Value::Array(items) => items.iter().any(nested_reference),
        _ => false,
    }
}
impl Record {
    fn authorize(&self, request: &Request, producer: &str, allow_expired: bool) -> Result<()> {
        let context = request
            .storage
            .as_ref()
            .ok_or_else(|| Failure::new("POLICY_DENIED", "Trusted storage context is required"))?;
        if self.version != 1
            || self.scope != request.scope
            || self.root != request.root
            || self.root_identity != request.root_identity
            || self.authority_id != context.authority_id
            || self.producer_tool != producer
        {
            return Err(Failure::new(
                "POLICY_DENIED",
                "Reference session, root, producer, or current authority differs",
            ));
        }
        context.authorize(producer)?;
        if !allow_expired
            && self.ttl_ms != 0
            && now_ms() >= self.created_at.saturating_add(self.ttl_ms)
        {
            return Err(Failure::new(
                "REFERENCE_EXPIRED",
                "Result observation expired",
            ));
        }
        Ok(())
    }
    fn reference(&self, id: &str) -> Result<StorageReference> {
        // The public handle is not embedded in the blob, so physical byte accounting has no cycle.
        let text = self
            .items
            .iter()
            .take(10)
            .map(serde_json::to_string)
            .collect::<std::result::Result<Vec<_>, _>>()?
            .join("\n");
        let preview: String = text.chars().take(512).collect();
        Ok(StorageReference {
            ref_id: format!(
                "ref://{}/{}/{}",
                segment(&self.scope),
                self.producer_tool,
                id
            ),
            created_at: self.created_at,
            ttl_ms: self.ttl_ms,
            schema_version: "1".into(),
            producer_tool: self.producer_tool.clone(),
            total_items: self.items.len(),
            total_bytes: if self.stored_bytes == 0 {
                serde_json::to_vec(self)?.len()
            } else {
                self.stored_bytes
            },
            preview,
        })
    }
}
fn existing_cache(request: &Request) -> Result<Cache> {
    Cache::existing(request).map_err(|error| {
        if error.code == "NOT_FOUND" {
            Failure::new(
                "REFERENCE_EXPIRED",
                "Reference cache is missing, expired, or destroyed",
            )
        } else {
            error
        }
    })
}
pub fn referenced_items(request: &Request, reference: &str) -> Result<Vec<Value>> {
    let (producer, id) = parse(request, reference)?;
    let cache = existing_cache(request)?;
    let (mut record, bytes): (Record, usize) = cache.read(&id)?;
    record.stored_bytes = bytes;
    record.authorize(request, &producer, false)?;
    cache.touch(&id)?;
    Ok(record.items)
}
pub fn run(request: &Request) -> Result<Value> {
    let args: ResultArgs = serde_json::from_value(request.args.clone())?;
    if args.action == "purge" {
        if request.read_only {
            return Err(Failure::policy(
                "read-only",
                "Read-only calls cannot purge references",
            ));
        }
        if args.id.is_some()
            || args.items.is_some()
            || args.ttl_ms.is_some()
            || args.offset != 0
            || args.limit.is_some()
            || args.max_bytes.is_some()
            || args.fields.is_some()
            || args.equals.is_some()
        {
            return Err(Failure::new(
                "INVALID_ARGUMENT",
                "purge accepts only action and trusted envelope storage metadata",
            ));
        }
        let counts = match Cache::existing(request) {
            Ok(cache) => cache.purge()?,
            Err(error) if error.code == "NOT_FOUND" => (0, 0),
            Err(error) => return Err(error),
        };
        return Ok(
            json!({"status":"completed","complete":true,"removed":counts.0,"retained":counts.1,"effectState":if counts.0 == 0 {"none"} else {"applied"}}),
        );
    }
    if args.action == "put" {
        if args.id.is_some() {
            return Err(Failure::new("INVALID_ARGUMENT", "put forbids id"));
        }
        let items = args
            .items
            .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "put requires items"))?;
        if items.len() > 10_000
            || items
                .iter()
                .any(|item| !item.is_object() || nested_reference(item))
        {
            return Err(Failure::new(
                "INVALID_ARGUMENT",
                "put accepts at most 10000 objects without nested reference handles",
            ));
        }
        let ttl_ms = args.ttl_ms.unwrap_or(0);
        if ttl_ms > 7 * 86400 * 1000 {
            return Err(Failure::new(
                "INVALID_ARGUMENT",
                "ttlMs is 0 (session lifetime) or at most seven days",
            ));
        }
        let context = request
            .storage
            .as_ref()
            .ok_or_else(|| Failure::new("POLICY_DENIED", "Trusted storage context is required"))?;
        context.authorize(&request.tool)?;
        if request.read_only {
            return Err(Failure::policy(
                "read-only",
                "Read-only calls cannot create references",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let record = Record {
            stored_bytes: 0,
            version: 1,
            scope: request.scope.clone(),
            root: request.root.clone(),
            root_identity: request.root_identity.clone(),
            authority_id: context.authority_id.clone(),
            producer_tool: request.tool.clone(),
            created_at: now_ms(),
            ttl_ms,
            items,
            source: None,
        };
        let reference = record.reference(&id)?;
        Cache::open(request)?.save(&id, &record)?;
        return Ok(
            json!({"status":"completed","id":reference.ref_id,"reference":reference,"total":record.items.len(),"complete":false,"omitted":record.items.len(),"nextAction":"Page this reference; it grants no authority. Reference pages never spill into another reference."}),
        );
    }
    if !matches!(args.action.as_str(), "page" | "release")
        || args.items.is_some()
        || args.ttl_ms.is_some()
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "Expected page/release without items or ttlMs",
        ));
    }
    let reference = args
        .id
        .as_deref()
        .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Reference id required"))?;
    let (producer, id) = parse(request, reference)?;
    if args.action == "release" && request.read_only {
        return Err(Failure::policy(
            "read-only",
            "Read-only calls cannot release references",
        ));
    }
    let cache = existing_cache(request)?;
    let (mut record, bytes): (Record, usize) = cache.read(&id)?;
    record.stored_bytes = bytes;
    record.authorize(request, &producer, args.action == "release")?;
    if args.action == "release" {
        cache.release(&id)?;
        return Ok(json!({"id":reference,"status":"released"}));
    }
    let value = page(&record, &args, &id)?;
    cache.touch(&id)?;
    Ok(value)
}
fn page(record: &Record, args: &ResultArgs, id: &str) -> Result<Value> {
    let limit = args.limit.unwrap_or(64);
    let budget = args.max_bytes.unwrap_or(16_384);
    if limit == 0
        || limit > 512
        || !(512..=65536).contains(&budget)
        || args
            .fields
            .as_ref()
            .is_some_and(|fields| fields.len() > 32 || fields.iter().any(|field| field.len() > 128))
        || args.equals.as_ref().is_some_and(|filter| filter.len() > 16)
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "Invalid result page bounds",
        ));
    }
    let reference = record.reference(id)?;
    let rows: Vec<_> = record
        .items
        .iter()
        .filter(|item| {
            args.equals.as_ref().is_none_or(|filter| {
                filter
                    .iter()
                    .all(|(key, value)| item.get(key) == Some(value))
            })
        })
        .collect();
    let total = rows.len();
    let start = args.offset.min(total);
    let mut value = json!({"id":reference.ref_id,"reference":reference,"items":[],"sourceTotal":record.items.len(),"contentHash":format!("sha256:{:x}", Sha256::digest(serde_json::to_vec(&record.items)?)),"total":total,"nextOffset":total,"complete":false,"omitted":total});
    if let Some(source) = &record.source {
        value["source"] = source.clone();
    }
    let header = serde_json::to_vec(&value)?.len() + 1;
    if header > budget {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            "Reference metadata exceeds page budget; increase maxBytes. A reference page never creates another reference.",
        ));
    }
    let mut room = budget - header;
    let mut items = Vec::new();
    for item in rows.into_iter().skip(start).take(limit) {
        let item = match &args.fields {
            Some(fields) => Value::Object(
                fields
                    .iter()
                    .filter_map(|key| item.get(key).map(|value| (key.clone(), value.clone())))
                    .collect(),
            ),
            None => item.clone(),
        };
        let size = serde_json::to_vec(&item)?.len() + 1;
        if size > room {
            if items.is_empty() {
                return Err(Failure::new(
                    "OUTPUT_LIMIT",
                    "One row exceeds page budget; project fewer fields or increase maxBytes. Reference pages never create new references.",
                ));
            }
            break;
        }
        room -= size;
        items.push(item);
    }
    let next = start + items.len();
    value["items"] = json!(items);
    value["nextOffset"] = json!(next);
    value["omitted"] = json!(total - next);
    value["complete"] = json!(next == total);
    Ok(value)
}

/// Store already bounded canonical capture. Only the trusted request supplies cache authority.
pub fn store_snapshot(
    request: &Request,
    items: Vec<Value>,
    source: Value,
) -> Result<StorageReference> {
    if request.read_only {
        return Err(Failure::policy(
            "read-only",
            "Read-only calls cannot create references",
        ));
    }
    let context = request
        .storage
        .as_ref()
        .ok_or_else(|| Failure::new("POLICY_DENIED", "Trusted storage context is required"))?;
    context.authorize(&request.tool)?;
    if items.iter().any(nested_reference) {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "Reference handles cannot be captured inside another reference",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let record = Record {
        stored_bytes: 0,
        version: 1,
        scope: request.scope.clone(),
        root: request.root.clone(),
        root_identity: request.root_identity.clone(),
        authority_id: context.authority_id.clone(),
        producer_tool: request.tool.clone(),
        created_at: now_ms(),
        ttl_ms: 0,
        items,
        source: Some(source),
    };
    let reference = record.reference(&id)?;
    Cache::open(request)?.save(&id, &record)?;
    Ok(reference)
}
