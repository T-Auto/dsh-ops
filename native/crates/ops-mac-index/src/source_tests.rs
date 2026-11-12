//! Tests for the `FsDataSource` wiring: what `state` may claim before
//! FSEvents exists, that the cold enumeration is available anyway, and that the
//! change stream refuses instead of inventing changes.

use super::*;
use ops_index::{EntryKind, SnapshotId};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// Process-unique temporary directory, removed when the test ends.
struct TempTree {
    root: PathBuf,
}

static NEXT_TREE: AtomicU64 = AtomicU64::new(0);

impl TempTree {
    fn new(label: &str) -> Self {
        let id = NEXT_TREE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "dsh-ops-mac-source-{}-{label}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create temp tree");
        Self { root }
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn file(&self, rel: &str, contents: &[u8]) -> PathBuf {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create file parent");
        }
        fs::write(&path, contents).expect("write file");
        path
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// A budget generous enough that only the tree matters.
fn budget() -> EnumBudget {
    EnumBudget::with_timeout(1000, 32, Duration::from_secs(60))
}

#[test]
fn state_is_unsupported_while_the_event_stream_is_not_wired() {
    let tree = TempTree::new("state-dir");
    tree.file("one.txt", b"one");
    // M1 has no caught-up snapshot, so it must not claim Ready. Callers gate on
    // this and keep their own traversal.
    assert_eq!(
        MacFsSource::new().state(tree.root()),
        SourceState::Unsupported
    );
}

#[test]
fn state_is_unavailable_for_a_root_it_cannot_serve() {
    let tree = TempTree::new("state-unavailable");
    let source = MacFsSource::new();
    assert_eq!(
        source.state(&tree.root().join("does-not-exist")),
        SourceState::Unavailable
    );
    let file = tree.file("plain.txt", b"x");
    assert_eq!(source.state(&file), SourceState::Unavailable);
}

#[test]
fn cold_enumeration_works_although_state_is_unsupported() {
    let tree = TempTree::new("cold");
    tree.file("one.txt", b"one");
    tree.file("dir/two.txt", b"two");
    let source: &dyn FsDataSource = &MacFsSource::new();
    assert!(!source.state(tree.root()).is_ready());
    let set = source
        .enumerate(tree.root(), budget())
        .expect("the cold enumeration itself succeeds");
    let mut rels: Vec<PathBuf> = set.entries.iter().map(|entry| entry.rel.clone()).collect();
    rels.sort();
    assert_eq!(
        rels,
        vec![
            PathBuf::from("dir"),
            PathBuf::from("dir/two.txt"),
            PathBuf::from("one.txt"),
        ]
    );
    assert!(!set.truncated);
    assert_eq!(
        set.entries
            .iter()
            .filter(|entry| entry.kind == EntryKind::File)
            .count(),
        2
    );
}

#[test]
fn enumerate_reports_budget_errors_from_the_walk() {
    let tree = TempTree::new("budget");
    tree.file("one.txt", b"one");
    let expired = EnumBudget::with_timeout(1000, 32, Duration::ZERO);
    assert_eq!(
        MacFsSource::new().enumerate(tree.root(), expired),
        Err(SourceError::Budget)
    );
}

#[test]
fn changes_are_unsupported_without_an_event_stream() {
    let tree = TempTree::new("changes");
    assert_eq!(
        MacFsSource::new().changes(tree.root(), SnapshotId::new(1)),
        Err(SourceError::Unsupported),
        "no journal exists on macOS and M2 has not wired FSEvents yet"
    );
}
