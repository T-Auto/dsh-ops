use super::*;

fn saved(journal_id: u64, next_usn: i64) -> Cursor {
    Cursor::Usn(cursor::SavedCursor {
        journal_id,
        next_usn,
    })
}

fn info(journal_id: u64, first_usn: i64, next_usn: i64, lowest_valid_usn: i64) -> Replay {
    Replay::Usn(cursor::JournalInfo {
        journal_id,
        first_usn,
        next_usn,
        lowest_valid_usn,
        max_usn: i64::MAX,
    })
}

#[test]
fn a_cursor_inside_the_journal_is_in_sync() {
    assert_eq!(
        validate_cursor(&saved(1, 500), &info(1, 100, 900, 200)),
        Resync::InSync
    );
}

#[test]
fn equality_at_every_boundary_is_in_sync() {
    // A real journal has first_usn <= lowest_valid_usn, so the equal-first
    // boundary is also the equal-lowest boundary here.
    let live = info(1, 100, 900, 100);
    for next_usn in [100, 900] {
        assert_eq!(
            validate_cursor(&saved(1, next_usn), &live),
            Resync::InSync,
            "next_usn {next_usn}"
        );
    }
    let live = info(1, 100, 900, 150);
    assert_eq!(validate_cursor(&saved(1, 150), &live), Resync::InSync);
}

#[test]
fn the_usn_branch_delegates_to_the_usn_truth_table() {
    // Each crafted pair makes the P3 function produce one reason; this test
    // asserts both that the delegation produces it and that the local reason
    // is the mapped equivalent. Changing either implementation without the
    // other fails here.
    let cases = [
        (
            saved(1, 10),
            info(2, 0, 20, 0),
            cursor::RescanReason::JournalIdChanged,
            RescanReason::JournalIdChanged,
        ),
        (
            saved(1, 5),
            info(1, 10, 20, 0),
            cursor::RescanReason::CursorPurged,
            RescanReason::CursorPurged,
        ),
        (
            saved(1, 5),
            info(1, 0, 20, 10),
            cursor::RescanReason::RestampDiscontinuity,
            RescanReason::RestampDiscontinuity,
        ),
    ];
    for (saved, live, usn_reason, local_reason) in cases {
        let Cursor::Usn(saved_cursor) = saved else {
            panic!("helper must build a USN cursor");
        };
        let Replay::Usn(live_info) = live else {
            panic!("helper must build a USN replay");
        };
        assert_eq!(
            cursor::validate_cursor(&saved_cursor, &live_info),
            cursor::Resync::FullRescan(usn_reason)
        );
        assert_eq!(
            validate_cursor(&saved, &live),
            Resync::FullRescan(local_reason)
        );
    }
}

#[test]
fn a_journal_id_change_wins_over_every_position_rule() {
    assert_eq!(
        validate_cursor(&saved(1, 0), &info(2, 100, 900, 200)),
        Resync::FullRescan(RescanReason::JournalIdChanged)
    );
    assert_eq!(
        validate_cursor(&saved(1, -5), &info(2, 100, 900, 200)),
        Resync::FullRescan(RescanReason::JournalIdChanged)
    );
}

#[test]
fn a_purged_cursor_wins_over_the_lowest_valid_rule() {
    assert_eq!(
        validate_cursor(&saved(1, 50), &info(1, 100, 900, 200)),
        Resync::FullRescan(RescanReason::CursorPurged)
    );
}

#[test]
fn a_cursor_below_the_lowest_valid_usn_is_a_restamp() {
    // first_usn <= next_usn < lowest_valid_usn: the readable range starts later.
    assert_eq!(
        validate_cursor(&saved(1, 150), &info(1, 100, 900, 200)),
        Resync::FullRescan(RescanReason::RestampDiscontinuity)
    );
}

#[test]
fn a_cursor_from_the_future_is_a_restamp() {
    assert_eq!(
        validate_cursor(&saved(1, 901), &info(1, 100, 900, 200)),
        Resync::FullRescan(RescanReason::RestampDiscontinuity)
    );
}

