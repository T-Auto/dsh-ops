use super::*;

fn legacy() -> Value {
    json!({"root":"/workspace","scope":"session","tool":"stat","args":{"path":"/workspace/file"},"read_only":true,"deny_roots":["/secret"]})
}
fn versioned() -> Value {
    json!({"version":1,"requestId":"req-1","component":"file","budget":{"timeoutMs":300000,"maxBytes":131072},"request":legacy()})
}
fn decoded(value: &Value) -> Result<Decoded> {
    decode(&serde_json::to_vec(value).unwrap())
}

#[test]
fn cache_directory_is_trusted_metadata_validated_before_execution() {
    // temp_dir() is absolute on every platform, so the happy path is portable.
    let absolute = std::env::temp_dir().join("dsh-ops-index-cache");
    let absolute_text = absolute.to_string_lossy().into_owned();
    let mut value = versioned();
    value["request"]["cache_dir"] = json!(absolute_text);
    let decoded_request = decoded(&value).unwrap();
    assert_eq!(
        decoded_request.request.cache_dir.as_deref(),
        Some(absolute.as_path())
    );
    assert!(decoded(&versioned()).unwrap().request.cache_dir.is_none());
    // Trusted metadata: the same key inside tool args must not set it.
    let mut args_value = versioned();
    args_value["request"]["args"]["cache_dir"] = json!(absolute_text);
    assert!(decoded(&args_value).unwrap().request.cache_dir.is_none());
    // The wire name is snake_case like read_only/deny_roots; camelCase is not it.
    let mut camel = versioned();
    camel["request"]["cacheDir"] = json!(absolute_text);
    assert!(decoded(&camel).is_err());
    // Unknown sibling fields inside the request are still rejected.
    let mut value = versioned();
    value["request"]["cache_dir"] = json!(absolute_text);
    value["request"]["cache_extra"] = json!(true);
    assert!(decoded(&value).is_err());
    // Relative, empty, oversized (encoded bytes) and NUL-bearing absolute paths
    // are rejected in both the versioned and the legacy form: a relative path
    // could be joined to the workspace later, which is what this field forbids.
    let prefix = absolute_text.trim_end_matches(['/', '\\']);
    let invalid = [
        json!("relative/cache"),
        json!(""),
        json!(format!("{prefix}/{}", "x".repeat(4096))),
        json!(format!("{prefix}/a\u{0}b")),
    ];
    for dir in invalid {
        let mut value = versioned();
        value["request"]["cache_dir"] = dir.clone();
        assert_eq!(
            decoded(&value).err().unwrap().code,
            "INVALID_ARGUMENT",
            "{dir}"
        );
        let mut legacy_value = legacy();
        legacy_value["cache_dir"] = dir;
        assert_eq!(
            decoded(&legacy_value).err().unwrap().code,
            "INVALID_ARGUMENT"
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_absolute_cache_paths_are_accepted() {
    for dir in [
        r"C:\dsh-ops\index-cache",
        r"\\server\share\dsh-ops\index-cache",
    ] {
        let mut value = versioned();
        value["request"]["cache_dir"] = json!(dir);
        let request = decoded(&value).unwrap();
        assert_eq!(
            request.request.cache_dir.as_deref(),
            Some(std::path::Path::new(dir)),
            "{dir}"
        );
    }
}
#[test]
fn formats_preserve_authority_and_use_bounded_budgets() {
    let old = decoded(&legacy()).unwrap();
    let new = decoded(&versioned()).unwrap();
    assert!(old.request_id.is_none());
    assert_eq!(new.request_id.as_deref(), Some("req-1"));
    assert!(matches!(new.component, Some(Component::File)));
    assert_eq!(new.request.root, old.request.root);
    assert_eq!(new.request.scope, old.request.scope);
    assert_eq!(new.request.deny_roots, ["/secret"]);
    assert!(new.request.read_only);
    assert_eq!(old.budget.max_bytes, MAX_OUTPUT_BYTES);
    assert_eq!(new.budget.timeout_ms, DEFAULT_TIMEOUT_MS);
}
#[test]
fn partial_unknown_and_invalid_envelopes_never_downgrade() {
    for key in ["version", "requestId", "component", "budget", "request"] {
        let mut value = legacy();
        value[key] = json!(1);
        assert!(decoded(&value).is_err(), "marker {key}");
        let mut value = versioned();
        value.as_object_mut().unwrap().remove(key);
        assert!(decoded(&value).is_err(), "missing {key}");
    }
    let mut value = versioned();
    value["version"] = json!(2);
    assert_eq!(decoded(&value).err().unwrap().code, "PROTOCOL_VERSION");
    for (key, invalid) in [
        ("requestId", json!("")),
        ("requestId", json!("a\nb")),
        ("requestId", json!("x".repeat(129))),
        ("component", json!("shell")),
        ("extra", json!(true)),
    ] {
        let mut value = versioned();
        value[key] = invalid;
        assert!(decoded(&value).is_err(), "invalid {key}");
    }
    let mut value = versioned();
    value["request"]["extra"] = json!(true);
    assert!(decoded(&value).is_err());
    // Decode the original bytes so duplicate struct fields cannot be collapsed by Value.
    let old = serde_json::to_string(&legacy()).unwrap();
    let new = serde_json::to_string(&versioned()).unwrap();
    for text in [
        old.replacen("{", "{\"root\":\"/other\",", 1),
        new.replacen("{", "{\"version\":1,", 1),
        new.replace("\"timeoutMs\":", "\"timeoutMs\":1,\"timeoutMs\":"),
    ] {
        assert!(decode(text.as_bytes()).is_err());
    }
}
#[test]
fn budgets_reject_tiny_huge_and_unusable_values_before_execution() {
    for (key, value) in [
        ("timeoutMs", json!(0)),
        ("timeoutMs", json!(-1)),
        ("timeoutMs", json!(1.5)),
        ("timeoutMs", json!(2147483648_u64)),
        ("maxBytes", json!(1023)),
        ("maxBytes", json!(131073)),
        ("extra", json!(1)),
    ] {
        let mut input = versioned();
        input["budget"][key] = value;
        assert!(decoded(&input).is_err(), "invalid {key}");
    }
    assert_eq!(
        decode(&vec![b' '; MAX_REQUEST_BYTES + 1])
            .err()
            .unwrap()
            .code,
        "OUTPUT_LIMIT"
    );
}
#[test]
fn output_budget_counts_encoded_bytes_and_keeps_effects_honest() {
    assert!(
        encode_result(
            &json!({}),
            Budget {
                max_bytes: 1,
                ..Budget::default()
            },
            false
        )
        .is_err()
    );
    let budget = Budget {
        max_bytes: 1024,
        ..Budget::default()
    };
    let value = json!({"status":"completed","text":"\0".repeat(1000)});
    for (mutating, expected) in [(false, "none"), (true, "unknown")] {
        let bytes = encode_result(&value, budget, mutating).unwrap();
        assert!(bytes.len() <= 1024);
        assert_eq!(bytes.last(), Some(&b'\n'));
        let output: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(output["error"]["code"], "OUTPUT_LIMIT");
        assert_eq!(output["error"]["effectState"], expected);
    }
    for effect in ["none", "applied", "partial", "unknown"] {
        let value = json!({"error":{"effectState":effect,"message":"x".repeat(2000)}});
        let output: Value =
            serde_json::from_slice(&encode_result(&value, budget, true).unwrap()).unwrap();
        assert_eq!(output["error"]["effectState"], effect);
    }
    let exact = json!({"text":"x".repeat(1012)}); // 1023 serialized bytes plus newline.
    assert_eq!(encode_result(&exact, budget, false).unwrap().len(), 1024);
}
