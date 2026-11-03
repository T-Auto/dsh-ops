use super::*;
use crate::fsevents::{Batch, Event, EventFlags, EventId};

fn event(id: u64, flags: EventFlags) -> Event {
    Event {
        id: EventId::from_raw(id),
        flags,
        path: PathBuf::from("/root/a.txt"),
        file_id: None,
    }
}

fn batch(
    events: Vec<Event>,
    latest: u64,
    history_done: bool,
    dropped: bool,
    event_ids_wrapped: bool,
) -> Batch {
    Batch {
        events,
        latest: EventId::from_raw(latest),
        history_done,
        dropped,
        event_ids_wrapped,
    }
}

#[test]
fn no_invalidating_flag_has_no_reason() {
    for flags in [
        EventFlags::NONE,
        EventFlags::ITEM_CREATED,
        EventFlags::ITEM_REMOVED,
        EventFlags::ITEM_MODIFIED,
        EventFlags::ITEM_RENAMED,
        EventFlags::HISTORY_DONE,
        EventFlags::ITEM_IS_DIR,
    ] {
        assert_eq!(RescanReason::from_flags(flags), None, "{flags:?}");
    }
}

#[test]
fn every_invalidating_flag_maps_to_its_reason() {
    let pairs = [
        (EventFlags::MUST_SCAN_SUBDIRS, RescanReason::MustScanSubDirs),
        (EventFlags::USER_DROPPED, RescanReason::UserDropped),
        (EventFlags::KERNEL_DROPPED, RescanReason::KernelDropped),
        (EventFlags::EVENT_IDS_WRAPPED, RescanReason::EventIdsWrapped),
        (EventFlags::ROOT_CHANGED, RescanReason::RootChanged),
        (EventFlags::MOUNT, RescanReason::Mount),
        (EventFlags::UNMOUNT, RescanReason::Unmount),
    ];
    assert_eq!(pairs.len(), RescanReason::ALL.len());
    for (flags, reason) in pairs {
        assert_eq!(RescanReason::from_flags(flags), Some(reason), "{flags:?}");
        let combined = EventFlags::from_raw(flags.raw() | EventFlags::ITEM_CREATED.raw());
        assert_eq!(RescanReason::from_flags(combined), Some(reason));
    }
}

#[test]
fn every_reason_has_a_stable_name() {
    for reason in RescanReason::ALL {
        assert_eq!(RescanReason::from_flags(flags_for(reason)), Some(reason));
        assert_eq!(reason.to_string(), reason.as_str());
        assert!(!reason.as_str().is_empty());
    }
}

fn flags_for(reason: RescanReason) -> EventFlags {
    match reason {
        RescanReason::MustScanSubDirs => EventFlags::MUST_SCAN_SUBDIRS,
        RescanReason::UserDropped => EventFlags::USER_DROPPED,
        RescanReason::KernelDropped => EventFlags::KERNEL_DROPPED,
        RescanReason::EventIdsWrapped => EventFlags::EVENT_IDS_WRAPPED,
        RescanReason::RootChanged => EventFlags::ROOT_CHANGED,
        RescanReason::Mount => EventFlags::MOUNT,
        RescanReason::Unmount => EventFlags::UNMOUNT,
    }
}

#[test]
fn lost_events_are_classified_separately_from_tree_changes() {
    for reason in [
        RescanReason::MustScanSubDirs,
        RescanReason::UserDropped,
        RescanReason::KernelDropped,
    ] {
        assert!(reason.means_lost_events(), "{reason}");
    }
    for reason in [
        RescanReason::EventIdsWrapped,
        RescanReason::RootChanged,
        RescanReason::Mount,
        RescanReason::Unmount,
    ] {
        assert!(!reason.means_lost_events(), "{reason}");
    }
}

#[test]
fn must_scan_subdirs_forces_a_rescan_even_with_arriving_events() {
    // The batch carries a usable event and an invalidating one: nothing from
    // this batch may be applied as a complete answer.
    let input = batch(
        vec![
            event(3, EventFlags::ITEM_CREATED),
            event(4, EventFlags::MUST_SCAN_SUBDIRS),
        ],
        4,
        false,
        true,
        false,
    );
    let answer = recovery(&input, EventId::SINCE_NOW);
    assert_eq!(
        answer,
        Recovery::Rescan {
            reason: RescanReason::MustScanSubDirs,
            latest: EventId::from_raw(4),
        }
    );
    assert!(!answer.is_caught_up());
    assert_eq!(answer.latest(), EventId::from_raw(4));
}

#[test]
fn every_invalidating_flag_wins_over_a_clean_history() {
    for flags in [
        EventFlags::MUST_SCAN_SUBDIRS,
        EventFlags::USER_DROPPED,
        EventFlags::KERNEL_DROPPED,
        EventFlags::EVENT_IDS_WRAPPED,
        EventFlags::ROOT_CHANGED,
        EventFlags::MOUNT,
        EventFlags::UNMOUNT,
    ] {
        let input = batch(vec![event(7, flags)], 7, true, false, false);
        let answer = recovery(&input, EventId::from_raw(3));
        assert_eq!(answer.rescan_reason(), RescanReason::from_flags(flags));
        assert!(!answer.is_caught_up());
    }
}

