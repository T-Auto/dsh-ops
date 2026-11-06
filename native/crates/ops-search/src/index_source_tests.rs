//! Tests for the G3 index wiring: cache-dir gating, platform fallback and the
//! cursor domain that keeps a multi-page answer on one traversal.
//!
//! Every case uses `MemorySource` or the real platform source. No test bypass is
//! added to `native/src`: `glob_with_source` is a `cfg(test)` seam in this crate
//! so a fake-`Ready` source can be exercised end to end.

use super::*;
use cap_fs_ext::MetadataExt;
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use ops_index::{
    Candidate, CandidateSet, Change, EntryKind, EnumBudget, FileKey, FsDataSource, MemorySource,
    SnapshotId, SourceError, SourceState,
};

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "dsh-ops-index-cache-{tag}-{}",
                uuid::Uuid::new_v4()
            ));
        std::fs::create_dir(&root).unwrap();
        Self { root }
    }

    fn file(&self, name: &str, contents: &str) -> PathBuf {
        let path = self.root.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A source candidate with the identity cap-std reports for `name`.
fn candidate(root: &Path, name: &str) -> Candidate {
    let directory = Dir::open_ambient_dir(root, ambient_authority()).unwrap();
    let metadata = directory.symlink_metadata(name).unwrap();
    Candidate {
        rel: PathBuf::from(name),
        key: FileKey::new(metadata.dev(), metadata.ino()),
        kind: EntryKind::File,
        len: metadata.len(),
        modified_ns: None,
    }
}

fn source(root: &Path, names: &[&str]) -> MemorySource {
    MemorySource::ready(
        SnapshotId::new(1),
        names.iter().map(|name| candidate(root, name)).collect(),
    )
}

fn request(root: &Path, cache_dir: Option<&Path>, args: Value) -> Request {
    let mut value = json!({
        "root": root,
        "scope": "index-wiring",
        "tool": "glob",
        "args": args,
    });
    if let Some(cache_dir) = cache_dir {
        value["cache_dir"] = json!(cache_dir);
    }
    serde_json::from_value(value).unwrap()
}

fn glob_args(root: &Path) -> Value {
    json!({ "path": root, "pattern": ["*"] })
}

#[test]
fn a_ready_source_produces_the_same_glob_output() {
    let fixture = Fixture::new("ready");
    fixture.file("a.txt", "a");
    fixture.file("b.txt", "b");
    let cache = fixture.root.join("cache");
    std::fs::create_dir(&cache).unwrap();
    let walked = glob(&request(&fixture.root, None, glob_args(&fixture.root))).unwrap();
    let indexed = glob_with_source(
        &request(&fixture.root, Some(&cache), glob_args(&fixture.root)),
        &source(&fixture.root, &["a.txt", "b.txt"]),
    )
    .unwrap();

    assert_eq!(
        walked, indexed,
        "a revalidated index answer must be byte-identical to the walk"
    );
}

#[test]
fn a_cache_directory_without_a_ready_source_falls_back_to_the_walk() {
    let fixture = Fixture::new("fallback");
    fixture.file("a.txt", "a");
    fixture.file("b.txt", "b");
    let cache = fixture.root.join("cache");
    std::fs::create_dir(&cache).unwrap();
    let walked = glob(&request(&fixture.root, None, glob_args(&fixture.root))).unwrap();
    let with_cache = glob(&request(
        &fixture.root,
        Some(&cache),
        glob_args(&fixture.root),
    ))
    .unwrap();

    assert_eq!(
        walked, with_cache,
        "the platform source is not Ready in G3, so the answer is exactly the walk"
    );
}

#[test]
fn a_missing_cache_directory_still_serves_the_walk() {
    let fixture = Fixture::new("missing");
    fixture.file("a.txt", "a");
    let walked = glob(&request(&fixture.root, None, glob_args(&fixture.root))).unwrap();
    let with_missing_cache = glob(&request(
        &fixture.root,
        Some(&fixture.root.join("never-created")),
        glob_args(&fixture.root),
    ))
    .unwrap();

    assert_eq!(walked, with_missing_cache);
}

#[test]
fn the_cursor_kind_comes_from_the_continuation_prefix() {
    assert_eq!(SourceKind::from_token("s1:abc"), Some(SourceKind::Walk));
    assert_eq!(SourceKind::from_token("s2:abc"), Some(SourceKind::Index));
    assert_eq!(SourceKind::from_token("s3:abc"), None);
    assert_eq!(SourceKind::from_token(""), None);
}

#[test]
fn page_two_of_an_indexed_glob_is_not_stale() {
    let fixture = Fixture::new("page-two");
    for name in ["a.txt", "b.txt", "c.txt"] {
        fixture.file(name, name);
    }
    let cache = fixture.root.join("cache");
    std::fs::create_dir(&cache).unwrap();
    let source = source(&fixture.root, &["a.txt", "b.txt", "c.txt"]);
    let first = glob_with_source(
        &request(
            &fixture.root,
            Some(&cache),
            json!({ "path": fixture.root, "pattern": ["*"], "limit": 2 }),
        ),
        &source,
    )
    .unwrap();
    let token = first["continuation"]
        .as_str()
        .expect("a complete indexed page with more rows has a continuation")
        .to_owned();
    assert!(
        token.starts_with("s2:"),
        "an indexed continuation names the index kind"
    );

    let second = glob_with_source(
        &request(
            &fixture.root,
            Some(&cache),
            json!({ "path": fixture.root, "pattern": ["*"], "limit": 2, "offset": 2, "continuation": token }),
        ),
        &source,
    )
    .expect("page two of an indexed glob must not be stale");
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
}

#[test]
fn an_indexed_continuation_replayed_through_the_walk_is_stale() {
    let fixture = Fixture::new("stale");
    for name in ["a.txt", "b.txt", "c.txt"] {
        fixture.file(name, name);
    }
    let cache = fixture.root.join("cache");
    std::fs::create_dir(&cache).unwrap();
    let source = source(&fixture.root, &["a.txt", "b.txt", "c.txt"]);
    let first = glob_with_source(
        &request(
            &fixture.root,
            Some(&cache),
            json!({ "path": fixture.root, "pattern": ["*"], "limit": 2 }),
        ),
        &source,
    )
    .unwrap();
    let token = first["continuation"].as_str().unwrap().to_owned();

    // The cache is gone on page two: the walk serves the page, which is a
    // different snapshot domain than the one the token names.
    let error = glob(&request(
        &fixture.root,
        None,
        json!({ "path": fixture.root, "pattern": ["*"], "limit": 2, "offset": 2, "continuation": token }),
    ))
    .unwrap_err();
    assert_eq!(error.code, "SEARCH_STALE");
}

use std::cell::Cell;

struct CountingSource {
    inner: MemorySource,
    states: Cell<usize>,
    enumerates: Cell<usize>,
}

impl CountingSource {
    fn new(inner: MemorySource) -> Self {
        Self {
            inner,
            states: Cell::new(0),
            enumerates: Cell::new(0),
        }
    }
}

impl FsDataSource for CountingSource {
    fn state(&self, _root: &Path) -> SourceState {
        self.states.set(self.states.get() + 1);
        SourceState::Ready {
            snapshot: SnapshotId::new(1),
            consistent_at_ms: 0,
        }
    }

    fn enumerate(
        &self,
        root: &Path,
        budget: EnumBudget,
    ) -> std::result::Result<CandidateSet, SourceError> {
        self.enumerates.set(self.enumerates.get() + 1);
        self.inner.enumerate(root, budget)
    }

    fn changes(
        &self,
        root: &Path,
        since: SnapshotId,
    ) -> std::result::Result<Vec<Change>, SourceError> {
        self.inner.changes(root, since)
    }
}

#[test]
fn grep_never_consults_an_index_source() {
    let fixture = Fixture::new("grep-gate");
    fixture.file("a.txt", "hit\n");
    fixture.file("b.txt", "hit\n");
    let cache = fixture.root.join("cache");
    std::fs::create_dir(&cache).unwrap();
    let counting = CountingSource::new(source(&fixture.root, &["a.txt", "b.txt"]));
    let indexed = grep_with_source(
        &request(
            &fixture.root,
            Some(&cache),
            json!({ "path": fixture.root, "pattern": "hit" }),
        ),
        &counting,
    )
    .unwrap();
    let walked = grep(&request(
        &fixture.root,
        None,
        json!({ "path": fixture.root, "pattern": "hit" }),
    ))
    .unwrap();

    assert_eq!(
        indexed, walked,
        "grep keeps the walk even with a cache hint"
    );
    assert_eq!(
        counting.states.get(),
        0,
        "grep must never ask for source state"
    );
    assert_eq!(
        counting.enumerates.get(),
        0,
        "grep must never enumerate a source"
    );
}

#[cfg(all(windows, not(feature = "win-index")))]
#[test]
fn a_default_windows_build_never_serves_an_index() {
    let fixture = Fixture::new("win-default");
    fixture.file("a.txt", "a");
    let cache = fixture.root.join("cache");
    std::fs::create_dir(&cache).unwrap();
    let source = platform_source();
    assert!(
        matches!(source.state(&fixture.root), SourceState::Unsupported),
        "the default Windows build must not link the MFT source (#718)"
    );
    let walked = glob(&request(&fixture.root, None, glob_args(&fixture.root))).unwrap();
    let with_cache = glob(&request(&fixture.root, Some(&cache), glob_args(&fixture.root))).unwrap();
    assert_eq!(walked, with_cache, "the gated source still falls back to the walk");
}

#[cfg(all(windows, feature = "win-index"))]
#[test]
fn the_opt_in_windows_source_is_selected_but_never_ready() {
    let fixture = Fixture::new("win-optin");
    let source = platform_source();
    assert!(
        !matches!(source.state(&fixture.root), SourceState::Ready { .. }),
        "W1 has no watcher yet, so an opted-in build still walks"
    );
}
