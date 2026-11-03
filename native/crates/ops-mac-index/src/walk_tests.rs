//! Tests for the cold walk: an independent `std::fs` oracle, the budget rules
//! and the symlink contract.
//!
//! The oracle below traverses the same tree with `std::fs` only (no
//! `walkdir`, no rayon) and rebuilds the candidates from `symlink_metadata`.
//! That is the "cold enumeration agrees with a walk" assertion in #609: if the
//! two disagree on a path, on a kind, on the identity or on a timestamp, the
//! test fails.

use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Process-unique temporary directory, removed when the test ends.
struct TempTree {
    root: PathBuf,
}

static NEXT_TREE: AtomicU64 = AtomicU64::new(0);

impl TempTree {
    fn new(label: &str) -> Self {
        let id = NEXT_TREE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "dsh-ops-mac-walk-{}-{label}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create temp tree");
        Self { root }
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn dir(&self, rel: &str) -> PathBuf {
        let path = self.root.join(rel);
        fs::create_dir_all(&path).expect("create directory");
        path
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

/// One entry as the independent oracle sees it.
#[derive(Debug, PartialEq, Eq)]
struct OracleEntry {
    rel: PathBuf,
    kind: EntryKind,
    volume: u64,
    file: u64,
    len: u64,
    modified_ns: Option<i64>,
}

/// Walks `root` with `std::fs` alone, without following symlinks.
fn oracle(root: &Path) -> Vec<OracleEntry> {
    let mut entries = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut children: Vec<PathBuf> = fs::read_dir(&dir)
            .expect("read directory")
            .map(|child| child.expect("directory entry").path())
            .collect();
        children.sort();
        for path in children {
            let metadata = fs::symlink_metadata(&path).expect("lstat");
            let file_type = metadata.file_type();
            let kind = if file_type.is_file() {
                EntryKind::File
            } else if file_type.is_dir() {
                EntryKind::Dir
            } else if file_type.is_symlink() {
                EntryKind::Link
            } else {
                EntryKind::Other
            };
            entries.push(OracleEntry {
                rel: path
                    .strip_prefix(root)
                    .expect("path below root")
                    .to_path_buf(),
                kind,
                volume: metadata.dev(),
                file: metadata.ino(),
                len: if kind == EntryKind::File {
                    metadata.len()
                } else {
                    0
                },
                modified_ns: oracle_modified_ns(&metadata),
            });
            if file_type.is_dir() {
                stack.push(path);
            }
        }
    }
    entries
}

/// Independent mtime conversion for the oracle.
///
/// It intentionally does not call the production `modified_ns` helper: if that
/// helper had a sign or precision bug, sharing it would make the expected and
/// actual values wrong in the same way and the comparison would stay green.
fn oracle_modified_ns(metadata: &fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    match modified.duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_nanos()).ok(),
        Err(before) => i64::try_from(before.duration().as_nanos())
            .ok()
            .map(|nanos| -nanos),
    }
}

/// Asserts that a candidate set agrees with the oracle entry by entry.
fn assert_matches_oracle(root: &Path, set: &CandidateSet) {
    let mut expected: Vec<(PathBuf, EntryKind, u64, u64, u64, Option<i64>)> = oracle(root)
        .into_iter()
        .map(|entry| {
            (
                entry.rel,
                entry.kind,
                entry.volume,
                entry.file,
                entry.len,
                entry.modified_ns,
            )
        })
        .collect();
    let mut actual: Vec<(PathBuf, EntryKind, u64, u64, u64, Option<i64>)> = set
        .entries
        .iter()
        .map(|candidate| {
            (
                candidate.rel.clone(),
                candidate.kind,
                candidate.key.volume,
                candidate.key.file,
                candidate.len,
                candidate.modified_ns,
            )
        })
        .collect();
    expected.sort_by(|left, right| left.0.cmp(&right.0));
    actual.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(actual, expected);
}

/// Walks with a generous budget.
fn walk(root: &Path, max_entries: usize, max_depth: usize) -> CandidateSet {
    walk_root(
        root,
        EnumBudget::with_timeout(max_entries, max_depth, Duration::from_secs(60)),
    )
    .expect("cold walk succeeds")
}