#[test]
fn a_wrapped_batch_rescans_even_without_a_flagged_event() {
    let input = batch(Vec::new(), 9, false, false, true);
    assert_eq!(
        recovery(&input, EventId::from_raw(3)),
        Recovery::Rescan {
            reason: RescanReason::EventIdsWrapped,
            latest: EventId::from_raw(9),
        }
    );
}

#[test]
fn a_dropped_batch_without_a_flagged_event_still_rescans() {
    let input = batch(Vec::new(), 9, true, true, false);
    assert_eq!(
        recovery(&input, EventId::from_raw(3)),
        Recovery::Rescan {
            reason: RescanReason::KernelDropped,
            latest: EventId::from_raw(9),
        }
    );
}

#[test]
fn a_clean_replay_that_reached_history_done_is_caught_up() {
    let input = batch(
        vec![event(9, EventFlags::ITEM_CREATED)],
        9,
        true,
        false,
        false,
    );
    let answer = recovery(&input, EventId::from_raw(3));
    assert_eq!(
        answer,
        Recovery::CaughtUp {
            latest: EventId::from_raw(9),
        }
    );
    assert!(answer.is_caught_up());
    assert_eq!(answer.rescan_reason(), None);
}

#[test]
fn a_clean_replay_without_history_done_is_incomplete() {
    let input = batch(
        vec![event(9, EventFlags::ITEM_CREATED)],
        9,
        false,
        false,
        false,
    );
    let answer = recovery(&input, EventId::from_raw(3));
    assert_eq!(
        answer,
        Recovery::ReplayIncomplete {
            latest: EventId::from_raw(9),
        }
    );
    assert!(!answer.is_caught_up());
}

#[test]
fn a_live_stream_is_caught_up_without_a_history_sentinel() {
    let input = batch(
        vec![event(9, EventFlags::ITEM_CREATED)],
        9,
        false,
        false,
        false,
    );
    assert_eq!(
        recovery(&input, EventId::SINCE_NOW),
        Recovery::CaughtUp {
            latest: EventId::from_raw(9),
        }
    );
}

#[test]
fn time_machine_mount_points_are_recognised() {
    for path in [
        "/Volumes/com.apple.TimeMachine.localsnapshots/Backups.backupdb/x",
        "/Volumes/.timemachine/ABC/2026-01-01",
        "/.MobileBackups/root",
        "/Volumes/Backup/Backups.backupdb/Mac/2026-01-01/data",
        "/Users/someone/com.apple.TimeMachine.localsnapshots",
    ] {
        assert!(is_time_machine_path(Path::new(path)), "{path}");
    }
}

#[test]
fn ordinary_paths_are_not_time_machine() {
    for path in [
        "/",
        "/Volumes",
        "/Volumes/Data",
        "/Volumes/com.example.TimeMachine",
        "/Users/someone/Documents/Backups.backupdb.txt",
        "/Users/someone/time.machine",
    ] {
        assert!(!is_time_machine_path(Path::new(path)), "{path}");
    }
    assert!(!is_time_machine_path(&std::env::temp_dir()));
}

#[test]
fn time_machine_roots_are_split_from_the_watchable_set() {
    let roots = vec![
        PathBuf::from("/Volumes/Data"),
        PathBuf::from("/Volumes/com.apple.TimeMachine.localsnapshots/x"),
        PathBuf::from("/Volumes/.timemachine/y"),
        PathBuf::from("/Users/someone"),
    ];
    let (watchable, excluded) = split_time_machine_roots(&roots);
    assert_eq!(
        watchable,
        vec![
            PathBuf::from("/Volumes/Data"),
            PathBuf::from("/Users/someone")
        ]
    );
    assert_eq!(
        excluded,
        vec![
            PathBuf::from("/Volumes/com.apple.TimeMachine.localsnapshots/x"),
            PathBuf::from("/Volumes/.timemachine/y"),
        ]
    );
}

#[test]
fn every_reason_preserves_the_cursor_value_it_was_given() {
    let input = batch(Vec::new(), 42, true, false, false);
    assert_eq!(
        recovery(&input, EventId::from_raw(41)).latest(),
        EventId::from_raw(42)
    );
    let input = batch(Vec::new(), 43, false, false, false);
    assert_eq!(
        recovery(&input, EventId::from_raw(41)).latest(),
        EventId::from_raw(43)
    );
}

#[test]
fn a_root_changed_event_forces_a_rescan() {
    // WatchRoot (M2) is what makes this event reachable; without a rescan the
    // index would keep applying changes to a tree whose root was replaced.
    let input = batch(
        vec![event(4, EventFlags::ROOT_CHANGED)],
        4,
        true,
        false,
        false,
    );
    let answer = recovery(&input, EventId::from_raw(3));
    assert_eq!(
        answer,
        Recovery::Rescan {
            reason: RescanReason::RootChanged,
            latest: EventId::from_raw(4),
        }
    );
    assert!(!RescanReason::RootChanged.means_lost_events());
}
