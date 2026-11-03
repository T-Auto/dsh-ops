use super::*;

fn core() -> SessionCore {
    SessionCore::new(PathBuf::from("/root"))
}

#[test]
fn a_queue_overflow_requires_a_rescan() {
    let mut state = core();
    state.note_queue_overflow();
    assert_eq!(state.invalidated(), Some(InvalidationReason::QueueOverflow));
    assert_eq!(
        InvalidationReason::QueueOverflow.code(),
        "INDEX_WATCH_QUEUE_OVERFLOW"
    );
}

#[test]
fn tracked_directories_and_their_ancestors_are_recognized() {
    let mut state = core();
    state.adopt_directories([PathBuf::from("a/b")]);
    assert!(state.tracks(Path::new("a/b")));
    assert!(state.tracks(Path::new("a")));
    assert!(!state.tracks(Path::new("a/b/file.txt")));
    assert!(!state.tracks(Path::new("other")));
}

#[test]
fn losing_a_tracked_directory_requires_a_rescan() {
    let mut state = core();
    state.adopt_directories([PathBuf::from("dir")]);
    state.note_tracked_tree_moved();
    assert_eq!(
        state.invalidated(),
        Some(InvalidationReason::WatchedTreeMoved)
    );
}

#[test]
fn a_directory_moved_into_the_tree_requires_a_rescan() {
    let mut state = core();
    state.note_directory_moved_in();
    assert_eq!(
        state.invalidated(),
        Some(InvalidationReason::WatchedTreeMoved)
    );
}

#[test]
fn a_native_failure_degrades_to_polling_and_requires_a_rescan() {
    let mut state = core();
    assert!(state.on_backend_error());
    assert_eq!(state.mode(), WatchMode::Polling);
    assert_eq!(
        state.invalidated(),
        Some(InvalidationReason::DegradedToPolling)
    );
    assert_eq!(
        InvalidationReason::DegradedToPolling.code(),
        "INDEX_WATCH_DEGRADED"
    );
}

#[test]
fn a_polling_failure_means_the_backend_is_lost() {
    let mut state = core();
    state.set_mode(WatchMode::Polling);
    assert!(!state.on_backend_error());
    assert_eq!(state.invalidated(), Some(InvalidationReason::BackendLost));
    assert_eq!(
        InvalidationReason::BackendLost.code(),
        "INDEX_WATCH_BACKEND_LOST"
    );
}

#[test]
fn the_first_invalidation_reason_wins() {
    let mut state = core();
    state.note_queue_overflow();
    state.note_tracked_tree_moved();
    assert_eq!(state.invalidated(), Some(InvalidationReason::QueueOverflow));
}

#[test]
fn resync_baseline_clears_invalidation_and_replaces_the_directory_set() {
    let mut state = core();
    state.adopt_directories([PathBuf::from("old")]);
    state.note_tracked_tree_moved();
    state.resync_baseline([PathBuf::from("new")]);
    assert_eq!(state.invalidated(), None);
    assert!(state.tracks(Path::new("new")));
    assert!(!state.tracks(Path::new("old")));
}
