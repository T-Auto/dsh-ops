use super::*;

fn validation_request(tool: &str, args: Value) -> Request {
    serde_json::from_value(json!({"root":".","scope":"validation","tool":tool,"args":args}))
        .unwrap()
}

#[test]
fn glob_rejects_blank_pattern_entries_by_index() {
    for (patterns, index) in [
        (vec![""], 0),
        (vec!["", "!vendor/**"], 0),
        (vec!["*.rs", " \t"], 1),
    ] {
        let request = validation_request("glob", json!({"path":".","pattern":patterns}));
        let error = glob(&request).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert_eq!(
            error.message,
            format!("pattern[{index}] must be a non-empty glob")
        );
    }
}

#[test]
fn grep_validation_names_the_pattern_or_limit_cause() {
    let missing = validation_request("grep", json!({"path":".","pattern":"","limit":0}));
    let error = grep(&missing).unwrap_err();
    assert_eq!(error.code, "INVALID_ARGUMENT");
    assert_eq!(error.message, "grep pattern is required");

    for limit in [0, 10_001] {
        let request = validation_request("grep", json!({"path":".","pattern":"x","limit":limit}));
        let error = grep(&request).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert_eq!(error.message, "grep limit is 1-10000");
    }
}

#[test]
fn glob_lists_empty_directories_and_mixed_entries_with_stable_pages() {
    let root = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!("dsh-glob-kinds-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    for name in ["empty", "nested", ".hidden", "node_modules"] {
        fs::create_dir(root.join(name)).unwrap();
    }
    fs::write(root.join("a.txt"), "a").unwrap();
    fs::write(root.join("nested").join("b.txt"), "b").unwrap();
    #[cfg(windows)]
    assert!(
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("linked"))
            .arg(root.join("nested"))
            .output()
            .unwrap()
            .status
            .success()
    );
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("nested"), root.join("linked")).unwrap();
    let call = |args: Value| {
        let request: Request =
            serde_json::from_value(json!({"root":root,"scope":"kinds","tool":"glob","args":args}))
                .unwrap();
        glob(&request)
    };
    let default = call(json!({"path":root,"pattern":["*"]})).unwrap();
    assert_eq!(default["items"], json!([root.join("a.txt")]));
    let dirs = call(json!({"path":root,"pattern":["*"],"kind":"directory"})).unwrap();
    assert_eq!(
        dirs["items"],
        json!([root.join("empty"), root.join("nested")])
    );
    assert_eq!(dirs["scanComplete"], true);
    let first =
        call(json!({"path":root,"pattern":["*"],"kind":"all","outputMode":"details","limit":2}))
            .unwrap();
    assert_eq!(first["items"][0]["kind"], "file");
    assert_eq!(first["items"][1]["kind"], "directory");
    assert_eq!(first["matchedTotal"], 3);
    let second = call(json!({"path":root,"pattern":["*"],"kind":"all","outputMode":"details","limit":2,"continuation":first["continuation"]})).unwrap();
    assert_eq!(second["items"][0]["path"], json!(root.join("nested")));
    assert_eq!(second["complete"], true);
    assert_eq!(call(json!({"path":root,"pattern":["*"],"kind":"directory","outputMode":"details","limit":2,"continuation":first["continuation"]})).unwrap_err().code, "SEARCH_STALE");
    assert_eq!(
        call(json!({"path":root,"pattern":["*"],"kind":"invalid"}))
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    #[cfg(windows)]
    fs::remove_dir(root.join("linked")).unwrap();
    fs::remove_dir_all(root).unwrap();
}
