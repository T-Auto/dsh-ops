use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ops_index::{EntryKind, SourceState};

use super::*;

fn unique_root(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("dsh-ops-win-w1-{tag}-{}", std::process::id()))
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

#[test]
fn state_branches_are_explicit() {
    assert_eq!(
        classify_state(false, false),
        SourceState::Unavailable,
        "a missing root is not a platform limitation"
    );
    assert_eq!(classify_state(false, true), SourceState::Unavailable);
    assert_eq!(
        classify_state(true, false),
        SourceState::Unsupported,
        "the non-Administrator fallback is Unsupported"
    );
    assert_eq!(
        classify_state(true, true),
        SourceState::Unavailable,
        "W1 has a cold source but no caught-up snapshot"
    );
}

#[test]
fn changes_are_unsupported_in_w1() {
    let source = WinFsSource::new();
    assert_eq!(
        source.changes(Path::new("C:\\"), SnapshotId::new(1)),
        Err(SourceError::Unsupported)
    );
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
    let budget = EnumBudget::new(10, 4, Instant::now() + Duration::from_secs(10));
    assert_eq!(
        source.enumerate(&root, budget),
        Err(SourceError::Io(std::io::ErrorKind::NotADirectory))
    );
    let _ = fs::remove_file(&root);
}

#[test]
fn cold_enumeration_matches_a_walk_of_the_same_root() {
    let root = unique_root("walk");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("docs")).expect("create docs");
    fs::write(root.join("docs").join("report.txt"), b"report").expect("write report");
    fs::write(root.join("notes.md"), b"notes").expect("write notes");
    let source = WinFsSource::new();
    let state = source.state(&root);
    let budget = EnumBudget::new(1_000_000, 32, Instant::now() + Duration::from_secs(120));
    match source.enumerate(&root, budget) {
        Ok(set) => {
            assert!(!set.truncated, "a tiny tree fits a large budget");
            assert_eq!(
                state,
                SourceState::Unavailable,
                "W1 is elevated but never claims Ready without a journal"
            );
            let mut got: Vec<PathBuf> = set
                .entries
                .iter()
                .map(|candidate| candidate.rel.clone())
                .collect();
            got.sort();
            assert_eq!(got, walk_paths(&root), "MFT paths must match a walk");
            let dir = set
                .entries
                .iter()
                .find(|candidate| candidate.rel.as_path() == Path::new("docs"))
                .expect("docs entry");
            assert_eq!(dir.kind, EntryKind::Dir);
            let file = set
                .entries
                .iter()
                .find(|candidate| candidate.rel.as_path() == Path::new("notes.md"))
                .expect("notes entry");
            assert_eq!(file.kind, EntryKind::File);
            assert_eq!(file.len, 0, "MFT enumeration carries no size");
            assert!(
                file.modified_ns.is_none(),
                "MFT enumeration carries no modification time"
            );
            for candidate in &set.entries {
                assert!(
                    candidate.key.file < (1 << 48),
                    "only the record number is exposed"
                );
            }
        }
        Err(SourceError::Unsupported) => {
            assert_eq!(
                state,
                SourceState::Unsupported,
                "the non-Administrator fallback must stay typed, not an error"
            );
        }
        Err(other) => panic!("unexpected enumeration failure: {other:?}"),
    }
    let _ = fs::remove_dir_all(&root);
}
