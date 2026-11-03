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
fn before_the_baseline_is_adopted_every_path_is_conservatively_tracked() {
    let state = core();
    assert!(state.tracks(Path::new("unknown/dir")));
    assert!(state.tracks(Path::new("")));
}

#[test]
fn the_tracked_set_is_closed_under_ancestors() {
    let mut state = core();
    state.adopt_directories([PathBuf::from("a/b")]);
    assert!(state.tracks(Path::new("a/b")));
    assert!(state.tracks(Path::new("a")));
    assert!(state.tracks(Path::new("")));
    assert!(!state.tracks(Path::new("a/b/file.txt")));
    assert!(!state.tracks(Path::new("other")));
}

#[test]
fn an_empty_directory_set_still_tracks_the_root() {
    let mut state = core();
    state.adopt_directories(Vec::new());
    assert!(state.tracks(Path::new("")));
    assert!(!state.tracks(Path::new("x")));
}

#[test]
fn a_structural_change_requires_a_rescan() {
    let mut state = core();
    state.adopt_directories([PathBuf::from("dir")]);
    state.note_structure_changed();
    assert_eq!(
        state.invalidated(),
        Some(InvalidationReason::WatchedTreeMoved)
    );
    assert_eq!(
        InvalidationReason::WatchedTreeMoved.code(),
        "INDEX_WATCH_TREE_MOVED"
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
fn a_disconnected_channel_means_the_backend_is_lost() {
    let mut state = core();
    state.on_backend_disconnected();
    assert_eq!(state.invalidated(), Some(InvalidationReason::BackendLost));
}

#[test]
fn the_first_invalidation_reason_wins() {
    let mut state = core();
    state.note_queue_overflow();
    state.note_structure_changed();
    assert_eq!(state.invalidated(), Some(InvalidationReason::QueueOverflow));
}

#[test]
fn resync_baseline_clears_invalidation_and_replaces_the_directory_set() {
    let mut state = core();
    state.adopt_directories([PathBuf::from("old")]);
    state.note_structure_changed();
    state.resync_baseline([PathBuf::from("new")]);
    assert_eq!(state.invalidated(), None);
    assert!(state.tracks(Path::new("new")));
    assert!(!state.tracks(Path::new("old")));
}
