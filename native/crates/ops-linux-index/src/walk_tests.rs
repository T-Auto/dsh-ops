use super::*;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A unique directory tree under the system temp dir, removed on drop.
struct TempTree {
    root: PathBuf,
}

impl TempTree {
    fn new(label: &str) -> Self {
        let unique = format!(
            "ops-linux-index-{}-{}-{label}",
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

    fn file(&self, rel: &str, bytes: usize) -> PathBuf {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, vec![b'x'; bytes]).unwrap();
        path
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn budget(max_entries: usize, max_depth: usize) -> EnumBudget {
    EnumBudget::with_timeout(max_entries, max_depth, Duration::from_secs(30))
}

fn sorted(mut entries: Vec<Candidate>) -> Vec<Candidate> {
    entries.sort_by(|left, right| {
        left.rel
            .as_os_str()
            .as_encoded_bytes()
            .cmp(right.rel.as_os_str().as_encoded_bytes())
    });
    entries
}

fn rel_paths(entries: &[Candidate]) -> Vec<String> {
    entries
        .iter()
        .map(|entry| entry.rel.to_string_lossy().into_owned())
        .collect()
}

/// Independent recursive walk: the oracle for the cold enumeration.
fn reference_walk(root: &Path) -> Vec<Candidate> {
    fn recurse(root: &Path, dir: &Path, out: &mut Vec<Candidate>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let metadata = entry.metadata().unwrap();
            let file_type = metadata.file_type();
            let kind = if file_type.is_symlink() {
                EntryKind::Link
            } else if file_type.is_dir() {
                EntryKind::Dir
            } else if file_type.is_file() {
                EntryKind::File
            } else {
                EntryKind::Other
            };
            out.push(Candidate {
                rel: entry.path().strip_prefix(root).unwrap().to_path_buf(),
                key: FileKey::new(metadata.dev(), metadata.ino()),
                kind,
                len: if kind == EntryKind::File {
                    metadata.len()
                } else {
                    0
                },
                modified_ns: {
                    let seconds = i128::from(metadata.mtime());
                    let nanos = i128::from(metadata.mtime_nsec());
                    let total = seconds
                        .checked_mul(1_000_000_000)
                        .unwrap()
                        .checked_add(nanos)
                        .unwrap();
                    i64::try_from(total).ok()
                },
            });
            if kind == EntryKind::Dir {
                recurse(root, &entry.path(), out);
            }
        }
    }

    let mut out = Vec::new();
    recurse(root, root, &mut out);
    out
}

#[test]
fn cold_enumeration_matches_the_reference_walk() {
    let tree = TempTree::new("matches-walk");
    tree.dir("empty");
    tree.file("a.txt", 3);
    tree.file("a/one.bin", 10);
    tree.file("a/b/deep.txt", 5);
    std::os::unix::fs::symlink(tree.root.join("a.txt"), tree.root.join("link.txt")).unwrap();

    let set = enumerate(&tree.root, budget(100, 8)).unwrap();
    assert!(!set.truncated);
    assert_eq!(sorted(set.entries), sorted(reference_walk(&tree.root)));
    assert!(set.consistent_at_ms > 0);
}

#[test]
fn candidates_carry_size_mtime_and_a_unique_key() {
    let tree = TempTree::new("metadata");
    let path = tree.file("sized.bin", 10);
    tree.dir("dir");

    let set = enumerate(&tree.root, budget(100, 4)).unwrap();
    let file = set
        .entries
        .iter()
        .find(|entry| entry.rel == Path::new("sized.bin"))
        .unwrap();
    assert_eq!(file.kind, EntryKind::File);
    assert_eq!(file.len, 10);
    assert!(
        file.modified_ns.is_some(),
        "a regular file always has an mtime"
    );

    let dir = set
        .entries
        .iter()
        .find(|entry| entry.rel == Path::new("dir"))
        .unwrap();
    assert_eq!(dir.kind, EntryKind::Dir);
    assert_eq!(dir.len, 0, "the source has no size for a directory");

    let metadata = std::fs::symlink_metadata(&path).unwrap();
    assert_eq!(file.key, FileKey::new(metadata.dev(), metadata.ino()));

    let mut keys: Vec<FileKey> = set.entries.iter().map(|entry| entry.key).collect();
    keys.sort_by_key(|key| (key.volume, key.file));
    keys.dedup();
    assert_eq!(
        keys.len(),
        set.entries.len(),
        "keys must identify distinct objects"
    );
}

#[test]
fn symlinks_are_reported_but_never_followed() {
    let tree = TempTree::new("symlink");
    tree.file("real/inside.txt", 1);
    std::os::unix::fs::symlink(tree.root.join("real"), tree.root.join("linkdir")).unwrap();

    let set = enumerate(&tree.root, budget(100, 8)).unwrap();
    let paths = rel_paths(&sorted(set.entries.clone()));
    assert_eq!(paths, ["linkdir", "real", "real/inside.txt"]);

    let link = set
        .entries
        .iter()
        .find(|entry| entry.rel == Path::new("linkdir"))
        .unwrap();
    assert_eq!(link.kind, EntryKind::Link);
    assert_eq!(link.len, 0);
}

#[test]
fn a_socket_is_reported_as_other_kind() {
    let tree = TempTree::new("socket");
    let listener = std::os::unix::net::UnixListener::bind(tree.root.join("sock")).unwrap();
    let set = enumerate(&tree.root, budget(10, 2)).unwrap();
    drop(listener);
    let socket = set
        .entries
        .iter()
        .find(|entry| entry.rel == Path::new("sock"))
        .expect("the socket file must be enumerated");
    assert_eq!(socket.kind, EntryKind::Other);
    assert_eq!(socket.len, 0);
}

#[test]
fn entry_budget_truncates_and_never_exceeds_the_limit() {
    let tree = TempTree::new("entry-budget");
    for index in 0..5 {
        tree.file(&format!("f{index}.txt"), 1);
    }
    let set = enumerate(&tree.root, budget(2, 4)).unwrap();
    assert_eq!(set.entries.len(), 2);
    assert!(set.truncated, "a cut set must never look complete");
    assert_eq!(rel_paths(&set.entries), ["f0.txt", "f1.txt"]);
}

#[test]
fn an_exactly_full_entry_budget_is_not_truncated() {
    let tree = TempTree::new("entry-exact");
    tree.file("f0.txt", 1);
    tree.file("f1.txt", 1);
    let set = enumerate(&tree.root, budget(2, 4)).unwrap();
    assert_eq!(set.entries.len(), 2);
    assert!(!set.truncated);
}

#[test]
fn depth_budget_keeps_entries_up_to_the_cap_and_reports_truncation() {
    let tree = TempTree::new("depth");
    tree.file("a/b/c.txt", 1);
    let set = enumerate(&tree.root, budget(100, 2)).unwrap();
    assert_eq!(rel_paths(&set.entries), ["a", "a/b"]);
    assert!(
        set.truncated,
        "a directory at the depth cap had content that was skipped"
    );
}

#[test]
fn depth_cap_over_an_empty_directory_is_not_truncated() {
    let tree = TempTree::new("depth-empty");
    tree.dir("empty");
    let set = enumerate(&tree.root, budget(100, 1)).unwrap();
    assert_eq!(rel_paths(&set.entries), ["empty"]);
    assert!(!set.truncated);
}

#[test]
fn zero_depth_budget_lists_nothing_and_marks_a_non_empty_root() {
    let tree = TempTree::new("depth-zero");
    tree.file("a.txt", 1);
    let set = enumerate(&tree.root, budget(10, 0)).unwrap();
    assert!(set.entries.is_empty());
    assert!(set.truncated);

    let empty = TempTree::new("depth-zero-empty");
    let set = enumerate(&empty.root, budget(10, 0)).unwrap();
    assert!(set.entries.is_empty());
    assert!(!set.truncated);
}

#[test]
fn missing_root_is_an_io_error() {
    let tree = TempTree::new("missing");
    let missing = tree.root.join("does-not-exist");
    assert_eq!(
        enumerate(&missing, budget(10, 4)),
        Err(SourceError::Io(std::io::ErrorKind::NotFound))
    );
}

#[test]
fn a_file_root_is_not_a_directory() {
    let tree = TempTree::new("file-root");
    let file = tree.file("plain.txt", 1);
    assert_eq!(
        enumerate(&file, budget(10, 4)),
        Err(SourceError::Io(std::io::ErrorKind::NotADirectory))
    );
}

#[test]
fn an_already_expired_budget_is_an_error() {
    let tree = TempTree::new("expired");
    let expired = EnumBudget::new(10, 4, Instant::now() - Duration::from_millis(1));
    assert_eq!(enumerate(&tree.root, expired), Err(SourceError::Budget));
}

#[test]
fn a_symlinked_root_is_enumerated() {
    let tree = TempTree::new("root-symlink-target");
    tree.file("a.txt", 1);
    let alias = tree.root.with_file_name(format!(
        "{}-alias",
        tree.root.file_name().unwrap().to_string_lossy()
    ));
    std::os::unix::fs::symlink(&tree.root, &alias).unwrap();
    let set = enumerate(&alias, budget(10, 4)).unwrap();
    let _ = std::fs::remove_file(&alias);
    assert_eq!(rel_paths(&set.entries), ["a.txt"]);
}

#[test]
fn a_generous_budget_is_reproducible() {
    let tree = TempTree::new("reproducible");
    for dir in 0..4 {
        for file in 0..5 {
            tree.file(&format!("d{dir}/f{file}.txt"), 1);
        }
    }
    let first = enumerate(&tree.root, budget(1000, 8)).unwrap();
    let second = enumerate(&tree.root, budget(1000, 8)).unwrap();
    assert_eq!(first.entries, second.entries);
    assert_eq!(first.truncated, second.truncated);
}

#[test]
fn reserving_beyond_the_entry_budget_marks_truncation() {
    let walk = WalkBudget::new(budget(1, 4));
    assert!(walk.reserve());
    assert!(!walk.reserve());
    assert!(walk.truncated.load(Ordering::Relaxed));
}

#[test]
fn an_expired_deadline_inside_a_directory_stops_the_batch() {
    let tree = TempTree::new("deadline");
    tree.file("a.txt", 1);
    let walk = WalkBudget::new(EnumBudget::new(
        10,
        4,
        Instant::now() - Duration::from_millis(1),
    ));
    let batch = walk_directory(&tree.root, &tree.root, 1, &walk).unwrap();
    assert!(batch.stopped);
    assert!(batch.entries.is_empty());
    assert!(walk.truncated.load(Ordering::Relaxed));
}
