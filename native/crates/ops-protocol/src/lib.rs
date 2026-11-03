#![forbid(unsafe_code)]
pub mod capture;
pub mod envelope;
pub mod search;
pub mod storage;
pub mod windows_paths;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub op: Kind,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Copy,
    Move,
    Remove,
}
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Pending,
    Unknown,
    Completed,
    Failed,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Item {
    pub operation: Operation,
    pub revision: String,
    pub logical_bytes: u64,
    pub entries: u64,
    pub state: State,
    pub error: Option<Failure>,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Job {
    pub version: u32,
    pub id: String,
    pub root: String,
    pub root_identity: String,
    pub scope: String,
    pub created: u64,
    pub protect: Vec<String>,
    pub items: Vec<Item>,
}
/// A failed request.
///
/// `effect_state` answers the question a caller must not get wrong: did anything
/// happen? `none` — nothing was written. `applied` — the change is published even
/// though the call failed, so repeating it is wrong. `unknown` — the failure was
/// caught mid-flight and the caller has to go and look.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<Box<str>>,
    pub phase: Box<str>,
    pub retryable: bool,
    pub effect_state: Box<str>,
    pub next_action: Box<str>,
    pub message: String,
}
impl Failure {
    pub fn new(code: &str, message: impl ToString) -> Self {
        Self {
            code: code.into(),
            reason: None,
            phase: "preflight".into(),
            retryable: false,
            effect_state: "none".into(),
            next_action: match code {
                "ERR_INVALID_ENCODING" => "Use a dedicated document/binary reader, or inspect with view=hex; do not replace invalid bytes with lossy text.",
                "METADATA_UNSUPPORTED" => "Use a filesystem/platform or dedicated tool that preserves the source metadata. Changing the permission selector or blindly retrying cannot repair this limitation.",
                "LOCK_UNSUPPORTED" => "Use a local drive or the shell for this filesystem; retrying cannot add lock support.",
                "PATH_CHANGED" => "Restart the query; the directory changed during enumeration. No complete result is available.",
                "REFERENCE_EXPIRED" => "Release the expired result and acquire a new observation; references never grant authority.",
                "REVISION_CONFLICT" => "Inspect the current revision before preparing a new request; do not blindly retry.",
                "CREDENTIAL_DENIED" => "Choose a non-credential path; do not bypass the credential fence or change the permission selector to remove it.",
                "PATH_RESTRICTED" => "Inspect the real path and linked/special components; do not bypass no-follow protection.",
                _ => "Correct the request or inspect the manifest.",
            }.into(),
            message: message.to_string(),
        }
    }
    /// Only actual authorization-mode/root denials may carry selector advice.
    pub fn policy(reason: &str, message: impl ToString) -> Self {
        let mut failure = Self::new("POLICY_DENIED", message);
        failure.reason = Some(reason.into());
        failure
    }
    pub fn unknown(message: impl ToString) -> Self {
        let mut e = Self::new("RESULT_UNKNOWN", message);
        e.phase = "execute".into();
        e.effect_state = "unknown".into();
        e.next_action = "Inspect postconditions; never blindly retry this item.".into();
        e
    }
}
impl From<std::io::Error> for Failure {
    fn from(e: std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => "NOT_FOUND",
            std::io::ErrorKind::PermissionDenied => "ACCESS_DENIED",
            std::io::ErrorKind::AlreadyExists => "REVISION_CONFLICT",
            _ => "IO_ERROR",
        };
        Self::new(code, e)
    }
}
impl From<serde_json::Error> for Failure {
    fn from(e: serde_json::Error) -> Self {
        Self::new("INVALID_ARGUMENT", e)
    }
}
impl Request {
    /// The workspace root as a path, for rendering a relative display path.
    pub fn root_path(&self) -> std::path::PathBuf {
        std::path::PathBuf::from(&self.root)
    }
    /// Apply the host's credential policy to each actual traversal target.
    pub fn denies_path(&self, path: &std::path::Path) -> bool {
        let normalize = |value: &std::path::Path| {
            let text = value.to_string_lossy().replace('\\', "/");
            let text = text.strip_prefix("//?/").unwrap_or(&text).to_owned();
            if cfg!(windows) || self.windows_paths { text.to_lowercase() } else { text }
        };
        let target = normalize(path);
        if self.deny_roots.iter().any(|root| {
            let root = normalize(std::path::Path::new(root));
            target == root || target.starts_with(&format!("{}/", root.trim_end_matches('/')))
        }) { return true; }
        if !self.deny_credential_names { return false; }
        static NAMES: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        NAMES.get_or_init(|| regex::Regex::new(r"(?i)(^|/)(id_(rsa|dsa|ecdsa|ed25519)(\.|$)|[^/]*credentials[^/]*\.(json|ya?ml|ini)$|service-account[^/]*\.json$|\.env(\.|$))").expect("fixed credential expression")).is_match(&target)
    }
    pub fn authorize_path(&self, path: &std::path::Path) -> Result<()> {
        if self.denies_path(path) { return Err(Failure::new("CREDENTIAL_DENIED", "Credential location refused by the operator's file policy")); }
        if self.windows_paths {
            for component in path.components() {
                if let std::path::Component::Normal(name) = component {
                    windows_paths::validate_name(name.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?)?;
                }
            }
        }
        Ok(())
    }
    /// The denied roots as paths, in the lexical form the traversal compares
    /// against. The host sends absolute, canonicalized paths.
    pub fn deny_roots_paths(&self) -> Vec<std::path::PathBuf> {
        self.deny_roots.iter().map(std::path::PathBuf::from).collect()
    }
    /// Validates the optional host cache directory from the trusted envelope.
    ///
    /// The directory is only a hint: this crate never creates it, and an absent
    /// or unusable directory must degrade to the walk. Rejecting a malformed one
    /// here keeps a relative, oversized or NUL-bearing path from reaching the
    /// index layer where it could be joined to a workspace path.
    pub fn validate_cache_dir(&self) -> Result<()> {
        if let Some(directory) = &self.cache_dir {
            let length = directory.as_os_str().len();
            if !directory.is_absolute()
                || length == 0
                || length > 4096
                || directory.to_string_lossy().contains('\0')
            {
                return Err(Failure::new(
                    "INVALID_ARGUMENT",
                    "cacheDir must be an absolute path of 1..4096 bytes without NUL",
                ));
            }
        }
        Ok(())
    }
}
pub type Result<T> = std::result::Result<T, Failure>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    #[serde(skip)]
    pub output_sink: Option<std::rc::Rc<capture::OutputSink>>,
    #[serde(skip)]
    pub output_budget: usize,
    /// Trusted envelope metadata; never accepted from the tool argument/request data plane.
    #[serde(skip)]
    pub storage: Option<storage::StorageContext>,
    /// Host-provided cache directory for the ops-index snapshot.
    ///
    /// `None` means the index is disabled for this request and every caller keeps
    /// the existing walk semantics. When present it must be an absolute path the
    /// host created private (0700 on POSIX); the worker never invents or widens
    /// it, and an unusable directory falls back to the walk without an error.
    #[serde(default)]
    pub cache_dir: Option<std::path::PathBuf>,
    pub root: String,
    #[serde(default)]
    pub read_only: bool,
    /// Delegation can strengthen POSIX checks to the originating Windows path semantics.
    #[serde(default)]
    pub windows_paths: bool,
    #[serde(default)]
    pub write_roots: Option<Vec<String>>,
    /// Absolute roots the traversal must not descend into or report. The host
    /// fills this with credential locations; the worker never reads them, so a
    /// glob or grep cannot even name them.
    #[serde(default)]
    pub deny_roots: Vec<String>,
    #[serde(default)]
    pub deny_credential_names: bool,
    #[serde(default)]
    pub root_identity: String,
    pub scope: String,
    pub tool: String,
    pub args: Value,
    #[serde(default)]
    pub job_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BatchArgs {
    pub action: String,
    #[serde(default)]
    pub operations: Vec<Operation>,
    pub operations_ref: Option<String>,
    #[serde(default)]
    pub protect: Vec<String>,
    pub id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResultArgs {
    pub action: String,
    pub id: Option<String>,
    pub items: Option<Vec<Value>>,
    #[serde(default)]
    pub offset: usize,
    pub limit: Option<usize>,
    pub max_bytes: Option<usize>,
    pub ttl_ms: Option<u64>,
    pub fields: Option<Vec<String>>,
    pub equals: Option<std::collections::BTreeMap<String, Value>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delegated_windows_paths_retain_case_insensitive_denials_and_reserved_names() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "root":"/project", "scope":"wsl-test", "tool":"read_files", "args":{},
            "windows_paths":true, "deny_roots":["/project/Private"], "deny_credential_names":true
        })).unwrap();
        assert!(request.denies_path(std::path::Path::new("/project/private/token")));
        for name in ["CON.txt", "name.", "name ", "file:stream", "LPT1"] {
            assert!(request.authorize_path(std::path::Path::new(&format!("/project/{name}"))).is_err(), "{name}");
        }
        assert!(windows_paths::validate_name("bad\\name").is_err());
        assert!(request.authorize_path(std::path::Path::new("/project/valid.txt")).is_ok());
    }

    #[test]
    fn selector_reasons_are_optional_and_backward_compatible() {
        let legacy = serde_json::to_value(Failure::new("POLICY_DENIED", "Scope mismatch")).unwrap();
        assert!(legacy.get("reason").is_none());
        let restored: Failure = serde_json::from_value(legacy).unwrap();
        assert_eq!(restored.reason, None);
        for reason in ["read-only", "write-roots"] {
            let failure = serde_json::to_value(Failure::policy(reason, "Authorization refused")).unwrap();
            assert_eq!(failure["code"], "POLICY_DENIED");
            assert_eq!(failure["reason"], reason);
            assert_eq!(failure["effectState"], "none");
        }
        for code in ["PATH_RESTRICTED", "CREDENTIAL_DENIED"] {
            let failure = serde_json::to_value(Failure::new(code, "Restriction")).unwrap();
            assert!(failure.get("reason").is_none());
        }
    }
}

impl Job {
    pub fn authorize(&self, request: &Request) -> Result<()> {
        if self.version != 1
            || self.scope != request.scope
            || self.root != request.root
            || self.root_identity != request.root_identity
        {
            return Err(Failure::new(
                "POLICY_DENIED",
                "Job scope, root or version mismatch",
            ));
        }
        Ok(())
    }
}