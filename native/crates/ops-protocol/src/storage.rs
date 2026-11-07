//! Reference metadata belongs to the trusted worker envelope, never tool arguments.
use crate::{Failure, Result};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageContext {
    pub root: String,
    #[serde(default)]
    pub windows_write_sid: Option<String>,
    pub authority_id: String,
    pub allowed_tools: Vec<String>,
}
impl StorageContext {
    pub fn validate(&self) -> Result<()> {
        if !std::path::Path::new(&self.root).is_absolute()
            || self.root.len() > 4096
            || self.root.contains('\0')
            || self.authority_id.len() != 64
            || !self
                .authority_id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || self
                .windows_write_sid
                .as_deref()
                .is_some_and(|sid| !valid_temp_sid(sid))
            || self.allowed_tools.len() > 64
            || self.allowed_tools.iter().any(|tool| !valid_tool(tool))
        {
            return Err(Failure::new(
                "INVALID_ARGUMENT",
                "Invalid trusted storage context",
            ));
        }
        Ok(())
    }
    pub fn authorize(&self, tool: &str) -> Result<()> {
        if !self.allowed_tools.iter().any(|allowed| allowed == tool) {
            return Err(Failure::new(
                "POLICY_DENIED",
                "Reference producer is outside the current capability set",
            ));
        }
        Ok(())
    }
}
/// Exact private-temp family emitted by the pinned Windows confinement provider.
pub fn valid_temp_sid(sid: &str) -> bool {
    let parts: Vec<_> = sid.split('-').collect();
    parts.len() == 6
        && parts[..3] == ["S", "1", "4"]
        && parts[5] == "1"
        && parts[3..5].iter().all(|part| {
            part.parse::<u32>()
                .is_ok_and(|value| value > 0 && value < 1 << 30 && value.to_string() == *part)
        })
}
pub fn valid_tool(tool: &str) -> bool {
    !tool.is_empty()
        && tool.len() <= 64
        && tool
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageReference {
    pub ref_id: String,
    pub created_at: u64,
    /// Zero means session lifetime; host lifecycle cleanup invalidates all session references.
    pub ttl_ms: u64,
    pub schema_version: String,
    pub producer_tool: String,
    pub total_items: usize,
    pub total_bytes: usize,
    pub preview: String,
}
