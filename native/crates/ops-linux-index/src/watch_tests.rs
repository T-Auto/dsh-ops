use super::*;
use notify::event::{CreateKind, Flag, RemoveKind};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A unique directory tree under the system temp dir, removed on drop.
struct TempTree {
    root: PathBuf,
}

impl TempTree {
    fn new(label: &str) -> Self {
        let unique = format!(
            "ops-linux-watch-{}-{}-{label}",
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

    fn file(&self, rel: &str) -> PathBuf {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, b"x").unwrap();
        path
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn limits() -> WatchLimits {
    WatchLimits {
        max_user_watches: 65_536,
        max_user_instances: 128,
        max_queued_events: 16_384,
    }
}

fn no_budget() -> WatchLimits {
    WatchLimits {
        max_user_watches: 0,
        ..limits()
    }
}

fn core(root: &Path) -> SessionCore {
    SessionCore::new(root.to_path_buf())
}

fn event_with(kind: EventKind, paths: &[&str]) -> Event {
    paths.iter().fold(Event::new(kind), |event, path| {
        event.add_path(PathBuf::from(path))
    })
}

/// Polls until `predicate` matches or ten seconds pass.
fn wait_for(
    session: &mut WatchSession,
    predicate: impl Fn(&WatchUpdate) -> bool,
) -> Option<WatchUpdate> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let update = session.poll();
        if predicate(&update) {
            return Some(update);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn maps_create_remove_modify_and_rename_events() {
    let root = Path::new("/root");
    let mut state = core(root);

    let created = event_with(
        EventKind::Create(CreateKind::File),
        &["/root/a.txt", "/outside/ignored.txt"],
    );
    assert_eq!(
        state.on_event(&created),
        vec![WatchEvent {
            rel: PathBuf::from("a.txt"),
            action: ChangeAction::Added,
        }]
    );

    let removed = event_with(EventKind::Remove(RemoveKind::File), &["/root/old.txt"]);
    assert_eq!(
        state.on_event(&removed),
        vec![WatchEvent {
            rel: PathBuf::from("old.txt"),
            action: ChangeAction::Removed,
        }]
    );

    let modified = event_with(
        EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
        &["/root/data.bin"],
    );
    assert_eq!(
        state.on_event(&modified),
        vec![WatchEvent {
            rel: PathBuf::from("data.bin"),
            action: ChangeAction::Modified,
        }]
    );

    let renamed = event_with(
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
        &["/root/from.txt", "/root/to.txt"],
    );
    assert_eq!(
        state.on_event(&renamed),
        vec![
            WatchEvent {
                rel: PathBuf::from("from.txt"),
                action: ChangeAction::Removed,
            },
            WatchEvent {
                rel: PathBuf::from("to.txt"),
                action: ChangeAction::Added,
            },
        ]
    );

    let accessed = event_with(
        EventKind::Access(notify::event::AccessKind::Any),
        &["/root/read.txt"],
    );
    assert!(state.on_event(&accessed).is_empty());
}

#[test]
fn a_rescan_flag_invalidates_before_any_mapping() {
    let mut state = core(Path::new("/root"));
    let overflow = Event::new(EventKind::Other).set_flag(Flag::Rescan);
    assert!(state.on_event(&overflow).is_empty());
    assert_eq!(state.invalidated, Some(InvalidationReason::QueueOverflow));
    assert_eq!(
        InvalidationReason::QueueOverflow.code(),
        "INDEX_WATCH_QUEUE_OVERFLOW"
    );
}

#[test]
fn removing_a_tracked_directory_invalidates_the_snapshot() {
    let mut state = core(Path::new("/root"));
    state.adopt_directories([PathBuf::from("dir")]);
    let removed = event_with(EventKind::Remove(RemoveKind::Folder), &["/root/dir"]);
    state.on_event(&removed);
    assert_eq!(
        state.invalidated,
        Some(InvalidationReason::WatchedTreeMoved)
    );
}

#[test]
fn removing_a_file_is_not_a_structural_change() {
    let mut state = core(Path::new("/root"));
    state.adopt_directories([PathBuf::from("dir")]);
    let removed = event_with(EventKind::Remove(RemoveKind::File), &["/root/dir/file.txt"]);
    let mapped = state.on_event(&removed);
    assert_eq!(mapped.len(), 1);
    assert_eq!(state.invalidated, None);
}

#[test]
fn removing_an_ancestor_of_a_tracked_directory_invalidates() {
    let mut state = core(Path::new("/root"));
    state.adopt_directories([PathBuf::from("a/b")]);
    let removed = event_with(EventKind::Remove(RemoveKind::Folder), &["/root/a"]);
    state.on_event(&removed);
    assert_eq!(
        state.invalidated,
        Some(InvalidationReason::WatchedTreeMoved)
    );
}

#[test]
fn a_directory_moved_into_the_tree_invalidates() {
    let tree = TempTree::new("moved-in");
    tree.dir("newdir");
    let mut state = core(&tree.root);
    let moved = event_with(
        EventKind::Modify(ModifyKind::Name(RenameMode::To)),
        &[tree.root.join("newdir").to_str().unwrap()],
    );
    state.on_event(&moved);
    assert_eq!(
        state.invalidated,
        Some(InvalidationReason::WatchedTreeMoved)
    );
}

#[test]
fn a_file_renamed_into_the_tree_is_a_plain_add() {
    let tree = TempTree::new("file-moved-in");
    tree.file("new.txt");
    let mut state = core(&tree.root);
    let moved = event_with(
        EventKind::Modify(ModifyKind::Name(RenameMode::To)),
        &[tree.root.join("new.txt").to_str().unwrap()],
    );
    assert_eq!(state.on_event(&moved).len(), 1);
    assert_eq!(state.invalidated, None);
}

#[test]
fn a_native_failure_degrades_to_polling_and_requires_a_rescan() {
    let mut state = core(Path::new("/root"));
    assert!(state.on_backend_error());
    assert_eq!(state.mode, WatchMode::Polling);
    assert_eq!(
        state.invalidated,
        Some(InvalidationReason::DegradedToPolling)
    );
}

#[test]
fn a_polling_failure_means_the_backend_is_lost() {
    let mut state = core(Path::new("/root"));
    state.mode = WatchMode::Polling;
    assert!(!state.on_backend_error());
    assert_eq!(state.invalidated, Some(InvalidationReason::BackendLost));
    assert_eq!(
        InvalidationReason::BackendLost.code(),
        "INDEX_WATCH_BACKEND_LOST"
    );
}

#[test]
fn resync_baseline_clears_invalidation_and_replaces_the_directory_set() {
    let mut state = core(Path::new("/root"));
    state.adopt_directories([PathBuf::from("old")]);
    state.invalidate(InvalidationReason::WatchedTreeMoved);
    state.resync_baseline([PathBuf::from("new")]);
    assert_eq!(state.invalidated, None);
    assert!(state.tracks(Path::new("new")));
    assert!(!state.tracks(Path::new("old")));
}

#[test]
fn notify_errors_map_onto_the_limit_policy() {
    use notify::Error;
    assert_eq!(
        classify_notify_error(Error::new(notify::ErrorKind::MaxFilesWatch)),
        DegradeReason::WatchLimitExhausted
    );
    assert_eq!(
        classify_notify_error(Error::io(std::io::Error::from(
            std::io::ErrorKind::StorageFull
        ))),
        DegradeReason::WatchLimitExhausted
    );
    assert_eq!(
        classify_notify_error(Error::path_not_found()),
        DegradeReason::Io(std::io::ErrorKind::Other)
    );
    assert_eq!(
        DegradeReason::WatchLimitExhausted.code(),
        "INDEX_WATCH_LIMIT_EXHAUSTED"
    );
}

#[test]
fn an_empty_poll_is_clean() {
    let tree = TempTree::new("empty-poll");
    let mut session =
        WatchSession::start(&tree.root, &limits(), Duration::from_millis(20)).unwrap();
    let update = session.poll();
    assert!(update.events.is_empty());
    assert_eq!(update.invalidated, None);
    assert!(matches!(
        update.mode,
        WatchMode::Native | WatchMode::Polling
    ));
    assert_eq!(session.invalidated(), None);
}

#[test]
fn a_session_sees_a_created_file() {
    let tree = TempTree::new("sees-create");
    let mut session =
        WatchSession::start(&tree.root, &limits(), Duration::from_millis(20)).unwrap();
    tree.file("created.txt");

    let update = wait_for(&mut session, |update| {
        update.events.iter().any(|event| {
            event.rel == Path::new("created.txt") && event.action == ChangeAction::Added
        })
    })
    .expect("the created file must be reported by the native or polling backend");
    assert_eq!(update.invalidated, None);
}

#[test]
fn a_zero_watch_budget_starts_in_polling_mode_and_still_delivers_events() {
    let tree = TempTree::new("zero-budget");
    let mut session =
        WatchSession::start(&tree.root, &no_budget(), Duration::from_millis(20)).unwrap();
    assert_eq!(session.mode(), WatchMode::Polling);
    tree.file("polled.txt");
    let update = wait_for(&mut session, |update| {
        update
            .events
            .iter()
            .any(|event| event.rel == Path::new("polled.txt"))
    })
    .expect("polling mode must still deliver events");
    assert_eq!(update.mode, WatchMode::Polling);
}

#[test]
fn renaming_a_tracked_directory_invalidates_a_live_session() {
    let tree = TempTree::new("rename-dir");
    tree.dir("dir-a");
    tree.file("dir-a/file.txt");
    let mut session =
        WatchSession::start(&tree.root, &limits(), Duration::from_millis(20)).unwrap();
    session.adopt_directories([PathBuf::from("dir-a")]);

    std::fs::rename(tree.root.join("dir-a"), tree.root.join("dir-b")).unwrap();
    let update = wait_for(&mut session, |update| update.invalidated.is_some())
        .expect("a directory rename must invalidate the snapshot");
    assert_eq!(
        update.invalidated,
        Some(InvalidationReason::WatchedTreeMoved)
    );
    assert!(
        update.events.is_empty(),
        "an invalidated update carries no events"
    );
}

#[test]
fn resyncing_after_a_rescan_clears_the_live_session_invalidation() {
    let tree = TempTree::new("resync");
    tree.dir("dir");
    let mut session =
        WatchSession::start(&tree.root, &limits(), Duration::from_millis(20)).unwrap();
    session.adopt_directories([PathBuf::from("dir")]);
    std::fs::remove_dir_all(tree.root.join("dir")).unwrap();
    wait_for(&mut session, |update| update.invalidated.is_some())
        .expect("removing a tracked directory must invalidate the snapshot");

    session.resync_baseline([PathBuf::from(".")]);
    assert_eq!(session.invalidated(), None);
    let update = session.poll();
    assert_eq!(update.invalidated, None);
}
