use super::*;

#[test]
fn regular_file_ancestor_is_path_restricted() {
    let root = std::env::temp_dir().join(format!("ops-parent-file-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let file = root.join("file");
    std::fs::write(&file, b"content").unwrap();
    let result = checked_leaf(file.join("child").to_str().unwrap(), true)
        .map(|_| ())
        .map_err(|error| error.code);
    std::fs::remove_file(file).unwrap();
    std::fs::remove_dir(root).unwrap();
    assert_eq!(result.unwrap_err(), "PATH_RESTRICTED");
}

#[cfg(windows)]
#[test]
fn checked_parents_refuse_junctions_and_retain_no_delete_lease() {
    use std::{fs, process::Command};
    let root = std::env::temp_dir().join(format!("ops-parent-lease-{}", uuid::Uuid::new_v4()));
    let plain = root.join("plain");
    let child = plain.join("child");
    fs::create_dir_all(&child).unwrap();
    let file = child.join("input.txt");
    fs::write(&file, b"content").unwrap();
    let alias = root.join("alias");
    assert!(
        Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&alias)
            .arg(&plain)
            .output()
            .unwrap()
            .status
            .success()
    );
    let linked = checked(alias.join("child/input.txt").to_str().unwrap())
        .map(|_| ())
        .map_err(|error| error.code);
    let absent = child.join("absent");
    let target = checked_leaf(absent.to_str().unwrap(), true).unwrap();
    assert_eq!(target.name, "absent");
    assert!(!absent.exists(), "lookup must not create the missing leaf");
    let destination = plain.join("renamed");
    let rename = fs::rename(&child, &destination);
    drop(target);
    if rename.is_ok() {
        fs::rename(&destination, &child).unwrap();
    }
    fs::remove_dir(alias).unwrap();
    fs::remove_file(file).unwrap();
    fs::remove_dir(child).unwrap();
    fs::remove_dir(plain).unwrap();
    fs::remove_dir(root).unwrap();
    assert_eq!(linked.unwrap_err(), "PATH_RESTRICTED");
    assert_eq!(
        rename.unwrap_err().raw_os_error(),
        Some(32),
        "held parent must prevent rename"
    );
}

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

#[cfg(windows)]
#[test]
fn each_ancestor_retains_its_read_access_check() {
    use std::{fs, process::Command};
    let root = std::env::temp_dir().join(format!("ops-parent-acl-{}", uuid::Uuid::new_v4()));
    let denied = root.join("denied");
    let child = denied.join("child");
    fs::create_dir_all(&child).unwrap();
    let file = child.join("input.txt");
    fs::write(&file, b"visible").unwrap();
    let identity = Command::new("whoami.exe")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .unwrap();
    assert!(identity.status.success());
    let output = String::from_utf8(identity.stdout).unwrap();
    let sid = output.trim().rsplit(',').next().unwrap().trim_matches('"');
    assert!(
        sid.starts_with("S-1-")
            && sid
                .chars()
                .all(|c| c.is_ascii_digit() || c == '-' || c == 'S')
    );
    let apply = Command::new("icacls.exe")
        .arg(&denied)
        .arg("/deny")
        .arg(format!("*{sid}:(RD)"))
        .output()
        .unwrap();
    assert!(apply.status.success());
    let result = checked(file.to_str().unwrap())
        .map(|_| ())
        .map_err(|error| error.code);
    // Restore only the fixture's explicit ACE before checking the result.
    let restore = Command::new("icacls.exe")
        .arg(&denied)
        .arg("/remove:d")
        .arg(format!("*{sid}"))
        .output()
        .unwrap();
    assert!(restore.status.success());
    fs::remove_file(file).unwrap();
    fs::remove_dir(child).unwrap();
    fs::remove_dir(denied).unwrap();
    fs::remove_dir(root).unwrap();
    assert_eq!(result.unwrap_err(), "ACCESS_DENIED");
}
