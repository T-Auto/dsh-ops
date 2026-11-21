use super::*;

#[test]
fn audit_components_are_reserved_case_insensitively() {
    for name in [".dsh-ops", ".DsH-OpS", ".DSH-OPS"] {
        assert_eq!(validate_name(name).unwrap_err().code, "PATH_RESTRICTED");
        assert_eq!(
            crate::paths::relative(name).unwrap_err().code,
            "PATH_RESTRICTED"
        );
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
    for name in [
        ".dsh-ops-backup",
        ".dsh-ops.json",
        "dsh-ops",
        ".dsh-ops-update-lock",
    ] {
        validate_name(name).unwrap();
        crate::paths::relative(name).unwrap();
    }
}

#[test]
fn asar_file_components_are_archive_members_not_traversal_bypasses() {
    let root = std::env::temp_dir().join(format!("dsh-ops-asar-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    // macOS reaches the temp directory through /var -> /private/var, and checked_leaf
    // refuses a symlinked component, so pin the canonical spelling before walking.
    let root = std::fs::canonicalize(&root).unwrap();
    std::fs::write(root.join("bundle.asar"), b"archive bytes").unwrap();
    // #836: Electron presents a real .asar FILE as a directory only through its
    // own patched filesystem; the worker names the archive member instead of
    // implying a no-follow bypass.
    let failure = match checked_leaf(
        root.join("bundle.asar").join("app.js").to_str().unwrap(),
        true,
    ) {
        Err(failure) => failure,
        Ok(_) => panic!("a file component must not become a traversable directory"),
    };
    assert_eq!(failure.code, "ARCHIVE_MEMBER_UNSUPPORTED");
    assert!(
        failure.message.contains("bundle.asar"),
        "{}",
        failure.message
    );
    // A genuine directory keeps working: the .asar spelling is not reserved.
    std::fs::create_dir(root.join("folder.asar")).unwrap();
    std::fs::write(root.join("folder.asar").join("inner.js"), b"real").unwrap();
    let directory = checked_leaf(
        root.join("folder.asar").join("inner.js").to_str().unwrap(),
        false,
    )
    .unwrap();
    assert_eq!(directory.name, "inner.js");
    // A plain file component that is not an archive keeps the traversal refusal.
    std::fs::write(root.join("readme.txt"), b"text").unwrap();
    let plain = match checked_leaf(
        root.join("readme.txt").join("inner.js").to_str().unwrap(),
        true,
    ) {
        Err(failure) => failure,
        Ok(_) => panic!("a plain file must not become a traversable directory"),
    };
    assert_eq!(plain.code, "PATH_RESTRICTED");
    // The archive itself stays a readable regular file.
    let archive = checked_leaf(root.join("bundle.asar").to_str().unwrap(), false).unwrap();
    assert_eq!(archive.name, "bundle.asar");
    // The Targets hold directory handles on Windows; drop them before removing.
    drop(directory);
    drop(archive);
    std::fs::remove_dir_all(&root).unwrap();
}
