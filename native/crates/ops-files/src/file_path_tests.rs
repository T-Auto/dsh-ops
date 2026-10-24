use super::*;

#[test]
fn audit_components_are_reserved_case_insensitively() {
    for name in [".dsh-ops", ".DsH-OpS", ".DSH-OPS"] {
        assert_eq!(validate_name(name).unwrap_err().code, "PATH_RESTRICTED");
        assert_eq!(crate::paths::relative(name).unwrap_err().code, "PATH_RESTRICTED");
    }
}

#[test]
fn audit_component_rejection_precedes_missing_ancestor_io() {
    let root = std::env::temp_dir().join(format!("dsh-ops-missing-{}", uuid::Uuid::new_v4()));
    for suffix in [".DSH-OPS", ".dsh-ops/new", "nested/.DsH-OpS/new"] {
        let path = root.join(suffix);
        match checked_leaf(path.to_str().unwrap(), true) {
            Err(error) => assert_eq!(error.code, "PATH_RESTRICTED"),
            Ok(_) => panic!("reserved path was accepted"),
        }
    }
    assert!(!root.exists());
}

#[test]
fn near_audit_names_are_not_reserved_components() {
    for name in [".dsh-ops-backup", ".dsh-ops.json", "dsh-ops", ".dsh-ops-update-lock"] {
        validate_name(name).unwrap();
        crate::paths::relative(name).unwrap();
    }
}
