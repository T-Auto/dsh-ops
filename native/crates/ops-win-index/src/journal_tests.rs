use std::path::Path;

use ops_index::SnapshotId;

use super::*;

#[test]
fn a_cursor_round_trips_through_its_encoding() {
    let cursor = JournalCursor::new(0x1234_5678_9abc_def0, 42);
    let encoded = cursor.encode();
    assert_eq!(JournalCursor::decode(&encoded), Some(cursor));
}

#[test]
fn decoding_rejects_foreign_versions_and_short_records() {
    let mut encoded = JournalCursor::new(1, 2).encode();
    assert_eq!(JournalCursor::decode(&encoded[..16]), None);
    encoded[0] = 9;
    assert_eq!(JournalCursor::decode(&encoded), None);
}

#[test]
fn converting_to_and_from_the_pure_cursor_is_lossless() {
    let saved = SavedCursor {
        journal_id: 7,
        next_usn: -3,
    };
    assert_eq!(JournalCursor::from_saved(saved).saved(), saved);
}

#[test]
fn replayability_follows_the_pure_truth_table() {
    let live = JournalInfo {
        journal_id: 7,
        first_usn: 100,
        next_usn: 500,
        lowest_valid_usn: 90,
        max_usn: 1_000,
    };
    assert!(is_replayable(JournalCursor::new(7, 300), &live));
    assert!(is_replayable(JournalCursor::new(7, 100), &live));
    assert!(is_replayable(JournalCursor::new(7, 500), &live));
    assert!(!is_replayable(JournalCursor::new(8, 300), &live));
    assert!(!is_replayable(JournalCursor::new(7, 99), &live));
    assert!(!is_replayable(JournalCursor::new(7, 501), &live));

    let restamped = JournalInfo {
        journal_id: 7,
        first_usn: 80,
        next_usn: 500,
        lowest_valid_usn: 90,
        max_usn: 1_000,
    };
    assert!(!is_replayable(JournalCursor::new(7, 85), &restamped));
}

#[test]
fn the_memory_store_round_trips_by_root_and_snapshot() {
    let store = MemoryCursorStore::new();
    let root = Path::new("C:\\work");
    let first = store
        .save(root, JournalCursor::new(1, 10))
        .expect("first snapshot");
    assert_eq!(
        store.load_for_root(root),
        Some((first, JournalCursor::new(1, 10)))
    );
    assert_eq!(store.load(first), Some(JournalCursor::new(1, 10)));

    let second = store
        .save(root, JournalCursor::new(1, 20))
        .expect("second snapshot");
    assert_ne!(first, second);
    assert_eq!(
        store.load_for_root(root),
        Some((second, JournalCursor::new(1, 20)))
    );
    assert_eq!(store.load(first), Some(JournalCursor::new(1, 10)));
    assert_eq!(store.load(SnapshotId::new(999)), None);
}
