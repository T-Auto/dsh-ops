//! Tests for the bounded traversal and the indexed entry point.
//!
//! The live walk and `walk_indexed` must be indistinguishable in their output,
//! so every indexed case is compared against a walk over the same tree. The
//! source is `MemorySource` (never a platform source), which makes the same
//! assertions run on every OS.

use super::*;
use crate::paging::{Cursor, Page, finish};
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use ops_index::{
    Candidate, CandidateSet, Change, EntryKind, FileKey, MemorySource, NullSource, SnapshotId,
    SourceError, SourceState,
};

fn fixture() -> (PathBuf, Request) {
    let root = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!("dsh-search-budget-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    for name in ["a", "b", "c"] {
        fs::write(root.join(name), "hit\n").unwrap();
    }
    let request =
        serde_json::from_value(json!({"root":root,"scope":"scan-test","tool":"grep","args":{}}))
            .unwrap();
    (root, request)
}

#[test]
fn partial_directory_scan_reports_budget_and_bounded_gap_examples() {
    let (root, request) = fixture();
    for name in ["d1", "d2", "d3"] {
        fs::create_dir(root.join(name)).unwrap();
    }
    let mut scan = Scan::new();
    scan.max_depth = 0;
    scan.include_directories = true;
    let mut paths = Vec::new();
    scan.walk(&root, &["**".into()], &request, |path, _, _| {
        paths.push(path.to_owned());
        Ok(())
    })
    .unwrap();
    let output = report(&paths, scan, &request, 0, 100);
    assert_eq!(output["scanComplete"], false);
    assert_eq!(output["scannedFiles"], 3);
    assert_eq!(output["matchedObserved"], 6);
    assert_eq!(output["skipReasons"]["depth-limit"], 3);
    assert!(output.get("continuation").is_none());
    assert!(output.get("matchedTotal").is_none());
    let action = output["nextAction"].as_str().unwrap();
    assert!(action.contains("d1") && action.contains("d2"), "{action}");
    assert!(!action.contains("d3"), "samples must be bounded: {action}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn io_gap_examples_preserve_stable_codes_without_changing_reason_counts() {
    let mut scan = Scan::new();
    scan.skip_io(
        "unreadable-entry",
        Path::new("denied"),
        true,
        &std::io::Error::from(std::io::ErrorKind::PermissionDenied),
    );
    #[cfg(windows)]
    let long_path = 206;
    #[cfg(target_os = "linux")]
    let long_path = 36;
    #[cfg(target_os = "macos")]
    let long_path = 63;
    scan.skip_io(
        "unreadable-entry",
        Path::new("long"),
        true,
        &std::io::Error::from_raw_os_error(long_path),
    );
    assert_eq!(scan.reasons["unreadable-entry"], 2);
    assert_eq!(scan.gap_examples[0]["code"], "EACCES");
    assert_eq!(scan.gap_examples[1]["code"], "ENAMETOOLONG");
}

// Linux filesystems accept arbitrary name bytes; APFS rejects this fixture at creation.
#[cfg(target_os = "linux")]
#[test]
fn linux_non_utf8_directory_names_are_reported_as_gaps() {
    use std::os::unix::ffi::OsStrExt;
    let (root, request) = fixture();
    fs::create_dir(root.join(std::ffi::OsStr::from_bytes(b"bad-\xff"))).unwrap();
    let mut scan = Scan::new();
    scan.include_directories = true;
    scan.walk(&root, &["*".into()], &request, |_, _, _| Ok(()))
        .unwrap();
    assert!(!scan.complete());
    assert_eq!(scan.reasons["non-utf8-path"], 1);
    assert_eq!(scan.gap_examples[0]["path"], json!(root));
    fs::remove_dir_all(root).unwrap();
}

/// Builds a relative path with the host separator, so a verbatim Windows
/// fixture root never receives a forward slash inside a file name.
fn rel_path(rel: &str) -> PathBuf {
    rel.split('/')
        .fold(PathBuf::new(), |path, name| path.join(name))
}

/// A source candidate that matches what a real source would report for `rel`.
fn candidate(root: &Path, rel: &str) -> Candidate {
    let directory = Dir::open_ambient_dir(root, ambient_authority()).unwrap();
    let metadata = directory.symlink_metadata(rel_path(rel)).unwrap();
    let kind = if metadata.is_file() {
        EntryKind::File
    } else if metadata.is_dir() {
        EntryKind::Dir
    } else {
        EntryKind::Link
    };
    Candidate {
        rel: rel_path(rel),
        key: FileKey::new(metadata.dev(), metadata.ino()),
        kind,
        len: metadata.len(),
        modified_ns: None,
    }
}

/// Runs one scan through either path.
fn scan_path(
    root: &Path,
    request: &Request,
    patterns: &[String],
    source: Option<&dyn FsDataSource>,
) -> (Vec<PathBuf>, Scan) {
    let mut scan = Scan::new();
    let mut files = Vec::new();
    let mut each = |path: &Path, _metadata: &cap_std::fs::Metadata, _scan: &mut Scan| {
        files.push(path.to_path_buf());
        Ok(())
    };
    match source {
        Some(source) => {
            scan.walk_indexed(root, source, patterns, request, &mut each)
                .unwrap();
        }
        None => {
            scan.walk(root, patterns, request, &mut each).unwrap();
        }
    }
    (files, scan)
}

/// Finishes a single page, so the JSON a caller receives is comparable too.
fn report(files: &[PathBuf], scan: Scan, request: &Request, offset: usize, limit: usize) -> Value {
    let cursor = Cursor::new_for(request, scan.source, offset, None).unwrap();
    let mut page = Page::new(offset, limit, None);
    for (ordinal, file) in files.iter().enumerate() {
        page.push(json!(file), ordinal).unwrap();
    }
    finish(scan, cursor, page, files.len(), files.len(), json!({})).unwrap()
}

/// Ready source whose entries are `rels` under `root`.
fn source(root: &Path, rels: &[&str]) -> MemorySource {
    let entries = rels.iter().map(|rel| candidate(root, rel)).collect();
    MemorySource::ready(SnapshotId::new(1), entries)
}

/// Records how often the source is consulted.
struct CountingSource {
    inner: MemorySource,
    states: std::cell::Cell<usize>,
    enumerates: std::cell::Cell<usize>,
}

impl CountingSource {
    fn new(inner: MemorySource) -> Self {
        Self {
            inner,
            states: std::cell::Cell::new(0),
            enumerates: std::cell::Cell::new(0),
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
fn windows_delegation_keeps_reserved_names_as_scan_gaps_and_denials_case_insensitive() {
    let (root, mut request) = fixture();
    fs::write(root.join("NUL.txt"), "must not appear").unwrap();
    fs::create_dir(root.join("Private")).unwrap();
    fs::write(root.join("Private/token.txt"), "must not appear").unwrap();
    request.windows_paths = true;
    request.deny_roots = vec![root.join("private").to_string_lossy().into_owned()];
    let mut scan = Scan::new();
    let mut paths = Vec::new();
    scan.walk(&root, &[], &request, |path, _, _| {
        paths.push(path.file_name().unwrap().to_owned());
        Ok(())
    })
    .unwrap();
    assert_eq!(paths.len(), 3);
    assert!(!scan.complete());
    assert_eq!(scan.reasons.get("invalid-path"), Some(&1));
    assert_eq!(scan.reasons.get("credential"), Some(&1));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn file_entry_time_and_io_limits_never_claim_a_complete_scan() {
    let (root, request) = fixture();
    let mut scan = Scan::new();
    scan.max_files = 2;
    let mut paths = Vec::new();
    scan.walk(&root, &[], &request, |path, _, _| {
        paths.push(path.file_name().unwrap().to_owned());
        Ok(())
    })
    .unwrap();
    assert_eq!(paths.len(), 2);
    assert_eq!(scan.scanned, 2);
    assert!(!scan.complete());
    assert_eq!(scan.stopped, Some(TruncatedBy::ScanBudget));
    assert_eq!(scan.reasons["file-limit"], 1);
    let report = finish(
        scan,
        Cursor::new(&request, 0, None).unwrap(),
        Page::new(0, 1, None),
        paths.len(),
        paths.len(),
        json!({}),
    )
    .unwrap();
    assert_eq!(report["scanComplete"], false);
    assert!(report.get("matchedTotal").is_none());
    assert_eq!(report["truncatedBy"], "scan-budget");
    assert_eq!(report["skipReasons"]["file-limit"], 1);
    assert!(report.get("continuation").is_none());
    assert!(report["nextAction"].as_str().unwrap().contains("Narrow"));
    let indexed_source = source(&root, &["a", "b", "c"]);
    let mut indexed = Scan::new();
    indexed.max_files = 2;
    indexed
        .walk_indexed(&root, &indexed_source, &[], &request, |_, _, _| Ok(()))
        .unwrap();
    assert_eq!(indexed.reasons["file-limit"], 1);
    let mut scan = Scan::new();
    scan.entries = MAX_WALK_ENTRIES;
    scan.walk(&root, &[], &request, |_, _, _| {
        panic!("entry limit must stop before file processing")
    })
    .unwrap();
    assert!(!scan.complete());
    assert_eq!(scan.stopped, Some(TruncatedBy::ScanBudget));
    assert_eq!(scan.reasons["entry-limit"], 1);
    let mut scan = Scan::new();
    scan.timeout = Duration::ZERO;
    scan.walk(&root, &[], &request, |_, _, _| {
        panic!("expired scan must not run")
    })
    .unwrap();
    assert!(!scan.complete());
    assert_eq!(scan.stopped, Some(TruncatedBy::Time));
    let mut scan = Scan::new();
    scan.bytes = MAX_SCAN_BYTES;
    assert!(scan.read(&root.join("a")).is_none());
    assert!(!scan.complete());
    assert_eq!(scan.stopped, Some(TruncatedBy::ScanBudget));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn depth_limit_skips_only_the_subtree_and_preserves_later_siblings() {
    let (root, request) = fixture();
    fs::create_dir_all(root.join("a-deep/child")).unwrap();
    fs::write(root.join("a-deep/child/leaf"), "must not appear").unwrap();
    fs::create_dir(root.join("z-sibling")).unwrap();
    fs::write(root.join("z-sibling/after"), "hit").unwrap();
    fs::write(root.join("zz-later"), "hit").unwrap();
    let mut scan = Scan::new();
    scan.max_depth = 1;
    let mut paths = Vec::new();
    scan.walk(&root, &[], &request, |path, _, _| {
        paths.push(path.to_path_buf());
        Ok(())
    })
    .unwrap();
    let relative: Vec<String> = paths
        .iter()
        .map(|path| {
            path.strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    assert!(relative.contains(&"z-sibling/after".into()));
    assert!(relative.contains(&"zz-later".into()));
    assert!(!relative.iter().any(|path| path.ends_with("leaf")));
    assert_eq!(scan.reasons["depth-limit"], 1);
    assert_eq!(scan.stopped, None);
    assert!(!scan.complete());
    let output = report(&paths, scan, &request, 0, 100);
    assert_eq!(output["scanComplete"], false);
    assert_eq!(output["skipReasons"]["depth-limit"], 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn exclusions_are_counted_without_turning_them_into_unreadable_gaps() {
    let (root, request) = fixture();
    fs::write(root.join(".hidden"), "hit").unwrap();
    let mut scan = Scan::new();
    scan.walk(&root, &["a".into()], &request, |_, _, _| Ok(()))
        .unwrap();
    assert!(scan.complete());
    assert_eq!(scan.scanned, 3);
    assert_eq!(scan.skipped, 3);
    assert_eq!(scan.reasons["pattern"], 2);
    assert_eq!(scan.reasons["excluded"], 1);
    assert!(scan.read(&root.join("missing")).is_none());
    assert!(!scan.complete());
    assert_eq!(scan.reasons["read-error"], 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn indexed_and_walked_answers_are_byte_identical() {
    let (root, request) = fixture();
    fs::write(root.join(".hidden"), "hit").unwrap();
    let patterns: Vec<String> = vec!["b".into()];
    let source = source(&root, &["a", "b", "c", ".hidden"]);

    let (walked, walk_scan) = scan_path(&root, &request, &patterns, None);
    let (indexed, index_scan) = scan_path(&root, &request, &patterns, Some(&source));

    assert_eq!(
        walked, indexed,
        "both paths return the same items in the same order"
    );
    assert_eq!(walk_scan.scanned, index_scan.scanned);
    assert_eq!(walk_scan.skipped, index_scan.skipped);
    assert_eq!(walk_scan.reasons, index_scan.reasons);
    assert_eq!(walk_scan.failed, index_scan.failed);
    assert_eq!(walk_scan.complete(), index_scan.complete());
    assert_eq!(walk_scan.stopped, index_scan.stopped);
    assert_eq!(index_scan.source, SourceKind::Index);
    assert_eq!(
        report(&walked, walk_scan, &request, 0, 100),
        report(&indexed, index_scan, &request, 0, 100),
        "the JSON a caller receives is identical"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn walk_indexed_consults_the_source_once_and_falls_back_to_the_walk() {
    let (root, request) = fixture();
    let patterns: Vec<String> = vec!["*".into()];
    let (walked, walk_scan) = scan_path(&root, &request, &patterns, None);

    // No source wired: the walk, with the walk's counters.
    let (null_files, null_scan) = scan_path(&root, &request, &patterns, Some(&NullSource));
    assert_eq!(walked, null_files);
    assert_eq!(walk_scan.scanned, null_scan.scanned);
    assert_eq!(null_scan.source, SourceKind::Walk);

    // A ready source is asked exactly once, before any traversal starts.
    let counting = CountingSource::new(source(&root, &["a", "b", "c"]));
    let (indexed_files, index_scan) = scan_path(&root, &request, &patterns, Some(&counting));
    assert_eq!(walked, indexed_files);
    assert_eq!(
        counting.states.get(),
        1,
        "state is consulted once per request"
    );
    assert_eq!(
        counting.enumerates.get(),
        1,
        "enumerate is consulted once per request"
    );
    assert_eq!(index_scan.source, SourceKind::Index);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_truncated_indexed_answer_is_never_complete() {
    let (root, request) = fixture();
    let patterns: Vec<String> = vec!["*".into()];
    let truncated = source(&root, &["a", "b", "c"]).with_truncated(true);
    let (files, scan) = scan_path(&root, &request, &patterns, Some(&truncated));

    assert_eq!(files.len(), 3);
    assert!(!scan.complete());
    assert_eq!(scan.stopped, Some(TruncatedBy::ScanBudget));
    let report = report(&files, scan, &request, 0, 100);
    assert_eq!(report["scanComplete"], false);
    assert_eq!(report["truncatedBy"], "scan-budget");
    assert!(report.get("continuation").is_none());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn page_two_of_an_indexed_query_is_not_stale() {
    let (root, request) = fixture();
    let patterns: Vec<String> = vec!["*".into()];
    let source = source(&root, &["a", "b", "c"]);
    let (files, scan) = scan_path(&root, &request, &patterns, Some(&source));
    let cursor = Cursor::new_for(&request, scan.source, 0, None).unwrap();
    let mut page = Page::new(0, 2, None);
    for (ordinal, file) in files.iter().enumerate() {
        page.push(json!(file), ordinal).unwrap();
    }
    let first = finish(scan, cursor, page, files.len(), files.len(), json!({})).unwrap();
    let token = first["continuation"]
        .as_str()
        .expect("a complete page with more rows has a continuation")
        .to_owned();

    let cursor = Cursor::new_for(&request, SourceKind::Index, 2, Some(&token))
        .expect("page two of an indexed query must not be stale");
    let (files, scan) = scan_path(&root, &request, &patterns, Some(&source));
    let mut page = Page::new(2, 2, None);
    for (ordinal, file) in files.iter().enumerate() {
        page.push(json!(file), ordinal).unwrap();
    }
    finish(scan, cursor, page, files.len(), files.len(), json!({})).expect("page two finishes");

    // A walk cursor is a different consistency domain and must be stale here.
    assert!(Cursor::new_for(&request, SourceKind::Walk, 2, Some(&token)).is_err());
    assert!(Cursor::new(&request, 2, Some(&token)).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn walk_continuations_keep_the_existing_cursor_shape() {
    let (root, request) = fixture();
    let patterns: Vec<String> = vec!["*".into()];
    let (files, scan) = scan_path(&root, &request, &patterns, None);
    let cursor = Cursor::new(&request, 0, None).unwrap();
    let mut page = Page::new(0, 2, None);
    for (ordinal, file) in files.iter().enumerate() {
        page.push(json!(file), ordinal).unwrap();
    }
    let first = finish(scan, cursor, page, files.len(), files.len(), json!({})).unwrap();
    let token = first["continuation"]
        .as_str()
        .expect("walk continuation")
        .to_owned();
    assert!(
        token.starts_with("s1:"),
        "walk tokens keep their existing spelling"
    );
    assert!(Cursor::new(&request, 2, Some(&token)).is_ok());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_denied_root_is_never_enumerated() {
    let (root, mut request) = fixture();
    request.deny_roots = vec![root.to_string_lossy().into_owned()];
    let patterns: Vec<String> = vec!["*".into()];
    let counting = CountingSource::new(source(&root, &["a", "b", "c"]));
    let mut scan = Scan::new();
    let error = scan
        .walk_indexed(&root, &counting, &patterns, &request, |_, _, _| Ok(()))
        .unwrap_err();
    assert_eq!(
        error.code, "CREDENTIAL_DENIED",
        "authorization must precede enumeration"
    );
    assert_eq!(
        counting.states.get(),
        0,
        "a denied root must never reach the source state"
    );
    assert_eq!(
        counting.enumerates.get(),
        0,
        "a denied root must never be enumerated"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn snapshot_domains_differ_even_when_the_answers_match() {
    let (root, request) = fixture();
    let patterns: Vec<String> = vec!["*".into()];
    let source = source(&root, &["a", "b", "c"]);
    let (walked, walk_scan) = scan_path(&root, &request, &patterns, None);
    let (indexed, index_scan) = scan_path(&root, &request, &patterns, Some(&source));
    assert_eq!(walked, indexed);
    assert_eq!(walk_scan.scanned, index_scan.scanned);
    let walk_snapshot = format!("{:x}", walk_scan.hash.clone().finalize());
    let index_snapshot = format!("{:x}", index_scan.hash.clone().finalize());
    assert_ne!(
        walk_snapshot, index_snapshot,
        "the walk stamps the root and directories; the index path stamps only candidate files"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn finish_rejects_a_cursor_from_another_source_kind() {
    let (root, request) = fixture();
    let patterns: Vec<String> = vec!["*".into()];
    let source = source(&root, &["a", "b", "c"]);
    let (files, scan) = scan_path(&root, &request, &patterns, Some(&source));
    let cursor = Cursor::new_for(&request, scan.source, 0, None).unwrap();
    let mut page = Page::new(0, 2, None);
    for (ordinal, file) in files.iter().enumerate() {
        page.push(json!(file), ordinal).unwrap();
    }
    let first = finish(scan, cursor, page, files.len(), files.len(), json!({})).unwrap();
    let token = first["continuation"]
        .as_str()
        .expect("indexed continuation")
        .to_owned();

    // Page two parses the indexed cursor, but the source is gone, so the page
    // is produced by the walk: the two snapshot domains must not be mixed.
    let cursor = Cursor::new_for(&request, SourceKind::Index, 2, Some(&token)).unwrap();
    let mut scan = Scan::new();
    scan.walk_indexed(&root, &NullSource, &patterns, &request, |_, _, _| Ok(()))
        .unwrap();
    assert_eq!(scan.source, SourceKind::Walk);
    let error = finish(
        scan,
        cursor,
        Page::new(2, 2, None),
        files.len(),
        files.len(),
        json!({}),
    )
    .unwrap_err();
    assert_eq!(error.code, "SEARCH_STALE");
    fs::remove_dir_all(root).unwrap();
}