/// A tree with files, nested directories, an empty file, an empty directory and
/// symlinks to a file, to a directory and to nothing.
fn populated_tree(label: &str) -> (TempTree, TempTree) {
    let tree = TempTree::new(label);
    tree.file("alpha.txt", b"alpha");
    tree.dir("empty.dir");
    tree.file("empty.file", b"");
    tree.file("nested/beta.txt", b"beta");
    tree.dir("nested/empty.dir");
    tree.file("nested/gamma/deep.dat", b"deep");
    let outside = TempTree::new("outside");
    outside.file("target.txt", b"target");
    std::os::unix::fs::symlink(outside.root(), tree.root().join("link-to-dir"))
        .expect("symlink to directory");
    std::os::unix::fs::symlink(
        tree.root().join("alpha.txt"),
        tree.root().join("link-to-file"),
    )
    .expect("symlink to file");
    std::os::unix::fs::symlink(tree.root().join("missing"), tree.root().join("dangling"))
        .expect("dangling symlink");
    (tree, outside)
}

#[test]
fn cold_walk_matches_an_independent_std_walk() {
    let (tree, _outside) = populated_tree("oracle");
    let set = walk(tree.root(), 1000, 32);
    assert!(!set.truncated);
    assert!(set.consistent_at_ms > 0);
    assert_matches_oracle(tree.root(), &set);
    assert_eq!(set.entries.len(), oracle(tree.root()).len());
}

#[test]
fn symlinks_are_reported_but_never_followed() {
    let (tree, _outside) = populated_tree("symlink");
    let set = walk(tree.root(), 1000, 32);
    let link = set
        .entries
        .iter()
        .find(|candidate| candidate.rel == Path::new("link-to-dir"))
        .expect("the symlink itself is listed");
    assert_eq!(link.kind, EntryKind::Link);
    assert_eq!(link.len, 0);
    assert!(
        !set.entries
            .iter()
            .any(|candidate| candidate.rel == Path::new("link-to-dir/target.txt")),
        "a link target outside the root must not be enumerated"
    );
    let dangling = set
        .entries
        .iter()
        .find(|candidate| candidate.rel == Path::new("dangling"))
        .expect("a dangling symlink is still an entry");
    assert_eq!(dangling.kind, EntryKind::Link);
}

#[test]
fn an_empty_root_is_an_empty_complete_set() {
    let tree = TempTree::new("empty");
    let set = walk(tree.root(), 1000, 32);
    assert!(set.entries.is_empty());
    assert!(!set.truncated);
}

#[test]
fn max_entries_truncates_the_set() {
    let tree = TempTree::new("entries");
    for index in 0..5 {
        tree.file(&format!("file{index}.txt"), b"x");
    }
    let cut = walk(tree.root(), 2, 32);
    assert_eq!(cut.entries.len(), 2);
    assert!(cut.truncated);

    let exact = walk(tree.root(), 5, 32);
    assert_eq!(exact.entries.len(), 5);
    assert!(!exact.truncated);
}

#[test]
fn max_depth_stops_at_the_limit() {
    let tree = TempTree::new("depth");
    tree.dir("one");
    tree.dir("one/two");
    tree.file("one/two/three.txt", b"three");
    let rels = |set: &CandidateSet| -> Vec<PathBuf> {
        let mut rels: Vec<PathBuf> = set.entries.iter().map(|entry| entry.rel.clone()).collect();
        rels.sort();
        rels
    };

    let one = walk(tree.root(), 1000, 1);
    assert_eq!(rels(&one), vec![PathBuf::from("one")]);
    assert!(
        one.truncated,
        "the directory at the limit may hide children"
    );

    let two = walk(tree.root(), 1000, 2);
    assert_eq!(
        rels(&two),
        vec![PathBuf::from("one"), PathBuf::from("one/two")]
    );
    assert!(two.truncated);

    let three = walk(tree.root(), 1000, 3);
    assert_eq!(
        rels(&three),
        vec![
            PathBuf::from("one"),
            PathBuf::from("one/two"),
            PathBuf::from("one/two/three.txt"),
        ]
    );
    assert!(
        !three.truncated,
        "the deepest entry is a file, not a pruned directory"
    );
}