#[test]
fn an_empty_journal_only_accepts_the_current_position() {
    let live = info(1, 7, 7, 7);
    assert_eq!(validate_cursor(&saved(1, 7), &live), Resync::InSync);
    assert_eq!(
        validate_cursor(&saved(1, 6), &live),
        Resync::FullRescan(RescanReason::CursorPurged)
    );
    assert_eq!(
        validate_cursor(&saved(1, 8), &live),
        Resync::FullRescan(RescanReason::RestampDiscontinuity)
    );
}

#[test]
fn fsevents_replays_forward_and_rejects_a_future_id() {
    let live = Replay::Fsevents {
        latest_event_id: 100,
    };
    assert_eq!(
        validate_cursor(&Cursor::Fsevents { event_id: 100 }, &live),
        Resync::InSync
    );
    assert_eq!(
        validate_cursor(&Cursor::Fsevents { event_id: 40 }, &live),
        Resync::InSync,
        "InSync only promises replayability; MustScanSubDirs is the platform's call"
    );
    assert_eq!(
        validate_cursor(&Cursor::Fsevents { event_id: 101 }, &live),
        Resync::FullRescan(RescanReason::RestampDiscontinuity)
    );
}

#[test]
fn linux_cursors_are_explicitly_not_replayable() {
    assert_eq!(
        validate_cursor(&Cursor::Unreplayable, &Replay::Unreplayable),
        Resync::FullRescan(RescanReason::Unreplayable)
    );
    assert_eq!(
        validate_cursor(&Cursor::Unreplayable, &info(1, 0, 10, 0)),
        Resync::FullRescan(RescanReason::Unreplayable)
    );
    assert_eq!(
        validate_cursor(&saved(1, 5), &Replay::Unreplayable),
        Resync::FullRescan(RescanReason::Unreplayable)
    );
}

#[test]
fn a_cursor_for_another_source_kind_is_a_rescan() {
    assert_eq!(
        validate_cursor(&saved(1, 5), &Replay::Fsevents { latest_event_id: 9 }),
        Resync::FullRescan(RescanReason::SourceChanged)
    );
    assert_eq!(
        validate_cursor(&Cursor::Fsevents { event_id: 5 }, &info(1, 0, 10, 0)),
        Resync::FullRescan(RescanReason::SourceChanged)
    );
}

#[test]
fn no_combination_returns_a_wrong_in_sync() {
    // A small exhaustive sweep: whenever the saved cursor cannot describe the
    // live position, the answer must be a full rescan, never InSync.
    let journals = [(1, 0, 10, 0), (1, 5, 10, 0), (2, 0, 10, 0), (1, 0, 10, 6)];
    for journal_id in [0u64, 1, 2] {
        for next_usn in [-1i64, 0, 5, 10, 11] {
            for (live_id, first, next, lowest) in journals {
                let saved = saved(journal_id, next_usn);
                let live = info(live_id, first, next, lowest);
                let verdict = validate_cursor(&saved, &live);
                let expected = live_id == journal_id
                    && next_usn >= first
                    && next_usn >= lowest
                    && next_usn <= next;
                assert_eq!(
                    verdict.is_in_sync(),
                    expected,
                    "saved={saved:?} live={live:?} verdict={verdict:?}"
                );
            }
        }
    }
}

#[test]
fn resync_and_reason_accessors_are_stable() {
    assert!(Resync::InSync.is_in_sync());
    assert!(!Resync::FullRescan(RescanReason::CursorPurged).is_in_sync());
    let reasons = [
        (
            RescanReason::JournalIdChanged,
            "INDEX_CURSOR_JOURNAL_ID_CHANGED",
        ),
        (RescanReason::CursorPurged, "INDEX_CURSOR_PURGED"),
        (RescanReason::RestampDiscontinuity, "INDEX_CURSOR_RESTAMP"),
        (RescanReason::SourceChanged, "INDEX_CURSOR_SOURCE_CHANGED"),
        (RescanReason::Unreplayable, "INDEX_CURSOR_UNREPLAYABLE"),
    ];
    for (reason, code) in reasons {
        assert_eq!(reason.code(), code);
    }
}
