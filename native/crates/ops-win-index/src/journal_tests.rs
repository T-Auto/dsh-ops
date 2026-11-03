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
    let first_stored = StoredCursor {
        cursor: JournalCursor::new(1, 10),
        consistent_at_ms: 111,
    };
    let first = store.save(root, first_stored).expect("first snapshot");
    assert_eq!(store.load_for_root(root), Some((first, first_stored)));
    assert_eq!(store.load_for_snapshot(root, first), Some(first_stored));

    let second_stored = StoredCursor {
        cursor: JournalCursor::new(1, 20),
        consistent_at_ms: 222,
    };
    let second = store.save(root, second_stored).expect("second snapshot");
    assert_ne!(first, second);
    assert_eq!(store.load_for_root(root), Some((second, second_stored)));
    assert_eq!(store.load_for_snapshot(root, first), Some(first_stored));
    assert_eq!(store.load_for_snapshot(root, SnapshotId::new(999)), None);
    assert_eq!(
        store.load_for_snapshot(Path::new("D:\\other"), first),
        None,
        "a snapshot is bound to the root it was saved for"
    );
}
