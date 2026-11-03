use super::*;
use crate::ffi;
use objc2_core_services::{
    kFSEventStreamCreateFlagFileEvents, kFSEventStreamCreateFlagUseCFTypes,
    kFSEventStreamCreateFlagUseExtendedData, kFSEventStreamCreateFlagWatchRoot,
    kFSEventStreamEventFlagEventIdsWrapped, kFSEventStreamEventFlagHistoryDone,
    kFSEventStreamEventFlagItemChangeOwner, kFSEventStreamEventFlagItemCloned,
    kFSEventStreamEventFlagItemCreated, kFSEventStreamEventFlagItemFinderInfoMod,
    kFSEventStreamEventFlagItemInodeMetaMod, kFSEventStreamEventFlagItemIsDir,
    kFSEventStreamEventFlagItemIsFile, kFSEventStreamEventFlagItemIsHardlink,
    kFSEventStreamEventFlagItemIsLastHardlink, kFSEventStreamEventFlagItemIsSymlink,
    kFSEventStreamEventFlagItemModified, kFSEventStreamEventFlagItemRemoved,
    kFSEventStreamEventFlagItemRenamed, kFSEventStreamEventFlagItemXattrMod,
    kFSEventStreamEventFlagKernelDropped, kFSEventStreamEventFlagMount,
    kFSEventStreamEventFlagMustScanSubDirs, kFSEventStreamEventFlagNone,
    kFSEventStreamEventFlagOwnEvent, kFSEventStreamEventFlagRootChanged,
    kFSEventStreamEventFlagUnmount, kFSEventStreamEventFlagUserDropped,
};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicU64, Ordering};

/// How long a real-delivery test waits before declaring failure.
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);

static NEXT_TREE: AtomicU64 = AtomicU64::new(0);

/// One temporary directory that removes itself, so a failing test leaves no
/// trees behind.
struct TempTree {
    path: PathBuf,
}

