//! Tests for candidate revalidation.
//!
//! The source is always `MemorySource` so every case runs on every OS; the
//! file system is a private temporary tree whose identities are read through
//! cap-std, never through a platform API.

use super::*;
use crate::scan::Scan;
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use ops_index::{CandidateSet, Change, MemorySource};
use serde_json::json;
use std::time::Duration;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("dsh-ops-candidates-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self { root }
    }

    fn file(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn dir(&self, rel: &str) {
        std::fs::create_dir_all(self.root.join(rel)).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn identity(root: &Path, rel: &str) -> (FileKey, EntryKind, u64) {
    let directory = Dir::open_ambient_dir(root, ambient_authority()).unwrap();
    let metadata = directory.symlink_metadata(rel).unwrap();
    let kind = if metadata.is_file() {
        EntryKind::File
    } else if metadata.is_dir() {
        EntryKind::Dir
    } else {
        EntryKind::Other
    };
    (
        FileKey::new(metadata.dev(), metadata.ino()),
        kind,
        metadata.len(),
    )
}

fn candidate(root: &Path, rel: &str) -> Candidate {
    let (key, kind, len) = identity(root, rel);
    Candidate {
        rel: PathBuf::from(rel),
        key,
        kind,
        len,
        modified_ns: None,
    }
}

fn vanished(rel: &str) -> Candidate {
    Candidate {
        rel: PathBuf::from(rel),
        key: FileKey::new(0, 0),
        kind: EntryKind::File,
        len: 0,
        modified_ns: None,
    }
}

fn drifted(mut candidate: Candidate) -> Candidate {
    candidate.key = FileKey::new(candidate.key.volume, candidate.key.file.wrapping_add(1));
    candidate
}

fn request(root: &Path) -> Request {
    serde_json::from_value(json!({
        "root": root,
        "scope": "candidates",
        "tool": "glob",
        "args": {}
    }))
    .unwrap()
}

fn denying_request(root: &Path) -> Request {
    serde_json::from_value(json!({
        "root": root,
        "scope": "candidates",
        "tool": "glob",
        "args": {},
        "deny_credential_names": true
    }))
    .unwrap()
}

fn budget() -> EnumBudget {
    EnumBudget::with_timeout(100_000, 128, Duration::from_secs(30))
}

fn ready(outcome: Outcome) -> Batch {
    match outcome {
        Outcome::Ready(batch) => batch,
        Outcome::Fallback(fallback) => panic!("expected a ready batch, got {fallback:?}"),
    }
}

fn fallback(outcome: Outcome) -> Fallback {
    match outcome {
        Outcome::Fallback(fallback) => fallback,
        Outcome::Ready(batch) => panic!(
            "expected a fallback, got {} accepted candidates",
            batch.fresh.len()
        ),
    }
}

fn sorted_rels(batch: &Batch) -> Vec<PathBuf> {
    batch
        .fresh
        .iter()
        .map(|fresh| fresh.candidate.rel.clone())
        .collect()
}

#[derive(Default)]
struct FaultyInspect {
    faults: BTreeMap<PathBuf, InspectError>,
}

impl FaultyInspect {
    fn fail(&mut self, path: PathBuf, error: InspectError) {
        self.faults.insert(path, error);
    }
}

impl Inspect for FaultyInspect {
    fn leaf(&self, parent: &Path, name: &str) -> Result<Metadata, InspectError> {
        if let Some(error) = self.faults.get(&parent.join(name)) {
            return Err(*error);
        }
        HostInspect.leaf(parent, name)
    }
}

struct LateSource {
    entries: Vec<Candidate>,
}

impl FsDataSource for LateSource {
    fn state(&self, _root: &Path) -> SourceState {
        SourceState::Ready {
            snapshot: SnapshotId::new(7),
            consistent_at_ms: 0,
        }
    }

    fn enumerate(&self, _root: &Path, _budget: EnumBudget) -> Result<CandidateSet, SourceError> {
        Ok(CandidateSet {
            entries: self.entries.clone(),
            truncated: false,
            consistent_at_ms: 0,
        })
    }

    fn changes(&self, _root: &Path, _since: SnapshotId) -> Result<Vec<Change>, SourceError> {
        Err(SourceError::Unsupported)
    }
}

#[test]
fn skip_reasons_keep_the_walk_vocabulary() {
    let cases = [
        (SkipReason::InvalidPath, "invalid-path", true, false),
        (SkipReason::NonUtf8Path, "non-utf8-path", true, false),
        (SkipReason::Symlink, "symlink", false, false),
        (SkipReason::Credential, "credential", false, true),
        (SkipReason::Excluded, "excluded", false, true),
        (SkipReason::Unsupported, "unsupported-entry", false, false),
        (SkipReason::Unreadable, "unreadable-entry", true, false),
    ];
    for (reason, name, gap, file) in cases {
        assert_eq!(reason.as_str(), name);
        assert_eq!(reason.is_gap(), gap, "{name}");
        assert_eq!(reason.counts_file(), file, "{name}");
    }
    let skip = Skip {
        rel: PathBuf::from("a"),
        reason: SkipReason::Unreadable,
        file: false,
    };
    assert!(skip.gap());
}

#[test]
fn host_errors_map_to_the_walk_classes() {
    assert_eq!(
        io_to_inspect(io::Error::from(io::ErrorKind::PermissionDenied)),
        InspectError::Unreadable
    );
    assert_eq!(
        io_to_inspect(io::Error::from(io::ErrorKind::NotFound)),
        InspectError::Stale
    );
    assert_eq!(
        io_to_inspect(io::Error::from(io::ErrorKind::NotADirectory)),
        InspectError::Stale
    );
    assert_eq!(
        io_to_inspect(io::Error::from(io::ErrorKind::Other)),
        InspectError::Unverified
    );
    assert_eq!(
        failure_to_inspect(Failure::from(io::Error::from(
            io::ErrorKind::PermissionDenied
        ))),
        InspectError::Unreadable
    );
    assert_eq!(
        failure_to_inspect(Failure::from(io::Error::from(io::ErrorKind::NotFound))),
        InspectError::Stale
    );
    assert_eq!(
        failure_to_inspect(Failure::new("PATH_RESTRICTED", "link")),
        InspectError::AncestorLink
    );
    assert_eq!(
        failure_to_inspect(Failure::new("IO_ERROR", "eio")),
        InspectError::Unverified
    );
}

#[test]
fn an_expired_deadline_stops_revalidation_even_if_the_source_ignores_it() {
    let fixture = Fixture::new("deadline");
    fixture.file("a.txt", b"a");
    let source = LateSource {
        entries: vec![candidate(&fixture.root, "a.txt")],
    };
    let failure = fallback(collect(
        &fixture.root,
        &request(&fixture.root),
        &source,
        EnumBudget::with_timeout(100, 128, Duration::ZERO),
    ));

    assert_eq!(failure.kind, FallbackKind::Source(SourceError::Budget));
    assert_eq!(failure.rel, None);
}

#[test]
fn a_root_that_is_not_absolute_is_never_revalidated() {
    let source = MemorySource::ready(SnapshotId::new(1), Vec::new());
    let failure = fallback(collect(
        Path::new("relative-root"),
        &request(Path::new("/tmp")),
        &source,
        budget(),
    ));

    assert_eq!(failure.kind, FallbackKind::Unverified);
    assert_eq!(failure.rel, None);
}

#[test]
fn fresh_candidates_are_revalidated_in_component_order() {
    let fixture = Fixture::new("fresh");
    for rel in ["a.txt", "a/x.txt", "a-b.txt", "b.txt"] {
        fixture.file(rel, rel.as_bytes());
    }
    let mut entries: Vec<_> = ["b.txt", "a.txt", "a/x.txt", "a-b.txt"]
        .iter()
        .map(|rel| candidate(&fixture.root, rel))
        .collect();
    entries.push(candidate(&fixture.root, "b.txt"));
    // A directory candidate is traversal state, not an item and not a skip.
    entries.push(candidate(&fixture.root, "a"));
    let source =
        MemorySource::ready(SnapshotId::new(42), entries).with_consistent_at(1_700_000_000_123);
    let request = request(&fixture.root);
    let batch = ready(collect(&fixture.root, &request, &source, budget()));

    assert_eq!(batch.snapshot, SnapshotId::new(42));
    assert_eq!(batch.consistent_at_ms, 1_700_000_000_123);
    assert_eq!(batch.entries, 5, "exact duplicate paths are dropped once");
    assert_eq!(
        sorted_rels(&batch),
        ["a/x.txt", "a-b.txt", "a.txt", "b.txt"]
            .map(PathBuf::from)
            .to_vec(),
        "component order, not a rendered-string order"
    );
    assert_eq!(batch.stale, 0);
    assert!(batch.skipped.is_empty());
    assert!(!batch.truncated);
    assert!(batch.fresh.iter().all(|fresh| fresh.metadata.is_file()));

    let mut scan = Scan::new();
    let mut walked = Vec::new();
    scan.walk(&fixture.root, &[], &request, |path, _, _| {
        walked.push(path.to_path_buf());
        Ok(())
    })
    .unwrap();
    let indexed: Vec<_> = batch.fresh.iter().map(|fresh| fresh.path.clone()).collect();
    assert_eq!(walked, indexed, "an indexed answer keeps the walk's order");
}

#[test]
fn a_vanished_candidate_is_silent_and_never_a_skip_reason() {
    let fixture = Fixture::new("stale");
    fixture.file("present.txt", b"p");
    let source = MemorySource::ready(
        SnapshotId::new(1),
        vec![
            candidate(&fixture.root, "present.txt"),
            vanished("gone.txt"),
            vanished("gone-dir/nested.txt"),
        ],
    );
    let batch = ready(collect(
        &fixture.root,
        &request(&fixture.root),
        &source,
        budget(),
    ));

    assert_eq!(sorted_rels(&batch), vec![PathBuf::from("present.txt")]);
    assert_eq!(batch.stale, 2);
    assert!(
        batch.skipped.is_empty(),
        "the walk would not have listed a vanished path either"
    );
    assert_eq!(batch.gaps(), 0);
    assert_eq!(batch.skipped_files(), 0);
}

#[test]
fn identity_drift_invalidates_the_whole_query() {
    let fixture = Fixture::new("drift");
    fixture.file("a.txt", b"a");
    fixture.file("b.txt", b"b");
    let source = MemorySource::ready(
        SnapshotId::new(1),
        vec![
            candidate(&fixture.root, "b.txt"),
            drifted(candidate(&fixture.root, "a.txt")),
        ],
    );
    let failure = fallback(collect(
        &fixture.root,
        &request(&fixture.root),
        &source,
        budget(),
    ));

    assert_eq!(failure.kind, FallbackKind::IdDrift);
    assert_eq!(failure.rel.as_deref(), Some(Path::new("a.txt")));
}

#[test]
fn an_unreadable_candidate_is_a_gap_not_a_silent_drop() {
    let fixture = Fixture::new("eacces");
    fixture.file("secret.txt", b"s");
    let source = MemorySource::ready(
        SnapshotId::new(1),
        vec![candidate(&fixture.root, "secret.txt")],
    );
    let mut faults = FaultyInspect::default();
    faults.fail(fixture.root.join("secret.txt"), InspectError::Unreadable);
    let request = request(&fixture.root);
    let batch = ready(collect_with(
        &fixture.root,
        &request,
        &source,
        budget(),
        &faults,
    ));

    assert!(batch.fresh.is_empty());
    assert_eq!(batch.skipped.len(), 1);
    assert_eq!(batch.skipped[0].reason, SkipReason::Unreadable);
    assert_eq!(batch.skipped[0].rel, PathBuf::from("secret.txt"));
    assert!(!batch.skipped[0].file, "the walk has no metadata to count");
    assert_eq!(batch.reasons().get("unreadable-entry"), Some(&1));
    assert_eq!(batch.gaps(), 1);
    assert_eq!(batch.skipped_files(), 0);
}

#[test]
fn a_truncated_enumeration_is_reported_as_incomplete() {
    let fixture = Fixture::new("truncated");
    for rel in ["a.txt", "b.txt"] {
        fixture.file(rel, rel.as_bytes());
    }
    let entries = vec![
        candidate(&fixture.root, "a.txt"),
        candidate(&fixture.root, "b.txt"),
    ];
    let request = request(&fixture.root);

    let marked = MemorySource::ready(SnapshotId::new(1), entries.clone()).with_truncated(true);
    let batch = ready(collect(&fixture.root, &request, &marked, budget()));
    assert_eq!(batch.fresh.len(), 2);
    assert!(
        batch.truncated,
        "a truncated set is never a complete answer"
    );

    let capped = MemorySource::ready(SnapshotId::new(1), entries);
    let batch = ready(collect(
        &fixture.root,
        &request,
        &capped,
        EnumBudget::with_timeout(1, 128, Duration::from_secs(30)),
    ));
    assert_eq!(batch.entries, 1);
    assert_eq!(batch.fresh.len(), 1);
    assert!(batch.truncated);
}

#[test]
fn a_source_that_cannot_serve_the_root_falls_back() {
    let fixture = Fixture::new("source");
    let request = request(&fixture.root);

    let failure = fallback(collect(
        &fixture.root,
        &request,
        &MemorySource::unsupported(),
        budget(),
    ));
    assert_eq!(failure.kind, FallbackKind::Source(SourceError::Unsupported));
    assert_eq!(failure.rel, None);

    let failure = fallback(collect(
        &fixture.root,
        &request,
        &MemorySource::unavailable(),
        budget(),
    ));
    assert_eq!(failure.kind, FallbackKind::Source(SourceError::NotReady));

    let failed = MemorySource::ready(SnapshotId::new(1), Vec::new())
        .with_enumerate_error(SourceError::Io(std::io::ErrorKind::PermissionDenied));
    let failure = fallback(collect(&fixture.root, &request, &failed, budget()));
    assert_eq!(
        failure.kind,
        FallbackKind::Source(SourceError::Io(std::io::ErrorKind::PermissionDenied))
    );
}

#[test]
fn leaf_exclusions_and_credentials_match_the_walk_counters() {
    let fixture = Fixture::new("skips");
    fixture.file("visible.txt", b"v");
    fixture.file(".hidden", b"h");
    fixture.file("id_rsa", b"k");
    let request = denying_request(&fixture.root);
    let source = MemorySource::ready(
        SnapshotId::new(9),
        vec![
            candidate(&fixture.root, "visible.txt"),
            candidate(&fixture.root, ".hidden"),
            candidate(&fixture.root, "id_rsa"),
        ],
    );
    let batch = ready(collect(&fixture.root, &request, &source, budget()));

    assert_eq!(sorted_rels(&batch), vec![PathBuf::from("visible.txt")]);
    assert_eq!(
        batch
            .skipped
            .iter()
            .map(|skip| (skip.rel.clone(), skip.reason, skip.file))
            .collect::<Vec<_>>(),
        vec![
            (PathBuf::from(".hidden"), SkipReason::Excluded, true),
            (PathBuf::from("id_rsa"), SkipReason::Credential, true),
        ]
    );
    assert_eq!(batch.gaps(), 0);
    assert_eq!(batch.skipped_files(), 2);

    let mut scan = Scan::new();
    let mut walked = Vec::new();
    scan.walk(&fixture.root, &[], &request, |path, _, _| {
        walked.push(path.to_path_buf());
        Ok(())
    })
    .unwrap();
    let indexed: Vec<_> = batch.fresh.iter().map(|fresh| fresh.path.clone()).collect();
    assert_eq!(walked, indexed);
    assert_eq!(scan.reasons, batch.reasons());
    assert_eq!(scan.skipped, batch.skipped_files());
    assert_eq!(scan.gap, batch.gaps() > 0);
}

#[test]
fn a_candidate_below_a_pruned_directory_falls_back_instead_of_guessing() {
    let fixture = Fixture::new("pruned");
    fixture.file(".git/config", b"c");
    fixture.dir("node_modules");
    fixture.file("node_modules/dep.txt", b"d");
    let source = MemorySource::ready(
        SnapshotId::new(1),
        vec![
            candidate(&fixture.root, ".git/config"),
            candidate(&fixture.root, "node_modules/dep.txt"),
        ],
    );
    let failure = fallback(collect(
        &fixture.root,
        &request(&fixture.root),
        &source,
        budget(),
    ));

    assert_eq!(failure.kind, FallbackKind::Unverified);
    assert_eq!(failure.rel.as_deref(), Some(Path::new(".git/config")));
}

#[test]
fn a_file_that_became_a_directory_invalidates_the_batch() {
    let fixture = Fixture::new("kind");
    fixture.dir("a.txt");
    let mut became_directory = candidate(&fixture.root, "a.txt");
    became_directory.kind = EntryKind::File;
    let source = MemorySource::ready(SnapshotId::new(1), vec![became_directory]);
    let failure = fallback(collect(
        &fixture.root,
        &request(&fixture.root),
        &source,
        budget(),
    ));

    assert_eq!(failure.kind, FallbackKind::KindChanged);
    assert_eq!(failure.rel.as_deref(), Some(Path::new("a.txt")));
}

#[test]
fn an_ancestor_link_invalidates_the_batch() {
    let fixture = Fixture::new("ancestor");
    fixture.file("a.txt", b"a");
    let source = MemorySource::ready(SnapshotId::new(1), vec![candidate(&fixture.root, "a.txt")]);
    let mut faults = FaultyInspect::default();
    faults.fail(fixture.root.join("a.txt"), InspectError::AncestorLink);
    let request = request(&fixture.root);
    let failure = fallback(collect_with(
        &fixture.root,
        &request,
        &source,
        budget(),
        &faults,
    ));

    assert_eq!(failure.kind, FallbackKind::AncestorLink);
    assert_eq!(failure.rel.as_deref(), Some(Path::new("a.txt")));
}
