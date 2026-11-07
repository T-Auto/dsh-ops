//! Versioned one-shot transport. Legacy input is an explicit v0 format, never a fallback.
use crate::{Failure, Request, Result};
use serde::Deserialize;
use serde_json::{Value, json};

pub const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 128 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 300_000;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Budget {
    pub timeout_ms: u64,
    pub max_bytes: usize,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_bytes: MAX_OUTPUT_BYTES,
        }
    }
}
impl Budget {
    fn validate(self) -> Result<Self> {
        if self.timeout_ms == 0
            || self.timeout_ms > 2_147_483_647
            || !(1024..=MAX_OUTPUT_BYTES).contains(&self.max_bytes)
        {
            return Err(Failure::new(
                "INVALID_ARGUMENT",
                "budget requires timeoutMs 1..2147483647 and maxBytes 1024..131072",
            ));
        }
        Ok(self)
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Component {
    File,
    Ptc,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Envelope {
    version: u32,
    request_id: String,
    component: Component,
    budget: Budget,
    request: Request,
    storage: Option<crate::storage::StorageContext>,
}

pub struct Decoded {
    pub request: Request,
    pub budget: Budget,
    pub request_id: Option<String>,
    pub component: Option<Component>,
}

pub fn decode(bytes: &[u8]) -> Result<Decoded> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(Failure::new("OUTPUT_LIMIT", "Request exceeds 2 MiB"));
    }
    let value: Value = serde_json::from_slice(bytes)?;
    // A malformed or unsupported envelope must not be retried as an unversioned request.
    if [
        "version",
        "requestId",
        "component",
        "budget",
        "request",
        "storage",
    ]
    .iter()
    .any(|key| value.get(key).is_some())
    {
        let mut envelope: Envelope = serde_json::from_slice(bytes)?;
        if envelope.version != 1 {
            return Err(Failure::new(
                "PROTOCOL_VERSION",
                "Supported worker request version is 1",
            ));
        }
        if envelope.request_id.is_empty()
            || envelope.request_id.len() > 128
            || !envelope
                .request_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(Failure::new(
                "INVALID_ARGUMENT",
                "requestId must contain 1..128 ASCII letters, digits, underscores or hyphens",
            ));
        }
        if let Some(storage) = &envelope.storage {
            storage.validate()?;
        }
        envelope.request.storage = envelope.storage;
        envelope.request.validate_cache_dir()?;
        Ok(Decoded {
            request: envelope.request,
            budget: envelope.budget.validate()?,
            request_id: Some(envelope.request_id),
            component: Some(envelope.component),
        })
    } else {
        let request: Request = serde_json::from_slice(bytes)?;
        request.validate_cache_dir()?;
        Ok(Decoded {
            request,
            budget: Budget::default(),
            request_id: None,
            component: None,
        })
    }
}

/// Size includes the terminating newline. Never misclassify lost mutation receipts as no effects.
pub fn encode_result(value: &Value, budget: Budget, may_mutate: bool) -> Result<Vec<u8>> {
    let budget = budget.validate()?;
    let mut bytes = serde_json::to_vec(value)?;
    if bytes.len() + 1 > budget.max_bytes {
        let effect = value
            .get("error")
            .and_then(|error| error.get("effectState"))
            .and_then(Value::as_str)
            .unwrap_or(if may_mutate { "unknown" } else { "none" });
        let mut failure = if effect == "none" {
            Failure::new(
                "OUTPUT_LIMIT",
                "Serialized result exceeds maxBytes; narrow the request or page the result",
            )
        } else {
            let mut failure = Failure::unknown(
                "Serialized result exceeds maxBytes; inspect postconditions or the job audit before retrying",
            );
            failure.code = "OUTPUT_LIMIT".into();
            failure.effect_state = effect.into();
            failure
        };
        failure.phase = "verify".into();
        bytes = serde_json::to_vec(&json!({"status":"error", "error":failure}))?;
    }
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests;
