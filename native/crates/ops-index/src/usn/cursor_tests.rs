use super::*;

fn live() -> JournalInfo {
    JournalInfo {
        journal_id: 7,
        first_usn: 100,
        next_usn: 1000,
        lowest_valid_usn: 0,
        max_usn: i64::MAX,
    }
}

fn saved(next_usn: i64) -> SavedCursor {
    SavedCursor {
        journal_id: 7,
        next_usn,
    }
}

fn purged() -> Resync {
    Resync::FullRescan(RescanReason::CursorPurged)
}

fn restamp() -> Resync {
    Resync::FullRescan(RescanReason::RestampDiscontinuity)
}

fn journal_changed() -> Resync {
    Resync::FullRescan(RescanReason::JournalIdChanged)
}

#[test]
fn cursor_inside_the_window_is_in_sync() {
    assert_eq!(validate_cursor(&saved(500), &live()), Resync::InSync);
}

#[test]
fn cursor_at_first_usn_is_in_sync() {
    assert_eq!(validate_cursor(&saved(100), &live()), Resync::InSync);
}

#[test]
fn cursor_at_next_usn_is_in_sync() {
    assert_eq!(validate_cursor(&saved(1000), &live()), Resync::InSync);
}

#[test]
fn cursor_at_lowest_valid_usn_is_in_sync() {
    let live = JournalInfo {
        lowest_valid_usn: 200,
        ..live()
    };
    assert_eq!(validate_cursor(&saved(200), &live), Resync::InSync);
}

#[test]
fn journal_id_mismatch_forces_a_full_rescan() {
    let stale = SavedCursor {
        journal_id: 6,
        next_usn: 500,
    };
    assert_eq!(validate_cursor(&stale, &live()), journal_changed());
}

#[test]
fn journal_id_mismatch_outranks_a_purge() {
    let stale = SavedCursor {
        journal_id: 6,
        next_usn: 50,
    };
    assert_eq!(validate_cursor(&stale, &live()), journal_changed());
}

#[test]
fn cursor_below_first_usn_is_purged() {
    assert_eq!(validate_cursor(&saved(50), &live()), purged());
}

#[test]
fn purge_outranks_restamp_when_both_apply() {
    let live = JournalInfo {
        lowest_valid_usn: 200,
        ..live()
    };
    assert_eq!(validate_cursor(&saved(50), &live), purged());
}

#[test]
fn cursor_below_lowest_valid_usn_is_a_restamp() {
    let live = JournalInfo {
        lowest_valid_usn: 200,
        ..live()
    };
    assert_eq!(validate_cursor(&saved(150), &live), restamp());
}

#[test]
fn first_usn_equality_does_not_override_lowest_valid() {
    let live = JournalInfo {
        lowest_valid_usn: 200,
        ..live()
    };
    // At FirstUsn, so row 2 does not fire, but still below LowestValidUsn.
    assert_eq!(validate_cursor(&saved(100), &live), restamp());
}

#[test]
fn cursor_from_the_future_is_a_restamp() {
    assert_eq!(validate_cursor(&saved(2000), &live()), restamp());
}

#[test]
fn empty_journal_accepts_only_the_caught_up_cursor() {
    let empty = JournalInfo {
        first_usn: 1000,
        next_usn: 1000,
        ..live()
    };
    assert_eq!(validate_cursor(&saved(1000), &empty), Resync::InSync);
    assert_eq!(validate_cursor(&saved(999), &empty), purged());
    assert_eq!(validate_cursor(&saved(1001), &empty), restamp());
}

#[test]
fn max_usn_is_never_consulted() {
    for max_usn in [i64::MIN, 0, 500, i64::MAX] {
        let live = JournalInfo { max_usn, ..live() };
        assert_eq!(validate_cursor(&saved(500), &live), Resync::InSync);
        // Even a cursor above MaxUsn is judged only against NextUsn.
        assert_eq!(validate_cursor(&saved(2000), &live), restamp());
    }
}

#[test]
fn extreme_usn_values_are_total() {
    let live = JournalInfo {
        journal_id: 1,
        first_usn: i64::MIN,
        next_usn: i64::MAX,
        lowest_valid_usn: i64::MIN,
        max_usn: i64::MAX,
    };
    let at_min = SavedCursor {
        journal_id: 1,
        next_usn: i64::MIN,
    };
    let at_max = SavedCursor {
        journal_id: 1,
        next_usn: i64::MAX,
    };
    assert_eq!(validate_cursor(&at_min, &live), Resync::InSync);
    assert_eq!(validate_cursor(&at_max, &live), Resync::InSync);
}

#[test]
fn inconsistent_live_values_still_follow_the_table() {
    // The OS should never report FirstUsn > NextUsn; if it does, the function
    // stays total and table-ordered instead of panicking.
    let inverted = JournalInfo {
        first_usn: 1000,
        next_usn: 100,
        ..live()
    };
    assert_eq!(validate_cursor(&saved(500), &inverted), purged());
    assert_eq!(validate_cursor(&saved(1500), &inverted), restamp());
}

/// Every boundary position of the valid window, including both sides of
/// equality, against a journal whose LowestValidUsn is above FirstUsn.
#[test]
fn lowest_valid_sweep_is_exhaustive() {
    let live = JournalInfo {
        lowest_valid_usn: 200,
        ..live()
    };
    let cases = [
        (i64::MIN, purged()),
        (0, purged()),
        (50, purged()),
        (99, purged()),
        (100, restamp()),
        (150, restamp()),
        (199, restamp()),
        (200, Resync::InSync),
        (201, Resync::InSync),
        (500, Resync::InSync),
        (999, Resync::InSync),
        (1000, Resync::InSync),
        (1001, restamp()),
        (i64::MAX, restamp()),
    ];
    for (next_usn, expected) in cases {
        assert_eq!(
            validate_cursor(&saved(next_usn), &live),
            expected,
            "saved.next_usn = {next_usn}"
        );
    }
}

/// The same sweep with LowestValidUsn below FirstUsn, so purge and restamp
/// cannot both fire and equality at FirstUsn is the only boundary left.
#[test]
fn first_usn_sweep_is_exhaustive() {
    let cases = [
        (i64::MIN, purged()),
        (0, purged()),
        (50, purged()),
        (99, purged()),
        (100, Resync::InSync),
        (101, Resync::InSync),
        (500, Resync::InSync),
        (999, Resync::InSync),
        (1000, Resync::InSync),
        (1001, restamp()),
        (i64::MAX, restamp()),
    ];
    for (next_usn, expected) in cases {
        assert_eq!(
            validate_cursor(&saved(next_usn), &live()),
            expected,
            "saved.next_usn = {next_usn}"
        );
    }
}

#[test]
fn journal_id_change_outranks_every_position() {
    let live = JournalInfo {
        lowest_valid_usn: 200,
        ..live()
    };
    for next_usn in [i64::MIN, 0, 99, 100, 199, 200, 500, 1000, 1001, i64::MAX] {
        let stale = SavedCursor {
            journal_id: live.journal_id + 1,
            next_usn,
        };
        assert_eq!(
            validate_cursor(&stale, &live),
            journal_changed(),
            "saved.next_usn = {next_usn}"
        );
    }
}