impl TempTree {
    fn new(tag: &str) -> Self {
        let mut base =
            std::fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
        base.push(format!(
            "dsh-ops-mac-m2-{tag}-{}-{}",
            std::process::id(),
            NEXT_TREE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&base).expect("create temporary tree");
        Self { path: base }
    }

    fn to_path_buf(&self) -> PathBuf {
        self.path.clone()
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn open_stream(roots: &[PathBuf], since: EventId) -> EventStream {
    EventStream::open(roots, since, Duration::from_millis(50)).expect("open FSEvents stream")
}

/// Drains until an event for `target` arrives or the wait elapses.
fn wait_for_path(stream: &mut EventStream, target: &Path) -> Option<Event> {
    let deadline = Instant::now() + DELIVERY_TIMEOUT;
    while Instant::now() < deadline {
        let batch = stream.drain(Duration::from_millis(200));
        if let Some(event) = batch
            .events
            .iter()
            .find(|event| event.path == target || event.path.file_name() == target.file_name())
        {
            return Some(event.clone());
        }
    }
    None
}

#[test]
fn event_id_since_now_is_the_all_ones_sentinel() {
    assert_eq!(EventId::SINCE_NOW.raw(), u64::MAX);
    assert!(EventId::SINCE_NOW.is_since_now());
    assert!(!EventId::from_raw(0).is_since_now());
    assert!(!EventId::from_raw(u64::MAX - 1).is_since_now());
}

#[test]
fn event_id_round_trips_through_u64() {
    for raw in [0u64, 1, 42, u64::MAX - 2] {
        let id = EventId::from_raw(raw);
        assert_eq!(id.raw(), raw);
        assert_eq!(EventId::from_raw(id.raw()), id);
    }
    assert!(EventId::from_raw(1) < EventId::from_raw(2));
}

#[test]
fn every_flag_matches_the_kernel_binding() {
    let pairs = [
        (EventFlags::NONE, kFSEventStreamEventFlagNone),
        (
            EventFlags::MUST_SCAN_SUBDIRS,
            kFSEventStreamEventFlagMustScanSubDirs,
        ),
        (EventFlags::USER_DROPPED, kFSEventStreamEventFlagUserDropped),
        (
            EventFlags::KERNEL_DROPPED,
            kFSEventStreamEventFlagKernelDropped,
        ),
        (
            EventFlags::EVENT_IDS_WRAPPED,
            kFSEventStreamEventFlagEventIdsWrapped,
        ),
        (EventFlags::HISTORY_DONE, kFSEventStreamEventFlagHistoryDone),
        (EventFlags::ROOT_CHANGED, kFSEventStreamEventFlagRootChanged),
        (EventFlags::MOUNT, kFSEventStreamEventFlagMount),
        (EventFlags::UNMOUNT, kFSEventStreamEventFlagUnmount),
        (EventFlags::ITEM_CREATED, kFSEventStreamEventFlagItemCreated),
        (EventFlags::ITEM_REMOVED, kFSEventStreamEventFlagItemRemoved),
        (
            EventFlags::ITEM_INODE_META_MOD,
            kFSEventStreamEventFlagItemInodeMetaMod,
        ),
        (EventFlags::ITEM_RENAMED, kFSEventStreamEventFlagItemRenamed),
        (
            EventFlags::ITEM_MODIFIED,
            kFSEventStreamEventFlagItemModified,
        ),
        (
            EventFlags::ITEM_FINDER_INFO_MOD,
            kFSEventStreamEventFlagItemFinderInfoMod,
        ),
        (
            EventFlags::ITEM_CHANGE_OWNER,
            kFSEventStreamEventFlagItemChangeOwner,
        ),
        (
            EventFlags::ITEM_XATTR_MOD,
            kFSEventStreamEventFlagItemXattrMod,
        ),
        (EventFlags::ITEM_IS_FILE, kFSEventStreamEventFlagItemIsFile),
        (EventFlags::ITEM_IS_DIR, kFSEventStreamEventFlagItemIsDir),
        (
            EventFlags::ITEM_IS_SYMLINK,
            kFSEventStreamEventFlagItemIsSymlink,
        ),
        (EventFlags::OWN_EVENT, kFSEventStreamEventFlagOwnEvent),
        (
            EventFlags::ITEM_IS_HARDLINK,
            kFSEventStreamEventFlagItemIsHardlink,
        ),
        (
            EventFlags::ITEM_IS_LAST_HARDLINK,
            kFSEventStreamEventFlagItemIsLastHardlink,
        ),
        (EventFlags::ITEM_CLONED, kFSEventStreamEventFlagItemCloned),
    ];
    for (ours, kernel) in pairs {
        assert_eq!(ours.raw(), kernel, "flag {ours:?}");
    }
}

#[test]
fn creation_flags_request_file_events_and_extended_data() {
    assert_ne!(ffi::CREATE_FLAGS & kFSEventStreamCreateFlagFileEvents, 0);
    assert_ne!(
        ffi::CREATE_FLAGS & kFSEventStreamCreateFlagUseExtendedData,
        0
    );
    // UseExtendedData is only valid together with UseCFTypes; without the
    // latter the callback would receive C strings instead of dictionaries.
    assert_ne!(ffi::CREATE_FLAGS & kFSEventStreamCreateFlagUseCFTypes, 0);
    // WatchRoot is what reports a replaced or renamed root as `RootChanged`,
    // one of the flags that forces a rescan.
    assert_ne!(ffi::CREATE_FLAGS & kFSEventStreamCreateFlagWatchRoot, 0);
}

#[test]
fn unknown_bits_are_preserved_and_queryable() {
    let flags = EventFlags::from_raw(1 << 31 | EventFlags::ITEM_CREATED.raw());
    assert_eq!(flags.raw(), 1 << 31 | 0x100);
    assert!(flags.contains(EventFlags::ITEM_CREATED));
    assert!(!flags.contains(EventFlags::ITEM_REMOVED));
    assert!(flags.intersects(EventFlags::ITEM_CREATED));
    assert!(!EventFlags::from_raw(0).intersects(EventFlags::NONE));
}

#[test]
fn dropped_flags_are_reported_honestly() {
    for flag in [
        EventFlags::MUST_SCAN_SUBDIRS,
        EventFlags::USER_DROPPED,
        EventFlags::KERNEL_DROPPED,
    ] {
        assert!(flag.signals_dropped(), "{flag:?}");
    }
    for flag in [
        EventFlags::NONE,
        EventFlags::ITEM_CREATED,
        EventFlags::HISTORY_DONE,
        EventFlags::EVENT_IDS_WRAPPED,
        EventFlags::ROOT_CHANGED,
    ] {
        assert!(!flag.signals_dropped(), "{flag:?}");
    }
    let combined =
        EventFlags::from_raw(EventFlags::ITEM_MODIFIED.raw() | EventFlags::MUST_SCAN_SUBDIRS.raw());
    assert!(combined.signals_dropped());
}

#[test]
fn history_done_is_recognised_but_is_not_a_drop() {
    assert!(EventFlags::HISTORY_DONE.is_history_done());
    assert!(!EventFlags::HISTORY_DONE.signals_dropped());
    assert!(!EventFlags::NONE.is_history_done());
    assert!(!EventFlags::ITEM_CREATED.is_history_done());
}

#[test]
fn relative_path_uses_the_longest_matching_root() {
    let roots = vec![PathBuf::from("/data/a"), PathBuf::from("/data/a/b")];
    assert_eq!(
        relative_path(&roots, Path::new("/data/a/b/c.txt")),
        Some(PathBuf::from("c.txt"))
    );
    assert_eq!(
        relative_path(&roots, Path::new("/data/a/other.txt")),
        Some(PathBuf::from("other.txt"))
    );
    assert_eq!(
        relative_path(&roots, Path::new("/data/a/b")),
        Some(PathBuf::new())
    );
    assert_eq!(relative_path(&roots, Path::new("/data/abcdef")), None);
    assert_eq!(relative_path(&[], Path::new("/anything")), None);
}

#[test]
fn an_event_reports_its_path_relative_to_the_matching_root() {
    let roots = vec![PathBuf::from("/root")];
    let event = Event {
        id: EventId::from_raw(7),
        flags: EventFlags::ITEM_CREATED,
        path: PathBuf::from("/root/dir/file.txt"),
        file_id: Some(9),
    };
    assert_eq!(
        event.relative_to(&roots),
        Some(PathBuf::from("dir/file.txt"))
    );
    let outside = Event {
        path: PathBuf::from("/elsewhere/file.txt"),
        ..event
    };
    assert_eq!(outside.relative_to(&roots), None);
}

#[test]
fn errors_map_onto_the_source_boundary() {
    assert_eq!(
        EventError::EmptyRoots.source_error(),
        SourceError::Io(ErrorKind::InvalidInput)
    );
    assert_eq!(
        EventError::NonUtf8Root(PathBuf::from("/x")).source_error(),
        SourceError::Io(ErrorKind::InvalidInput)
    );
    assert_eq!(
        EventError::RootNotDirectory(PathBuf::from("/x")).source_error(),
        SourceError::Io(ErrorKind::InvalidInput)
    );
    for error in [
        EventError::CreationFailed,
        EventError::ScheduleFailed,
        EventError::StartFailed,
    ] {
        assert_eq!(error.source_error(), SourceError::Io(ErrorKind::Other));
        assert!(!error.to_string().is_empty());
    }
}

#[test]
fn empty_roots_are_rejected() {
    assert_eq!(
        EventStream::open(&[], EventId::SINCE_NOW, Duration::from_millis(10)).unwrap_err(),
        EventError::EmptyRoots
    );
}

#[test]
fn non_utf8_roots_are_rejected_before_any_ffi_call() {
    let invalid = PathBuf::from(std::ffi::OsStr::from_bytes(b"/tmp/dsh-m2-\xFF-root"));
    assert_eq!(
        EventStream::open(
            std::slice::from_ref(&invalid),
            EventId::SINCE_NOW,
            Duration::from_millis(10)
        )
        .unwrap_err(),
        EventError::NonUtf8Root(invalid)
    );
}

#[test]
fn missing_roots_are_rejected() {
    let missing = PathBuf::from("/nonexistent-dsh-ops-mac-m2-root");
    assert_eq!(
        EventStream::open(
            std::slice::from_ref(&missing),
            EventId::SINCE_NOW,
            Duration::from_millis(10)
        )
        .unwrap_err(),
        EventError::RootNotDirectory(missing)
    );
}

#[test]
fn one_stream_watches_every_root() {
    let first = TempTree::new("one");
    let second = TempTree::new("two");
    let third = TempTree::new("three");
    let roots = vec![
        first.to_path_buf(),
        second.to_path_buf(),
        third.to_path_buf(),
    ];
    let stream = open_stream(&roots, EventId::SINCE_NOW);
    let mut watched: Vec<PathBuf> = stream
        .watched_roots()
        .into_iter()
        .map(|path| std::fs::canonicalize(&path).unwrap_or(path))
        .collect();
    watched.sort();
    let mut expected: Vec<PathBuf> = roots
        .iter()
        .map(|root| std::fs::canonicalize(root).expect("canonical root"))
        .collect();
    expected.sort();
    assert_eq!(watched, expected);
}

#[test]
fn replay_from_a_persisted_id_reports_a_new_file() {
    let tree = TempTree::new("replay");
    let root = tree.to_path_buf();
    // Persist the marker: everything up to it was already known.
    let since = EventStream::current_event_id();
    let file = root.join("created-after-the-marker.txt");
    std::fs::write(&file, b"payload").expect("write file");
    let mut stream = open_stream(std::slice::from_ref(&root), since);
    let Some(event) = wait_for_path(&mut stream, &file) else {
        panic!("no FSEvents event for {file:?} within {DELIVERY_TIMEOUT:?}");
    };
    assert!(
        event.flags.contains(EventFlags::ITEM_CREATED)
            || event.flags.contains(EventFlags::ITEM_MODIFIED),
        "unexpected flags for a created file: {:?}",
        event.flags
    );
    assert!(
        event.id > since,
        "event id {} did not advance past {}",
        event.id.raw(),
        since.raw()
    );
    assert_eq!(
        event.relative_to(std::slice::from_ref(&root)),
        Some(PathBuf::from("created-after-the-marker.txt"))
    );
    let metadata = std::fs::metadata(&file).expect("stat file");
    assert_eq!(
        event.file_id,
        Some(metadata.ino()),
        "the extended data must carry the file id, so a rename needs no second stat"
    );
}

#[test]
fn an_idle_live_stream_reports_no_events() {
    let tree = TempTree::new("idle");
    let root = tree.to_path_buf();
    // SINCE_NOW replays nothing, not even operations recorded a moment before
    // the call: a stream opened at a concrete id can legitimately receive those
    // because fseventsd assigns ids asynchronously.
    let mut stream = open_stream(std::slice::from_ref(&root), EventId::SINCE_NOW);
    let batch = stream.drain(Duration::from_millis(300));
    assert!(batch.is_empty(), "{:?}", batch.events);
    assert!(!batch.dropped);
    assert!(!batch.event_ids_wrapped);
    assert!(!batch.history_done);
    // A live stream seeds its cursor with a real journal id at open time (see
    // the live-cursor test); it must never hand out the SINCE_NOW sentinel.
    assert!(batch.latest > EventId::from_raw(0));
    assert!(!batch.latest.is_since_now());
    assert!(batch.latest <= EventStream::current_event_id());
}

#[test]
fn a_live_batch_never_reports_the_since_now_sentinel() {
    let tree = TempTree::new("live-cursor");
    let root = tree.to_path_buf();
    // Opened live: there is no replay, so the batch is empty — but its cursor
    // must still be a real journal id, because persisting SINCE_NOW would make
    // the next process replay nothing forever.
    let mut stream = open_stream(std::slice::from_ref(&root), EventId::SINCE_NOW);
    assert_eq!(stream.since(), EventId::SINCE_NOW);
    let batch = stream.drain(Duration::from_millis(150));
    assert!(batch.is_empty(), "{:?}", batch.events);
    assert!(!batch.latest.is_since_now());
    assert!(batch.latest > EventId::from_raw(0));
    assert!(batch.latest <= EventStream::current_event_id());
}

#[test]
fn a_live_batch_never_reports_the_since_now_sentinel() {
    let tree = TempTree::new("live-cursor");
    let root = tree.to_path_buf();
    // Opened live: there is no replay, so the batch is empty — but its cursor
    // must still be a real journal id, because persisting SINCE_NOW would make
    // the next process replay nothing forever.
    let mut stream = open_stream(std::slice::from_ref(&root), EventId::SINCE_NOW);
    assert_eq!(stream.since(), EventId::SINCE_NOW);
    let batch = stream.drain(Duration::from_millis(150));
    assert!(batch.is_empty(), "{:?}", batch.events);
    assert!(!batch.latest.is_since_now());
    assert!(batch.latest > EventId::from_raw(0));
    assert!(batch.latest <= EventStream::current_event_id());
}

#[test]
fn drain_returns_within_its_timeout() {
    let tree = TempTree::new("timeout");
    let root = tree.to_path_buf();
    // A live stream has no replay to finish, so nothing can end the wait early
    // except a real event; none is written here.
    let mut stream = open_stream(std::slice::from_ref(&root), EventId::SINCE_NOW);
    let start = Instant::now();
    let batch = stream.drain(Duration::from_millis(150));
    let elapsed = start.elapsed();
    assert!(batch.is_empty(), "{:?}", batch.events);
    assert!(
        elapsed >= Duration::from_millis(140),
        "drain returned too early: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "drain ignored its timeout: {elapsed:?}"
    );
}

#[test]
fn opening_and_dropping_a_stream_repeatedly_is_safe() {
    for round in 0..3 {
        let tree = TempTree::new(&format!("drop-{round}"));
        let root = tree.to_path_buf();
        {
            let stream = open_stream(std::slice::from_ref(&root), EventId::SINCE_NOW);
            assert_eq!(stream.watched_roots().len(), 1);
            assert!(stream.latest_event_id() > EventId::from_raw(0));
        }
    }
}

#[test]
fn the_history_done_sentinel_is_dropped_without_moving_the_cursor() {
    let mut latest = EventId::from_raw(11);
    let mut tally = Tally::default();
    // The kernel's replay-end marker can carry a high id; it names no file, so
    // it must not become the persisted cursor.
    let raw = ffi::RawEvent {
        id: u64::MAX - 1,
        flags: EventFlags::HISTORY_DONE.raw() | EventFlags::ITEM_IS_DIR.raw(),
        path: "/root".to_string(),
        file_id: None,
    };
    assert_eq!(absorb(&raw, &mut latest, &mut tally), None);
    assert_eq!(latest, EventId::from_raw(11));
    assert!(tally.history_done);
    assert!(!tally.dropped);
    assert!(!tally.event_ids_wrapped);

    // A real event still advances it.
    let raw = ffi::RawEvent {
        id: 12,
        flags: EventFlags::ITEM_CREATED.raw(),
        path: "/root/a".to_string(),
        file_id: Some(3),
    };
    let event = absorb(&raw, &mut latest, &mut tally).expect("a real event is kept");
    assert_eq!(event.id, EventId::from_raw(12));
    assert_eq!(latest, EventId::from_raw(12));
}

#[test]
fn wrapped_ids_are_reported_separately_from_drops() {
    let mut latest = EventId::from_raw(0);
    let mut tally = Tally::default();
    let raw = ffi::RawEvent {
        id: 5,
        flags: EventFlags::EVENT_IDS_WRAPPED.raw(),
        path: "/root".to_string(),
        file_id: None,
    };
    assert!(absorb(&raw, &mut latest, &mut tally).is_some());
    assert!(tally.event_ids_wrapped);
    assert!(!tally.dropped);
    assert_eq!(latest, EventId::from_raw(5));
}

#[test]
fn relative_path_survives_a_case_difference_between_root_and_event() {
    // The default macOS file systems are case-insensitive and FSEvents reports
    // the on-disk spelling; the root may have been created with other case.
    let roots = vec![PathBuf::from("/Users/Alice/Data")];
    assert_eq!(
        relative_path(&roots, Path::new("/users/alice/data/report.pdf")),
        Some(PathBuf::from("report.pdf"))
    );
    assert_eq!(
        relative_path(&roots, Path::new("/USERS/ALICE/DATA")),
        Some(PathBuf::new())
    );
    // Components are compared whole: a longer sibling never matches.
    assert_eq!(
        relative_path(&roots, Path::new("/users/alice/database/x")),
        None
    );
}

#[test]
fn an_exact_case_match_wins_over_a_case_insensitive_one() {
    let roots = vec![PathBuf::from("/data"), PathBuf::from("/Data")];
    assert_eq!(
        relative_path(&roots, Path::new("/data/x")),
        Some(PathBuf::from("x"))
    );
    assert_eq!(
        relative_path(&roots, Path::new("/Data/x")),
        Some(PathBuf::from("x"))
    );
}

#[test]
fn a_panic_inside_the_callback_cannot_cross_the_ffi_boundary() {
    let tree = TempTree::new("panic");
    let root = tree.to_path_buf();
    let mut stream = open_stream(std::slice::from_ref(&root), EventId::SINCE_NOW);
    let before = ffi::CAUGHT_PANICS.load(Ordering::Relaxed);
    ffi::PANIC_IN_DELIVERY.store(true, Ordering::Relaxed);
    std::fs::write(root.join("trigger.txt"), b"x").expect("write trigger file");
    // Every delivery panics now. Without the catch_unwind boundary the process
    // would abort here; with it the stream keeps running and the count rises.
    for _ in 0..50 {
        let _ = stream.drain(Duration::from_millis(100));
        if ffi::CAUGHT_PANICS.load(Ordering::Relaxed) > before {
            break;
        }
    }
    ffi::PANIC_IN_DELIVERY.store(false, Ordering::Relaxed);
    assert!(
        ffi::CAUGHT_PANICS.load(Ordering::Relaxed) > before,
        "the callback never ran while the panic probe was set"
    );
}

#[test]
fn unsafe_is_confined_to_the_ffi_module() {
    let sources: [(&str, &str); 13] = [
        ("lib.rs", include_str!("lib.rs")),
        ("ffi.rs", include_str!("ffi.rs")),
        ("ffi_tests.rs", include_str!("ffi_tests.rs")),
        ("fsevents.rs", include_str!("fsevents.rs")),
        ("fsevents_tests.rs", include_str!("fsevents_tests.rs")),
        ("coalesce.rs", include_str!("coalesce.rs")),
        ("coalesce_tests.rs", include_str!("coalesce_tests.rs")),
        ("rescan.rs", include_str!("rescan.rs")),
        ("rescan_tests.rs", include_str!("rescan_tests.rs")),
        ("source.rs", include_str!("source.rs")),
        ("source_tests.rs", include_str!("source_tests.rs")),
        ("walk.rs", include_str!("walk.rs")),
        ("walk_tests.rs", include_str!("walk_tests.rs")),
    ];
    // The needles are assembled from fragments: written literally, this test
    // would find its own source (it contains the very words it searches for).
    let word = ["uns", "afe"].concat();
    let block = format!("{word} {{");
    let function = format!("{word} fn");
    let prefix = format!("{word} ");
    for (name, source) in sources {
        let unsafe_lines: Vec<&str> = source
            .lines()
            .filter(|line| {
                let text = line.trim_start();
                if text.starts_with("//") || text.starts_with("/*") || text.starts_with('*') {
                    return false;
                }
                text.contains(block.as_str())
                    || text.contains(function.as_str())
                    || text.starts_with(prefix.as_str())
            })
            .collect();
        if name == "ffi.rs" {
            assert!(
                !unsafe_lines.is_empty(),
                "the unsafe island should contain the unsafe blocks"
            );
        } else {
            assert!(
                unsafe_lines.is_empty(),
                "{name} has unsafe code outside ffi.rs: {unsafe_lines:?}"
            );
        }
    }
}
