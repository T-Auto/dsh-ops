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
