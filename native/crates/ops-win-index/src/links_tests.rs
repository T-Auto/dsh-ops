use super::*;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A unique directory tree under the system temp dir, removed on drop.
struct TempTree {
    root: PathBuf,
}

impl TempTree {
    fn new(label: &str) -> Self {
        let unique = format!(
            "ops-win-links-{}-{}-{label}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let root = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn dir(&self, rel: &str) -> PathBuf {
        let path = self.root.join(rel);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn file(&self, rel: &str) -> PathBuf {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, b"payload").unwrap();
        path
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Whether one reported wide name ends with the expected path suffix, judged by
/// path components so the volume-rooted prefix Win32 uses does not matter.
fn ends_with(name: &[u16], expected: &Path) -> bool {
    let os = OsString::from_wide(name);
    Path::new(&os).ends_with(expected)
}

fn names_end_with(set: &LinkSet, expected: &[&Path]) -> bool {
    expected
        .iter()
        .all(|suffix| set.names().iter().any(|name| ends_with(name, suffix)))
}

#[test]
fn a_single_link_is_reported_completely() {
    let tree = TempTree::new("single");
    let file = tree.file("single.txt");
    let outcome = enumerate(&file);
    let set = outcome.set().expect("a single-link file must enumerate");
    assert_eq!(set.len(), 1);
    assert!(ends_with(&set.names()[0], Path::new("single.txt")));
    assert!(!set.is_empty());
}

#[test]
fn adding_a_hard_link_makes_both_names_visible() {
    let tree = TempTree::new("two-links");
    let first = tree.file("d1/a.txt");
    tree.dir("d2");
    std::fs::hard_link(&first, tree.root.join("d2/b.txt")).unwrap();

    let outcome = enumerate(&first);
    let set = outcome.set().expect("both links must enumerate");
    assert_eq!(set.len(), 2);
    assert!(names_end_with(
        set,
        &[
            Path::new("d1").join("a.txt").as_path(),
            Path::new("d2").join("b.txt").as_path()
        ]
    ));
}

#[test]
fn removing_a_hard_link_leaves_the_remaining_name() {
    let tree = TempTree::new("one-left");
    let first = tree.file("d1/a.txt");
    let second = tree.root.join("d2/b.txt");
    tree.dir("d2");
    std::fs::hard_link(&first, &second).unwrap();
    std::fs::remove_file(&second).unwrap();

    let outcome = enumerate(&first);
    let set = outcome.set().expect("the surviving link must enumerate");
    assert_eq!(set.len(), 1);
    assert!(ends_with(
        &set.names()[0],
        Path::new("d1").join("a.txt").as_path()
    ));
}

#[test]
fn a_deleted_anchor_still_enumerates_through_another_link() {
    let tree = TempTree::new("anchor-gone");
    let first = tree.file("d1/a.txt");
    let second = tree.root.join("d2/b.txt");
    tree.dir("d2");
    std::fs::hard_link(&first, &second).unwrap();
    std::fs::remove_file(&first).unwrap();

    let outcome = enumerate(&second);
    let set = outcome.set().expect("the surviving name is a valid anchor");
    assert_eq!(set.len(), 1);
    assert!(ends_with(
        &set.names()[0],
        Path::new("d2").join("b.txt").as_path()
    ));
}

#[test]
fn unicode_names_round_trip_without_loss() {
    let tree = TempTree::new("unicode");
    let first = tree.file("d1/r\u{00e9}sum\u{00e9}.txt");
    let second = tree.root.join("d2/\u{526f}\u{672c}\u{6587}\u{6863}.txt");
    tree.dir("d2");
    std::fs::hard_link(&first, &second).unwrap();

    let outcome = enumerate(&first);
    let set = outcome.set().expect("unicode names must enumerate");
    assert_eq!(set.len(), 2);
    assert!(names_end_with(
        set,
        &[
            Path::new("d1").join("r\u{00e9}sum\u{00e9}.txt").as_path(),
            Path::new("d2")
                .join("\u{526f}\u{672c}\u{6587}\u{6863}.txt")
                .as_path(),
        ]
    ));
}

#[test]
fn a_missing_anchor_is_incomplete_not_an_empty_set() {
    let tree = TempTree::new("missing");
    let missing = tree.root.join("missing.txt");
    let outcome = enumerate(&missing);
    assert!(!outcome.is_complete());
    assert!(
        outcome.set().is_none(),
        "an empty set must never be reported"
    );
    let failure = outcome.failure().expect("a failure reason is required");
    assert_eq!(failure.kind, LinkFailureKind::FileGone);
    assert_eq!(failure.kind.code(), "WIN_LINK_FILE_GONE");
}

#[test]
fn a_relative_anchor_is_rejected_without_touching_the_file_system() {
    let outcome = enumerate(Path::new("relative.txt"));
    let failure = outcome.failure().expect("relative anchors are invalid");
    assert_eq!(failure.kind, LinkFailureKind::InvalidAnchor);
    assert_eq!(failure.kind.code(), "WIN_LINK_INVALID_ANCHOR");
}

#[test]
fn stats_count_complete_and_skipped_outcomes() {
    let tree = TempTree::new("stats");
    let file = tree.file("one.txt");
    let mut stats = LinkWalkStats::default();
    stats.record(&enumerate(&file));
    stats.record(&enumerate(&tree.root.join("gone.txt")));
    assert_eq!(stats.attempted, 2);
    assert_eq!(stats.completed, 1);
    assert_eq!(stats.skipped, 1);
    assert!(!stats.is_clean());
}

#[test]
fn every_reported_name_is_non_empty_and_has_no_interior_nul() {
    let tree = TempTree::new("names-clean");
    let first = tree.file("d1/a.txt");
    let second = tree.root.join("d2/b.txt");
    tree.dir("d2");
    std::fs::hard_link(&first, &second).unwrap();

    let outcome = enumerate(&first);
    let set = outcome.set().unwrap();
    for name in set.names() {
        assert!(!name.is_empty());
        assert_eq!(name.iter().filter(|&&unit| unit == 0).count(), 0);
    }
}

#[test]
fn failure_codes_are_stable() {
    assert_eq!(LinkFailureKind::FileGone.code(), "WIN_LINK_FILE_GONE");
    assert_eq!(
        LinkFailureKind::AccessDenied.code(),
        "WIN_LINK_ACCESS_DENIED"
    );
    assert_eq!(LinkFailureKind::WalkAborted.code(), "WIN_LINK_WALK_ABORTED");
    assert_eq!(LinkFailureKind::TooManyLinks.code(), "WIN_LINK_TOO_MANY");
    assert_eq!(
        LinkFailureKind::InvalidAnchor.code(),
        "WIN_LINK_INVALID_ANCHOR"
    );
}
