use super::*;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn candidate(rel: &str, file: u64) -> Candidate {
    Candidate {
        rel: PathBuf::from(rel),
        key: FileKey::new(1, file),
        kind: EntryKind::File,
        len: file,
        modified_ns: Some(1_700_000_000_000_000_000),
    }
}

fn budget(max_entries: usize, max_depth: usize) -> EnumBudget {
    EnumBudget::with_timeout(max_entries, max_depth, Duration::from_secs(30))
}

#[test]
fn null_source_is_always_unsupported() {
    let source = NullSource;
    let root = Path::new("/root");
    assert_eq!(source.state(root), SourceState::Unsupported);
    assert_eq!(
        source.enumerate(root, budget(1, 1)),
        Err(SourceError::Unsupported)
    );
    assert_eq!(
        source.changes(root, SnapshotId::new(1)),
        Err(SourceError::Unsupported)
    );
}

#[test]
fn null_source_works_through_a_trait_object() {
    let source: &dyn FsDataSource = &NullSource;
    assert!(!source.state(Path::new("/")).is_ready());
}

#[test]
fn source_states_expose_snapshot_and_timestamp_only_when_ready() {
    let ready = SourceState::Ready {
        snapshot: SnapshotId::new(9),
        consistent_at_ms: 1_700,
    };
    assert!(ready.is_ready());
    assert_eq!(ready.snapshot(), Some(SnapshotId::new(9)));
    assert_eq!(ready.consistent_at_ms(), Some(1_700));
    assert!(!SourceState::Unsupported.is_ready());
    assert_eq!(SourceState::Unsupported.snapshot(), None);
    assert!(!SourceState::Unavailable.is_ready());
    assert_eq!(SourceState::Unavailable.consistent_at_ms(), None);
    assert_eq!(SourceState::default(), SourceState::Unsupported);
}

#[test]
fn memory_source_returns_ready_entries_and_its_consistency_stamp() {
    let source = MemorySource::ready(SnapshotId::new(3), vec![candidate("a.txt", 1)])
        .with_consistent_at(1_780)
        .with_entry(candidate("dir/b.txt", 2));
    let set = source.enumerate(Path::new("/"), budget(10, 4)).unwrap();
    assert_eq!(set.entries.len(), 2);
    assert!(!set.truncated);
    assert_eq!(set.consistent_at_ms, 1_780);
    assert_eq!(
        source.state(Path::new("/")).snapshot(),
        Some(SnapshotId::new(3))
    );
}

#[test]
fn memory_source_enforces_the_entry_budget_and_reports_truncation() {
    let source = MemorySource::ready(
        SnapshotId::new(1),
        vec![candidate("a", 1), candidate("b", 2), candidate("c", 3)],
    );
    let set = source.enumerate(Path::new("/"), budget(2, 8)).unwrap();
    assert_eq!(set.entries.len(), 2);
    assert_eq!(set.entries[1].rel, PathBuf::from("b"));
    assert!(set.truncated, "a cut set must never look complete");
}

#[test]
fn memory_source_drops_entries_beyond_the_depth_budget() {
    let source = MemorySource::ready(
        SnapshotId::new(1),
        vec![
            candidate("a", 1),
            candidate("a/b", 2),
            candidate("a/b/c", 3),
        ],
    );
    let set = source.enumerate(Path::new("/"), budget(10, 2)).unwrap();
    assert_eq!(set.entries.len(), 2);
    assert!(set.truncated);
}

#[test]
fn memory_source_reports_an_expired_deadline_as_a_budget_failure() {
    let source = MemorySource::ready(SnapshotId::new(1), vec![candidate("a", 1)]);
    let expired = EnumBudget::new(10, 8, Instant::now() - Duration::from_millis(1));
    assert!(expired.expired());
    assert_eq!(
        source.enumerate(Path::new("/"), expired),
        Err(SourceError::Budget)
    );
}

#[test]
fn budget_helpers_expose_remaining_time() {
    let budget = EnumBudget::with_timeout(1, 1, Duration::from_secs(60));
    assert!(!budget.expired());
    assert!(
        budget
            .remaining()
            .is_some_and(|left| left <= Duration::from_secs(60))
    );
    let past = EnumBudget::new(1, 1, Instant::now() - Duration::from_secs(1));
    assert_eq!(past.remaining(), None);
}

#[test]
fn memory_source_reports_states_and_injected_io_failures() {
    let unsupported = MemorySource::unsupported();
    assert_eq!(
        unsupported.enumerate(Path::new("/"), budget(1, 1)),
        Err(SourceError::Unsupported)
    );
    let unavailable = MemorySource::unavailable();
    assert_eq!(
        unavailable.changes(Path::new("/"), SnapshotId::new(0)),
        Err(SourceError::NotReady)
    );
    let missing = MemorySource::ready(SnapshotId::new(1), Vec::new())
        .with_enumerate_error(SourceError::Io(std::io::ErrorKind::NotFound));
    assert_eq!(
        missing.enumerate(Path::new("/"), budget(1, 1)),
        Err(SourceError::Io(std::io::ErrorKind::NotFound))
    );
    let denied = MemorySource::ready(SnapshotId::new(1), Vec::new())
        .with_changes_error(SourceError::Io(std::io::ErrorKind::PermissionDenied));
    assert_eq!(
        denied.changes(Path::new("/"), SnapshotId::new(1)),
        Err(SourceError::Io(std::io::ErrorKind::PermissionDenied))
    );
}

#[test]
fn memory_source_replays_injected_changes() {
    let change = Change {
        rel: PathBuf::from("dir/renamed.txt"),
        key: FileKey::new(2, 7),
        action: ChangeAction::Renamed,
    };
    let source = MemorySource::ready(SnapshotId::new(4), Vec::new())
        .with_change(change.clone())
        .with_truncated(true);
    assert_eq!(
        source.changes(Path::new("/"), SnapshotId::new(4)),
        Ok(vec![change])
    );
    assert!(
        source
            .enumerate(Path::new("/"), budget(4, 4))
            .unwrap()
            .truncated
    );
}

#[test]
fn candidate_kind_helpers_classify_entries() {
    let file = candidate("a.txt", 1);
    assert!(file.is_file());
    assert!(!file.is_dir());
    let dir = Candidate {
        kind: EntryKind::Dir,
        ..file
    };
    assert!(dir.is_dir());
}

#[test]
fn source_error_codes_and_display_are_stable() {
    assert_eq!(SourceError::Unsupported.code(), "INDEX_SOURCE_UNSUPPORTED");
    assert_eq!(SourceError::NotReady.code(), "INDEX_SOURCE_NOT_READY");
    assert_eq!(SourceError::Budget.code(), "INDEX_SOURCE_BUDGET");
    assert_eq!(
        SourceError::Io(std::io::ErrorKind::Other).code(),
        "INDEX_SOURCE_IO"
    );
    assert!(SourceError::Budget.to_string().contains("budget"));
    let _: &dyn std::error::Error = &SourceError::Unsupported;
}