#[test]
fn depth_zero_prunes_the_root_itself() {
    let tree = TempTree::new("depth-zero");
    tree.file("only.txt", b"x");
    let set = walk(tree.root(), 1000, 0);
    assert!(set.entries.is_empty());
    assert!(set.truncated);
}

#[test]
fn an_expired_deadline_is_a_budget_error() {
    let tree = TempTree::new("deadline");
    tree.file("only.txt", b"x");
    let budget = EnumBudget::new(1000, 32, Instant::now());
    assert_eq!(walk_root(tree.root(), budget), Err(SourceError::Budget));
}

#[test]
fn a_missing_root_is_an_io_error() {
    let tree = TempTree::new("missing-root");
    let missing = tree.root().join("does-not-exist");
    let budget = EnumBudget::with_timeout(1000, 32, Duration::from_secs(60));
    assert_eq!(
        walk_root(&missing, budget),
        Err(SourceError::Io(ErrorKind::NotFound))
    );
}

#[test]
fn a_file_root_is_not_a_directory() {
    let tree = TempTree::new("file-root");
    let file = tree.file("plain.txt", b"x");
    let budget = EnumBudget::with_timeout(1000, 32, Duration::from_secs(60));
    assert_eq!(
        walk_root(&file, budget),
        Err(SourceError::Io(ErrorKind::NotADirectory))
    );
}

#[test]
fn an_unreadable_directory_is_an_io_error() {
    use std::os::unix::fs::PermissionsExt;
    let tree = TempTree::new("denied");
    let locked = tree.dir("locked");
    tree.file("locked/inside.txt", b"inside");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("chmod the directory");
    let result = walk_root(
        tree.root(),
        EnumBudget::with_timeout(1000, 32, Duration::from_secs(60)),
    );
    // Restore before asserting so a failure does not leave an unremovable tree.
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("restore the mode");
    assert_eq!(
        result,
        Err(SourceError::Io(ErrorKind::PermissionDenied)),
        "a partially readable tree must be an error, not a truncated set"
    );
}

#[test]
fn a_known_modification_time_arrives_in_nanoseconds() {
    let tree = TempTree::new("mtime");
    let path = tree.file("stamped.txt", b"stamped");
    let expected_ns: i64 = 1_700_000_000_123_456_789;
    let expected = UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_789);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("open for set_modified")
        .set_modified(expected)
        .expect("set the modification time");
    let set = walk(tree.root(), 1000, 32);
    let entry = set
        .entries
        .iter()
        .find(|candidate| candidate.rel == Path::new("stamped.txt"))
        .expect("the stamped file is listed");
    assert_eq!(
        entry.modified_ns,
        Some(expected_ns),
        "a known mtime must survive as whole nanoseconds since the epoch"
    );
}

#[test]
fn a_symlinked_root_is_followed() {
    let target = TempTree::new("root-target");
    target.file("inside.txt", b"inside");
    let host = TempTree::new("root-link");
    let link = host.root().join("linked-root");
    std::os::unix::fs::symlink(target.root(), &link).expect("symlink the root");
    let set = walk_root(
        &link,
        EnumBudget::with_timeout(1000, 32, Duration::from_secs(60)),
    )
    .expect("a symlinked root is walked");
    let mut rels: Vec<PathBuf> = set.entries.iter().map(|entry| entry.rel.clone()).collect();
    rels.sort();
    assert_eq!(rels, vec![PathBuf::from("inside.txt")]);
}

#[test]
fn repeated_walks_are_deterministic() {
    let (tree, _outside) = populated_tree("deterministic");
    let mut first = walk(tree.root(), 1000, 32).entries;
    let mut second = walk(tree.root(), 1000, 32).entries;
    first.sort_by(|left, right| left.rel.cmp(&right.rel));
    second.sort_by(|left, right| left.rel.cmp(&right.rel));
    assert_eq!(first, second);
}
