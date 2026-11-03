// Design informed by mustafaahci/goz (MIT).
//! Replayable source cursors and the rescan decision.
//!
//! A snapshot is only reusable when the source can prove it has caught up from
//! the cursor that was saved with it. That decision is a pure function here:
//! [`validate_cursor`] takes the saved cursor and the live source state and
//! returns either `InSync` or `FullRescan(reason)`. Being pure is what makes the
//! wrap, restamp and purge boundaries exhaustively testable without a volume.
//!
//! Three source shapes are modelled:
//!
//! - USN: `journal_id` plus the next USN. A journal id change, a purge below
//!   `first_usn`, a restamp below `lowest_valid_usn` or a cursor from the future
//!   all force a full rescan.
//! - FSEvents: an event id. A cursor that is ahead of the latest id cannot be
//!   from this log, so it is treated as a restamp.
//! - Unreplayable: Linux watch descriptors have no replay log, so there is no
//!   cursor that can prove anything; the answer is always a full rescan.
//!
//! The caller persists cursors next to the snapshot and must only reuse them
//! together; a saved cursor without its snapshot would let an empty index claim
//! to be current.

/// Saved cursor of the source that produced a snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cursor {
    /// USN journal position.
    Usn {
        /// Journal identity; a change invalidates every saved position.
        journal_id: u64,
        /// First USN not yet applied.
        next_usn: i64,
    },
    /// FSEvents event id.
    Fsevents {
        /// Last event id that was applied.
        event_id: u64,
    },
    /// The source has no replay log (Linux watch descriptors).
    Unreplayable,
}

/// Live state of a USN journal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JournalInfo {
    /// Identity of the journal.
    pub journal_id: u64,
    /// First USN still readable.
    pub first_usn: i64,
    /// Next USN the journal would hand out.
    pub next_usn: i64,
    /// Lowest USN that may be read after a restamp.
    pub lowest_valid_usn: i64,
}

/// Live state of the source, used to validate a saved cursor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Replay {
    /// A USN journal is live with this state.
    Usn(JournalInfo),
    /// An FSEvents log is live up to this event id.
    Fsevents {
        /// Latest event id the source can hand out.
        latest_event_id: u64,
    },
    /// The source has no replay log.
    Unreplayable,
}

/// Whether a saved cursor may be trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resync {
    /// The snapshot may be used after replaying from the saved cursor.
    InSync,
    /// The snapshot must be discarded and rebuilt.
    FullRescan(RescanReason),
}

impl Resync {
    /// Whether the snapshot may be used.
    pub fn is_in_sync(self) -> bool {
        matches!(self, Self::InSync)
    }
}

/// Why a saved cursor forced a full rescan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RescanReason {
    /// The journal was recreated and has a new identity.
    JournalIdChanged,
    /// The saved position fell below the first readable USN (journal wrapped).
    CursorPurged,
    /// The journal was restamped: the saved position is below the valid range or
    /// in the future.
    RestampDiscontinuity,
    /// The saved cursor describes a different kind of source.
    SourceChanged,
    /// The source has no replay log.
    Unreplayable,
}

impl RescanReason {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(self) -> &'static str {
        match self {
            Self::JournalIdChanged => "INDEX_CURSOR_JOURNAL_ID_CHANGED",
            Self::CursorPurged => "INDEX_CURSOR_PURGED",
            Self::RestampDiscontinuity => "INDEX_CURSOR_RESTAMP",
            Self::SourceChanged => "INDEX_CURSOR_SOURCE_CHANGED",
            Self::Unreplayable => "INDEX_CURSOR_UNREPLAYABLE",
        }
    }
}

/// Decides whether a saved cursor may be trusted against the live source.
///
/// Total and pure: no I/O, no clock, no panics. The first matching rule wins,
/// which is observable and tested:
///
/// 1. either side unreplayable -> `Unreplayable`;
/// 2. cursor kind does not match the live source -> `SourceChanged`;
/// 3. journal id differs -> `JournalIdChanged` (before any position rule);
/// 4. `next_usn < first_usn` -> `CursorPurged` (before the lowest-valid rule);
/// 5. `next_usn < lowest_valid_usn` or `next_usn > live.next_usn` -> `RestampDiscontinuity`;
/// 6. otherwise `InSync`. Equality at `first_usn`, `lowest_valid_usn` and
///    `live.next_usn` is in sync.
pub fn validate_cursor(saved: &Cursor, live: &Replay) -> Resync {
    if matches!(saved, Cursor::Unreplayable) || matches!(live, Replay::Unreplayable) {
        return Resync::FullRescan(RescanReason::Unreplayable);
    }
    match (saved, live) {
        (
            Cursor::Usn {
                journal_id,
                next_usn,
            },
            Replay::Usn(info),
        ) => {
            if *journal_id != info.journal_id {
                return Resync::FullRescan(RescanReason::JournalIdChanged);
            }
            if *next_usn < info.first_usn {
                return Resync::FullRescan(RescanReason::CursorPurged);
            }
            if *next_usn < info.lowest_valid_usn || *next_usn > info.next_usn {
                return Resync::FullRescan(RescanReason::RestampDiscontinuity);
            }
            Resync::InSync
        }
        (Cursor::Fsevents { event_id }, Replay::Fsevents { latest_event_id }) => {
            if *event_id > *latest_event_id {
                return Resync::FullRescan(RescanReason::RestampDiscontinuity);
            }
            Resync::InSync
        }
        _ => Resync::FullRescan(RescanReason::SourceChanged),
    }
}

#[cfg(test)]
#[path = "cursor_tests.rs"]
mod cursor_tests;
