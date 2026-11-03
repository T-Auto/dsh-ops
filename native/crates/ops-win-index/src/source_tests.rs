use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cap_fs_ext::MetadataExt;
use ops_index::{ChangeAction, EntryKind, SourceState};

use super::*;
use crate::journal::MemoryCursorStore;

fn unique_root(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("dsh-ops-win-w2-{tag}-{}", std::process::id()))
}

fn walk_paths(root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut stack = vec![PathBuf::new()];
    while let Some(relative) = stack.pop() {
        for entry in fs::read_dir(root.join(&relative)).expect("read_dir") {
            let entry = entry.expect("directory entry");
            let child = relative.join(entry.file_name());
            if entry.file_type().expect("file type").is_dir() {
                stack.push(child.clone());
            }
            paths.push(child);
        }
    }
    paths.sort();
    paths
}

fn generous_budget() -> EnumBudget {
    EnumBudget::new(1_000_000, 32, Instant::now() + Duration::from_secs(120))
}

#[test]
fn a_missing_root_reports_unavailable() {
    let source = WinFsSource::new();
    assert_eq!(
        source.state(&unique_root("missing")),
        SourceState::Unavailable
    );
}

#[test]
fn enumerate_rejects_a_file_root() {
    let root = unique_root("file-root");
    fs::write(&root, b"x").expect("write file root");
    let source = WinFsSource::new();
    assert_eq!(
        source.enumerate(&root, generous_budget()),
        Err(SourceError::Io(std::io::ErrorKind::NotADirectory))
    );
    let _ = fs::remove_file(&root);
}

#[test]
fn a_source_without_a_cursor_store_never_claims_ready() {
    let root = unique_root("no-store");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("create root");
    let source = WinFsSource::new();
    assert!(!source.state(&root).is_ready());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn cold_enumeration_matches_a_walk_and_the_cap_identity() {
    let root = unique_root("identity");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("docs")).expect("create docs");
    fs::write(root.join("docs").join("report.txt"), b"report").expect("write report");
    fs::write(root.join("notes.md"), b"notes").expect("write notes");
    let source = WinFsSource::new();
    let state = source.state(&root);
    match source.enumerate(&root, generous_budget()) {
        Ok(set) => {
            let mut got: Vec<PathBuf> = set
                .entries
                .iter()
                .map(|candidate| candidate.rel.clone())
                .collect();
            got.sort();
            assert_eq!(
                got,
                walk_paths(&root),
                "journal catch-up keeps the MFT paths"
            );
            let cap_dir = cap_std::fs::Dir::open_ambient_dir(&root, cap_std::ambient_authority())
                .expect("cap dir");
            for candidate in &set.entries {
                let metadata = if candidate.kind == EntryKind::Dir {
                    cap_dir
                        .open_dir(&candidate.rel)
                        .expect("open dir")
                        .dir_metadata()
                        .expect("dir metadata")
                } else {
                    cap_dir
                        .open(&candidate.rel)
                        .expect("open file")
                        .metadata()
                        .expect("file metadata")
                };
                assert_eq!(
                    candidate.key.volume,
                    metadata.dev(),
                    "volume serial must match cap-fs-ext dev()"
                );
                assert_eq!(
                    candidate.key.file,
                    metadata.ino(),
                    "file index must match cap-fs-ext ino()"
                );
            }
            assert!(!state.is_ready(), "W2 does not claim Ready without a store");
        }
        Err(SourceError::Unsupported) => {
            assert!(!state.is_ready(), "unprivileged or journal-less fallback");
        }
        Err(other) => panic!("unexpected enumeration failure: {other:?}"),
    }
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn changes_replay_from_a_saved_cursor() {
    let root = unique_root("changes");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("docs")).expect("create docs");
    fs::write(root.join("docs").join("base.txt"), b"base").expect("write base");
    let store = Arc::new(MemoryCursorStore::new());
    let source = WinFsSource::with_cursor_store(store.clone());
    let cursor = match source.capture_cursor(&root) {
        Ok(cursor) => cursor,
        Err(SourceError::Unsupported) => {
            assert!(!source.state(&root).is_ready());
            let _ = fs::remove_dir_all(&root);
            return;
        }
        Err(other) => panic!("unexpected capture failure: {other:?}"),
    };
    let snapshot = store.save(&root, cursor).expect("save cursor");
    assert!(
        source.state(&root).is_ready(),
        "a valid saved cursor lets state claim Ready"
    );
    fs::write(root.join("added.txt"), b"added").expect("write added");
    fs::rename(
        root.join("docs").join("base.txt"),
        root.join("docs").join("renamed.txt"),
    )
    .expect("rename base");
    fs::write(root.join("gone.txt"), b"gone").expect("write gone");
    fs::remove_file(root.join("gone.txt")).expect("remove gone");
    let report = source.changes_report(&root, snapshot).expect("changes");
    assert!(
        report.cursor.next_usn() >= cursor.next_usn(),
        "the replay cursor advances"
    );
    assert!(
        report
            .changes
            .iter()
            .any(|change| change.rel == Path::new("added.txt")
                && change.action == ChangeAction::Added),
        "create maps to Added: {:?}",
        report.changes
    );
    assert!(
        report
            .changes
            .iter()
            .any(|change| change.rel == Path::new("docs").join("renamed.txt")
                && change.action == ChangeAction::Renamed),
        "rename maps to Renamed: {:?}",
        report.changes
    );
    assert!(
        report
            .changes
            .iter()
            .any(|change| change.rel == Path::new("gone.txt")
                && change.action == ChangeAction::Removed),
        "delete maps to Removed: {:?}",
        report.changes
    );
    assert_eq!(
        source.changes(&root, snapshot).expect("trait changes"),
        report.changes
    );
    let stale =
        crate::journal::JournalCursor::new(cursor.journal_id().wrapping_add(1), cursor.next_usn());
    let stale_snapshot = store.save(&root, stale).expect("save stale");
    assert_eq!(source.state(&root), SourceState::Unavailable);
    assert_eq!(
        source.changes_report(&root, stale_snapshot),
        Err(SourceError::NotReady)
    );
    let _ = fs::remove_dir_all(&root);
}
